"use client";

import { SCENARIOS, SCENARIOS_BY_ID, type ScenarioId, type ScenarioKind } from "@/lib/scenarios";
import type { RunResult, Verdict } from "@/lib/runner";

const GROUP_TITLES: Record<ScenarioKind, string> = {
  baseline: "Referenční průběh",
  probe: "Útoky — testují, jestli server něco nehlídá",
  guard: "Obrany — server je má odmítnout",
};

const GROUP_ORDER: ScenarioKind[] = ["baseline", "probe", "guard"];

const VERDICT_LABEL: Record<Verdict, string> = {
  as_expected: "podle očekávání",
  vulnerable: "zranitelnost",
  known_tradeoff: "známý kompromis",
  inconclusive: "neprůkazné",
  error: "chyba",
};

const VERDICT_CLASS: Record<Verdict, string> = {
  as_expected: "pill ok",
  vulnerable: "pill danger",
  known_tradeoff: "pill warn",
  inconclusive: "pill",
  error: "pill danger",
};

export function ScenarioPicker(props: {
  selected: ScenarioId;
  onSelect: (id: ScenarioId) => void;
  disabled: boolean;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>Testovací scénář</h2>
        <span className="pill">{SCENARIOS.length} variant</span>
      </div>
      <div className="card-body">
        {GROUP_ORDER.map((kind) => (
          <div className="scenario-group" key={kind}>
            <h3>{GROUP_TITLES[kind]}</h3>
            {SCENARIOS.filter((s) => s.kind === kind).map((scenario) => (
              <label
                key={scenario.id}
                className={`scenario${props.selected === scenario.id ? " selected" : ""}`}
              >
                <input
                  type="radio"
                  name="scenario"
                  checked={props.selected === scenario.id}
                  disabled={props.disabled}
                  onChange={() => props.onSelect(scenario.id)}
                />
                <span>
                  <span className="scenario-title">
                    {scenario.title}
                    {scenario.note && <span className="pill warn">{scenario.note}</span>}
                  </span>
                  <span className="scenario-what">{scenario.what}</span>
                  <span className="scenario-expected">Očekávání: {scenario.expected}</span>
                </span>
              </label>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export function RunLog({ runs }: { runs: RunResult[] }) {
  return (
    <div className="card">
      <div className="card-head">
        <h2>Průběh</h2>
        {runs.length > 0 && <span className="pill">{runs.length}</span>}
      </div>
      <div className="card-body">
        {runs.length === 0 && (
          <p className="hint">
            Zatím nic neproběhlo. Vyber scénář, vyplň adresu a částku, a spusť ho — každý krok se
            zapíše sem, včetně toho, co se doopravdy stalo na řetězci.
          </p>
        )}
        {runs.map((run) => (
          <RunEntry key={run.id} run={run} />
        ))}
      </div>
    </div>
  );
}

function RunEntry({ run }: { run: RunResult }) {
  const scenario = SCENARIOS_BY_ID[run.scenario];
  const running = run.finishedAt === null;

  return (
    <div className="run">
      <div className="run-head">
        <h4>{scenario?.title ?? run.scenario}</h4>
        {running ? (
          <span className="pill">běží…</span>
        ) : (
          <span className={VERDICT_CLASS[run.verdict]}>{VERDICT_LABEL[run.verdict]}</span>
        )}
        {run.txHash && (
          <a
            className="mono"
            href={`https://www.mintscan.io/secret/tx/${run.txHash}`}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--text-muted)" }}
          >
            {run.txHash.slice(0, 10)}…
          </a>
        )}
      </div>

      {!running && <p className="run-verdict">{run.verdictText}</p>}

      {run.measurement && (
        <p className="hint mono">
          zaplaceno {run.measurement.sscrtSpent} usSCRT
          {run.measurement.sscrtExpected && ` (poctivě by to bylo ${run.measurement.sscrtExpected})`}
          {run.measurement.grantSpentUscrt !== null &&
            ` · provider ${run.measurement.grantSpentUscrt} uscrt, nakvótováno ${run.measurement.quotedFeeUscrt}`}
        </p>
      )}

      <ul className="run-steps">
        {run.steps.map((step, index) => (
          <li key={index}>
            <span className="t">{step.at.slice(11, 19)}</span>
            <span className={step.level}>{step.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
