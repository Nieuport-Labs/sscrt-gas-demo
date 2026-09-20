"use client";

import { Modal } from "./Modal";
import { scrt, sscrt } from "@/lib/format";
import type { RunResult, Verdict } from "@/lib/runner";

const VERDICT_LABEL: Record<Verdict, string> = {
  as_expected: "podle očekávání",
  vulnerable: "zranitelnost",
  known_tradeoff: "známý kompromis",
  inconclusive: "neprůkazné",
  error: "chyba",
};

export function ProgressModal(props: { run: RunResult; onClose: () => void }) {
  const { run } = props;
  const running = run.finishedAt === null;

  return (
    <Modal
      title={running ? "Probíhá…" : "Hotovo"}
      // No close button while it runs. The transaction is already signed and on its way; hiding
      // the window would not stop it, it would only take away the one place the outcome appears.
      onClose={running ? undefined : props.onClose}
      footer={
        running ? (
          <>
            <span className="msg">Nezavírej okno, dokud transakce neproběhne.</span>
            <span className="spin" />
          </>
        ) : (
          <>
            <span className="msg">
              {run.txHash && (
                <a
                  href={`https://www.mintscan.io/secret/tx/${run.txHash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mono"
                  style={{ color: "var(--muted)" }}
                >
                  {run.txHash.slice(0, 12)}… ↗
                </a>
              )}
            </span>
            <button className="btn primary" onClick={props.onClose}>
              Zavřít
            </button>
          </>
        )
      }
    >
      {!running && (
        <div className={`verdict ${run.verdict}`}>
          <span className="tag">{VERDICT_LABEL[run.verdict]}</span>
          {run.verdictText}
        </div>
      )}

      {run.measurement && (
        <table className="kv" style={{ marginBottom: "0.9rem" }}>
          <tbody>
            <tr>
              <td>Odešlo z účtu</td>
              <td className="mono">{sscrt(run.measurement.sscrtSpent)}</td>
            </tr>
            {run.measurement.sscrtExpected && (
              <tr>
                <td>Samotný převod</td>
                <td className="mono">{sscrt(run.measurement.sscrtExpected)}</td>
              </tr>
            )}
            {run.measurement.creditsAfterUscrt !== null && (
              <tr>
                <td>Gas credits</td>
                <td className="mono">
                  {scrt(run.measurement.creditsBeforeUscrt ?? "0")} → {scrt(run.measurement.creditsAfterUscrt)}
                </td>
              </tr>
            )}
            <tr>
              <td>Provider</td>
              <td>
                {run.measurement.providerUsed
                  ? "použit — prodal první kredity"
                  : "nepoužit — poplatek zaplatil vault"}
              </td>
            </tr>
          </tbody>
        </table>
      )}

      <ul className="steps">
        {run.steps.map((step, index) => (
          <li key={index}>
            <span className="t">{step.at.slice(11, 19)}</span>
            <span className={step.level}>{step.text}</span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
