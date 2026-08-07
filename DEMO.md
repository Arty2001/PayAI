# Running the PayAI demo

Everything here has been tested against the live site. Nothing in this document
is aspirational.

---

## 1. What you are actually showing

Say this out loud until it's yours:

> Every way to buy AI inference assumes a human. An email, a credit card, a
> dashboard login, an API key that a person was issued. An autonomous agent has
> none of those. PayAI is an LLM proxy where the agent pays for its own tokens
> in stablecoin over HTTP 402 — the "Payment Required" status code that has been
> in the spec since 1997 and never had a use. You point any SDK at it by
> changing one URL. It works with no account and no key.

**The one sentence that matters:** the pitch is not "we accept crypto." It is
**the absence of an account**. A piece of software that has never met a human can
buy inference, and every charge traces to a transaction it can verify itself.

If you only get one idea across, that's the one.

---

## 2. Pre-flight — 30 minutes before you present

### 2a. Switch off the mock provider

Right now PayAI returns **fake** model replies. A judge will ask "is that a real
model?" and you want the answer to be yes.

In `.env`, change:

```
PAYAI_MOCK_ANTHROPIC=false
```

Then restart the server (below). Verified working — real Claude Haiku 4.5
answers through the proxy, and it costs you about $0.0001 per call while PayAI
charges $0.005, so you are running at a margin. That's a good answer if anyone
asks about the business.

Leave it `true` only if the venue wifi is so bad that an upstream API call is a
risk. The mock replies still prove the payment mechanics; they just aren't a
real model.

### 2b. Start both halves

PayAI is two processes. **Both must be running.** The tunnel is a reverse proxy
to this laptop — if the app is down, the domain serves an error; if the tunnel
is down, the domain doesn't resolve to anything useful.

Terminal 1 — the app:

```powershell
cd C:\Users\athav\Documents\PayAI
npm start
```

Terminal 2 — the tunnel:

```powershell
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel run payai
```

### 2c. Turn off sleep

`payai.lanvar.ai` points at this machine. If it sleeps, your demo URL dies and
so does the repo's homepage link.

Settings → System → Power → Screen and sleep → **Never** on all four.

### 2d. Confirm it's actually up

```powershell
curl.exe -s https://payai.lanvar.ai/health
```

You want `"status":"ok"`, `"mockAnthropic":false`, and `"ready":true` under
`x402`. If `ready` is false the payment leg will not work — restart the app.

### 2e. Check the payer wallet still has USDC

