"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDownLeft, ArrowUpRight, FlaskConical, Settings } from "lucide-react";
import type { Permit } from "secretjs";
import { Modal } from "@/components/Modal";
import { ProgressModal } from "@/components/ProgressModal";
import { ReceiveModal } from "@/components/ReceiveModal";
import { SendModal } from "@/components/SendModal";
import { SettingsModal } from "@/components/SettingsModal";
import { WalletMenu } from "@/components/WalletMenu";
import { config } from "@/lib/config";
import { formatTokenAmount, formatUsd, scrt } from "@/lib/format";
import { providerApi, type ProviderStatus } from "@/lib/provider";
import { readCreditStatus, type CreditStatus } from "@/lib/gasCredits";
import { runScenario, type RunResult } from "@/lib/runner";
import type { ScenarioId } from "@/lib/scenarios";
import {
  connectKeplr,
  getSscrtCodeHash,
  querySscrtBalance,
  revokeBalancePermit,
  signBalancePermit,
  type Connection,
} from "@/lib/secret";

/** A permit is a signature over fixed terms, so it stays valid until the user revokes it — worth
 * keeping so a reload doesn't mean another Keplr prompt. It grants read access to one balance
 * and nothing else. */
const permitKey = (address: string) => `sscrt-gas-demo:permit:${config.chainId}:${address}`;
const DEV_MODE_KEY = "sscrt-gas-demo:devMode";

type Dialog = "send" | "receive" | "settings" | null;

