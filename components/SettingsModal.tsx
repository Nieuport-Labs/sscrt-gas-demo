"use client";

import { Modal } from "./Modal";
import { config } from "@/lib/config";
import { scrt, sscrt } from "@/lib/format";
import type { ProviderStatus } from "@/lib/provider";
import type { CreditStatus } from "@/lib/gasCredits";
import { SCENARIOS } from "@/lib/scenarios";

export function SettingsModal(props: {
  status: ProviderStatus | null;
  statusError: string | null;
  creditPriceSscrt: string | null;
  credits: CreditStatus | null;
  devMode: boolean;
  onDevModeChange: (value: boolean) => void;
  onForgetPermit: () => void;
  onRevokePermit: () => void;
  onClose: () => void;
}) {
  const { status } = props;

  return (
    <Modal
      title="Nastavení"
      onClose={props.onClose}
      footer={
        <button className="btn primary" onClick={props.onClose}>
          Hotovo
        </button>
      }
    >
      <div className="field">
        <label className="check">
          <input
            type="checkbox"
            checked={props.devMode}
            onChange={(event) => props.onDevModeChange(event.target.checked)}
          />
          <span>
            <strong>Dev mode</strong>
            <br />
            <span className="hint">
              Přidá do okna odesílání výběr z {SCENARIOS.length} scénářů, včetně útoků na providera.
              Ty posílají skutečné transakce na {config.chainId} a stojí skutečné peníze — tebe
              i providera.
            </span>
          </span>
        </label>
      </div>

      <h2 style={{ marginTop: "1.25rem" }}>Připojení</h2>
      <table className="kv">
        <tbody>
          <tr>
            <td>Provider</td>
            <td className="mono" style={{ overflowWrap: "anywhere" }}>
              {config.providerUrl}
              <br />
              <span style={{ color: props.statusError ? "var(--err)" : "var(--ok)" }}>
                {props.statusError ?? (status ? "online" : "…")}
              </span>
            </td>
          </tr>
          <tr>
            <td>Síť</td>
            <td className="mono">{status?.chainId ?? config.chainId}</td>
          </tr>
          <tr>
            <td>LCD</td>
            <td className="mono" style={{ overflowWrap: "anywhere" }}>
              {config.lcdUrl}
            </td>
          </tr>
          <tr>
            <td>sSCRT</td>
            <td className="mono" style={{ overflowWrap: "anywhere" }}>
              {status?.sscrtContract ?? config.sscrtContract}
            </td>
          </tr>
          <tr>
            <td>Gas vault</td>
            <td className="mono" style={{ overflowWrap: "anywhere" }}>
              {config.gasVaultAddress}
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Gas credits</h2>
      <p className="note" style={{ marginTop: 0 }}>
        Kredit je předplacený poplatek: zaplatíš SCRT do kontraktu a ten ti vydá fee grant ve
        stejné výši. <strong>Zpátky se nevybírají</strong> — odejdou jedině jako gas. Proto tu
        aplikace nedrží víc než {scrt(config.creditTargetUscrt)}.
      </p>
      <table className="kv">
        <tbody>
          <tr>
            <td>Zbývá</td>
            <td>
              {/* Not connected, and "could not ask", are both unknown. Neither is zero, and
                  printing zero for either is the exact mistake the vault's own reply is
                  careful to avoid. */}
              {props.credits === null
                ? "—"
                : props.credits.state === "unknown"
                  ? "vault neodpověděl — to není nula"
                  : scrt(props.credits.remainingUscrt ?? "0")}
            </td>
          </tr>
          <tr>
            <td>Dobíjí se</td>
            <td>
              pod {scrt(config.creditFloorUscrt)} na {scrt(config.creditTargetUscrt)}
              <br />
              <span className="hint">
                Sama, z tvého sSCRT, jednou transakcí. Provider u toho není.
              </span>
            </td>
          </tr>
          <tr>
            <td>První kredity od providera</td>
            <td>
              {props.creditPriceSscrt && status?.creditsForSale
                ? `${scrt(status.creditsForSale.creditsUscrt)} za ${sscrt(props.creditPriceSscrt)}`
                : "—"}
              <br />
              <span className="hint">
                Marže {status ? `${status.config.feeMarkupPercent} %` : "—"}. Platí se jen když
                nemáš čím zaplatit gas; jinak se provider nepoužije vůbec.
              </span>
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Co o tobě provider ví</h2>
      <p className="note" style={{ marginTop: 0 }}>
        <strong>Zůstatek sSCRT, a jenom při nákupu prvních kreditů.</strong> Než na tebe utratí
        vlastní gas, potřebuje vědět, že platba nepropadne — a zůstatek je privátní, takže si ho
        přečte permitem. Jakmile kredity dodá, permit maže.
      </p>
      <p className="note">
        <strong>Co nevidí:</strong> komu posíláš a kolik. Ty transakce podepisuješ sám proti
        vaultu a server v nich nefiguruje. Vidět je jen to, co je stejně veřejné na chainu —
        adresa, čas a zaplacený poplatek.
      </p>
      <p className="note">
        <strong>Smazání permitu na serveru je slib, ne důkaz.</strong> SNIP-24 permit nemá
        expiraci: dokud ho neodvoláš v kontraktu, podpis platí a kdokoli s jeho kopií si tvůj
        zůstatek přečte. Odvolání stojí gas — což je právě to, co ti kredity umožňují zaplatit.
      </p>
      <div style={{ display: "flex", gap: "0.6rem", flexWrap: "wrap" }}>
        <button className="btn" onClick={props.onForgetPermit}>
          Zapomenout v prohlížeči
        </button>
        <button className="btn primary" onClick={props.onRevokePermit}>
          Odvolat v kontraktu
        </button>
      </div>
    </Modal>
  );
}
