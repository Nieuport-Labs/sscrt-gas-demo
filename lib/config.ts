// Everything that differs between a devnet, pulsar-3 and mainnet deployment. All of it is
// NEXT_PUBLIC_*, because this app has no server side worth the name — the only API route it
// owns is a price proxy.
export const config = {
  providerUrl: (process.env.NEXT_PUBLIC_PROVIDER_URL ?? "http://localhost:8787").replace(/\/+$/, ""),
  chainId: process.env.NEXT_PUBLIC_CHAIN_ID ?? "secret-4",
  lcdUrl: (process.env.NEXT_PUBLIC_LCD_URL ?? "https://lcd.secret.mainnet.secret3.dev").replace(/\/+$/, ""),
  sscrtContract: process.env.NEXT_PUBLIC_SSCRT_CONTRACT ?? "secret1k0jntykt7e4g3y88ltc60czgjuqdy4c9e8fzek",
};

export const SSCRT_DECIMALS = 6;

/** The permit's name is part of what the user signs, so changing it invalidates every stored one. */
export const PERMIT_NAME = "sscrt-gas-demo-balance";

export const MSG_EXECUTE_CONTRACT_TYPE_URL = "/secret.compute.v1beta1.MsgExecuteContract";
