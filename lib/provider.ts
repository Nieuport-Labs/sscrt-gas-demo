// HTTP client for the gas provider service (onboard / quote / submit, plus its public /status).
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
  config: {
    feeMarkupPercent: number;
    autoUnwrap: { enabled: boolean; thresholdUscrt: string };
  };
}

export interface OnboardResult {
  grantTxHash: string;
  grantedTo: string;
  spendLimitUscrt: string;
  expiresAt: string;
}

export interface WireMessage {
  typeUrl: string;
  value: unknown;
}

export interface QuoteResult {
  quoteId: string;
  messages: unknown[];
  gasLimit: number;
  feeAmountUscrt: string;
  feeGranter: string;
  sscrtPaymentAmount: string;
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
  quote: (address: string, pubkeyBase64: string, messages: WireMessage[]) =>
    call<QuoteResult>("/quote", { address, pubkeyBase64, messages }),
  submit: (quoteId: string, signedTxBytes: string) => call<SubmitResult>("/submit", { quoteId, signedTxBytes }),
};
