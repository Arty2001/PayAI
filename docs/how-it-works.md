# PayAI, from scratch

Written to be read end to end by someone who knows nothing about it. Everything
here is implemented and was verified against the deployed system, not planned.

---

## 1. The problem

Buying AI inference assumes a human exists.

Every provider — OpenAI, Anthropic, OpenRouter, all of them — needs an email, a
credit card, a dashboard login, and an API key that a person was issued. That is
fine when a person is doing the buying.

It breaks the moment software is. An autonomous agent has no email address, no
card, and no way to click through a signup flow. So today an agent spends *its
operator's* key: a human anticipates the spend, provisions credentials, and
carries the risk. The agent can't buy anything on its own terms, can't be
metered independently, and can't be given a budget it is unable to talk its way
around.

That gap is the whole reason PayAI exists.

## 2. HTTP 402, dormant since 1997

HTTP has always had a status code for this. **402 Payment Required** was in the
HTTP/1.1 spec in 1997 and reserved for future use. It sat unused for nearly
thirty years because the web had no way to actually pay inside an HTTP round
trip — payments meant redirecting a human to a checkout page.

Stablecoins changed that. A payment can now be a signature, settled in seconds,
for a fraction of a cent.

**x402** is the protocol that fills in the blank. The exchange is four steps:

1. A client requests a resource.
2. The server answers **402** with machine-readable terms: amount, token,
   network, recipient address.
3. The client signs a payment authorization and retries with it in a header.
4. A *facilitator* verifies and settles onchain; the server returns the
   resource, plus a receipt.

No account. No key. No human. The protocol is governed by the Linux Foundation,
with Coinbase, Cloudflare, Stripe, AWS, Google, Visa and Mastercard behind it.

Nobody had pointed it at the thing agents actually consume most: **tokens**.

## 3. What PayAI is

An LLM proxy that speaks the Anthropic and OpenAI APIs verbatim, meters real
token usage, and bills it against a prepaid stablecoin balance over x402.

You point an existing SDK at it by changing one line:

```python
client = Anthropic(
    base_url="https://payai.lanvar.ai",   # was api.anthropic.com
    api_key="unused",                     # PayAI bills a wallet, not a key
    default_headers={"x-payai-wallet": "my-agent"},
)
```

That's the entire integration. Existing code, existing SDK, no API key.

**The claim is not "we accept crypto."** It is the absence of an account.
Software that has never interacted with a human can acquire inference capacity,
and every charge traces to a transaction it can independently verify.

## 4. What happens on a single request

```
request
  → identify the wallet        x-payai-wallet header
  → prove ownership            signature, once the wallet holds real money
  → apply policy               rate limit, budget, model allowlist
  → reserve                    hold an estimate, or return 402 with terms
  → proxy upstream             stream to the client, capture usage in flight
  → reconcile                  charge actual tokens, refund the rest
```

Six stages. The interesting ones are the money.

## 5. The money model

**Reserve, then reconcile.** You cannot know a request's cost before it runs —
output length isn't known until it's generated. So PayAI holds a conservative
estimate up front, proxies the call while capturing real token counts, then
charges actual usage and returns the difference.

Amounts are integer **micro-USD** throughout — six decimals, the same precision
as USDC — because floating-point money is how ledgers drift.

**The invariant that matters: every reservation settles exactly once.** Either
it reconciles against real usage, or it is released in full. A hold must never
be silently kept.

That is harder than it sounds. A request can die in a dozen ways — the provider
500s, a key is missing, the network drops, the client hangs up mid-stream. Each
is a path where naive code keeps the caller's money. Rather than patch each
`catch` block, PayAI attaches the guarantee to the response itself: when the
response closes, any hold that was never reconciled is released. Paths nobody
enumerated are covered too.

## 6. Who owns a balance

A wallet id is just a string the caller picks — `alice`, `my-agent`, anything.
There is no signup, because an agent can't do one. Naming a wallet is enough to
start, and a new one gets a small faucet credit.

That is obviously insufficient for real money, so ownership arrives with the
first payment. When an x402 payment settles, the facilitator reports **which
address signed it** — attested cryptographically, not self-declared. PayAI binds
that address to the wallet. From then on the name alone is worthless: spending
requires a signature over a single-use nonce, from the same key.

So the lifecycle is:

```
named        →  small trial credit, anyone with the name can spend
funded       →  bound to the paying key, only that key can spend
```

In production an agent simply uses **its own address as the wallet id**, and the
name and the key collapse into the same thing — no collision is possible,
because you can only pay from an address you hold.

## 7. Not trusting the payment layer

A settlement report is a claim. The facilitator says "paid, here's a hash," and
a naive proxy credits the balance on that word alone.

PayAI reads the chain itself and confirms the transaction succeeded, that USDC
moved **from the canonical token contract** to its own address, for at least the
amount credited. A lookalike token paying the right address for the right amount
is rejected.

It also distinguishes two very different negatives:

- `unverifiable` — we could not check (no RPC, unknown chain). Says nothing.
- `failed` — we checked and the chain disagrees. That is an alarm.

Verification runs out of band, so a slow node never delays a top-up.

There's a nice symmetry in how it reads the chain: PayAI buys its RPC calls from
QuickNode **over x402**, the same protocol it uses to sell inference. There is no
API key anywhere in the stack — not for the caller, not for the node provider.

## 8. Built for agents, not just for humans

**MCP server.** PayAI exposes itself as Model Context Protocol tools, so an
agent in Claude Code or Cursor can call a paid tool directly. When the wallet is
empty the tool doesn't just fail — it returns the x402 payment terms, so the
agent can settle and retry unattended.

**Discovery manifest.** `/.well-known/x402` publishes endpoints, per-model rates
and payment terms, so an agent can find PayAI through an index and integrate
without a human reading documentation.

## 9. The engineering that was actually hard

Not the payments — the protocol libraries handle those. It was **not taking
people's money by accident**. Five real bugs, all found by running the system
rather than reading it:

1. **Every error path stole money.** A 500 left the reservation deducted
   forever — money gone, no usage record. Fixed with the settle-exactly-once
   guarantee above.

2. **A public URL was an unlimited faucet.** A read-only balance lookup created
   the wallet it was looking up, minting free credit. Reads are now read-only,
   and the faucet is capped.

3. **A payments outage was a total outage.** If the facilitator was unreachable
   at boot, the process exited before it ever listened. Now it degrades: still
   serves inference, returns plain 402s, reports why.

4. **The meter read one-millionth of actual cost.** A unit conversion divided by
   a million where the conversion was the identity — USDC's six decimals already
   cancel the price denominator. A minimum-charge floor masked it completely, so
   every request billed the same $0.005 regardless of size. A 1M-token request
   billed half a cent instead of $30.

5. **Every streamed call was free.** The safety net from (1) raced itself: on a
   streamed response the body is piped before usage is parsed, so the response
   closed first, the refund fired, and the real charge arrived to find the
   request already settled. Deferring the release by one event-loop turn fixes
   it. This one was invisible under the mock provider, which finalizes
   synchronously and never runs the streaming path.

Four of the five were silent. Nothing errored; money just quietly went the wrong
way. That is the actual character of payments work.

## 10. Facts worth citing

- **30 automated checks**, including a hard process kill mid-run to prove
  balances, history and receipts survive a crash
- **8 verified onchain settlements** and **172 metered requests** to date, each
  charge traceable to a transaction on Base Sepolia
- The ledger is **SQLite via `node:sqlite`** — no dependency, no native build
  step, which matters on hosts that won't compile
- Charges are anchored to transactions: a receipts endpoint returns every charge
  alongside the settlement that funded it
- Live at **payai.lanvar.ai**, public repo at **github.com/Arty2001/PayAI**

## 11. What is and isn't real

Be precise about this, because overclaiming is the fastest way to lose
credibility with anyone technical.

**Real:** the model responses (Claude Haiku 4.5 through the actual API), the
token metering, the EIP-3009 signatures, the onchain settlement, the
verification, the receipts.

**Testnet:** Base Sepolia. The USDC came from a faucet and has no dollar value.
Every *mechanism* is production-real; the currency is play money. Moving to
mainnet is a configuration change — a network id and a token address — not a
rewrite.

**Notably, the payer needs no ETH.** x402's exact scheme signs an EIP-3009
authorization offchain and the facilitator broadcasts it and pays the gas. An
agent needs a stablecoin balance and nothing else — no gas management, which is
the detail that makes machine payments practical rather than theoretical.