export default function Home() {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [priceUsd, setPriceUsd] = useState<number | null>(null);

  const [connection, setConnection] = useState<Connection | null>(null);
  const [permit, setPermit] = useState<Permit | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [creditPrice, setCreditPrice] = useState<string | null>(null);
  const [credits, setCredits] = useState<CreditStatus | null>(null);
  const [onboardError, setOnboardError] = useState<string | null>(null);

  const [dialog, setDialog] = useState<Dialog>(null);
  const [run, setRun] = useState<RunResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devMode, setDevMode] = useState(false);

  useEffect(() => {
    try {
      setDevMode(window.localStorage.getItem(DEV_MODE_KEY) === "true");
    } catch {
      // Private mode, blocked storage: dev mode simply stays off, which is the safe default.
    }
  }, []);

  const changeDevMode = (value: boolean) => {
    setDevMode(value);
    try {
      window.localStorage.setItem(DEV_MODE_KEY, String(value));
    } catch {
      /* not worth surfacing */
    }
  };

  // --- provider status + price ---------------------------------------------------------------

  useEffect(() => {
    providerApi.status().then((result) => {
      if (result.ok) {
        setStatus(result.data);
        setStatusError(null);
      } else {
        setStatusError(`${result.error}: ${result.message}`);
      }
    });
  }, []);

  useEffect(() => {
    const load = () =>
      fetch("/api/price")
        .then((r) => r.json())
        .then((body) => setPriceUsd(typeof body.usd === "number" ? body.usd : null))
        .catch(() => setPriceUsd(null));
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, []);

  // --- wallet --------------------------------------------------------------------------------

  const refreshBalance = useCallback(async (activePermit: Permit) => {
    try {
      setBalance(await querySscrtBalance(activePermit));
    } catch (err) {
      setError(`nepodařilo se přečíst zůstatek: ${(err as Error).message}`);
    }
  }, []);

  // Gas credits are public — a fee allowance and a bank balance are on chain in the clear — so
  // reading them needs no permit and does not involve the provider at all.
  const refreshCredits = useCallback(async (address: string) => {
    try {
      setCredits(await readCreditStatus(address));
    } catch {
      // A vault that cannot be reached is not the same as no credits, and guessing either way
      // is worse than the dash the UI shows instead.
      setCredits(null);
    }
  }, []);

  // Asked only so the price can be shown before anyone commits to anything. The provider is not
  // involved again unless the wallet turns out to be cold.
  const loadCreditPrice = useCallback(async (address: string, activePermit: Permit) => {
    const result = await providerApi.onboard(address, activePermit);
    if (result.ok) {
      setCreditPrice(result.data.creditPriceSscrt);
      setOnboardError(null);
    } else {
      setCreditPrice(null);
      setOnboardError(result.message);
    }
  }, []);

  const connect = async () => {
    setError(null);
    setBusy(true);
    try {
      const conn = await connectKeplr();
      setConnection(conn);

      const stored = window.localStorage.getItem(permitKey(conn.address));
      if (stored) {
        const parsed = JSON.parse(stored) as Permit;
        setPermit(parsed);
        await refreshBalance(parsed);
        await refreshCredits(conn.address);
        await loadCreditPrice(conn.address, parsed);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const unlockBalance = async () => {
    if (!connection) return;
    setError(null);
    setBusy(true);
    try {
      const signed = await signBalancePermit(connection.address, connection.client);
      window.localStorage.setItem(permitKey(connection.address), JSON.stringify(signed));
      setPermit(signed);
      await refreshBalance(signed);
      await refreshCredits(connection.address);
      await loadCreditPrice(connection.address, signed);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /** Forgets the session in this tab only. Keplr keeps its own approval, and the permit stays in
   * storage so reconnecting does not mean signing again. */
  const disconnect = () => {
    setConnection(null);
    setPermit(null);
    setBalance(null);
    setCreditPrice(null);
    setCredits(null);
    setOnboardError(null);
    setDialog(null);
  };

  const forgetPermit = () => {
    if (connection) window.localStorage.removeItem(permitKey(connection.address));
    setPermit(null);
    setBalance(null);
    setCreditPrice(null);
    setDialog(null);
  };

  /**
   * The version of "forget my permit" that does not rely on anyone keeping a promise.
   *
   * Forgetting deletes copies. Revoking tells the contract to stop honouring the signature, so
   * neither this app nor the provider can use it again whatever either of them kept. It needs
   * gas, which is exactly what gas credits are for.
   */
  const revokePermit = async () => {
    if (!connection) return;
    setError(null);
    setBusy(true);
    try {
      const result = await revokeBalancePermit(connection, await getSscrtCodeHash());
      if (result.code !== 0) throw new Error(`kontrakt permit neodvolal (code ${result.code}): ${result.rawLog}`);
      forgetPermit();
    } catch (err) {
      setError(`odvolání permitu selhalo: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // --- sending -------------------------------------------------------------------------------

  const send = async (recipient: string, amountBase: string, scenario: ScenarioId) => {
    if (!connection || !permit || !status?.providerAddress) return;
    setError(null);
    setDialog(null);
    setBusy(true);

    try {
      await runScenario({
        connection,
        permit,
        providerAddress: status.providerAddress,
        recipient,
        amountBase,
        scenario,
        onUpdate: setRun,
      });
      await refreshBalance(permit);
      await refreshCredits(connection.address);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // --- render --------------------------------------------------------------------------------

  const providerOnline = Boolean(status?.providerAddress);
  const usdValue = balance !== null && priceUsd !== null ? (Number(balance) / 1e6) * priceUsd : null;
  const canTransact = Boolean(connection && permit && providerOnline);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="mark">sS</div>
          <div>
            <div className="name">sSCRT Gas</div>
            <div className="sub">poplatky v sSCRT</div>
          </div>
        </div>

        <div className="spacer" />

        {devMode && (
          <span className="status dev" title="Dev mode — v okně odesílání jde vybrat útočný scénář">
            <FlaskConical />
            dev
          </span>
        )}

        <span className="status" title={statusError ?? config.providerUrl}>
          <span className={`dot${providerOnline ? "" : status ? " warn" : " err"}`} />
          {providerOnline ? "provider" : status ? "bez peněženky" : "nedostupný"}
        </span>

        {connection ? (
          <WalletMenu
            address={connection.address}
            onSettings={() => setDialog("settings")}
            onDisconnect={disconnect}
          />
        ) : (
          <>
            <button className="btn primary" onClick={connect} disabled={busy}>
              Připojit Keplr
            </button>
            <button className="icon-btn" onClick={() => setDialog("settings")} aria-label="Nastavení">
              <Settings />
            </button>
          </>
        )}
      </header>

      <main>
        <div className="balance">
          <div className="label">Zůstatek</div>
          {balance !== null ? (
            <>
              <div className="amount">
                {formatTokenAmount(balance)}
                <span className="unit">sSCRT</span>
              </div>
              {usdValue !== null && <div className="fiat">{formatUsd(usdValue)}</div>}
              {credits && (
                <div className="fiat" title="Předplacený gas. Dobíjí se sám ze sSCRT, dokud je z čeho.">
                  {credits.state === "unknown"
                    ? "gas: vault neodpověděl"
                    : `gas na ${scrt(credits.remainingUscrt ?? "0")}`}
                  {credits.state === "cold" && " — první kredity koupí provider"}
                </div>
              )}
            </>
          ) : (
            <>
              <div className="amount" style={{ color: "var(--dim)" }}>
                ••••<span className="unit">sSCRT</span>
              </div>
              <div className="locked">
                {connection ? "Zůstatek je privátní — odemkni ho permitem." : "Připoj peněženku."}
              </div>
            </>
          )}
        </div>

        {connection && !permit && (
          <button className="btn primary wide" style={{ marginTop: "1rem" }} onClick={unlockBalance} disabled={busy}>
            Odemknout zůstatek
          </button>
        )}

        {canTransact && (
          <div className="actions">
            <button className="btn act send" onClick={() => setDialog("send")} disabled={busy}>
              <ArrowUpRight />
              Odeslat
            </button>
            <button className="btn act receive" onClick={() => setDialog("receive")} disabled={busy}>
              <ArrowDownLeft />
              Přijmout
            </button>
          </div>
        )}

        {onboardError && (
          <div className="banner err">
            <strong>Provider tuhle adresu nepřijal.</strong> {onboardError}
          </div>
        )}

        {error && (
          <div className="banner err">
            <strong>Chyba.</strong> {error}
          </div>
        )}

      </main>

      {dialog === "send" && (
        <SendModal
          balance={balance}
          priceUsd={priceUsd}
          credits={credits}
          devMode={devMode}
          onClose={() => setDialog(null)}
          onSend={send}
        />
      )}

      {dialog === "receive" && connection && (
        <ReceiveModal address={connection.address} onClose={() => setDialog(null)} />
      )}

      {dialog === "settings" && (
        <SettingsModal
          status={status}
          statusError={statusError}
          creditPriceSscrt={creditPrice}
          credits={credits}
          onRevokePermit={revokePermit}
          devMode={devMode}
          onDevModeChange={changeDevMode}
          onForgetPermit={forgetPermit}
          onClose={() => setDialog(null)}
        />
      )}

      {run && <ProgressModal run={run} onClose={() => setRun(null)} />}

      {busy && !run && dialog === null && (
        <Modal title="Moment…">
          <div style={{ display: "flex", gap: "0.7rem", alignItems: "center", color: "var(--muted)" }}>
            <span className="spin" />
            Čekám na peněženku.
          </div>
        </Modal>
      )}
    </div>
  );
}
