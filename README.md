# sSCRT Gas Demo

A minimal Secret Network dApp that sends **sSCRT while paying the transaction fee in sSCRT**, and
an adversarial test harness for the server that makes that possible.

It is the client side of [sSCRT Gas Provider](https://github.com/Nieuport-Labs/Private-gas-server):
a wallet holding no native SCRT at all connects, reads its private sSCRT balance through a SNIP-24
permit, and sends a transfer whose gas is fronted by the provider and reimbursed in sSCRT in the
same transaction.

The second half of the app is the reason it exists. A switch selects one of twelve scenarios —
eleven of which deviate from what the provider quoted — and the app reports what the chain
actually did about it.

> The interface is in Czech; the code and this document are in English.

## What it does

**Send panel.** Connect Keplr, sign a balance permit, get a fee grant from the provider, send
sSCRT. The amount can be entered in sSCRT or in USD, converted at the live SCRT price from
Osmosis (sSCRT is a 1:1 wrapper, so the same price applies).

**Test panel.** Twelve scenarios in three groups:

| Group | Meaning |
|---|---|
| Baseline | The honest flow, so every other result has something to compare against. |
| Probes | Deviations the provider *may or may not* check. Success is a finding. |
| Guards | Refusals the provider explicitly implements. Rejection is a pass. |

The probes all exploit the same structural fact: the provider decides the quote, but the **user
signs the bytes**, and the two need not agree. Each probe changes exactly one thing between the
quote and the signature — drop the payment message, pay 1 usSCRT instead of the quoted amount,
send the payment to yourself, inflate the gas limit fivefold, starve it of gas, or make the action
itself fail — and then submits.

The guards cover quote expiry, replay, the sequence lock, the contract whitelist and rate limiting.

## How a result is judged

Every run measures two numbers itself, before and after, rather than trusting the provider's
response:

- **The user's sSCRT balance**, read through the permit. This shows what was really transferred
  and to whom.
- **The fee grant's remaining spend limit** (`/cosmos/feegrant/v1beta1/allowance/{granter}/{grantee}`,
  public, no key needed). This shows what the provider was really charged.

That distinction matters. `/submit` reports `sscrtReceived` as the amount it *quoted*, on the
assumption that a transaction with `code: 0` paid it — which is precisely the assumption several
of these scenarios exist to test. A verdict of `vulnerable` is only ever reported from a measured
balance delta, never from a status code.

Verdicts: `as_expected`, `vulnerable`, `known_tradeoff`, `inconclusive`, `error`.

`known_tradeoff` is its own category on purpose. When a transaction runs out of gas or the action
fails, the provider loses the fee and receives nothing — the payment reverts with the rest of the
atomic bundle. That is a property of `x/feegrant`, which charges in the ante handler before any
message executes, not a defect in the server. The app says so rather than flagging it red.

## Running it

```bash
cp .env.example .env.local   # point it at your provider
npm install
npm run dev
```

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_PROVIDER_URL` | The gas provider's base URL. Must be reachable from the browser. |
| `NEXT_PUBLIC_CHAIN_ID` | `secret-4` for mainnet. |
| `NEXT_PUBLIC_LCD_URL` | An LCD endpoint that serves permissive CORS headers. |
| `NEXT_PUBLIC_SSCRT_CONTRACT` | The sSCRT SNIP-20 contract. |

Deploying to Vercel needs nothing beyond those four environment variables.

### Provider-side prerequisites

Sending sSCRT through the provider is a `MsgExecuteContract` call, which the provider sponsors only
for contracts its operator has explicitly vetted. On the provider:

1. Add the sSCRT contract to `ALLOWED_CONTRACT_ADDRESSES`.
2. Calibrate its gas constant — `MsgExecuteContract` cannot be simulated on Secret at all, so the
   figure has to be measured from real transactions:
   ```bash
   npm run calibrate:contract -- secret1k0jnt… '{"transfer":{"recipient":"secret1…","amount":"1"}}'
   ```

Without both, `/quote` answers `contract_not_allowed` or `contract_gas_not_calibrated`. That is the
provider working correctly, and the "contract outside the whitelist" scenario exists to demonstrate
it.

## Costs and warnings

The attack scenarios broadcast **real transactions on whatever chain you point them at**. On
mainnet they cost real money — the provider's, and yours. Run them against an instance you own,
with small amounts.

Two scenarios have side effects worth knowing about before you click:

- **Quote flood** trips the per-address rate limiter, which then blocks the other scenarios for
  about a minute.
- **Expired quote** takes roughly 50 seconds, because it waits for the quote's TTL to pass.

**Sequence race** asks Keplr to sign twice.

## Privacy

sSCRT balances and transfer amounts are private; they are readable here only because the user signs
a permit scoped to their own balance, and that permit never leaves the browser except in the
`/onboard` call that hands it to the provider. Everything else about these transactions is public:
which contract was called, by whom, when, and what the gas cost. "Built on Secret" does not mean
the transfer is invisible — only its amount and balances are.

## Stack

Next.js 16 (App Router), React 19, secretjs 1.22, plain CSS. One API route, `/api/price`, which
proxies and caches the Osmosis price so it is fetched once per minute rather than once per visitor.

## Licence

MIT.
