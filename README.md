# PayAI

**LLM inference an agent can buy on its own.** An OpenAI- and Anthropic-compatible
proxy that meters real token usage and settles it against a prepaid balance funded
over [x402](https://github.com/x402-foundation/x402) — HTTP 402 turned into an
actual payment handshake.

Point any existing SDK at it by changing one URL. The caller needs a stablecoin,
not an account.

```
┌────────────┐   POST /v1/messages    ┌─────────────────────────────┐   ┌───────────┐
│   Agent    │ ─────────────────────► │           PayAI             │ ─►│ Anthropic │
│  or app    │                        │                             │   │  OpenAI   │
│            │ ◄───── 402 + terms ─── │  auth → policy → reserve →  │   └───────────┘
│            │ ── PAYMENT-SIGNATURE ► │  proxy → meter → reconcile  │
└────────────┘                        └──────────────┬──────────────┘
                                                     │
                                         facilitator │ settle USDC
                                                     ▼
                                              Base / Solana
```

## Why this exists

Every existing way to buy inference assumes a human: an email, a card, a dashboard,
an API key issued to a person. An autonomous agent has none of those.

PayAI's claim is not "we accept crypto." It is **the absence of an account**. An
agent that has never met a human can acquire inference capacity, and every charge
against it traces back to an onchain settlement the agent can independently verify.

## Quickstart

```bash
npm install
cp .env.example .env      # works as-is; mock provider needs no API key
npm start                 # http://localhost:4020
```

Then, in another terminal:

```bash
npm run test:402          # drain a wallet to HTTP 402, top up, retry
npm run test:all          # full regression suite (27 checks)
```

Open `http://localhost:4020` and track a wallet id to watch the balance move live.

### Use it from an existing SDK

```python
from anthropic import Anthropic

client = Anthropic(
    base_url="http://localhost:4020",
    api_key="unused",                                # PayAI bills the wallet
    default_headers={"x-payai-wallet": "my-agent"},
)
client.messages.create(model="claude-haiku-4-5", max_tokens=256,
                       messages=[{"role": "user", "content": "hello"}])
```

### Use it from an agent over MCP

```json
{
  "mcpServers": {
    "payai": {
      "command": "node",
      "args": ["src/mcp/server.js"],
      "env": { "PAYAI_PROXY_URL": "http://localhost:4020", "PAYAI_WALLET": "my-agent" }
    }
  }
}
```

Tools: `payai_chat` (paid), `payai_wallet`, `payai_receipts`. When the wallet runs
dry, `payai_chat` returns the x402 payment terms in its result so the agent can
settle and retry without a human.

## How billing works

1. **Reserve** — estimate the request's cost and hold it from the balance.
2. **Proxy** — stream the request upstream, capturing real token usage.
3. **Reconcile** — charge actual usage, refund the difference.

Every reservation settles exactly once. A `res.on("close")` hook releases any hold
that was never reconciled, so an upstream 500, a dead provider, or a client that
hangs up mid-stream cannot silently keep the caller's money.

Balances live in SQLite (`node:sqlite`, no native build step) and survive restarts.

## API

| Endpoint | Purpose |
|---|---|
| `POST /v1/messages` | Anthropic Messages API (drop-in) |
| `POST /v1/chat/completions` | OpenAI Chat Completions (drop-in) |
| `GET /api/wallet/:id` | Balance and usage — read-only, never mints credit |
| `GET /api/wallet/:id/receipts` | Verifiable spend history + funding settlements |
| `POST /api/wallet/:id/fund` | x402 top-up (402 with payment terms, then settle) |
| `POST /api/wallet/:id/challenge` | Nonce for proof-of-ownership signing |
| `GET /api/wallet/:id/events` | SSE feed of balance changes |
| `GET /.well-known/x402` | Discovery manifest for agent indexes |
| `GET /health` | Status, x402 readiness, policy config |

Identify a wallet with `x-payai-wallet: <id>` or `Authorization: PayAI wallet=<id>`.

## Wallet ownership

A wallet id alone is a bearer secret. Once a wallet is funded by a real x402 payer,
that payer's address is bound to it and spending requires a signature from the same
key — challenge at `POST /api/wallet/:id/challenge`, sign the returned message,
resend with `x-payai-nonce` and `x-payai-signature`. Nonces are single-use.

`PAYAI_WALLET_AUTH` controls this: `owned` (default — only funded wallets are
protected, so the faucet demo still works), `strict` (every wallet), `off`.

```bash
npm run test:auth   # proves an id alone cannot spend a funded wallet
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4020` | Listen port |
| `PAYAI_PUBLIC_URL` | `http://localhost:$PORT` | **Must** match the deployed origin — x402 terms embed it |
| `PAYAI_MOCK_ANTHROPIC` | `true` | Fake provider; set `false` to proxy the real API |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | — | Upstream credentials |
| `PAYAI_DB_PATH` | `./data/payai.db` | SQLite location |
| `PAYAI_INITIAL_BALANCE_USD` | `0.05` | Free starting balance |
| `PAYAI_MAX_FREE_WALLETS` | `500` | Faucet cap — caps total free exposure |
| `PAYAI_WALLET_AUTH` | `owned` | `owned` / `strict` / `off` |
| `PAYAI_RATE_LIMIT_RPM` | `60` | Per-wallet requests/minute (`0` = off) |
| `PAYAI_HOURLY_BUDGET_USD` | `0` | Per-wallet rolling hourly spend cap |
| `PAYAI_MAX_REQUEST_USD` | `0` | Reject requests estimated above this |
| `PAYAI_ALLOWED_MODELS` | — | Comma-separated allowlist |
| `PAYAI_ADMIN_TOKEN` | — | Required to list all wallets |
| `PAYAI_EVM_PAY_TO` / `PAYAI_SVM_PAY_TO` | — | Settlement addresses; unset ⇒ demo mode |
| `X402_FACILITATOR_URL` | `https://x402.org/facilitator` | Verify/settle service |

## Operational behavior

- **The facilitator is not a hard dependency.** If it is unreachable at boot, PayAI
  still starts, still serves inference, and returns plain 402s explaining why —
  `/health` reports `x402.ready: false` with the error. A payments outage is not a
  service outage.
- **Failing to bind the port exits non-zero**, so a broken deploy fails its health
  check instead of reporting success.
- **Settlements are replay-protected** — a payment is credited exactly once, keyed
  on its onchain transaction.

## Tests

```bash
npm run test:all       # 27 checks: metering, refunds, 402, policy, persistence
npm run test:auth      # wallet ownership proof (needs PAYAI_WALLET_AUTH=strict)
npm run test:mcp       # drives the MCP server as an agent would
npm run test:402       # the demo path: drain → top up → retry
```

## Project layout

```
src/
  server.js              express app, lifecycle, error handling
  config.js              env → typed config
  billing/pricing.js     per-model rates, cost estimation
  middleware/
    wallet.js            wallet resolution
    wallet-auth.js       ownership proof (challenge/signature)
    policy.js            rate limits, budgets, model allowlist
    billing-gate.js      reserve → settle-exactly-once
  proxy/                 anthropic, openai, streaming engine, usage parsing
  routes/                messages, chat, wallet, discovery
  store/
    db.js                SQLite schema and statements
    ledger.js            balances, receipts, settlement
  mcp/server.js          MCP server exposing paid tools
```

## Publishing it

`deploy/cloudflare/` sets PayAI up behind a Cloudflare Tunnel at a public
hostname — no open port, no certificate. Read that README before deploying:
`PAYAI_PUBLIC_URL` has to equal the public origin or x402 signatures stop
matching, and this network needs the tunnel pinned to HTTP/2.

## What's next

See [IDEAS.md](IDEAS.md) for the integration roadmap and the open architectural
questions.
