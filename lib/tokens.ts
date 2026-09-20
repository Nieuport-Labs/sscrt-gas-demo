// The SNIP-20 tokens this app knows about.
//
// One entry today. The registry exists anyway because the alternative -- a `sscrtContract`
// string reached for from five places -- is what makes adding a second token a rewrite instead
// of a line. Nothing here is a code hash: those are read from the chain, because a migration
// changes them and a stale one stops every query dead rather than degrading.
import { config } from "./config";

export interface Token {
  symbol: string;
  contract: string;
  decimals: number;
  /**
   * True for the SNIP-20 that wraps SCRT 1:1 and can be redeemed back into it.
   *
   * Only this one can buy gas -- credits are paid for in native SCRT, and unwrapping is the only
   * way to get there without already having some. A second token would be sendable but would
   * still need sSCRT, or a swap, behind its gas.
   */
  isGasToken: boolean;
  /** Part of what the user signs, so it is per-token and changing it invalidates stored permits. */
  permitName: string;
}

export const SSCRT: Token = {
  symbol: "sSCRT",
  contract: config.sscrtContract,
  decimals: 6,
  isGasToken: true,
  permitName: "sscrt-gas-demo-balance",
};

export const TOKENS: Token[] = [SSCRT];

/** The token the app sends by default, and the only one it offers until there is a second. */
export const DEFAULT_TOKEN = SSCRT;

/** The token gas is ultimately paid out of. There can only be one, and it has to be redeemable. */
export const GAS_TOKEN = SSCRT;

export function tokenByContract(contract: string): Token | undefined {
  return TOKENS.find((token) => token.contract === contract);
}
