// The catalogue behind the test switch.
//
// Three kinds, and the difference matters when reading a result:
//
//   baseline  — the honest flow, so every other row has something to be compared against.
//   guard     — probes a refusal the provider service explicitly implements. Being rejected is
//               a pass; going through is a regression.
//   probe     — probes something the provider may or may not check. Going through is a finding,
//               not a feature, and the app says so.
//
// A "probe" that succeeds is not a bug in this app. It is the app doing its job.
export type ScenarioId =
  | "honest"
  | "no_payment"
  | "underpay"
  | "redirect_payment"
  | "inflate_gas"
  | "low_gas"
  | "failing_action"
  | "expired_quote"
  | "replay"
  | "sequence_race"
  | "unwhitelisted_contract"
  | "quote_flood";

export type ScenarioKind = "baseline" | "guard" | "probe";

export interface Scenario {
  id: ScenarioId;
  kind: ScenarioKind;
  title: string;
  what: string;
  expected: string;
  /** true when running it needs more than one Keplr approval, or takes a visibly long time. */
  note?: string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: "honest",
    kind: "baseline",
    title: "Poctivý převod",
    what: "Odešle sSCRT přesně tak, jak provider nakvótoval: akce + platba za gas.",
    expected: "Transakce projde (code 0) a zůstatek klesne o částku + poplatek.",
  },
  {
    id: "no_payment",
    kind: "probe",
    title: "Platba vynechána",
    what: "Vyžádá si kvótu, ale podepíše jen samotný převod — platební zprávu z bundlu vypustí.",
    expected: "Provider by měl odmítnout. Pokud transakce projde, zaplatil gas a nedostal nic.",
  },
  {
    id: "underpay",
    kind: "probe",
    title: "Podhodnocená platba",
    what: "Podepíše platbu na 1 usSCRT místo nakvótované částky.",
    expected: "Provider by měl odmítnout. Pokud projde, dostal zaplaceno zlomek ceny.",
  },
  {
    id: "redirect_payment",
    kind: "probe",
    title: "Platba přesměrovaná",
    what: "Podepíše platbu ve správné výši, ale příjemcem je vlastní adresa, ne provider.",
    expected: "Provider by měl odmítnout. Pokud projde, platba se mu nikdy nedostala.",
  },
  {
    id: "inflate_gas",
    kind: "probe",
    title: "Nafouknutý gas limit",
    what: "Podepíše transakci s pětinásobným gas limitem, než kolik provider nakvótoval.",
    expected:
      "Provider by měl odmítnout. Pokud projde, zaplatil pětinásobný poplatek a dostal jednonásobnou platbu.",
  },
  {
    id: "low_gas",
    kind: "probe",
    title: "Nedostatečný gas",
    what: "Podepíše transakci s 40 % nakvótovaného gasu, takže dojde v půlce.",
    expected:
      "Transakce selže na out of gas. Poplatek je stržen z grantu i tak, a platba se s ní vrátí zpět.",
  },
  {
    id: "failing_action",
    kind: "probe",
    title: "Transakce, která selže",
    what: "Pošle víc sSCRT, než uživatel vlastní — kontrakt volání odmítne.",
    expected: "Transakce selže (code ≠ 0). Poplatek provider zaplatil, platbu ale nedostal — bundle je atomický.",
  },
  {
    id: "expired_quote",
    kind: "guard",
    title: "Propadlá kvóta",
    what: "Podepíše kvótu a odešle ji až po vypršení její platnosti.",
    expected: "HTTP 410 expired.",
    note: "Trvá ~50 sekund — čeká se na vypršení kvóty.",
  },
  {
    id: "replay",
    kind: "guard",
    title: "Opakované odeslání",
    what: "Odešle úspěšnou transakci, a hned nato tytéž podepsané bajty podruhé.",
    expected: "Druhý pokus skončí na HTTP 409 already_submitted.",
  },
  {
    id: "sequence_race",
    kind: "guard",
    title: "Souběh sekvence",
    what: "Vyžádá dvě kvóty na stejné sequence number, obě podepíše a obě odešle.",
    expected: "První projde, druhá skončí na HTTP 409 sequence_changed.",
    note: "Keplr se zeptá na podpis dvakrát.",
  },
  {
    id: "unwhitelisted_contract",
    kind: "guard",
    title: "Kontrakt mimo whitelist",
    what: "Vyžádá kvótu na volání kontraktu, který provider nesponzoruje.",
    expected: "HTTP 403 contract_not_allowed, ještě před jakýmkoli odhadem gasu.",
  },
  {
    id: "quote_flood",
    kind: "guard",
    title: "Zahlcení kvótami",
    what: "Vystřelí 15 žádostí o kvótu za sebou.",
    expected: "Rate limiter zabere a začne vracet HTTP 429.",
    note: "Po doběhnutí je adresa na minutu zablokovaná i pro ostatní testy.",
  },
];

export const SCENARIOS_BY_ID: Record<ScenarioId, Scenario> = Object.fromEntries(
  SCENARIOS.map((s) => [s.id, s]),
) as Record<ScenarioId, Scenario>;
