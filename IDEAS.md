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

## Open risk #1 — wallet identity is unauthenticated

This is the largest remaining hole and it is a **design** gap, not a bug I could
patch without changing the demo flow.

```
x-payai-wallet: alice
```

That header is the only thing identifying a payer. Anyone who learns a wallet id
can spend that wallet's balance. Today the id is an arbitrary string chosen by the
caller and never verified against anything.

Mitigations already applied: the cross-wallet listing is admin-gated, so ids are no
longer enumerable from the outside. That reduces discovery, not the underlying
problem.

**The real fix**, in rough order of effort:

1. **Derive the wallet id from the settled payer address.** `settleResult.payer` is
   already returned by the facilitator and is cryptographically attested. Credit
   *that* address rather than a caller-supplied string, and the wallet id becomes
   unforgeable for anyone who has ever topped up.
2. **Challenge/response for spending.** `GET /api/wallet/:id/nonce` → client signs
   it with the same key → send as `x-payai-signature`. Cheap, standard EIP-191.
3. **Bearer capability tokens.** On successful settlement, issue a short-lived
   opaque token scoped to that wallet. Easiest for non-crypto clients, and keeps
   the signing key out of every request.

Option 1 is the one that fits the architecture — the payer address is already
flowing through `settleIncomingPayment()`, it just isn't used as identity.

## Open risk #2 — the ledger is in memory

`src/store/ledger.js` is a `Map`. A restart or a platform-initiated redeploy wipes
every balance, including balances people paid real USDC for. Fine for a demo,
disqualifying for anything else. See "Persistence" below.

## Open risk #3 — no replay tracking on settlement

`settleIncomingPayment()` credits the wallet whenever the facilitator reports
success. It keeps no record of which payment payloads it has already honored, so
PayAI is trusting the facilitator's nonce handling completely. Storing settled
`(payer, nonce)` pairs and rejecting repeats is a small change with real value.

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

### Near-term, high leverage

**Monetized MCP server (`@x402/mcp`).** The highest-value move. Expose PayAI's
proxy as MCP tools where individual tools are marked paid — any Claude Code,
Cursor, or Claude Desktop agent can then pay per tool call with no API key. This
flips PayAI from "a proxy you configure" to "a service agents discover and use."
Cloudflare's Agents SDK has shipped x402+MCP since Sept 2025, so the pattern is
well-trodden.

**List in the x402 Bazaar.** The [discovery layer](https://docs.cdp.coinbase.com/x402/bazaar)
is a semantic index agents search to find paid endpoints — 112+ services across
11 categories. Being findable is the difference between a demo and a business.
Listing is metadata, not engineering.

**Persistence.** Swap the `Map` for SQLite (`node:sqlite` is built in, zero deps)
or Cloudflare D1/Durable Objects. The `Ledger` class is already a clean seam —
every mutation goes through `credit`/`reserve`/`release`/`reconcile`, so this is a
contained change.

**Real receipts.** `PAYMENT-RESPONSE` already carries the settlement tx. Persist it
per request and expose `GET /api/wallet/:id/receipts` — a verifiable, onchain-anchored
spend log. This is something OpenRouter structurally cannot offer.

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
