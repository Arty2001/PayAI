# PayAI — hardening notes, open risks, and where this can go

## What PayAI actually is

An OpenAI/Anthropic-compatible LLM proxy that meters real token usage and settles
it against a prepaid balance funded over [x402](https://github.com/x402-foundation/x402) —
HTTP 402 turned into a real payment handshake. Point any existing SDK at it by
changing `base_url`; the caller needs a stablecoin, not an account.

The thing that makes it interesting is not "crypto payments for AI." It's that
**an autonomous agent can acquire inference capacity with no human in the loop** —
no signup, no card, no API key issued by a human. x402 is now governed by the
Linux Foundation with Coinbase, Cloudflare, Stripe, Visa and Mastercard behind it,
so this is a rail, not a novelty.

---

## Resolved: wallet identity

`x-payai-wallet: alice` used to be the only thing identifying a payer — anyone who
learned an id could spend the balance.

Now: when a wallet is funded, the facilitator-attested `settleResult.payer` is
bound to it as `ownerAddress`. Spending an owned wallet requires a signature over
a single-use nonce (`POST /api/wallet/:id/challenge` → sign → `x-payai-signature`).
`PAYAI_WALLET_AUTH=owned` is the default: unfunded faucet wallets stay open so the
demo works, while anything holding real money is locked to its key.

Proven by `npm run test:auth` — 8 checks, including that a captured signature
cannot be replayed and that a different key is rejected as an owner mismatch.

## Resolved: durability

The ledger is SQLite (`node:sqlite` — no dependency, no native build step on
deploy hosts), with balances, per-request receipts, and settlements persisted.
Restored on boot; in-flight reservations are released rather than stranded.
`npm run test:all` hard-kills the server mid-suite and asserts balances, request
history, and receipts all survive.

## Resolved: replay protection

Settlements are keyed on the onchain transaction hash (falling back to a hash of
the signed payload when a facilitator settles off-chain) in a `settlements` table
with a primary-key constraint. A replayed `PAYMENT-SIGNATURE` is rejected rather
than credited twice.

## Resolved: trusting the facilitator

Crediting on `settleResult.success === true` meant taking the facilitator's word
for a transaction nobody read. Settlements are now verified against the chain
through QuickNode — confirming that USDC from the canonical token contract
actually reached the pay-to address, for at least the credited amount.

Verification runs out of band, so a slow node never delays a top-up, and it
distinguishes `unverifiable` (we could not check) from `failed` (we checked and
the chain disagrees). Only the latter is an alarm. `npm run test:verify` covers
16 cases against synthetic receipts, including lookalike token contracts and
split transfers.

## Still open

- **Faucet economics.** The free starting balance is capped
  (`PAYAI_MAX_FREE_WALLETS`) but still unauthenticated — a determined caller can
  cycle wallet ids up to the cap. Binding the faucet to a proof-of-personhood or
  requiring a nominal payment would close it.
- **Solana settlements are unverifiable.** The verifier is EVM-only; an SVM
  settlement is credited on the facilitator's word and marked `unverifiable`.
- **`unverifiable` is never retried.** Only `pending` rows are re-checked on boot,
  so a settlement that failed verification because the RPC was down stays that way.
- **Single-process ledger.** SQLite write-through is correct for one instance;
  horizontal scaling needs Postgres or a Durable Object.

---

## What was hardened

| Problem | Before | After |
|---|---|---|
| Reserved funds on error paths | Any 500/502/abort silently kept the caller's hold — money gone, no usage record | `res.on("close")` settlement guarantee in the billing gate: every reservation either reconciles against real usage or is released |
| Facilitator outage | `await initX402()` threw before `app.listen()` — process exited, whole service dark | Init is non-fatal; server boots in a `DEGRADED` state, still serves LLM traffic and plain 402s, reports why in `/health` |
| Crash on the 402 path | Facilitator errors while building a 402 became an unhandled rejection | `safeSendPaymentRequired()` falls back to a plain 402 carrying `x402Error` |
| Unlimited free credit | `GET /api/wallet/<anything>` minted $0.05 — a public URL was an open faucet | GET is read-only (`exists: false` for unknown wallets); wallets are created only by real traffic; global faucet cap via `PAYAI_MAX_FREE_WALLETS` |
| Wallet enumeration | `GET /api/wallet` returned every id and balance | Aggregate stats only; full listing behind `PAYAI_ADMIN_TOKEN` |
| Infinite demo credits | `/simulate-fund` was an unlimited money button | Per-wallet cap via `PAYAI_MAX_SIMULATED_TOPUPS` |
| Negative balances | Under-reserved requests could push a balance below zero | `reconcile()` clamps at zero and never charges more than was held; the shortfall is recorded as `underReservedMicroUsd` |
| Non-JSON upstream errors | `JSON.parse` threw, converting a real provider error into an opaque 502 | Parse is opportunistic; the upstream body passes through |
| Silent deploy failure | A port-bind failure was swallowed and exited 0 — a broken deploy looks healthy | `server.on("error")` exits non-zero |
| SSE lifetime | Default 5s keep-alive raced long-lived streams; writes to closed sockets threw | `keepAliveTimeout`/`headersTimeout` raised; writes guarded; cleanup on both `req`/`res` close |

Reservations are also now visible: `heldMicroUsd` tracks in-flight escrow per
wallet, so the dashboard can show held-vs-available rather than a balance that
mysteriously dips during a request.

---

## Integrations, roughly by effort

### Shipped

**MCP server** (`src/mcp/server.js`) — `payai_chat`, `payai_wallet`,
`payai_receipts`. When the wallet is empty, `payai_chat` returns the x402 terms in
its result body and `_meta`, so an agent can settle and retry without a human.
(Throwing an `McpError` looks tidier but `McpServer` converts thrown errors into
`isError` results and discards the structured `data` — the agent would get a
message and no way to pay.) Exercised by `npm run test:mcp`.

**Discovery manifest** at `/.well-known/x402` — endpoints, per-model rates,
top-up terms, and accepted networks, ready to submit to the
[x402 Bazaar](https://docs.cdp.coinbase.com/x402/bazaar). Submitting it is
account work, not engineering.

**Receipts** — `GET /api/wallet/:id/receipts` returns every charge alongside the
settlements that funded it, each carrying its transaction hash and verification
status. This is the thing a centralized credit system structurally cannot offer.

**Policy engine** — per-wallet rate limits, rolling hourly budgets, per-request
cost ceiling, model allowlist, and a `max_tokens` clamp applied *before* cost
estimation so the reservation and the upstream request agree.

### Medium

**Coinbase Agentic Wallets / AgentKit.** MPC-secured wallets in TEEs with
programmable session caps and per-transaction limits, gasless on Base, native x402
support. This answers "who holds the agent's money" properly and gives you
spend-policy enforcement you don't have to build.

**Multi-provider routing.** `MODEL_RATES` and the provider abstraction already
generalize. Add Groq / Together / Fireworks / Bedrock behind the same balance and
PayAI becomes a crypto-native OpenRouter — one balance, many models.

**Policy engine.** Per-wallet rate limits, model allowlists, max spend per hour,
per-agent budget delegation. Necessary the moment a wallet belongs to an
autonomous agent rather than a person.

**Streaming settlement.** Today it's reserve-then-reconcile per request. Settling
every N tokens mid-stream is closer to true micropayment semantics and makes long
generations safe to serve to strangers.

### Ambitious

**Agent-to-agent delegation.** A parent agent funds sub-wallets with scoped
budgets; children spend without touching the parent's key. This is the primitive
that makes multi-agent systems economically self-contained.

**BYOK routing fee.** Let callers bring their own provider key and charge a small
x402 fee for routing, metering, and receipts. Inverts the margin model and removes
your inventory risk entirely.

**Self-hosted facilitator.** The x402 docs explicitly warn against assuming the
public `x402.org` facilitator for mainnet. Running your own removes the dependency
that currently puts the service into `DEGRADED` when it hiccups.

**Multi-chain.** `@x402/evm` and `@x402/svm` are already wired. Aptos, Stellar,
Hedera, Avalanche, and TVM packages exist. Widening chain support widens who can
pay you.

---

## Positioning

OpenRouter is the obvious comparison: one prepaid balance, 300+ models, no
per-token markup, monetized on a fee at credit purchase — and it charges **5% on
crypto top-ups**, gated behind an account.

PayAI's distinct claim is not price, it's **the absence of an account**. An agent
that has never met a human can obtain inference, and every charge against it is
anchored to an onchain settlement it can verify. Lead the demo with that, not with
"we accept crypto."

---

## Deployment notes

- Set `PAYAI_PUBLIC_URL` to the deployed origin — x402 payment requirements embed
  the resource URL, and a wrong value makes signatures fail to match.
- Set `PAYAI_MAX_FREE_WALLETS` deliberately. The default of 500 caps faucet
  exposure at 500 × `PAYAI_INITIAL_BALANCE_USD`.
- Set `PAYAI_ADMIN_TOKEN` if you want the wallet listing at all in production.
- `PAYAI_DEMO_MODE` defaults to **on** whenever no pay-to address is configured,
  which exposes `/simulate-fund`. Set it explicitly rather than inheriting it.
- The service binds `PORT` and exits non-zero if it can't — health checks are
  meaningful now.
