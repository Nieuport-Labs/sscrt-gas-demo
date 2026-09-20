// Runs one scenario end to end and reports what actually happened on chain, not what the
// provider said would happen.
//
// The shape of this changed with the move to gas credits. The provider used to sponsor every
// transaction, so every run went through it and most scenarios were about what could be smuggled
// into a bundle it was paying for. Now there are three paths and only one of them touches the
// provider at all:
//
//   warm      — enough credits. Sign, set fee.granter to the vault, send. No server.
//   draining  — low. Refill from the wallet's own sSCRT first, then send. Still no server.
//   cold      — nothing to pay gas with. Only here does the provider get involved, and only to
//               sell the first credits.
//
// What has not changed is that measurement beats narration: /submit reports what the provider
// quoted, not what the chain charged, so every run reads the balance and the vault allowance
// itself, before and after.
import { MsgExecuteContract } from "secretjs";
import type { Msg, Permit } from "secretjs";
import { config, PROVIDER_PERMIT_TTL_SECONDS } from "./config";
import {
  getSscrtCodeHash,
  newProviderPermitName,
  queryGrantRemainingUscrt,
  querySscrtBalance,
  revokePermitMessages,
  signExpiringPermit,
  GAS_REVOKE_PERMIT,
  type Connection,
} from "./secret";
import { clearPendingRevokes, pendingRevokes } from "./pendingRevokes";
import {
  GAS_PRICE_USCRT,
  GAS_TOPUP,
  nativeBalance,
  queryRemaining,
  readCreditStatus,
  refillAmount,
  topUpGasCredits,
  type CreditStatus,
} from "./gasCredits";
import { DEFAULT_TOKEN, GAS_TOKEN } from "./tokens";
import { providerApi, type QuoteResult } from "./provider";
import { SCENARIOS_BY_ID, type ScenarioId } from "./scenarios";
import { scrt, sscrt } from "./format";

/** Gas for one SNIP-20 transfer, with headroom. Cosmos charges the limit, not the usage. */
const GAS_TRANSFER = 150_000;

export type StepLevel = "info" | "ok" | "warn" | "error";

export interface RunStep {
  at: string;
  level: StepLevel;
  text: string;
}

export type Verdict = "as_expected" | "vulnerable" | "known_tradeoff" | "inconclusive" | "error";

export interface RunMeasurement {
  /** How much sSCRT actually left the wallet. */
  sscrtSpent: string;
  /** What it should have been. */
  sscrtExpected: string | null;
  /** Gas credits at the vault before and after, or null when they could not be read. */
  creditsBeforeUscrt: string | null;
  creditsAfterUscrt: string | null;
  /** Whether the provider was involved at all. On the warm path it is not. */
  providerUsed: boolean;
}

export interface RunResult {
  id: string;
  scenario: ScenarioId;
  startedAt: string;
  finishedAt: string | null;
  steps: RunStep[];
  txHash: string | null;
  txCode: number | null;
  verdict: Verdict;
  verdictText: string;
  measurement: RunMeasurement | null;
}

