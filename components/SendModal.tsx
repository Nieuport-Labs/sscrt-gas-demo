"use client";

import { useState } from "react";
import { ArrowUpDown } from "lucide-react";
import { Modal } from "./Modal";
import { formatTokenAmount, formatUsd, toBaseUnits } from "@/lib/format";
import { SCENARIOS, SCENARIOS_BY_ID, type ScenarioId } from "@/lib/scenarios";
import type { CreditStatus } from "@/lib/gasCredits";

export function SendModal(props: {
  balance: string | null;
  priceUsd: number | null;
  /** Where the gas is coming from. Decides how many signatures this will take. */
  credits: CreditStatus | null;
  /** The scenario picker is a developer tool and stays out of the way unless it is switched on. */
  devMode: boolean;
  onClose: () => void;
  onSend: (recipient: string, amountBase: string, scenario: ScenarioId) => void;
}) {
  const [recipient, setRecipient] = useState("");
  // Always the amount in sSCRT, whichever unit is on screen. Only one of the two can be the
  // source of truth, and it has to be the one a transaction is built from.
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState<"token" | "usd">("token");
  const [scenario, setScenario] = useState<ScenarioId>("honest");

  const priceKnown = props.priceUsd !== null && props.priceUsd > 0;
  const amountBase = toBaseUnits(amount);
  const tokenAmount = Number(amount || "0");
  const usdAmount = priceKnown ? tokenAmount * (props.priceUsd as number) : null;

  const recipientTrimmed = recipient.trim();
  const recipientValid = /^secret1[0-9a-z]{38}$/.test(recipientTrimmed);
  const overBalance = amountBase !== null && props.balance !== null && BigInt(amountBase) > BigInt(props.balance);
  const malformed = amount !== "" && amountBase === null;

  const onTyped = (raw: string) => {
    const cleaned = raw.replace(/[^0-9.]/g, "");
    if (unit === "token" || !priceKnown) {
      setAmount(cleaned);
      return;
    }
    // Typed in dollars: convert once, here, and keep the token figure as the stored value.
    const usd = Number(cleaned || "0");
    setAmount(cleaned === "" ? "" : (usd / (props.priceUsd as number)).toFixed(6));
  };

  const shown = unit === "token" ? amount : amount === "" ? "" : (usdAmount ?? 0).toFixed(2);

  let ctaLabel = "Odeslat";
  let ctaReady = true;
  if (!amountBase || amountBase === "0") {
    ctaLabel = "Zadej částku";
    ctaReady = false;
  } else if (overBalance) {
    ctaLabel = "Nedostatečný zůstatek";
    ctaReady = false;
  } else if (!recipientValid) {
    ctaLabel = "Zadej adresu příjemce";
    ctaReady = false;
  } else if (scenario !== "honest") {
    ctaLabel = "Spustit scénář";
  } else if (props.credits?.state === "draining") {
    // Two signatures, not one. Saying so up front is the difference between a second Keplr
    // prompt being expected and it looking like something went wrong.
    ctaLabel = "Dobít kredity a odeslat";
  } else if (props.credits?.state === "cold") {
    ctaLabel = "Koupit kredity a odeslat";
  }

  const selected = SCENARIOS_BY_ID[scenario];

  return (
    <Modal title="Odeslat sSCRT" onClose={props.onClose}>
      <div className="send-panel">
        <div className="top">
          <div className="send-label">Odesíláš</div>

          <div className="send-amount">
            {unit === "usd" && <span className="sigil">$</span>}
            <input
              inputMode="decimal"
              placeholder="0"
              value={shown}
              onChange={(event) => onTyped(event.target.value)}
              aria-label={unit === "usd" ? "Částka v dolarech" : "Částka v sSCRT"}
              autoFocus
            />
          </div>

          <div className="send-secondary">
            <button
              type="button"
              onClick={() => setUnit(unit === "token" ? "usd" : "token")}
              disabled={!priceKnown}
              title={priceKnown ? "Přepnout jednotku" : "Kurz se nepodařilo načíst"}
            >
              {unit === "token"
                ? usdAmount === null
                  ? "kurz nedostupný"
                  : formatUsd(usdAmount)
                : `${tokenAmount.toFixed(6)} sSCRT`}
              {priceKnown && <ArrowUpDown />}
            </button>
          </div>
        </div>

        {/* No chevron and nothing to open: there is one token here, and a control that looks like a
            picker but never picks anything is worse than no control. */}
        <div className="send-token">
          <span className="coin">sS</span>
          <span className="sym">sSCRT</span>
          <span className="bal">
            {props.balance !== null ? (
              <>
                {formatTokenAmount(props.balance)}
                <br />
                zůstatek
              </>
            ) : (
              "—"
            )}
          </span>
        </div>
      </div>

      <div className={`send-to${recipientTrimmed && !recipientValid ? " invalid" : ""}`}>
        <label htmlFor="send-recipient">Komu</label>
        <input
          id="send-recipient"
          placeholder="secret1…"
          spellCheck={false}
          autoComplete="off"
          value={recipient}
          onChange={(event) => setRecipient(event.target.value)}
        />
      </div>

      {recipientTrimmed && !recipientValid && (
        <p className="send-error">Tohle nevypadá jako platná secret adresa.</p>
      )}
      {malformed && <p className="send-error">Nejvýš šest desetinných míst.</p>}

      <button
        className="btn primary cta"
        disabled={!ctaReady}
        onClick={() => amountBase && props.onSend(recipientTrimmed, amountBase, scenario)}
      >
        {ctaLabel}
      </button>

      {props.credits?.state === "cold" && scenario === "honest" && (
        <p className="note">
          Nemáš čím zaplatit poplatek, takže si první gas credits koupíš u providera — jediná
          chvíle, kdy je v cestě. Přečte si přitom tvůj zůstatek sSCRT, aby věděl, že platba
          projde.
        </p>
      )}
      {props.credits?.state === "draining" && scenario === "honest" && (
        <p className="note">
          Kredity docházejí, takže se nejdřív dobijí z tvého sSCRT. Jde to přímo přes kontrakt,
          provider u toho není — Keplr se zeptá dvakrát.
        </p>
      )}

      {props.devMode && (
        <div className="dev-block">
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="send-scenario">Scénář (dev)</label>
            <select
              id="send-scenario"
              value={scenario}
              onChange={(event) => setScenario(event.target.value as ScenarioId)}
            >
              {SCENARIOS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.title}
                </option>
              ))}
            </select>
            <div className="hint">
              {selected?.what}
              <br />
              <em>Očekávání: {selected?.expected}</em>
              {selected?.note && (
                <>
                  <br />
                  <strong>{selected.note}</strong>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