The demo spends real testnet USDC. Last checked: **19.9 USDC**, which is ~199
top-ups. You will not run out. If you somehow do:
[faucet.circle.com](https://faucet.circle.com), pick Base Sepolia, paste
`0x19017B6d37E64cdfD57DE4d61A119e667B10aA1B`.

The payer holds **0 ETH and does not need any** — x402 signs an EIP-3009
authorization offchain and the facilitator pays the gas. That's worth saying on
stage; it's the detail that makes agent payments practical.

### 2f. Set the stage

Have these open before you walk up:

| Where | What |
|---|---|
| Browser tab 1 | `https://payai.lanvar.ai` — full screen |
| Browser tab 2 | `https://sepolia.basescan.org` — for the transaction |
| Terminal 3 | `cd C:\Users\athav\Documents\PayAI` — the one you type in |

Pick your wallet id now and use it everywhere. Something short you can say out
loud: **`stage`**.

**Pre-type your commands** and leave them unexecuted, or put them in your shell
history so up-arrow works. Do not type long commands live in front of judges.

---

## 3. The three-minute run

Three minutes is much shorter than it sounds. This is timed to land at 2:50.

### Beat 1 — the problem (0:00–0:25)

Dashboard on screen, nothing running yet.

> "This is PayAI. Every way to buy AI inference assumes a human — a card, an
> account, an API key someone issued. An agent has none of that. So here's an
> agent buying its own inference, with no account anywhere."

Type your wallet id `stage` into the **Watching** field, press Watch.

Point at the panel: balance `$0.000000`, all marks dark. Say:

> "Nothing here yet. Each of these marks is one paid call."

### Beat 2 — it just works (0:25–1:10)

In terminal 3:

```powershell
$env:PAYAI_PROXY_URL="https://payai.lanvar.ai"; $env:PAYAI_WALLET="stage"; npm run test:messages
```

While it runs:

> "That's the standard Anthropic SDK. The only thing I changed is the base URL —
> it points at payai.lanvar.ai instead of api.anthropic.com. No API key in that
> request at all."

The reply comes back from real Claude. **Point at the dashboard**: the wallet
opened with $0.05 of faucet credit, one mark just went dark, and the wire on the
right shows the call with its real token counts.

> "Ten marks, ten calls. It metered the actual tokens and charged for them."

### Beat 3 — the money runs out (1:10–1:45)

This is the moment the whole thing exists for. Run it again nine times:

```powershell
1..9 | ForEach-Object { npm run test:messages }
```

Watch the marks go out one at a time. When the last one dies, **the panel turns
red** — the number goes vermilion, the border changes, and top-up becomes the
only lit control.

Run one more call so it 402s:

```powershell
npm run test:messages
```

> "That's a real HTTP 402. And it isn't just an error — the response carries
> machine-readable payment terms. The amount, the network, the address. An agent
> reads this and knows exactly how to pay. No human has been involved yet."

### Beat 4 — the agent pays itself (1:45–2:35)

```powershell
npm run pay
```

Read the output as it appears — it narrates itself:

```
Paying…  (402 → sign EIP-3009 → settle onchain)
Settled ✓
  credited   $0.100000
  tx         0x02e9c5ef...
Verifying onchain (PayAI reads the chain through QuickNode)…
  ✓ verified · block 45149251 · $0.100000 onchain
```

> "It signed a stablecoin authorization, a facilitator settled it on Base, and
> PayAI then read the chain itself to confirm the money actually moved — it
> doesn't take the facilitator's word for it."

**Copy the tx hash into the Basescan tab.** Show the real transaction. This is
the single most convincing thing in the demo — do not skip it.

Back to the dashboard: the marks are lit again. Run one more call:

```powershell
npm run test:messages
```

> "And it's working again. Paid, settled, verified, spending — nobody logged in
> to anything."

### Beat 5 — close (2:35–2:50)

> "x402 is a Linux Foundation standard now, with Coinbase, Cloudflare, Stripe
> and Visa behind it. Nobody had pointed it at the thing agents actually consume
> most, which is tokens. That's PayAI. It's live at payai.lanvar.ai, the repo is
> public, and every charge has a receipt anchored to a transaction."

Stop talking. Let them ask.

---

## 3b. The encore: a coding agent that pays for itself

If you have time after the main run, or if a judge asks "so how would an agent
actually use this," show PayAI as an MCP server. Your editor's agent calls a
paid tool, and the meter on the dashboard ticks down while they watch.

Both configs are committed in the repo, pointed at the live site:
`.mcp.json` for Claude Code, `.cursor/mcp.json` for Cursor.

### Claude Code

Project MCP servers need a one-time approval. **Do this before you present** —
you don't want a permission prompt on stage.

```powershell
cd C:\Users\athav\Documents\PayAI
claude
```

It asks whether to trust the `payai` server from `.mcp.json`. Approve it. Then
confirm:

```powershell
claude mcp list      # payai should say Connected, not Pending approval
```

In a session, `/mcp` lists the three tools. Ask for one by name:

> "Use the payai_chat tool to ask what HTTP 402 is for."

Claude Code calls the tool, PayAI meters it, and a mark goes dark on the
dashboard. Then:

> "Now call payai_wallet."

It reads back the balance it just spent from.

### Cursor

Cursor picks up `.cursor/mcp.json` from the project. Settings → MCP → enable
`payai` if it isn't already. Then ask the agent the same thing in Composer.

### What to say

> "That's my editor's agent calling a paid tool. It has no API key for this — it
> has a wallet. When the wallet runs dry the tool doesn't just fail, it returns
> the payment terms, and the agent can settle and retry on its own."

Drain the wallet first if you want to show that: the tool returns a
`payment_required` result carrying the full x402 terms, which is exactly what an
autonomous agent needs to pay without a human.

### What I could not make work

Routing Claude Code's **own** inference through PayAI —
`ANTHROPIC_BASE_URL=https://payai.lanvar.ai` plus a wallet header — is
technically possible and I saw PayAI correctly bill and 402 a real Claude Code
request. But it was not reliable: on a second run Claude Code answered without
the request ever reaching PayAI, most likely because this install is
OAuth-authenticated and doesn't consistently honor the override. It also
reserves about **$1.64 per turn**, because Claude Code sends a large system
prompt with a high `max_tokens` — a $0.10 top-up covers zero turns.

Don't demo it. If someone asks whether it's possible, the honest answer is
"yes, and PayAI meters it correctly, but the client-side override isn't
dependable enough to put on stage."

---

## 4. What's on the screen, so you can answer anything

| Element | What it means |
|---|---|
| **Balance** | Prepaid credit in USD, 6 decimals — same precision as USDC |
| **The marks** | One per paid call at the $0.005 minimum charge. Makes the balance physical: it *is* quantized into requests |
| **Held** | Money reserved for a request in flight. Returns if the request fails |
| **Spent / Calls** | Lifetime totals for this wallet |
| **Owner** | The address that funded it. Once set, only that key can spend |
| **The wire** | Every metered call with real token counts and cost |
| **Amber vs red** | Amber is money. Red means one thing only: payment required |

**How billing works** (you will be asked): reserve an estimate → proxy the call →
charge actual token usage → refund the difference. Every reservation settles
exactly once; if the upstream provider fails, the hold is released rather than
kept.

---

## 5. Questions you will get

**"Is that a real model response?"**
Yes — Claude Haiku 4.5, through the real Anthropic API. Show the token counts on
the wire; they're the actual usage the meter charged against.

**"Is that real money?"**
Real USDC on Base Sepolia, which is a testnet — so the dollars aren't real, but
every mechanism is: real signature, real onchain settlement, real verification.
Moving to mainnet is a config change, not a rewrite.

**"What stops me spending someone else's balance?"**
Once a wallet is funded, it binds to the paying address, and spending then needs
a signature over a single-use nonce. `npm run test:auth` proves it — eight
checks including that a captured signature can't be replayed.

**"What if the payment provider lies?"**
PayAI reads the chain itself through QuickNode and confirms USDC actually
reached its address, from the real token contract, for at least the credited
amount. It distinguishes "couldn't check" from "the chain disagrees."

**"How is this different from OpenRouter?"**
OpenRouter is one balance for many models and charges 5% on crypto top-ups —
behind an account. The difference isn't price, it's that PayAI needs no account
at all. An agent that has never met a human can use it.

**"What's actually hard here?"**
Not taking people's money by accident. Every reservation settles exactly once —
a response-close hook releases any hold that was never reconciled, so an
upstream 500 or a client hanging up mid-stream can't silently keep your money.
27 automated checks cover it, including a hard kill mid-suite to prove balances
survive a crash.

**"Where does it go next?"**
It's an MCP server too, so agents can use it as a tool directly, and it
publishes a discovery manifest so they can find it without a human integrating
anything.

---

## 6. When something breaks

**The site won't load.** Check both processes. The app: `curl.exe -s
http://127.0.0.1:4020/health`. The tunnel: is terminal 2 still running? Restart
whichever is dead. First request after starting the tunnel is sometimes slow —
reload once.

**A call returns 402 when you didn't expect it.** The wallet is out of credit.
`npm run pay`, or use a fresh wallet id — new ones open with $0.05.

**`npm run pay` fails.** Check `curl.exe -s https://payai.lanvar.ai/health` shows
`x402.ready: true`. If false, restart the app. Worst case, switch to a fresh
wallet id and demo the faucet credit — you lose the payment beat but keep
everything else.

**Real Claude is timing out on venue wifi.** Set `PAYAI_MOCK_ANTHROPIC=true` and
restart. Replies become synthetic but every payment mechanic still works. Say
so if asked — don't claim a mock is real.

**Everything is on fire.** The repo is public, the README works, and
`npm run test:all` runs the whole thing locally with no network. Walk them
through that instead.

---

## 7. The one-line cheat sheet

Everything below already targets `https://payai.lanvar.ai` — no environment
setup, nothing to mistype on stage.

```powershell
# terminal 1 - the app
npm start

# terminal 2 - the tunnel
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel run payai

# terminal 3 - the demo
npm run demo          # one metered call against the live site
npm run demo:pay      # top up with real USDC over x402
```

`npm run demo` uses wallet `stage` by default. To use another:

```powershell
$env:PAYAI_WALLET="alice"; npm run demo
```

Drain to 402 in one line:

```powershell
1..10 | ForEach-Object { npm run demo }
```

**If a page load or a call returns nothing at all**, the tunnel occasionally
drops a single request — I saw it three times during testing, always transient.
Reload or re-run. It is not the app; check `http://127.0.0.1:4020/health` if you
want to confirm.
