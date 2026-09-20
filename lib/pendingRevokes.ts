// Permits handed to the provider that are waiting to be killed on chain.
//
// Revoking is the only way to end a SNIP-24 permit: it has no expiry, so the signature stays
// valid until the contract is told to stop honouring it. The provider deleting its copy is a
// promise; this is the part that does not need to be believed.
//
// It is not done immediately, because it costs gas and a signature. Instead the name is written
// down here and the revoke rides along in the wallet's next transaction, where it adds a little
// gas and nothing else. Until that happens the provider can still read the balance — which is
// worth saying plainly rather than implying the permit dies the moment the credits arrive.
import { config } from "./config";

const key = (address: string) => `sscrt-gas-demo:revoke:${config.chainId}:${address}`;

function read(address: string): string[] {
  try {
    const raw = window.localStorage.getItem(key(address));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === "string") : [];
  } catch {
    // Blocked or corrupt storage. An empty list means the revoke is missed, not that something
    // breaks — and the Settings dialog still offers to do it by hand.
    return [];
  }
}

function write(address: string, names: string[]): void {
  try {
    if (names.length === 0) window.localStorage.removeItem(key(address));
    else window.localStorage.setItem(key(address), JSON.stringify(names));
  } catch {
    /* nothing to do about it, and nothing depends on it succeeding */
  }
}

/** Names of provider permits this wallet has issued and not yet revoked. */
export function pendingRevokes(address: string): string[] {
  return read(address);
}

export function addPendingRevoke(address: string, permitName: string): void {
  const names = read(address);
  if (!names.includes(permitName)) write(address, [...names, permitName]);
}

/** Called once the revoke is on chain — and only then, so a failure leaves it queued. */
export function clearPendingRevokes(address: string, revoked: string[]): void {
  write(
    address,
    read(address).filter((name) => !revoked.includes(name)),
  );
}
