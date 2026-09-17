"use client";

import { useState } from "react";
import { formatTokenAmount, formatUsd, shortenAddress, toBaseUnits } from "@/lib/format";

export interface SendCardProps {
  address: string | null;
  balance: string | null;
  priceUsd: number | null;
  /** the amount as typed, always in sSCRT (not base units) */
  amount: string;
  onAmountChange: (value: string) => void;
  recipient: string;
  onRecipientChange: (value: string) => void;
  onSubmit: () => void;
  ctaLabel: string;
  ctaDisabled: boolean;
  busy: boolean;
  footnote?: string | null;
}

export function SendCard(props: SendCardProps) {
  const { address, balance, priceUsd, amount, recipient } = props;
  // The reference design leads with a fiat figure and keeps the token amount underneath. Both
  // are editable; only the token amount ever reaches a transaction.
  const [mode, setMode] = useState<"usd" | "token">("token");

  const tokenAmount = Number(amount || "0");
  const usdAmount = priceUsd === null ? null : tokenAmount * priceUsd;

  const handleBigInput = (raw: string) => {
    const cleaned = raw.replace(/[^0-9.]/g, "");
    if (mode === "token" || priceUsd === null || priceUsd === 0) {
      props.onAmountChange(cleaned);
      return;
    }
    const usd = Number(cleaned || "0");
    props.onAmountChange(cleaned === "" ? "" : (usd / priceUsd).toFixed(6));
  };

  const bigValue =
    mode === "token" ? amount : amount === "" ? "" : ((usdAmount ?? 0) as number).toFixed(2);

  const recipientLooksWrong = recipient !== "" && !/^secret1[0-9a-z]{38}$/.test(recipient.trim());

  return (
    <div className="card">
      <div className="card-head">
        <h2>Odeslat sSCRT</h2>
        <span className="pill">gas v sSCRT</span>
      </div>

      <div className="card-body">
        <div className="amount-panel">
          <div className="amount-label">Odesíláš</div>

          <div className="amount-row">
            {mode === "usd" && <span className="amount-currency">$</span>}
            <input
              className="amount-input"
              inputMode="decimal"
              placeholder="0"
              value={bigValue}
              onChange={(e) => handleBigInput(e.target.value)}
              aria-label={mode === "usd" ? "Částka v dolarech" : "Částka v sSCRT"}
            />
          </div>

          <div className="amount-secondary">
            <button
              type="button"
              className="icon-btn"
              onClick={() => setMode(mode === "usd" ? "token" : "usd")}
              disabled={priceUsd === null}
              title={priceUsd === null ? "Kurz se nepodařilo načíst" : "Přepnout jednotku"}
            >
              {mode === "token"
                ? usdAmount === null
                  ? "kurz nedostupný"
                  : `${formatUsd(usdAmount)} ⇅`
                : `${tokenAmount.toFixed(6)} sSCRT ⇅`}
            </button>
          </div>

          <div className="token-row">
            <span className="token-mark">sS</span>
            <span className="token-name">sSCRT</span>
            <span className="token-balance">
              {balance === null ? (
                "zůstatek skrytý"
              ) : (
                <>
                  {formatTokenAmount(balance)} sSCRT
                  {priceUsd !== null && (
                    <>
                      <br />
                      {formatUsd(Number(balance) / 1e6 * priceUsd)}
                    </>
                  )}
                </>
              )}
            </span>
          </div>
        </div>

        <div className={`field${recipientLooksWrong ? " invalid" : ""}`}>
          <label htmlFor="recipient">Komu</label>
          <input
            id="recipient"
            placeholder="secret1…"
            spellCheck={false}
            value={recipient}
            onChange={(e) => props.onRecipientChange(e.target.value)}
          />
        </div>
        {recipientLooksWrong && (
          <p className="hint" style={{ color: "var(--danger)" }}>
            Tohle nevypadá jako platná secret adresa.
          </p>
        )}

        <button
          className={`btn${props.ctaDisabled ? "" : " primary"}`}
          disabled={props.ctaDisabled || props.busy}
          onClick={props.onSubmit}
        >
          {props.busy ? "Probíhá…" : props.ctaLabel}
        </button>

        {props.footnote && <p className="hint">{props.footnote}</p>}

        {address && (
          <p className="hint mono" title={address}>
            {shortenAddress(address, 14, 8)}
          </p>
        )}
      </div>
    </div>
  );
}

export { toBaseUnits };
