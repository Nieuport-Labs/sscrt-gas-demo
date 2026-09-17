// Runs one scenario end to end and reports what actually happened on chain, not what the
// provider said would happen.
//
// The distinction matters. /submit's response reports `sscrtReceived` as the amount the provider
// *quoted*, on the assumption that a transaction with code 0 paid it — which is exactly the
// assumption several of these scenarios exist to test. So every run measures two things itself,
// from public or permit-readable state, before and after:
//
//   - the user's sSCRT balance, which shows what was really transferred and to whom;
//   - the fee grant's remaining spend limit, which shows what the provider was really charged.
//
// Everything else in a result is narration.
import { MsgExecuteContract } from "secretjs";
import type { Permit } from "secretjs";
import { config, MSG_EXECUTE_CONTRACT_TYPE_URL } from "./config";
import { getSscrtCodeHash, querySscrtBalance, queryGrantRemainingUscrt, type Connection } from "./secret";
import { providerApi, type QuoteResult, type WireMessage } from "./provider";
import type { ScenarioId } from "./scenarios";

/** A mainnet contract the provider is very unlikely to have whitelisted. Never actually called —
 * the whitelist check happens before the quote does any work, so this address is only ever a
 * string in a rejected request. */
const UNWHITELISTED_CONTRACT = "secret1qfql357amn448duf5gvp9gr48sxx9tsnhupu3d";

export type StepLevel = "info" | "ok" | "warn" | "error";

export interface RunStep {
  at: string;
  level: StepLevel;
  text: string;
}

export type Verdict = "as_expected" | "vulnerable" | "known_tradeoff" | "inconclusive" | "error";

