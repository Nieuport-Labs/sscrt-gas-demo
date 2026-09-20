// Everything that talks to Secret Network directly: wallet connection, the read-only client,
// the balance permit, and two public LCD queries the app uses to check its own work.
import { MsgExecuteContract, SecretNetworkClient, type Permit } from "secretjs";
import { config, PERMIT_NAME, PROVIDER_PERMIT_PREFIX } from "./config";

export interface Connection {
  address: string;
  /** base64, compressed secp256k1 — /quote needs it for an address that has never signed. */
  pubkeyBase64: string;
  client: SecretNetworkClient;
}

/** A client with no wallet. Used for every query that needs no signature at all.
 *
 * Built lazily: this module is imported by a client component, which Next also renders on the
 * server, and nothing here should construct a chain client during that pass. */
let readClientInstance: SecretNetworkClient | null = null;

export function readClient(): SecretNetworkClient {
  if (!readClientInstance) {
    readClientInstance = new SecretNetworkClient({ url: config.lcdUrl, chainId: config.chainId });
  }
  return readClientInstance;
}

interface KeplrLike {
  enable(chainId: string): Promise<void>;
  getKey(chainId: string): Promise<{ bech32Address: string; pubKey: Uint8Array }>;
  getOfflineSignerOnlyAmino(chainId: string): unknown;
  getEnigmaUtils(chainId: string): unknown;
  signAmino(
    chainId: string,
    signer: string,
    signDoc: unknown,
    options?: { preferNoSetFee?: boolean; preferNoSetMemo?: boolean },
  ): Promise<{ signed: unknown; signature: { pub_key: { type: string; value: string }; signature: string } }>;
  defaultOptions?: { sign?: { preferNoSetFee?: boolean; preferNoSetMemo?: boolean } };
}

function getKeplr(): KeplrLike {
  const keplr = (globalThis as unknown as { keplr?: KeplrLike }).keplr;
  if (!keplr) {
    throw new Error("Keplr not found — install the extension and reload the page.");
  }
  return keplr;
}

export async function connectKeplr(): Promise<Connection> {
  const keplr = getKeplr();

  // Without this, Keplr silently replaces the fee in any transaction it signs with its own
  // "low" tier — 0.05 uscrt/gas on Secret. The provider quotes at its configured price (0.1),
  // so the signed transaction then carries half the fee the node demands and is rejected with
  // "insufficient fees", naming a figure the app never chose. The fee is the provider's to set,
  // not the wallet's: it is paid from the provider's grant, and the user is billed for exactly
  // it in sSCRT.
  keplr.defaultOptions = { sign: { preferNoSetFee: true, preferNoSetMemo: true } };

  await keplr.enable(config.chainId);
  const key = await keplr.getKey(config.chainId);

  const client = new SecretNetworkClient({
    url: config.lcdUrl,
    chainId: config.chainId,
    wallet: keplr.getOfflineSignerOnlyAmino(config.chainId) as never,
    walletAddress: key.bech32Address,
    // Keplr derives the encryption seed from the user's own key, so anything encrypted here can
    // be decrypted again on any device that wallet is on — unlike a throwaway EncryptionUtils.
    encryptionUtils: keplr.getEnigmaUtils(config.chainId) as never,
  });

  return {
    address: key.bech32Address,
    pubkeyBase64: btoa(String.fromCharCode(...key.pubKey)),
    client,
  };
}

// The code hash is what a query or execute payload is encrypted against, and it changes on a
// contract migration — so it is resolved from the chain rather than hardcoded, and cached only
// for the lifetime of the page.
let codeHashCache: string | null = null;

export async function getSscrtCodeHash(): Promise<string> {
  if (codeHashCache) return codeHashCache;
  const resp = await readClient().query.compute.codeHashByContractAddress({
    contract_address: config.sscrtContract,
  });
  if (!resp.code_hash) throw new Error(`could not resolve the code hash for ${config.sscrtContract}`);
  codeHashCache = resp.code_hash;
  return codeHashCache;
}

/**
 * A SNIP-24 permit: an off-chain signature, no gas, no on-chain footprint, revocable. It is what
 * lets this app — and, once, the provider — read a private sSCRT balance without ever holding a
 * viewing key.
 *
 * The name is a parameter because the app and the provider must not share one. Revocation is
 * keyed by name, so a single shared permit could not be taken away from the provider without
 * also blinding this app. Two permits, two names, and only one of them ever leaves the browser.
 */
export async function signBalancePermit(
  address: string,
  client: SecretNetworkClient,
  permitName: string = PERMIT_NAME,
): Promise<Permit> {
  return client.utils.accessControl.permit.sign(
    address,
    config.chainId,
    permitName,
    [config.sscrtContract],
    ["balance"],
    true, // browser path: Keplr's own signAmino, with the fee and memo fields hidden
  );
}

/**
 * A fresh, single-use permit name for the provider.
 *
 * Unique every time, and that is load-bearing rather than tidy: the contract records a
 * revocation against the *name*, so a name that has been revoked once is dead for good. Reusing
 * it would hand the provider a permit that cannot read anything, and the failure would surface
 * as an unexplained refusal at onboarding rather than as the mistake it is.
 */
