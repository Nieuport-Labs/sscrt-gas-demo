import { SSCRT_DECIMALS } from "./config";

/** "1234567" (base units) -> "1.234567" */
export function fromBaseUnits(amount: string | bigint, decimals = SSCRT_DECIMALS): string {
  const negative = String(amount).startsWith("-");
  const digits = String(amount).replace("-", "").padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/**
 * "1.23" -> "1230000". Returns null for anything that isn't a plain decimal number, rather than
 * silently rounding — an amount is the one field in this app where a wrong value costs money.
 */
export function toBaseUnits(input: string, decimals = SSCRT_DECIMALS): string | null {
  const trimmed = input.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") return null;
  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) return null;
  const combined = `${whole}${fraction.padEnd(decimals, "0")}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

export function formatTokenAmount(base: string | bigint, decimals = SSCRT_DECIMALS, maxFraction = 6): string {
  const value = Number(fromBaseUnits(base, decimals));
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: maxFraction });
}

export function formatUsd(value: number): string {
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

export function shortenAddress(address: string, lead = 10, tail = 6): string {
  if (address.length <= lead + tail + 1) return address;
  return `${address.slice(0, lead)}…${address.slice(-tail)}`;
}

/**
 * Base units in, a figure a person can read out. Amounts are integers everywhere they are stored,
 * sent or signed — only the last step before a human eye converts them, so no rounding ever
 * reaches the money itself.
 */
export function scrt(base: string | bigint | number): string {
  return `${trimTrailingZeros(fromBaseUnits(String(base)))} SCRT`;
}

export function sscrt(base: string | bigint | number): string {
  return `${trimTrailingZeros(fromBaseUnits(String(base)))} sSCRT`;
}

function trimTrailingZeros(value: string): string {
  return value.includes(".") ? value.replace(/0+$/, "").replace(/\.$/, "") : value;
}