export interface RunMeasurement {
  /** How much sSCRT actually left the user's balance. */
  sscrtSpent: string;
  /** What it should have been on the honest path: transfer amount + quoted payment. */
  sscrtExpected: string | null;
  /** How much native SCRT the provider's grant really covered. */
  grantSpentUscrt: string | null;
  /** What the provider quoted that fee at. */
  quotedFeeUscrt: string | null;
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
  /** base units of the transfer the user is nominally making */
  amountBase: string;
  scenario: ScenarioId;
  onUpdate: (result: RunResult) => void;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The provider's quote TTL (QUOTE_TTL_SECONDS, 45s by default) plus a margin. */
const QUOTE_TTL_WAIT_MS = 52_000;

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
    verdictText: "running",
    measurement: null,
  };

  const log = (text: string, level: StepLevel = "info") => {
    result.steps = [...result.steps, { at: new Date().toISOString(), level, text }];
    onUpdate({ ...result });
  };
  const finish = (verdict: Verdict, verdictText: string): RunResult => {
    result.verdict = verdict;
    result.verdictText = verdictText;
    result.finishedAt = new Date().toISOString();
    onUpdate({ ...result });
    return result;
  };

  try {
    const codeHash = await getSscrtCodeHash();

    // --- Scenarios that never reach a signature -------------------------------------------

    if (scenario === "unwhitelisted_contract") {
      log(`žádám kvótu na volání ${UNWHITELISTED_CONTRACT}`);
      const quote = await providerApi.quote(connection.address, connection.pubkeyBase64, [
        {
          typeUrl: MSG_EXECUTE_CONTRACT_TYPE_URL,
          value: {
            sender: connection.address,
            contract_address: UNWHITELISTED_CONTRACT,
            code_hash: codeHash,
            msg: { transfer: { recipient, amount: "1" } },
          },
        },
      ]);
      if (quote.ok) {
        log("kvóta vydána — whitelist kontraktů neplatí", "error");
        return finish("vulnerable", "Provider nakvótoval volání kontraktu, který nemá na whitelistu.");
      }
      log(
        `HTTP ${quote.status} ${quote.error}: ${quote.message}`,
        quote.error === "contract_not_allowed" ? "ok" : "warn",
      );
      return quote.error === "contract_not_allowed"
        ? finish("as_expected", "Odmítnuto s contract_not_allowed, přesně jak má být.")
        : finish("inconclusive", `Odmítnuto, ale jiným důvodem: ${quote.error}.`);
    }

    if (scenario === "quote_flood") {
      log("posílám 15 žádostí o kvótu bez prodlevy");
      const action = buildActionWire(connection.address, codeHash, recipient, "1");
      let firstLimitedAt: number | null = null;
      for (let i = 1; i <= 15; i++) {
        const quote = await providerApi.quote(connection.address, connection.pubkeyBase64, [action]);
        if (!quote.ok && quote.status === 429) {
          firstLimitedAt = i;
          log(`žádost ${i}: HTTP 429 ${quote.message}`, "ok");
          break;
        }
        log(`žádost ${i}: ${quote.ok ? "kvóta vydána" : `HTTP ${quote.status} ${quote.error}`}`);
      }
      return firstLimitedAt === null
        ? finish("vulnerable", "15 kvót za sebou prošlo bez jediného 429 — rate limiting nezabral.")
        : finish("as_expected", `Rate limiter zabral u ${firstLimitedAt}. žádosti.`);
    }

    // --- The standard path ------------------------------------------------------------------

    const balanceBefore = await querySscrtBalance(permit);
    const grantBefore = await queryGrantRemainingUscrt(providerAddress, connection.address);
    log(`zůstatek před: ${balanceBefore} usSCRT, grant: ${grantBefore ?? "nezjištěn"} uscrt`);

    // The amount the action itself moves. `failing_action` deliberately asks for more than the
    // user owns, which the contract refuses at execution time — after the fee is already committed.
    const actionAmount =
      scenario === "failing_action" ? (BigInt(balanceBefore) + 1000000n).toString() : amountBase;

    const actionWire = buildActionWire(connection.address, codeHash, recipient, actionAmount);

    log("žádám o kvótu");
    const quoteResp = await providerApi.quote(connection.address, connection.pubkeyBase64, [actionWire]);
    if (!quoteResp.ok) {
      log(`HTTP ${quoteResp.status} ${quoteResp.error}: ${quoteResp.message}`, "error");
      return finish("error", `Kvóta neprošla: ${quoteResp.error} — ${quoteResp.message}`);
    }
    const quote = quoteResp.data;
    log(
      `kvóta ${quote.quoteId.slice(0, 8)}: gas ${quote.gasLimit}, poplatek ${quote.feeAmountUscrt} uscrt, ` +
        `platba ${quote.sscrtPaymentAmount} usSCRT, sequence ${quote.sequence}`,
      "ok",
    );

    const signed = await signForScenario(scenario, {
      connection,
      codeHash,
      actionAmount,
      recipient,
      quote,
      log,
    });

    // The one scenario that needs a second quote on the same sequence, signed before the first
    // one lands — the whole point is that both were built against a sequence only one can use.
    let secondSigned: { quoteId: string; bytes: string } | null = null;
    if (scenario === "sequence_race") {
      log("žádám o druhou kvótu na stejné sequence");
      const second = await providerApi.quote(connection.address, connection.pubkeyBase64, [actionWire]);
      if (!second.ok) {
        log(`druhá kvóta neprošla: HTTP ${second.status} ${second.error}`, "error");
        return finish("error", `Druhá kvóta neprošla: ${second.error}.`);
      }
      if (second.data.sequence !== quote.sequence) {
        log(`druhá kvóta má jinou sequence (${second.data.sequence}) — test by nic nedokázal`, "warn");
        return finish("inconclusive", "Obě kvóty nevyšly na stejné sequence number.");
      }
      log("podepisuji druhou kvótu (Keplr se zeptá znovu)");
      const bytes = await signBundle({
        connection,
        codeHash,
        actionAmount,
        recipient,
        paymentAmount: second.data.sscrtPaymentAmount,
        paymentRecipient: second.data.feeGranter,
        gasLimit: second.data.gasLimit,
        quote: second.data,
      });
      secondSigned = { quoteId: second.data.quoteId, bytes };
    }

    if (scenario === "expired_quote") {
      log(`čekám ${QUOTE_TTL_WAIT_MS / 1000} s, až kvóta propadne`);
      await sleep(QUOTE_TTL_WAIT_MS);
    }

    log("odesílám podepsanou transakci");
    const submitResp = await providerApi.submit(quote.quoteId, signed);

    if (!submitResp.ok) {
      log(`HTTP ${submitResp.status} ${submitResp.error}: ${submitResp.message}`, "warn");
      return judgeRejection(scenario, submitResp.error, finish);
    }

    result.txHash = submitResp.data.txHash;
    result.txCode = submitResp.data.code;
    log(
      `tx ${submitResp.data.txHash} · code ${submitResp.data.code}`,
      submitResp.data.code === 0 ? "ok" : "warn",
    );
    if (submitResp.data.code !== 0) log(submitResp.data.rawLog, "warn");

    if (scenario === "replay") {
      log("odesílám tytéž podepsané bajty podruhé");
      const replay = await providerApi.submit(quote.quoteId, signed);
      if (replay.ok) {
        log("druhé odeslání prošlo", "error");
        return finish("vulnerable", "Tatáž kvóta šla odeslat dvakrát.");
      }
      log(`HTTP ${replay.status} ${replay.error}: ${replay.message}`, "ok");
      return replay.error === "already_submitted"
        ? finish("as_expected", "Druhý pokus odmítnut s already_submitted.")
        : finish("inconclusive", `Odmítnuto jiným důvodem: ${replay.error}.`);
    }

    if (scenario === "sequence_race" && secondSigned) {
      log("odesílám druhou (souběžnou) transakci");
      const second = await providerApi.submit(secondSigned.quoteId, secondSigned.bytes);
      if (second.ok) {
        log(`druhá transakce prošla: code ${second.data.code}`, second.data.code === 0 ? "error" : "warn");
        return second.data.code === 0
          ? finish("vulnerable", "Obě transakce na stejné sequence prošly.")
          : finish("as_expected", "Druhou transakci zamítl řetězec na úrovni sekvence.");
      }
      log(`HTTP ${second.status} ${second.error}: ${second.message}`, "ok");
      return second.error === "sequence_changed"
        ? finish("as_expected", "Druhá transakce odmítnuta se sequence_changed, ještě před broadcastem.")
        : finish("inconclusive", `Odmítnuto jiným důvodem: ${second.error}.`);
    }

    // --- Measure, then judge ----------------------------------------------------------------

    const balanceAfter = await querySscrtBalance(permit);
    const grantAfter = await queryGrantRemainingUscrt(providerAddress, connection.address);
    const sscrtSpent = (BigInt(balanceBefore) - BigInt(balanceAfter)).toString();
    const grantSpent =
      grantBefore !== null && grantAfter !== null
        ? (BigInt(grantBefore) - BigInt(grantAfter)).toString()
        : null;

    result.measurement = {
      sscrtSpent,
      sscrtExpected: (BigInt(actionAmount) + BigInt(quote.sscrtPaymentAmount)).toString(),
      grantSpentUscrt: grantSpent,
      quotedFeeUscrt: quote.feeAmountUscrt,
    };
    log(
      `zůstatek po: ${balanceAfter} usSCRT (−${sscrtSpent}), grant čerpán o ${grantSpent ?? "?"} uscrt ` +
        `(nakvótováno ${quote.feeAmountUscrt})`,
    );

    return judgeOutcome(scenario, {
      code: submitResp.data.code,
      sscrtSpent,
      actionAmount,
      quotedPayment: quote.sscrtPaymentAmount,
      grantSpent,
      quotedFee: quote.feeAmountUscrt,
      finish,
    });
  } catch (err) {
    log((err as Error).message, "error");
    return finish("error", (err as Error).message);
  }
}