export interface RunOptions {
  connection: Connection;
  permit: Permit;
  providerAddress: string;
  recipient: string;
  /** base units of the transfer the user is making */
  amountBase: string;
  scenario: ScenarioId;
  onUpdate: (result: RunResult) => void;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The quote's own message, ready to sign as it is.
 *
 * secretjs treats `Msg` structurally — it only ever calls toProto()/toAmino() and, for the proto
 * form, encode() — so a plain object carrying the server's bytes is a valid message to sign. That
 * matters because the alternative, rebuilding it locally, re-encrypts with a fresh nonce: the
 * plaintext would be identical and the bytes would not, and /submit compares bytes.
 *
 * This is what an honest client should do. It cannot deviate from the quote even by accident.
 */
function quotedMessages(quote: QuoteResult): Msg[] {
  return quote.protoMessages.map((proto, index) => ({
    toProto: async () => ({
      type_url: proto.typeUrl,
      value: null,
      encode: () => fromBase64(proto.bytes),
    }),
    toAmino: async () => quote.messages[index] as never,
  }));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The provider's quote TTL (QUOTE_TTL_SECONDS, 45s by default) plus a margin. */
const QUOTE_TTL_WAIT_MS = 52_000;

interface Ctx {
  connection: Connection;
  permit: Permit;
  providerAddress: string;
  recipient: string;
  amountBase: string;
  codeHash: string;
  log: (level: StepLevel, text: string) => void;
  finish: (verdict: Verdict, text: string) => RunResult;
  result: RunResult;
  creditsBefore: string | null;
  balanceBefore: string;
}

export async function runScenario(options: RunOptions): Promise<RunResult> {
  const { connection, permit, providerAddress, recipient, amountBase, scenario, onUpdate } = options;

  const result: RunResult = {
    id: `${scenario}-${Date.now()}`,
    scenario,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    steps: [],
    txHash: null,
    txCode: null,
    verdict: "inconclusive",
    verdictText: "",
    measurement: null,
  };

  const log = (level: StepLevel, text: string) => {
    result.steps.push({ at: new Date().toISOString(), level, text });
    onUpdate({ ...result, steps: [...result.steps] });
  };

  const finish = (verdict: Verdict, verdictText: string): RunResult => {
    result.finishedAt = new Date().toISOString();
    result.verdict = verdict;
    result.verdictText = verdictText;
    onUpdate({ ...result, steps: [...result.steps] });
    return result;
  };

  try {
    const codeHash = await getSscrtCodeHash();
    const balanceBefore = await querySscrtBalance(permit);
    const creditsBefore = await queryRemaining(connection.address);
    log(
      "info",
      `zůstatek ${sscrt(balanceBefore)}, gas credits ` +
        `${creditsBefore === null ? "nelze přečíst" : scrt(creditsBefore)}`,
    );

    const ctx: Ctx = {
      connection,
      permit,
      providerAddress,
      recipient,
      amountBase,
      codeHash,
      log,
      finish,
      result,
      creditsBefore,
      balanceBefore,
    };

    switch (scenario) {
      case "honest":
        return await runHonest(ctx);
      case "no_payment":
      case "underpay":
      case "redirect_payment":
        return await runDeviantPurchase(ctx, scenario);
      case "expired_quote":
        return await runExpiredQuote(ctx);
      case "replay":
        return await runReplay(ctx);
      case "sequence_race":
        return await runSequenceRace(ctx);
      case "quote_flood":
        return await runQuoteFlood(ctx);
      case "refill":
        return await runRefill(ctx, false);
      case "refill_boundary":
        return await runRefill(ctx, true);
      case "steal_bootstrap":
        return await runStealBootstrap(ctx);
      case "double_onboard":
        return await runDoubleOnboard(ctx);
      case "topup_foreign_grantee":
        return await runForeignTopUp(ctx);
      default:
        return finish("error", `neznámý scénář: ${scenario}`);
    }
  } catch (err) {
    log("error", (err as Error).message);
    return finish("error", `běh skončil výjimkou: ${(err as Error).message}`);
  }
}

// --- the honest path -------------------------------------------------------------------------

async function runHonest(ctx: Ctx): Promise<RunResult> {
  const gas = await ensureGas(ctx);
  if (gas.blocked) return ctx.finish("error", gas.blocked);

  // Any permit the provider was given rides out with this transaction. One signature, one fee,
  // a little more gas — which is the only reason it can be automatic at all.
  const toRevoke = pendingRevokes(ctx.connection.address);
  if (toRevoke.length > 0) {
    ctx.log("info", `zároveň odvolávám ${toRevoke.length} permit providera — jede to v téže transakci`);
  }

  ctx.log("info", "odesílám převod, poplatek platí gas vault");
  const tx = await ctx.connection.client.tx.broadcast(
    [
      new MsgExecuteContract({
        sender: ctx.connection.address,
        contract_address: DEFAULT_TOKEN.contract,
        code_hash: ctx.codeHash,
        msg: { transfer: { recipient: ctx.recipient, amount: ctx.amountBase } },
      }),
      ...revokePermitMessages(ctx.connection, ctx.codeHash, toRevoke),
    ],
    {
      gasLimit: GAS_TRANSFER + GAS_REVOKE_PERMIT * toRevoke.length,
      gasPriceInFeeDenom: GAS_PRICE_USCRT,
      feeDenom: "uscrt",
      feeGranter: config.gasVaultAddress,
    },
  );

  // Only once it is on chain. A failed transaction leaves them queued for the next one, which is
  // the whole reason the list is not cleared optimistically.
  if (tx.code === 0 && toRevoke.length > 0) {
    clearPendingRevokes(ctx.connection.address, toRevoke);
    ctx.log("ok", "permit providera je odvolaný v kontraktu — už tvůj zůstatek nepřečte");
  }

  ctx.result.txHash = tx.transactionHash;
  ctx.result.txCode = tx.code;
  ctx.log(tx.code === 0 ? "ok" : "error", tx.code === 0 ? "transakce prošla" : `transakce selhala (code ${tx.code})`);

  await measure(ctx, gas.providerUsed);

  if (tx.code !== 0) return ctx.finish("error", `transakce selhala: ${tx.rawLog.slice(0, 200)}`);

  const spent = BigInt(ctx.result.measurement?.sscrtSpent ?? "0");
  const expected = BigInt(ctx.amountBase);
  if (spent !== expected) {
    return ctx.finish(
      "inconclusive",
      `z účtu odešlo ${sscrt(spent.toString())}, samotný převod byl ${sscrt(expected.toString())} — ` +
        "rozdíl je to, co v tomhle běhu stály kredity.",
    );
  }
  return ctx.finish(
    "as_expected",
    gas.providerUsed
      ? "Provider prodal první kredity, převod pak proběhl přímo proti vaultu."
      : "Převod proběhl bez providera — poplatek zaplatil gas vault.",
  );
}

/**
 * Get the wallet into a state where it can pay for a transaction, and say how.
 *
 * This is the whole decision the app has to make, and the answer is usually "nothing to do".
 */
async function ensureGas(ctx: Ctx): Promise<{ blocked?: string; providerUsed: boolean }> {
  const status = await readCreditStatus(ctx.connection.address);
  ctx.log("info", describeCreditState(status));

  if (status.state === "unknown") {
    return {
      blocked:
        "vault nedokázal přečíst zůstatek kreditů. To není totéž jako nula, takže se radši nic " +
        "nekupuje — zkus to za chvíli znovu.",
      providerUsed: false,
    };
  }

  if (status.state === "warm") return { providerUsed: false };

  if (status.state === "draining") {
    const amount = refillAmount(status, ctx.balanceBefore);
    if (amount <= 0n) return { blocked: "na dobití kreditů nezbývá dost sSCRT.", providerUsed: false };

    ctx.log("info", `dobíjím kredity o ${scrt(amount.toString())} — bez providera, přímo přes vault`);
    const tx = await topUpGasCredits(
      ctx.connection.client,
      ctx.connection.address,
      amount.toString(),
      ctx.codeHash,
    );
    if (tx.code !== 0) {
      return {
        blocked: `dobití kreditů selhalo (code ${tx.code}): ${tx.rawLog.slice(0, 200)}`,
        providerUsed: false,
      };
    }
    ctx.log("ok", "kredity dobity");
    return { providerUsed: false };
  }

  ctx.log("warn", "žádné kredity ani SCRT — tohle je jediný případ, kdy se volá provider");
  const failure = await buyFirstCredits(ctx);
  return failure ? { blocked: failure, providerUsed: true } : { providerUsed: true };
}

function describeCreditState(status: CreditStatus): string {
  switch (status.state) {
    case "warm":
      return `kreditů dost (${scrt(status.remainingUscrt ?? "0")}) — provider se nepoužije`;
    case "draining":
      return `kreditů málo (${scrt(status.remainingUscrt ?? "0")}) — dobiju si je sám`;
    case "cold":
      return "žádné kredity a žádný SCRT";
    default:
      return "vault neodpověděl na dotaz na zůstatek kreditů";
  }
}

/** The cold start. Returns an error string, or undefined when the credits arrived. */
async function buyFirstCredits(ctx: Ctx): Promise<string | undefined> {
  // A permit of its own, and one that dies on its own. Not the one this app reads the balance
  // with: the expiry is per permit, so a shared one could not be taken from the provider without
  // blinding the app too.
  const permitName = newProviderPermitName();
  const minutes = Math.round(PROVIDER_PERMIT_TTL_SECONDS / 60);
  ctx.log(
    "info",
    `podepisuji permit pro providera s platností ${minutes} min — potřebuje ověřit, že platba projde`,
  );
  const providerPermit = await signExpiringPermit(
    ctx.connection.address,
    permitName,
    PROVIDER_PERMIT_TTL_SECONDS,
  );

  const onboard = await providerApi.onboard(ctx.connection.address, providerPermit);
  if (!onboard.ok) return `provider tuhle adresu nepřijal: ${onboard.error} — ${onboard.message}`;
  ctx.log(
    "info",
    `provider prodá ${scrt(onboard.data.creditsUscrt)} kreditů za ${sscrt(onboard.data.creditPriceSscrt)}`,
  );

  // Buy what the onboarding said this wallet can afford, not the advertised size. A wallet that
  // has only ever been paid privately in sSCRT may hold less than a full purchase, and sending
  // it away to buy more sSCRT is the one thing this is supposed to avoid.
  const quote = await providerApi.purchaseQuote(
    ctx.connection.address,
    ctx.connection.pubkeyBase64,
    onboard.data.creditsUscrt,
  );
  if (!quote.ok) return `provider odmítl kvótu: ${quote.error} — ${quote.message}`;
  ctx.log("info", `kvóta ${quote.data.quoteId.slice(0, 8)}, platba ${sscrt(quote.data.sscrtPaymentAmount)}`);

  const signed = await signQuoted(ctx, quote.data, quotedMessages(quote.data));
  const submitted = await providerApi.submit(quote.data.quoteId, signed);
  if (!submitted.ok) return `provider odmítl podepsanou transakci: ${submitted.error} — ${submitted.message}`;

  ctx.result.txHash = submitted.data.txHash;
  if (submitted.data.code !== 0) return `platba selhala (code ${submitted.data.code})`;
  ctx.log("ok", `zaplaceno, ${sscrt(submitted.data.sscrtReceived)} providerovi`);

  if (submitted.data.delivery === "delivered") {
    ctx.log("ok", `kredity dorazily: ${scrt(submitted.data.creditsUscrt)}`);
    return undefined;
  }

  // Delivery is the provider's own second transaction, so there is a real gap to wait across.
  ctx.log("info", "čekám, až provider dodá kredity (dělá to vlastní transakcí)");
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(3000);
    const state = await providerApi.purchaseStatus(quote.data.quoteId);
    if (!state.ok) continue;
    if (state.data.state === "delivered") {
      ctx.log("ok", `kredity dorazily: ${scrt(submitted.data.creditsUscrt)}`);
      return undefined;
    }
    if (state.data.state === "failed" || state.data.state === "needs_review") {
      return (
        `provider platbu přijal, ale kredity nedodal (${state.data.state}): ` +
        `${state.data.lastError ?? "bez bližšího důvodu"}`
      );
    }
  }
  return (
    "provider platbu přijal, ale kredity zatím nedorazily. Doklad o zaplacení máš on-chain; " +
    "zkus to za chvíli znovu."
  );
}

// --- deviations from the purchase quote --------------------------------------------------------

async function runDeviantPurchase(ctx: Ctx, scenario: ScenarioId): Promise<RunResult> {
  const onboard = await providerApi.onboard(ctx.connection.address, ctx.permit);
  if (!onboard.ok) return ctx.finish("error", `onboarding selhal: ${onboard.error} — ${onboard.message}`);

  const quote = await providerApi.purchaseQuote(ctx.connection.address, ctx.connection.pubkeyBase64);
  if (!quote.ok) return judgeRejection(ctx, scenario, quote.error, quote.message);
  ctx.log("info", `kvóta na ${scrt(quote.data.creditsUscrt)} kreditů za ${sscrt(quote.data.sscrtPaymentAmount)}`);

  // Rebuilt locally on purpose. That alone changes the ciphertext, so byte-equality catches it
  // before the amount or the recipient even matter — which is the point being demonstrated.
  const deviant = deviantPayment(ctx, scenario, quote.data);
  ctx.log("warn", deviant.description);

  const signed = await signQuoted(ctx, quote.data, [deviant.message]);
  const submitted = await providerApi.submit(quote.data.quoteId, signed);
  if (!submitted.ok) return judgeRejection(ctx, scenario, submitted.error, submitted.message);

  ctx.result.txHash = submitted.data.txHash;
  ctx.result.txCode = submitted.data.code;
  await measure(ctx, true);
  return ctx.finish(
    "vulnerable",
    "Provider transakci přijal, přestože neodpovídala kvótě. Tohle měla zachytit byte-equality kontrola.",
  );
}

function deviantPayment(
  ctx: Ctx,
  scenario: ScenarioId,
  quote: QuoteResult,
): { message: Msg; description: string } {
  const build = (recipient: string, amount: string) =>
    new MsgExecuteContract({
      sender: ctx.connection.address,
      contract_address: GAS_TOKEN.contract,
      code_hash: ctx.codeHash,
      msg: { transfer: { recipient, amount } },
    });

  switch (scenario) {
    case "no_payment":
      return {
        message: build(ctx.connection.address, "1"),
        description: "místo platby providerovi podepisuji 1 usSCRT sám sobě",
      };
    case "underpay":
      return {
        message: build(ctx.providerAddress, "1"),
        description: `místo ${sscrt(quote.sscrtPaymentAmount)} podepisuji 1 usSCRT`,
      };
    default:
      return {
        message: build(ctx.connection.address, quote.sscrtPaymentAmount),
        description: "správná částka, ale příjemcem jsem já, ne provider",
      };
  }
}

// --- guards ------------------------------------------------------------------------------------

async function runExpiredQuote(ctx: Ctx): Promise<RunResult> {
  const quote = await providerApi.purchaseQuote(ctx.connection.address, ctx.connection.pubkeyBase64);
  if (!quote.ok) return judgeRejection(ctx, "expired_quote", quote.error, quote.message);

  const signed = await signQuoted(ctx, quote.data, quotedMessages(quote.data));
  ctx.log("info", `čekám ${Math.round(QUOTE_TTL_WAIT_MS / 1000)} s, než kvóta propadne`);
  await sleep(QUOTE_TTL_WAIT_MS);

  const submitted = await providerApi.submit(quote.data.quoteId, signed);
  if (!submitted.ok) return judgeRejection(ctx, "expired_quote", submitted.error, submitted.message);
  ctx.result.txHash = submitted.data.txHash;
  return ctx.finish("vulnerable", "Provider přijal propadlou kvótu.");
}

async function runReplay(ctx: Ctx): Promise<RunResult> {
  const quote = await providerApi.purchaseQuote(ctx.connection.address, ctx.connection.pubkeyBase64);
  if (!quote.ok) return judgeRejection(ctx, "replay", quote.error, quote.message);

  const signed = await signQuoted(ctx, quote.data, quotedMessages(quote.data));
  const first = await providerApi.submit(quote.data.quoteId, signed);
  if (!first.ok) return judgeRejection(ctx, "replay", first.error, first.message);
  ctx.result.txHash = first.data.txHash;
  ctx.result.txCode = first.data.code;
  ctx.log("ok", "první odeslání prošlo");

  const second = await providerApi.submit(quote.data.quoteId, signed);
  await measure(ctx, true);
  if (!second.ok) {
    ctx.log("ok", `druhé odmítnuto: ${second.error}`);
    return ctx.finish("as_expected", `Opakované odeslání odmítnuto (${second.error}).`);
  }
  return ctx.finish("vulnerable", "Tytéž podepsané bajty prošly dvakrát.");
}

async function runSequenceRace(ctx: Ctx): Promise<RunResult> {
  const first = await providerApi.purchaseQuote(ctx.connection.address, ctx.connection.pubkeyBase64);
  const second = await providerApi.purchaseQuote(ctx.connection.address, ctx.connection.pubkeyBase64);
  if (!first.ok) return judgeRejection(ctx, "sequence_race", first.error, first.message);
  if (!second.ok) return judgeRejection(ctx, "sequence_race", second.error, second.message);
  ctx.log("info", `dvě kvóty na sekvenci ${first.data.sequence} a ${second.data.sequence}`);

  const signedA = await signQuoted(ctx, first.data, quotedMessages(first.data));
  const signedB = await signQuoted(ctx, second.data, quotedMessages(second.data));

  const resultA = await providerApi.submit(first.data.quoteId, signedA);
  if (!resultA.ok) return judgeRejection(ctx, "sequence_race", resultA.error, resultA.message);
  ctx.result.txHash = resultA.data.txHash;
  ctx.result.txCode = resultA.data.code;
  ctx.log("ok", "první prošla");

  const resultB = await providerApi.submit(second.data.quoteId, signedB);
  await measure(ctx, true);
  if (!resultB.ok) {
    ctx.log("ok", `druhá odmítnuta: ${resultB.error}`);
    return ctx.finish("as_expected", `Druhá kvóta odmítnuta (${resultB.error}).`);
  }
  return ctx.finish("vulnerable", "Obě kvóty na stejné sekvenci prošly.");
}

async function runQuoteFlood(ctx: Ctx): Promise<RunResult> {
  let limited = 0;
  for (let i = 0; i < 15; i++) {
    const quote = await providerApi.purchaseQuote(ctx.connection.address, ctx.connection.pubkeyBase64);
    if (!quote.ok && quote.status === 429) limited += 1;
  }
  ctx.log(limited > 0 ? "ok" : "warn", `z 15 žádostí bylo ${limited} odmítnuto rate limiterem`);
  return limited > 0
    ? ctx.finish("as_expected", `Rate limiter zabral (${limited} z 15 na 429).`)
    : ctx.finish("vulnerable", "Patnáct kvót za sebou prošlo bez omezení.");
}

/**
 * The two chain assumptions the refill rests on, measured rather than reasoned about.
 *
 *   1. The second message spends coins the first produced. Messages in a Cosmos transaction run
 *      in order against one cached store, so they should be there — but "should" is not a basis
 *      for shipping a refill that strands a wallet when it is wrong.
 *
 *   2. A transaction may revoke and re-grant the allowance paying its own fee. The vault tops up
 *      by revoke-then-grant, and the fee is taken in the ante handler before any message runs.
 *
 * `boundary` goes after the nastier half of the second one: when the fee takes the allowance to
 * exactly zero, the chain deletes the grant mid-transaction and the vault has to tell "no grant"
 * apart from "could not ask". Reaching that needs no privileged access at all — Cosmos charges
 * the gas limit rather than the usage, and the limit is the sender's to choose, so setting it to
 * what is left drains the allowance to the uscrt.
 */
async function runRefill(ctx: Ctx, boundary: boolean): Promise<RunResult> {
  const status = await readCreditStatus(ctx.connection.address);
  if (status.state === "unknown") {
    return ctx.finish("error", "vault neodpověděl na dotaz na zůstatek kreditů — zkus to za chvíli.");
  }
  if (status.remainingUscrt === null || BigInt(status.remainingUscrt) === 0n) {
    return ctx.finish("error", "na tohle potřebuješ nějaké kredity — nejdřív pošli poctivý převod.");
  }

  const remaining = BigInt(status.remainingUscrt);
  const amount = BigInt(ctx.amountBase);
  if (amount > BigInt(ctx.balanceBefore)) {
    return ctx.finish("error", "na dobití o zadanou částku nemáš dost sSCRT.");
  }

  // Cosmos charges the limit, so the limit is the fee. For the boundary case, make it exactly
  // what is left; otherwise leave the usual headroom.
  const gasLimit = boundary ? Math.floor(Number(remaining) / GAS_PRICE_USCRT) : GAS_TOPUP;
  const feeUscrt = BigInt(Math.ceil(gasLimit * GAS_PRICE_USCRT));

  if (boundary && gasLimit < 400_000) {
    return ctx.finish(
      "error",
      `zbývá ${scrt(remaining.toString())} kreditů, což vystačí jen na ${gasLimit} gasu — na tuhle ` +
        "transakci je potřeba zhruba 700 000. Nejdřív kredity utrať, nebo je nech klesnout.",
    );
  }

  const nativeBefore = await nativeBalance(ctx.connection.address);
  ctx.log(
    "info",
    `kredity ${scrt(remaining.toString())}, dobíjím o ${sscrt(amount.toString())} ` +
      `s gas limitem ${gasLimit} (poplatek ${scrt(feeUscrt.toString())})`,
  );

  const tx = await topUpGasCredits(
    ctx.connection.client,
    ctx.connection.address,
    amount.toString(),
    ctx.codeHash,
    ctx.connection.address,
    gasLimit,
  );
  ctx.result.txHash = tx.transactionHash;
  ctx.result.txCode = tx.code;
  ctx.log("info", `gas_used ${tx.gasUsed} z ${gasLimit} nakvótovaných`);

  await measure(ctx, false);

  if (tx.code !== 0) {
    return ctx.finish(
      "vulnerable",
      `Transakce selhala (code ${tx.code}): ${tx.rawLog.slice(0, 200)}. Dobíjení nemůže být jedna ` +
        "transakce — musí se rozdělit a práh přepočítat.",
    );
  }

  const after = await queryRemaining(ctx.connection.address);
  if (after === null) {
    return ctx.finish("inconclusive", "transakce prošla, ale vault pak neodpověděl na dotaz na zůstatek.");
  }

  // The allowance should be what was there, less the fee the ante handler took, plus what was
  // just paid in. The boundary case lands at exactly the top-up, because the remainder was zero
  // and the grant was gone by the time the vault ran.
  const expected = remaining - feeUscrt + amount;
  const nativeAfter = await nativeBalance(ctx.connection.address);

  if (BigInt(after) !== expected) {
    return ctx.finish(
      "vulnerable",
      `Allowance je ${scrt(after)}, čekalo se ${scrt(expected.toString())}. Revoke-and-grant se ` +
        "nesečetl s odečtením poplatku tak, jak dobíjení předpokládá.",
    );
  }

  // Not "must be zero" but "must not have moved": the redeem adds native SCRT and the vault
  // message spends it, so a wallet that already held some is fine — a changed balance is not.
  if (nativeAfter !== nativeBefore) {
    return ctx.finish(
      "vulnerable",
      `Nativní zůstatek se změnil z ${scrt(nativeBefore)} na ${scrt(nativeAfter)} — druhá zpráva ` +
        "neutratila přesně to, co vydala první.",
    );
  }

  return ctx.finish(
    "as_expected",
    boundary
      ? `Prošlo i na hraně: poplatek ${scrt(feeUscrt.toString())} vyčerpal allowance na nulu, chain ` +
        `grant během transakce smazal a vault udělil nový na ${scrt(after)}. Skutečný gas: ${tx.gasUsed}.`
      : `Allowance sedí na uscrt (${scrt(after)}) a nativní zůstatek se nehnul — obě zprávy i ` +
        `revoke-and-grant drží. Skutečný gas: ${tx.gasUsed} z ${gasLimit}.`,
  );
}

async function runStealBootstrap(ctx: Ctx): Promise<RunResult> {
  const onboard = await providerApi.onboard(ctx.connection.address, ctx.permit);
  if (!onboard.ok) return ctx.finish("error", `onboarding selhal: ${onboard.message}`);

  const first = await providerApi.purchaseQuote(ctx.connection.address, ctx.connection.pubkeyBase64);
  if (!first.ok) return judgeRejection(ctx, "steal_bootstrap", first.error, first.message);
  const afterFirst = await queryGrantRemainingUscrt(ctx.providerAddress, ctx.connection.address);
  ctx.log("info", `po první kvótě má provider vydaný grant na ${scrt(afterFirst ?? "0")}`);

  // Walk away without signing, then come back. A second grant here would mean the provider can be
  // billed once per request rather than once per address.
  const second = await providerApi.purchaseQuote(ctx.connection.address, ctx.connection.pubkeyBase64);
  if (!second.ok) {
    ctx.log("ok", `druhá kvóta odmítnuta: ${second.error}`);
    return ctx.finish("as_expected", `Druhá kvóta odmítnuta (${second.error}), žádný druhý grant.`);
  }
  const afterSecond = await queryGrantRemainingUscrt(ctx.providerAddress, ctx.connection.address);
  ctx.log("info", `po druhé kvótě ${scrt(afterSecond ?? "0")}`);

  if (afterSecond === afterFirst) {
    return ctx.finish(
      "as_expected",
      "Druhá kvóta znovu použila už vydaný grant — provider za ni nic nezaplatil.",
    );
  }
  return ctx.finish(
    "vulnerable",
    `Grant se po druhé kvótě změnil z ${scrt(afterFirst ?? "0")} na ${scrt(afterSecond ?? "0")} — ` +
      "provider platí za každou žádost, ne za adresu.",
  );
}

async function runDoubleOnboard(ctx: Ctx): Promise<RunResult> {
  const first = await providerApi.onboard(ctx.connection.address, ctx.permit);
  const second = await providerApi.onboard(ctx.connection.address, ctx.permit);
  if (!first.ok) return ctx.finish("error", `první onboarding selhal: ${first.message}`);
  if (!second.ok) {
    ctx.log("ok", `druhý odmítnut: ${second.error}`);
    return ctx.finish("as_expected", `Druhý onboarding odmítnut (${second.error}).`);
  }
  ctx.log("ok", "oba prošly a vrátily totéž");
  return ctx.finish(
    "as_expected",
    "Onboarding nic neutrácí a nic nevydává — druhý jen přepsal uložený permit, což nikomu nic nedává.",
  );
}

async function runForeignTopUp(ctx: Ctx): Promise<RunResult> {
  const status = await readCreditStatus(ctx.connection.address);
  if (status.state === "cold" || status.state === "unknown") {
    return ctx.finish("error", "na tohle potřebuješ vlastní kredity — nejdřív pošli poctivý převod.");
  }

  // The provider's own address stands in for "somebody else": it certainly exists, and it can
  // use the credits, so nothing is stranded by the test.
  const grantee = ctx.providerAddress;
  const amount = "100000"; // 0.1 SCRT — enough to prove the mechanism, small enough not to matter
  ctx.log("info", `dobíjím ${scrt(amount)} kreditů adrese ${grantee.slice(0, 12)}… z vlastního sSCRT`);

  const tx = await topUpGasCredits(
    ctx.connection.client,
    ctx.connection.address,
    amount,
    ctx.codeHash,
    grantee,
  );
  ctx.result.txHash = tx.transactionHash;
  ctx.result.txCode = tx.code;
  await measure(ctx, false);

  if (tx.code !== 0) return ctx.finish("error", `nepovedlo se: ${tx.rawLog.slice(0, 200)}`);
  return ctx.finish(
    "known_tradeoff",
    "Prošlo, a je to záměr: vault umožňuje koupit kredity komukoli. Platí se z vlastního sSCRT, " +
      "takže se tím nedá nic získat na cizí účet — jen zaplatit někomu jinému gas.",
  );
}

// --- shared --------------------------------------------------------------------------------

async function signQuoted(ctx: Ctx, quote: QuoteResult, messages: Msg[]): Promise<string> {
  const bytes = await ctx.connection.client.tx.signTx(messages, {
    gasLimit: quote.gasLimit,
    gasPriceInFeeDenom: Number(quote.feeAmountUscrt) / quote.gasLimit,
    feeDenom: "uscrt",
    feeGranter: quote.feeGranter,
    explicitSignerData: {
      accountNumber: quote.accountNumber,
      sequence: quote.sequence,
      chainId: config.chainId,
    },
  });
  return toBase64(bytes);
}

async function measure(ctx: Ctx, providerUsed: boolean): Promise<void> {
  const balanceAfter = await querySscrtBalance(ctx.permit);
  const creditsAfter = await queryRemaining(ctx.connection.address);
  ctx.result.measurement = {
    sscrtSpent: (BigInt(ctx.balanceBefore) - BigInt(balanceAfter)).toString(),
    sscrtExpected: ctx.amountBase,
    creditsBeforeUscrt: ctx.creditsBefore,
    creditsAfterUscrt: creditsAfter,
    providerUsed,
  };
  ctx.log(
    "info",
    `z účtu odešlo ${sscrt(ctx.result.measurement.sscrtSpent)}, kredity ` +
      `${scrt(ctx.creditsBefore ?? "0")} → ${scrt(creditsAfter ?? "0")}`,
  );
}

/**
 * A refusal is only a pass when refusing was the point.
 *
 * A server that is down, or answering with something that is not JSON, refuses everything — and
 * counting that as "the guard worked" is how a broken endpoint gets recorded as a passing test.
 */
function judgeRejection(ctx: Ctx, scenario: ScenarioId, error: string, message: string): RunResult {
  ctx.log("warn", `${error}: ${message}`);

  if (["unreachable", "bad_response", "submit_failed", "not_broadcast", "quote_failed"].includes(error)) {
    return ctx.finish("error", `provider neodpověděl použitelně (${error}): ${message}`);
  }

  const kind = SCENARIOS_BY_ID[scenario].kind;
  if (kind === "guard" || kind === "probe") {
    return ctx.finish("as_expected", `Provider odmítl: ${error}.`);
  }
  return ctx.finish("error", `Provider odmítl i poctivý průběh: ${error} — ${message}`);
}
