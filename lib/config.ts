// Everything that differs between a devnet, pulsar-3 and mainnet deployment. All of it is
// NEXT_PUBLIC_*, because this app has no server side worth the name — the only API route it
// owns is a price proxy.
export const config = {
  providerUrl: (process.env.NEXT_PUBLIC_PROVIDER_URL ?? "http://localhost:8787").replace(/\/+$/, ""),
  chainId: process.env.NEXT_PUBLIC_CHAIN_ID ?? "secret-4",
  lcdUrl: (process.env.NEXT_PUBLIC_LCD_URL ?? "https://lcd.secret.mainnet.secret3.dev").replace(/\/+$/, ""),
  sscrtContract: process.env.NEXT_PUBLIC_SSCRT_CONTRACT ?? "secret1k0jntykt7e4g3y88ltc60czgjuqdy4c9e8fzek",

  // The gas-vault contract, confirmed on secret-4: it issues fee grants out of its own balance,
  // so a wallet with credits pays fees by naming the vault as granter and never holds SCRT.
  gasVaultAddress:
    process.env.NEXT_PUBLIC_GAS_VAULT_ADDRESS ?? "secret1kkmu4vydkppkhzmx00glm20vn47t09544adv0g",

  // Refill when credits drop below the floor, up to the target. The floor is far above what a
  // refill costs (~0.07 SCRT) on purpose: the refill transaction pays its own fee out of the
  // credits it is topping up, so it has to be affordable before it runs. The target is also the
  // most this wallet ever has tied up in the vault, because credits only ever leave as gas.
  creditFloorUscrt: process.env.NEXT_PUBLIC_CREDIT_FLOOR_USCRT ?? "5000000", // 5 SCRT
  creditTargetUscrt: process.env.NEXT_PUBLIC_CREDIT_TARGET_USCRT ?? "10000000", // 10 SCRT
};

export const SSCRT_DECIMALS = 6;

/** The permit's name is part of what the user signs, so changing it invalidates every stored one. */
export const PERMIT_NAME = "sscrt-gas-demo-balance";

export const MSG_EXECUTE_CONTRACT_TYPE_URL = "/secret.compute.v1beta1.MsgExecuteContract";