function buildActionWire(sender: string, codeHash: string, recipient: string, amount: string): WireMessage {
  return {
    typeUrl: MSG_EXECUTE_CONTRACT_TYPE_URL,
    value: {
      sender,
      contract_address: config.sscrtContract,
      code_hash: codeHash,
      msg: { transfer: { recipient, amount } },
    },
  };
}

interface SignBundleArgs {
  connection: Connection;
  codeHash: string;
  actionAmount: string;
  recipient: string;
  /** null omits the payment message entirely */
  paymentAmount: string | null;
  paymentRecipient: string;
  gasLimit: number;
  quote: QuoteResult;
}

async function signBundle(args: SignBundleArgs): Promise<string> {
  const { connection, codeHash, actionAmount, recipient, paymentAmount, paymentRecipient, gasLimit, quote } =
    args;

  const messages = [
    new MsgExecuteContract({
      sender: connection.address,
      contract_address: config.sscrtContract,
      code_hash: codeHash,
      msg: { transfer: { recipient, amount: actionAmount } },
    }),
  ];
  if (paymentAmount !== null) {
    messages.push(
      new MsgExecuteContract({
        sender: connection.address,
        contract_address: config.sscrtContract,
        code_hash: codeHash,
        msg: { transfer: { recipient: paymentRecipient, amount: paymentAmount } },
      }),
    );
  }

  const bytes = await connection.client.tx.signTx(messages, {
    gasLimit,
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

async function signForScenario(
  scenario: ScenarioId,
  ctx: {
    connection: Connection;
    codeHash: string;
    actionAmount: string;
    recipient: string;
    quote: QuoteResult;
    log: (text: string, level?: StepLevel) => void;
  },
): Promise<string> {
  const { quote, log } = ctx;

  // Each of these is one deviation from what the quote specified, applied to the bytes the user
  // signs — which is the only place a client can deviate at all, since the provider decides
  // everything else.
  let paymentAmount: string | null = quote.sscrtPaymentAmount;
  let paymentRecipient = quote.feeGranter;
  let gasLimit = quote.gasLimit;

  switch (scenario) {
    case "no_payment":
      paymentAmount = null;
      log("podepisuji bez platební zprávy", "warn");
      break;
    case "underpay":
      paymentAmount = "1";
      log(`podepisuji platbu 1 usSCRT místo ${quote.sscrtPaymentAmount}`, "warn");
      break;
    case "redirect_payment":
      paymentRecipient = ctx.connection.address;
      log("podepisuji platbu na vlastní adresu místo providerovy", "warn");
      break;
    case "inflate_gas":
      gasLimit = quote.gasLimit * 5;
      log(`podepisuji s gas limitem ${gasLimit} místo ${quote.gasLimit}`, "warn");
      break;
    case "low_gas":
      gasLimit = Math.floor(quote.gasLimit * 0.4);
      log(`podepisuji s gas limitem ${gasLimit} místo ${quote.gasLimit}`, "warn");
      break;
    default:
      log("podepisuji přesně nakvótované parametry");
  }

  return signBundle({
    connection: ctx.connection,
    codeHash: ctx.codeHash,
    actionAmount: ctx.actionAmount,
    recipient: ctx.recipient,
    paymentAmount,
    paymentRecipient,
    gasLimit,
    quote,
  });
}

/** A scenario whose /submit was refused outright. */
function judgeRejection(
  scenario: ScenarioId,
  error: string,
  finish: (verdict: Verdict, text: string) => RunResult,
): RunResult {
  if (scenario === "expired_quote") {
    return error === "expired"
      ? finish("as_expected", "Propadlá kvóta odmítnuta s expired.")
      : finish("inconclusive", `Odmítnuto jiným důvodem než expired: ${error}.`);
  }
  // For a probe, a refusal is the good outcome — the provider caught the deviation.
  return finish("as_expected", `Provider odmítl: ${error}.`);
}

function judgeOutcome(
  scenario: ScenarioId,
  m: {
    code: number;
    sscrtSpent: string;
    actionAmount: string;
    quotedPayment: string;
    grantSpent: string | null;
    quotedFee: string;
    finish: (verdict: Verdict, text: string) => RunResult;
  },
): RunResult {
  const { code, sscrtSpent, actionAmount, quotedPayment, grantSpent, quotedFee, finish } = m;
  const spent = BigInt(sscrtSpent);
  const expectedHonest = BigInt(actionAmount) + BigInt(quotedPayment);
  const providerPaid = grantSpent !== null ? BigInt(grantSpent) : null;

  switch (scenario) {
    case "honest":
      if (code !== 0) return finish("error", `Poctivý převod selhal s code ${code}.`);
      return spent === expectedHonest
        ? finish("as_expected", `Převedeno ${actionAmount} + zaplaceno ${quotedPayment} usSCRT za gas.`)
        : finish(
            "inconclusive",
            `Zůstatek klesl o ${sscrtSpent}, čekáno ${expectedHonest}. Zkontroluj transakci ručně.`,
          );

    case "no_payment":
    case "redirect_payment":
      if (code !== 0) return finish("as_expected", `Řetězec transakci odmítl (code ${code}).`);
      return finish(
        "vulnerable",
        `Transakce prošla a provider nedostal nic. Zaplatil ${providerPaid ?? quotedFee} uscrt z grantu.`,
      );

    case "underpay":
      if (code !== 0) return finish("as_expected", `Řetězec transakci odmítl (code ${code}).`);
      return finish(
        "vulnerable",
        `Prošlo s platbou 1 usSCRT místo ${quotedPayment}. Provider zaplatil ${providerPaid ?? quotedFee} uscrt.`,
      );

    case "inflate_gas": {
      if (code !== 0) return finish("as_expected", `Řetězec transakci odmítl (code ${code}).`);
      if (providerPaid !== null && providerPaid > BigInt(quotedFee)) {
        return finish(
          "vulnerable",
          `Provider zaplatil ${providerPaid} uscrt místo nakvótovaných ${quotedFee}, a dostal jen ${quotedPayment} usSCRT.`,
        );
      }
      return finish("inconclusive", "Transakce prošla, ale čerpání grantu se nepodařilo změřit.");
    }

    case "low_gas":
    case "failing_action":
      if (code === 0) {
        return finish("inconclusive", "Transakce nečekaně prošla — scénář nedokázal, co měl.");
      }
      return finish(
        "known_tradeoff",
        `Transakce selhala (code ${code}), platba se vrátila zpět, ale provider přišel o ` +
          `${providerPaid ?? quotedFee} uscrt. Tohle je vlastnost feegrantu, ne chyba serveru: ` +
          `poplatek se strhává v ante fázi, než se zpráva vůbec spustí.`,
      );

    default:
      return finish("inconclusive", `Scénář doběhl s code ${code}.`);
  }
}
