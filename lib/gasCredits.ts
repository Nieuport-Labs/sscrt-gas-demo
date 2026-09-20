// Gas credits, from the wallet's side. A port of `src/lib/gasCredits.ts` and the vault half of
// `src/lib/gasVault.ts` in jirkacepelka/fee-granter, which is where this logic is documented.
// Kept as a port rather than an import because that repo is a separate app, not a package.
//
// A gas credit is an ordinary `BasicAllowance` whose granter is the gas-vault contract, so a
// wallet with credits transacts by setting `fee.granter` to the vault and nothing else. This
// module answers the one question the app asks before every transaction: are there enough, and
// if not, can the wallet fix that by itself?
//
// It can, unless the credits have run out: unwrapping sSCRT and paying it into the vault is a
// transaction like any other, and the remaining credits pay for it. That is the whole reason the
// floor is above zero -- the refill has to be affordable before it runs. Below that, nothing is
// possible on chain without an outside sponsor, and this says so rather than trying.
import { MsgExecuteContract, type SecretNetworkClient, type TxResponse } from "secretjs";
import { config } from "./config";
import { GAS_TOKEN } from "./tokens";
import { readClient } from "./secret";

/** Execute, plus the revoke and grant the vault dispatches. */
export const GAS_BUY = 400_000;
/** The combined refill: a SNIP-20 redeem followed by that purchase. */
export const GAS_TOPUP = 700_000;
/** What the chain charges per unit of gas. The provider quotes at this too. */
export const GAS_PRICE_USCRT = 0.1;
/** What one refill costs, in base units. The floor has to clear this with room to spare. */
export const TOPUP_FEE_USCRT = BigInt(Math.ceil(GAS_TOPUP * GAS_PRICE_USCRT));

export type CreditState =
  /** Enough credits; transact directly, with no server involved. */
  | "warm"
  /** Low, but still enough to pay for its own refill. Still no server. */
  | "draining"
  /** Nothing to pay gas with. Only the provider can break the deadlock. */
  | "cold"
  /** The vault could not reach x/feegrant. Not the same as empty — do nothing. */
  | "unknown";

export interface CreditStatus {
  state: CreditState;
  /** Live remainder from the vault, or `null` when it could not be read. */
  remainingUscrt: string | null;
  /** How much to buy to reach the target. `"0"` when nothing is needed. */
  shortfallUscrt: string;
  /** Native SCRT held. A wallet with SCRT is never cold. */
  nativeUscrt: string;
}

// The vault's code hash, read from the chain and cached for this page load only. A migration
// changes it, and a stale one does not degrade -- it stops every query dead with an error that
// points nowhere near the cause.
let vaultCodeHash: string | null = null;

export async function getVaultCodeHash(): Promise<string> {
  if (vaultCodeHash) return vaultCodeHash;
  const resp = await readClient().query.compute.codeHashByContractAddress({
    contract_address: config.gasVaultAddress,
  });
  if (!resp.code_hash) throw new Error(`could not resolve the code hash for ${config.gasVaultAddress}`);
  vaultCodeHash = resp.code_hash;
  return vaultCodeHash;
}

/**
 * What `x/feegrant` says this address still has from the vault, in base units.
 *
 * **`null` is not zero.** The contract reads the figure through a stargate query the chain
 * allow-lists and reserves the right to change; when it cannot ask, it says so rather than
 * guessing. Rendering that as zero would tell someone their credits are gone when they are
 * intact, and would have the automatic refill spend money fixing nothing.
 */
export async function queryRemaining(address: string): Promise<string | null> {
  const codeHash = await getVaultCodeHash();
  const reply = (await readClient().query.compute.queryContract({
    contract_address: config.gasVaultAddress,
    code_hash: codeHash,
    query: { remaining: { grantee: address } },
  })) as { amount?: string | null };
  return reply?.amount ?? null;
}

async function queryNativeBalance(address: string): Promise<string> {
  const resp = await readClient().query.bank.balance({ address, denom: "uscrt" });
  return resp.balance?.amount ?? "0";
}

/**
 * Read the wallet's gas position.
 *
 * Both figures are public — a fee allowance and a bank balance are on chain in the clear — so
 * this needs no permit and no viewing key, and the provider is not involved in asking.
 */
export async function readCreditStatus(address: string): Promise<CreditStatus> {
  const [remainingUscrt, nativeUscrt] = await Promise.all([
    queryRemaining(address),
    queryNativeBalance(address),
  ]);

  if (remainingUscrt === null) {
    return { state: "unknown", remainingUscrt, shortfallUscrt: "0", nativeUscrt };
  }

  const remaining = BigInt(remainingUscrt);
  const native = BigInt(nativeUscrt);
  const floor = BigInt(config.creditFloorUscrt);
  const target = BigInt(config.creditTargetUscrt);

  // Either pot can pay for the refill: the credits being topped up, or SCRT already held. Only
  // when neither can is a sponsor needed.
  const canPayForRefill = remaining >= TOPUP_FEE_USCRT || native >= TOPUP_FEE_USCRT;
  const state: CreditState =
    remaining >= floor ? "warm" : canPayForRefill ? "draining" : "cold";

  return {
    state,
    remainingUscrt,
    shortfallUscrt: (remaining >= target ? 0n : target - remaining).toString(),
    nativeUscrt,
  };
}

/**
 * Refill, in one transaction, with no sponsor.
 *
 * Two messages: unwrap sSCRT into native SCRT, then pay that SCRT straight into the vault. The
 * second spends what the first produced — messages in a Cosmos transaction run in order against
 * one cached store, so the coins are there by the time the vault is called.
 *
 * The fee comes out of the credits being topped up, and the vault's purchase is a revoke
 * followed by a grant, which means this transaction re-issues the very allowance paying for it.
 * That works because the fee is taken in the ante handler before any message runs, so the vault
 * reads a remainder that already has it deducted.
 */
export async function topUpGasCredits(
  client: SecretNetworkClient,
  address: string,
  amountUscrt: string,
  gasTokenCodeHash: string,
  /** Who gets the credits. Defaults to the sender; the vault allows paying for someone else. */
  grantee: string = address,
): Promise<TxResponse> {
  const vaultCode = await getVaultCodeHash();

  const redeem = new MsgExecuteContract({
    sender: address,
    contract_address: GAS_TOKEN.contract,
    code_hash: gasTokenCodeHash,
    msg: { redeem: { amount: amountUscrt, denom: "uscrt" } },
    sent_funds: [],
  });

  const buy = new MsgExecuteContract({
    sender: address,
    contract_address: config.gasVaultAddress,
    code_hash: vaultCode,
    msg: { grant: { grantee } },
    sent_funds: [{ denom: "uscrt", amount: amountUscrt }],
  });

  return client.tx.broadcast([redeem, buy], {
    gasLimit: GAS_TOPUP,
    gasPriceInFeeDenom: GAS_PRICE_USCRT,
    feeDenom: "uscrt",
    feeGranter: config.gasVaultAddress,
  });
}

/** How much to buy: the shortfall, or everything the wallet can afford, whichever is less. */
export function refillAmount(status: CreditStatus, gasTokenBalanceUscrt: string): bigint {
  const wanted = BigInt(status.shortfallUscrt);
  const available = BigInt(gasTokenBalanceUscrt);
  return wanted < available ? wanted : available;
}
