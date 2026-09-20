"use client";

import { Modal } from "./Modal";
import { config, PROVIDER_PERMIT_TTL_SECONDS } from "@/lib/config";
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
        <strong>Zůstatek sSCRT, a jen po dobu nákupu prvních kreditů.</strong> Než na tebe utratí
        vlastní gas, potřebuje vědět, že platba nepropadne — a zůstatek je privátní, takže si ho
        přečte permitem.
      </p>
      <p className="note">
        <strong>Ten permit dostane vlastní a platí {Math.round(PROVIDER_PERMIT_TTL_SECONDS / 60)}{" "}
        minut.</strong> Pak ho kontrakt přestane uznávat, ať už si ho server smazal nebo ne. Doba
        platnosti je součástí toho, co podepisuješ, takže ji nejde prodloužit — změna podpis
        zneplatní. Není to slib, je to vlastnost.
      </p>
      <p className="note">
        <strong>Historii transakcí ne.</strong> Permit je omezený na dotaz „balance“ a kontrakt
        historii bez oprávnění „history“ odmítne. Komu posíláš a kolik je navíc uvnitř
        zašifrované zprávy, kterou server nikdy nevidí — ty transakce podepisuješ sám proti
        vaultu a server v nich nefiguruje.
      </p>
      <p className="note">
        <strong>Pozor ale: gas credits samy o sobě veřejné jsou.</strong> Fee grant je běžný
        stav řetězce, ne stav kontraktu, takže leží mimo soukromí Secretu. Kdokoli si může
        vypsat <em>všechny</em> uživatele tohohle vaultu i s jejich zbývajícím kreditem
        (<span className="mono">/cosmos/feegrant/v1beta1/issued/{config.gasVaultAddress.slice(0, 12)}…</span>)
        a sledováním toho čísla vyčíst, kdy a jak často odesíláš. Částky ani příjemce z toho
        nevyčte. Není to o providerovi — vidí to úplně každý, a platit poplatek vlastním SCRT
        by tě do takového seznamu nedalo.
      </p>
      <p className="note">
        Permit níž je <strong>jiný</strong> — ten, kterým tenhle prohlížeč čte tvůj zůstatek.
        Nikam se neposílá a expiraci nemá, protože ho appka potřebuje pořád. Odvolat ho jde
        v kontraktu; zapomenutí smaže jen kopii tady.
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
