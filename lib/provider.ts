// HTTP client for the gas provider service.
//
// The provider is only in the path of a cold start: a wallet holding sSCRT and nothing else
// cannot buy its first gas credit, because buying costs gas. Once it has credits it refills
// itself from the vault and none of this is called again.
//
// Every call returns a result object instead of throwing. The point of this app is to observe
// how the provider responds — including when it refuses — so an HTTP 402 or 409 is data, not an
// exception to be swallowed by a catch block somewhere up the stack.
import type { Permit } from "secretjs";
import { config } from "./config";

export type ApiResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; message: string };

export interface ProviderStatus {
  setupRequired: boolean;
  providerAddress: string | null;
  walletConfigured: boolean;
  chainId: string;
  sscrtContract: string;
  /** Where credits come from. Empty means this provider is not selling any. */
  gasVaultAddress: string;
  /** What one purchase costs and buys, or null when nothing is for sale. */
  creditsForSale: { creditsUscrt: string; priceSscrt: string; markupPercent: number } | null;
  config: {
    feeMarkupPercent: number;
    autoUnwrap: { enabled: boolean; thresholdUscrt: string };
  };
}

export interface OnboardResult {
  address: string;
  /** What one purchase of gas credits costs, in sSCRT base units. */
  creditPriceSscrt: string;
  /** What it buys, in uscrt of fee allowance. */
  creditsUscrt: string;
  sscrtBalance: string;
  gasVaultAddress: string;
}

export interface QuoteResult {
  quoteId: string;
  messages: unknown[];
  /** The same messages, protobuf-encoded and base64'd. /submit compares the signed transaction
   * against these byte for byte, so an honest client signs exactly what it was handed. */
  protoMessages: { typeUrl: string; bytes: string }[];
  gasLimit: number;
  feeAmountUscrt: string;
  feeGranter: string;
  /** What the buyer pays, in sSCRT base units. */
  sscrtPaymentAmount: string;
  /** What they get, in uscrt of fee allowance from the vault. */
  creditsUscrt: string;
  /** The vault that will hold it — what this wallet names as `fee.granter` from then on. */
  gasVaultAddress: string;
  accountNumber: number;
  sequence: number;
  expiresAt: string;
}

export interface SubmitResult {
  txHash: string;
  code: number;
  rawLog: string;
  nativeFeeSpentUscrt: string;
  sscrtReceived: string;
  creditsUscrt: string;
  /** Delivery is a second transaction the provider signs, so it can still be pending here. */
  delivery: "delivered" | "pending";
}

export interface PurchaseStatus {
  quoteId: string;
  state: "delivered" | "paid" | "delivering" | "failed" | "needs_review" | "unknown";
  creditsUscrt: string | null;
  lastError: string | null;
}

async function call<T>(path: string, body?: unknown): Promise<ApiResult<T>> {
  let resp: Response;
  try {
    resp = await fetch(`${config.providerUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    // A CORS rejection and a provider that is simply down are indistinguishable from here —
    // the browser reports both as a bare TypeError with no status.
    return {
      ok: false,
      status: 0,
      error: "unreachable",
      message: `could not reach the provider at ${config.providerUrl}: ${(err as Error).message}`,
    };
  }

  const text = await resp.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      status: resp.status,
      error: "bad_response",
      message: `provider returned non-JSON (HTTP ${resp.status}): ${text.slice(0, 200)}`,
    };
  }

  if (!resp.ok) {
    const body = parsed as { error?: string; message?: string };
    return {
      ok: false,
      status: resp.status,
      error: body.error ?? `http_${resp.status}`,
      message: body.message ?? text.slice(0, 200),
    };
  }
  return { ok: true, status: resp.status, data: parsed as T };
}

export const providerApi = {
  status: () => call<ProviderStatus>("/status"),
  onboard: (address: string, permit: Permit) => call<OnboardResult>("/onboard", { address, permit }),
  /**
   * A quote for one purchase of gas credits. No messages are sent: the provider builds the
   * whole transaction, which is why it no longer needs to see anything the user is doing.
   */
  purchaseQuote: (address: string, pubkeyBase64: string, creditAmountUscrt?: string) =>
    call<QuoteResult>("/purchase/quote", { address, pubkeyBase64, creditAmountUscrt }),
  submit: (quoteId: string, signedTxBytes: string) => call<SubmitResult>("/submit", { quoteId, signedTxBytes }),
  /** Credits arrive in the provider's own second transaction, so this is worth polling. */
  purchaseStatus: (quoteId: string) => call<PurchaseStatus>(`/purchase/${quoteId}`),
};
