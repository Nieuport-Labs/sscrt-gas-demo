// Everything that talks to Secret Network directly: wallet connection, the read-only client,
// the balance permit, and two public LCD queries the app uses to check its own work.
import { SecretNetworkClient, type Permit } from "secretjs";
import { config, PERMIT_NAME } from "./config";

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
 * lets this app — and the provider — read a private sSCRT balance without ever holding a viewing
 * key.
 */
export async function signBalancePermit(address: string, client: SecretNetworkClient): Promise<Permit> {
  return client.utils.accessControl.permit.sign(
    address,
    config.chainId,
    PERMIT_NAME,
    [config.sscrtContract],
    ["balance"],
    true, // browser path: Keplr's own signAmino, with the fee and memo fields hidden
  );
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
