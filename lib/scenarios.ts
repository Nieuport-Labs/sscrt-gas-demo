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
//
// Most of what used to be here aimed at a bundle of [the user's action, a payment] that the
// provider sponsored. That bundle no longer exists: the provider builds one message of its own
// shape and nothing else, so an unwhitelisted contract, an overspending transfer or a
// deliberately failing action are no longer things it can be made to pay for. What survives
// aims at the purchase itself; what is new aims at the two places where the provider still
// spends its own money — the bootstrap grant, and the credits it owes once it has been paid.
export type ScenarioId =
  | "honest"
  | "no_payment"
  | "underpay"
  | "redirect_payment"
  | "expired_quote"
  | "replay"
  | "sequence_race"
  | "quote_flood"
  | "steal_bootstrap"
  | "double_onboard"
  | "topup_foreign_grantee";

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
    what:
      "Odešle sSCRT. Podle stavu kreditů si je buď nejdřív sám dobije, nebo — pokud žádné nemá — " +
      "koupí první u providera a teprve pak odešle.",
    expected: "Transakce projde (code 0) a zůstatek klesne o odeslanou částku.",
  },
  {
    id: "no_payment",
    kind: "probe",
    title: "Platba vynechána",
    what: "Vyžádá si kvótu na nákup kreditů, ale podepíše převod na 1 usSCRT sobě samému místo ní.",
    expected: "Provider by měl odmítnout. Pokud projde, zaplatil gas a nedostal nic.",
  },
  {
    id: "underpay",
    kind: "probe",
    title: "Podhodnocená platba",
    what: "Podepíše platbu na 1 usSCRT místo nakvótované ceny kreditů.",
    expected: "Provider by měl odmítnout. Pokud projde, prodal kredity za zlomek ceny.",
  },
  {
    id: "redirect_payment",
    kind: "probe",
    title: "Platba přesměrovaná",
    what: "Podepíše platbu ve správné výši, ale příjemcem je vlastní adresa, ne provider.",
    expected: "Provider by měl odmítnout. Pokud projde, kredity dodal a zaplaceno nedostal.",
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
    what: "Odešle úspěšný nákup, a hned nato tytéž podepsané bajty podruhé.",
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
    id: "quote_flood",
    kind: "guard",
    title: "Zahlcení kvótami",
    what: "Vystřelí 15 žádostí o kvótu za sebou.",
    expected: "Rate limiter zabere a začne vracet HTTP 429.",
    note: "Po doběhnutí je adresa na minutu zablokovaná i pro ostatní testy.",
  },
  {
    id: "steal_bootstrap",
    kind: "guard",
    title: "Krádež prvního grantu",
    what:
      "Vyžádá si kvótu (čímž provider vydá bootstrap grant), nic nepodepíše, a hned si řekne " +
      "o druhou.",
    expected:
      "Druhá kvóta smí použít jen ten už vydaný grant — provider nesmí zaplatit druhý. Je to " +
      "jediné místo, kde adresa, která nikdy nezaplatí, něco stojí: zhruba 0,0026 SCRT.",
  },
  {
    id: "double_onboard",
    kind: "guard",
    title: "Dvojí onboarding",
    what: "Pošle permit dvakrát za sebou.",
    expected:
      "Druhý jen přepíše ten uložený. Onboarding nic neutrácí a nic nevydává, takže opakovat " +
      "ho nemá co získat.",
  },
  {
    id: "topup_foreign_grantee",
    kind: "probe",
    title: "Kredit cizí adrese",
    what: "Dobije gas credits jiné adrese než vlastní, z vlastního sSCRT.",
    expected:
      "Projde, a je to v pořádku — vault to umožňuje záměrně, aby mohl někdo platit gas za " +
      "někoho jiného. Platí se z vlastního, takže se tím na cizí účet nic nezískává.",
    note: "Providera nepoužívá vůbec. Jde přímo přes kontrakt.",
  },
];

export const SCENARIOS_BY_ID: Record<ScenarioId, Scenario> = Object.fromEntries(
  SCENARIOS.map((s) => [s.id, s]),
) as Record<ScenarioId, Scenario>;