export function newProviderPermitName(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${PROVIDER_PERMIT_PREFIX}${Date.now().toString(36)}-${suffix}`;
}

/**
 * A permit that stops working by itself.
 *
 * The original SNIP-24 permit has no expiry, which is why the only way to end one is an on-chain
 * revocation costing gas. The sSCRT deployed on secret-4 is built against a secret-toolkit that
 * added `created` and `expires` to `PermitParams` — and, decisively, put them inside
 * `PermitContent`, which is the part that gets signed. So the expiry is bound by the signature:
 * whoever holds the permit cannot extend it, because changing the field invalidates it.
 *
 * Verified rather than assumed. sSCRT is code id 2280; its wasm carries the `expires` field name
 * beside `permit_name`, the error string "Permit has expired", and the contract pins
 * SolarRepublic/secret-toolkit at df89b58, where `PermitContent` lists created and expires.
 *
 * `created` is deliberately omitted. It is optional outside blanket permits, and setting it
 * invites a failure this cannot fix: the contract rejects a permit created after the current
 * block time, so a browser clock a minute fast would produce a permit nothing accepts.
 *
 * The timestamp format is the one `iso8601_utc0_to_timestamp` accepts, which is exactly what
 * `Date.prototype.toISOString` produces.
 */
export async function signExpiringPermit(
  address: string,
  permitName: string,
  ttlSeconds: number,
): Promise<Permit> {
  const keplr = getKeplr();
  const expires = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const allowed_tokens = [config.sscrtContract];
  const permissions = ["balance"];

  // Amino canonicalises the document before signing, so the key order written here does not
  // matter; what matters is that every field the contract reconstructs is present and identical.
  const { signature } = await keplr.signAmino(
    config.chainId,
    address,
    {
      chain_id: config.chainId,
      account_number: "0",
      sequence: "0",
      fee: { amount: [{ amount: "0", denom: "uscrt" }], gas: "1" },
      msgs: [
        {
          type: "query_permit",
          value: { permit_name: permitName, allowed_tokens, permissions, expires },
        },
      ],
      memo: "",
    },
    { preferNoSetFee: true, preferNoSetMemo: true },
  );

  return {
    params: {
      chain_id: config.chainId,
      permit_name: permitName,
      allowed_tokens,
      permissions,
      expires,
    },
    signature,
  } as unknown as Permit;
}

export async function querySscrtBalance(permit: Permit): Promise<string> {
  const codeHash = await getSscrtCodeHash();
  const result = (await readClient().query.compute.queryContract({
    contract_address: config.sscrtContract,
    code_hash: codeHash,
    query: { with_permit: { permit, query: { balance: {} } } },
  })) as { balance?: { amount?: string } };
  if (!result?.balance?.amount) {
    throw new Error(`unexpected balance response: ${JSON.stringify(result)}`);
  }
  return result.balance.amount;
}

/**
 * Messages that kill permits on chain, for good.
 *
 * SNIP-24 permits have no expiry: the signature stays valid until the contract is told to stop
 * honouring it. Deleting a copy — here, or on the provider's server — only removes that copy.
 * This is the version that does not depend on anyone keeping a promise.
 *
 * Returned as messages rather than sent, so they can ride along in a transaction the wallet was
 * making anyway. That is what lets the provider's permit be revoked automatically: no second
 * signature to approve, no second fee, just a little more gas on the next transfer.
 *
 * Confirmed supported by the sSCRT deployed on secret-4 (code id 2280) — its wasm carries the
 * `revoke_permit` and `revoked` symbols.
 */
export function revokePermitMessages(
  connection: Connection,
  codeHash: string,
  permitNames: string[],
): MsgExecuteContract<object>[] {
  return permitNames.map(
    (permit_name) =>
      new MsgExecuteContract({
        sender: connection.address,
        contract_address: config.sscrtContract,
        code_hash: codeHash,
        msg: { revoke_permit: { permit_name } },
      }),
  );
}

/** Gas for one revoke. Small, but the limit is what gets charged, so it is not free. */
export const GAS_REVOKE_PERMIT = 90_000;

/** Revoke on its own, when there is no transaction to attach it to. */
export async function revokePermits(
  connection: Connection,
  codeHash: string,
  permitNames: string[],
): Promise<{ code: number; rawLog: string; txHash: string }> {
  const tx = await connection.client.tx.broadcast(
    revokePermitMessages(connection, codeHash, permitNames),
    {
      gasLimit: GAS_REVOKE_PERMIT * permitNames.length,
      gasPriceInFeeDenom: 0.1,
      feeDenom: "uscrt",
      feeGranter: config.gasVaultAddress,
    },
  );
  return { code: tx.code, rawLog: tx.rawLog ?? "", txHash: tx.transactionHash };
}

/**
 * How much native SCRT the provider's fee grant will still cover for this address. Public data —
 * no key, no permit. The app reads it before and after every run, because it is the only honest
 * measure of what a transaction actually cost the provider: the submit response reports what the
 * provider *quoted*, not what the chain charged.
 */
export async function queryGrantRemainingUscrt(granter: string, grantee: string): Promise<string | null> {
  const resp = await fetch(
    `${config.lcdUrl}/cosmos/feegrant/v1beta1/allowance/${granter}/${grantee}`,
  );
  if (!resp.ok) return null;
  const body = await resp.json();
  // AllowedMsgAllowance wraps a BasicAllowance; a bare BasicAllowance has the spend limit at the
  // top level. Handle both rather than assume the shape the provider happens to grant today.
  const outer = body?.allowance?.allowance;
  const inner = outer?.allowance ?? outer;
  const limit = inner?.spend_limit?.find((c: { denom: string }) => c.denom === "uscrt");
  return limit?.amount ?? null;
}
