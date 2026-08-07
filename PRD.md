# PayAI — Product Requirements Document

**One line:** LLM inference an autonomous agent can buy on its own, paid per token
in stablecoins over x402, with no account and no API key.

---

## 1. Problem

Every existing way to buy LLM inference assumes a human at the other end: an email
address, a credit card, a dashboard login, an API key issued to a person. OpenRouter,
Together, Anthropic, OpenAI — all of them.

An autonomous agent has none of those things. Today an agent that needs inference
must borrow a human's credentials, which means the human has to anticipate the
spend, provision the key, and carry the risk. There is no way for software to
acquire capacity on its own terms, with its own money, under limits it cannot talk
its way past.

x402 — HTTP 402 revived as a real payment handshake, now governed by the Linux
Foundation with Coinbase, Cloudflare, Stripe, Visa and Mastercard behind it — makes
machine-to-machine payment possible. Nobody has pointed it at the thing agents
actually consume most: tokens.

## 2. What we are building

A proxy that speaks the Anthropic and OpenAI APIs verbatim, so any existing SDK
works by changing one URL. Behind that interface it:

- meters real token usage per request,
- draws it down from a prepaid balance held against a wallet id,
- returns **HTTP 402 with machine-readable payment terms** when the balance runs out,
- accepts a signed stablecoin payment, settles it through an x402 facilitator, and
  credits the wallet,
- records a receipt for every charge, traceable to the onchain settlement that
  funded it.

**The claim is not "we accept crypto." It is the absence of an account.**

## 3. Success criteria

Demoable, end to end, on a public URL:

| # | Criterion |
|---|---|
| 1 | An unmodified Anthropic/OpenAI SDK gets a real completion through PayAI by changing only `base_url` |
| 2 | The balance visibly decreases per request, priced on actual token counts |
| 3 | When the balance is exhausted, the API returns HTTP 402 carrying x402 payment terms |
| 4 | A payment credits the wallet and the same request then succeeds |
| 5 | A live dashboard shows balance, holds, and spend updating in real time |
| 6 | An MCP-connected agent can call a paid tool and receive payment terms it can act on |
| 7 | Balances survive a restart |

## 4. Scope

### In scope

- Anthropic `/v1/messages` and OpenAI `/v1/chat/completions`, streaming and not
- Per-token metering with reserve → proxy → reconcile, refunding the difference
- x402 settlement on Base Sepolia (EVM) and Solana devnet (SVM)
- Durable ledger (SQLite) with per-request receipts and settlement records
- Wallet ownership proof: funded wallets are bound to the paying address
- Spend policy: per-wallet rate limits, hourly budgets, per-request cost cap,
  model allowlist
- MCP server exposing paid tools to agents
- Discovery manifest at `/.well-known/x402` for agent indexes
- Live dashboard over SSE
- A mock provider so the demo runs with no upstream API key

### Explicitly out of scope

- Fiat on-ramp, refunds, chargebacks, invoicing
- Mainnet settlement (testnet only for this build)
- Multi-tenant accounts, teams, org billing
- Hosting our own inference — we proxy, we don't serve models
- Running our own x402 facilitator

## 5. Architecture

```
request
  → wallet resolution        (x-payai-wallet header)
  → ownership proof          (signature required once a wallet is funded)
  → policy                   (rate limit, budget, model allowlist)
  → billing gate             (estimate + reserve, or 402 with payment terms)
  → provider proxy           (stream upstream, capture usage)
  → reconcile                (charge actual, refund the rest, write receipt)
```

**Settlement guarantee.** Every reservation settles exactly once. A response-close
hook releases any hold that was never reconciled, so an upstream failure, a missing
API key, or a client that hangs up mid-stream cannot silently keep the caller's
money.

**Availability guarantee.** The x402 facilitator is not a hard dependency. If it is
unreachable, PayAI still boots, still serves inference, and returns plain 402s
explaining why. A payments outage is not a service outage.

## 6. Non-goals for the demo

We are not optimizing price or model coverage. OpenRouter already does one-balance-
many-models better than we will tonight, and charges 5% on crypto top-ups behind an
account. Competing there loses. The demo leads with the thing that has no
equivalent: an agent buying inference with nobody logged in.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Facilitator unreachable during the demo | Server degrades instead of dying; demo mode credits without the chain |
| No upstream API key / provider outage | Mock provider produces real API-shaped responses and real usage numbers |
| Wallet id is a bearer secret | Funded wallets bound to the paying address; signature required to spend |
| Deployed instance drained via free credits | Faucet capped; read endpoints never mint; demo top-ups capped per wallet |
| Restart wipes balances people paid for | Ledger persisted to SQLite, restored on boot |

## 8. Verification

`npm run test:all` — 27 checks covering metering, refund-on-failure, 402 at
exhaustion, top-up and retry, receipts, policy enforcement, and persistence across
restart. Additional suites: `test:auth` (ownership proof), `test:mcp` (agent flow),
`test:402` (the demo path).
