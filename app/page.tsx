"use client";

import { useCallback, useEffect, useState } from "react";
import type { Permit } from "secretjs";
import { SendCard } from "@/components/SendCard";
import { RunLog, ScenarioPicker } from "@/components/TestPanel";
import { config } from "@/lib/config";
import { toBaseUnits } from "@/lib/format";
import { providerApi, type ProviderStatus } from "@/lib/provider";
import { runScenario, type RunResult } from "@/lib/runner";
import type { ScenarioId } from "@/lib/scenarios";
import {
  connectKeplr,
  querySscrtBalance,
  queryGrantRemainingUscrt,
  signBalancePermit,
  type Connection,
} from "@/lib/secret";

/** A permit is a signature over fixed terms, so it stays valid until the user revokes it — worth
 * keeping so a reload doesn't mean another Keplr prompt. It grants read access to one balance
 * and nothing else. */
const permitKey = (address: string) => `sscrt-gas-demo:permit:${config.chainId}:${address}`;

export default function Home() {
  const [status, setStatus] = useState<ProviderStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [priceUsd, setPriceUsd] = useState<number | null>(null);

  const [connection, setConnection] = useState<Connection | null>(null);
  const [permit, setPermit] = useState<Permit | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [hasGrant, setHasGrant] = useState<boolean | null>(null);

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [scenario, setScenario] = useState<ScenarioId>("honest");

  const [runs, setRuns] = useState<RunResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const refreshGrant = useCallback(async (address: string, providerAddress: string) => {
    const remaining = await queryGrantRemainingUscrt(providerAddress, address);
    setHasGrant(remaining !== null);
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
      }
      if (status?.providerAddress) await refreshGrant(conn.address, status.providerAddress);
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
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onboard = async () => {
    if (!connection || !permit || !status?.providerAddress) return;
    setError(null);
    setBusy(true);
    try {
      const result = await providerApi.onboard(connection.address, permit);
      if (!result.ok) {
        setError(`onboarding selhal (HTTP ${result.status} ${result.error}): ${result.message}`);
        return;
      }
      await refreshGrant(connection.address, status.providerAddress);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // --- running a scenario --------------------------------------------------------------------

  const amountBase = toBaseUnits(amount);
  const recipientValid = /^secret1[0-9a-z]{38}$/.test(recipient.trim());

  const run = async () => {
    if (!connection || !permit || !status?.providerAddress || !amountBase) return;
    setError(null);
    setBusy(true);

    const upsert = (result: RunResult) =>
      setRuns((previous) => {
        const index = previous.findIndex((r) => r.id === result.id);
        if (index === -1) return [result, ...previous];
        const next = [...previous];
        next[index] = result;
        return next;
      });

    try {
      await runScenario({
        connection,
        permit,
        providerAddress: status.providerAddress,
        recipient: recipient.trim(),
        amountBase,
        scenario,
        onUpdate: upsert,
      });
      await refreshBalance(permit);
      await refreshGrant(connection.address, status.providerAddress);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // --- what the big button does right now ----------------------------------------------------

  let ctaLabel = "Spustit scénář";
  let ctaDisabled = false;
  let onCta = run;

  if (!connection) {
    ctaLabel = "Připojit Keplr";
    onCta = connect;
  } else if (!permit) {
    ctaLabel = "Odemknout zůstatek";
    onCta = unlockBalance;
  } else if (hasGrant === false) {
    ctaLabel = "Zapnout sponzorovaný gas";
    onCta = onboard;
  } else if (!recipientValid) {
    ctaLabel = "Zadej adresu příjemce";
    ctaDisabled = true;
  } else if (!amountBase || amountBase === "0") {
    ctaLabel = "Zadej částku";
    ctaDisabled = true;
  } else if (scenario === "honest") {
    ctaLabel = "Odeslat";
  }

  const footnote = (() => {
    if (statusError) return `Provider ${config.providerUrl} neodpovídá: ${statusError}`;
    if (status && !status.walletConfigured)
      return "Provider běží, ale nemá nastavenou peněženku — nemůže vystavit fee grant. Dodělej to v jeho dashboardu.";
    if (!connection) return "Zůstatek sSCRT je privátní. Přečte se až po podepsání permitu — off-chain, zdarma.";
    if (!permit) return "Permit je podpis, ne transakce: žádný gas, žádný záznam na řetězci, kdykoli odvolatelný.";
    if (hasGrant === false)
      return "Provider ti vystaví fee grant, ze kterého bude platit nativní poplatky. Ty mu je vrátíš v sSCRT.";
    if (status) return `Marže providera: ${status.config.feeMarkupPercent} % nad cenu gasu.`;
    return null;
  })();

  return (
    <main className="page">
      <div className="shell">
        <header className="masthead">
          <div>
            <h1>sSCRT Gas Demo</h1>
            <p>
              Peněženka bez jediného SCRT pošle sSCRT a poplatek zaplatí taky v sSCRT — nativní gas
              za ni složí provider a nechá si ho hned proplatit. Přepínač napravo dovolí zkusit
              i to, co by uživatel dělat neměl.
            </p>
          </div>
          <div className="row">
            <span className="pill">{config.chainId}</span>
            {!status ? (
              <span className="pill danger">provider nedostupný</span>
            ) : status.providerAddress ? (
              <span className="pill ok">provider online</span>
            ) : (
              <span className="pill warn">provider bez peněženky</span>
            )}
            {priceUsd !== null && <span className="pill">SCRT ${priceUsd.toFixed(4)}</span>}
          </div>
        </header>

        <div className="stack">
          <SendCard
            address={connection?.address ?? null}
            balance={balance}
            priceUsd={priceUsd}
            amount={amount}
            onAmountChange={setAmount}
            recipient={recipient}
            onRecipientChange={setRecipient}
            onSubmit={onCta}
            ctaLabel={ctaLabel}
            ctaDisabled={ctaDisabled}
            busy={busy}
            footnote={footnote}
          />

          {error && (
            <div className="banner danger">
              <strong>Chyba.</strong> {error}
            </div>
          )}

          <div className="banner">
            <strong>Tohle je testovací nástroj.</strong> Útočné scénáře posílají skutečné
            transakce na {config.chainId} a stojí skutečné peníze — providera i tebe. Pouštěj je
            proti své vlastní instanci a s drobnými částkami.
          </div>
        </div>

        <div className="stack">
          <ScenarioPicker selected={scenario} onSelect={setScenario} disabled={busy} />
          <RunLog runs={runs} />
        </div>
      </div>
    </main>
  );
}
