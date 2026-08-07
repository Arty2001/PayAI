/**
 * One command that answers "can I walk up and demo this right now?"
 *
 * Checks the things that have actually broken during setup, in the order they
 * would bite on stage, and ends with a real metered call against the public URL
 * so a green result means the whole chain worked, not that six pieces of it
 * looked healthy in isolation.
 *
 *   npm run preflight
 */

import "dotenv/config";

const LIVE = process.env.PAYAI_PROXY_URL ?? "https://payai.lanvar.ai";
const LOCAL = `http://127.0.0.1:${process.env.PORT ?? 4020}`;

const pass = [];
const warn = [];
const fail = [];

const ok = (m, d = "") => { pass.push(m); console.log(`  ok    ${m}${d ? `  ${d}` : ""}`); };
const meh = (m, d = "") => { warn.push(m); console.log(`  warn  ${m}${d ? `  ${d}` : ""}`); };
const bad = (m, d = "") => { fail.push(m); console.log(`  FAIL  ${m}${d ? `  ${d}` : ""}`); };

async function json(url, init, ms = 25_000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

console.log("\nPayAI preflight\n───────────────────────────────────────────────");

/* 1. Is the app running at all? */
try {
  const { body } = await json(`${LOCAL}/health`, {}, 8000);
  ok("app is running", `pid on ${LOCAL}`);

  if (body.mockAnthropic) {
    bad("model replies are FAKE", "set PAYAI_MOCK_ANTHROPIC=false and restart");
  } else {
    ok("model replies are real");
  }

  if (body.x402?.ready) ok("x402 settlement ready", body.x402.facilitatorUrl);
  else bad("x402 NOT ready", body.x402?.error ?? "payments will fail");

  const v = body.x402?.verification;
  if (v?.verifySettlements) ok("onchain verification on", `${v.mode} · ${v.endpoint ?? ""}`);
  else meh("onchain verification off", "payments still work, receipts say unverifiable");

  if (body.ledger?.faucetRemaining > 20) ok("faucet has room", `${body.ledger.faucetRemaining} wallets left`);
  else meh("faucet nearly exhausted", `${body.ledger?.faucetRemaining} left`);
} catch (err) {
  bad("app is NOT running", `start it: npm start  (${err.message})`);
}

/* 2. Is it reachable from the internet? This is what judges hit. */
try {
  const res = await fetch(`${LIVE}/health`, { signal: AbortSignal.timeout(25_000) });
  if (res.ok) ok("public URL reachable", LIVE);
  else bad("public URL returned " + res.status, "is the tunnel running?");
} catch (err) {
  bad("public URL unreachable", `start the tunnel  (${err.message})`);
}

/* 3. Can the payer actually pay? A demo that 402s with no way out is a dead end. */
try {
  const { privateKeyToAccount } = await import("viem/accounts");
  const { createPublicClient, http, erc20Abi } = await import("viem");
  const { baseSepolia } = await import("viem/chains");

  const key = process.env.PAYAI_PAYER_PRIVATE_KEY;
  if (!key) {
    bad("no payer key", "npm run keygen, then fund at faucet.circle.com");
  } else {
    const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
    const client = createPublicClient({ chain: baseSepolia, transport: http("https://sepolia.base.org") });
    const usdc = await client.readContract({
      address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account.address],
    });
    const balance = Number(usdc) / 1e6;
    const topUps = Math.floor(balance / Number(process.env.PAYAI_TOPUP_USD ?? 0.1));
    if (balance >= 0.5) ok("payer funded", `${balance.toFixed(2)} USDC — ~${topUps} top-ups`);
    else bad("payer nearly empty", `${balance.toFixed(2)} USDC — refill at faucet.circle.com`);
  }
} catch (err) {
  meh("could not read payer balance", err.message);
}

/* 4. The real test: spend money through the public URL end to end. */
const probe = `preflight-${Date.now().toString(36)}`;
try {
  const { status, body } = await json(`${LIVE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payai-wallet": probe },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 48,
      messages: [{ role: "user", content: "Reply with exactly: ready." }],
    }),
  }, 60_000);

  if (status === 200) {
    const text = body.content?.find((b) => b.type === "text")?.text ?? "";
    const tokens = `${body.usage?.input_tokens} in / ${body.usage?.output_tokens} out`;
    ok("end-to-end call works", `"${text.trim().slice(0, 40)}"  ${tokens}`);
  } else {
    bad(`end-to-end call returned ${status}`, JSON.stringify(body).slice(0, 120));
  }
} catch (err) {
  bad("end-to-end call failed", err.message);
}

/* 5. Editor integration, if they want the encore. */
try {
  const { readFileSync } = await import("node:fs");
  readFileSync(".mcp.json");
  readFileSync(".cursor/mcp.json");
  ok("MCP configs present", "approve once with: claude");
} catch {
  meh("MCP configs missing", "the encore won't work, main demo unaffected");
}

/* ── Verdict ─────────────────────────────────────────────── */

console.log("───────────────────────────────────────────────");
if (fail.length) {
  console.log(`\n  NOT READY — ${fail.length} blocking issue(s):\n`);
  for (const f of fail) console.log(`    · ${f}`);
  console.log("");
  process.exit(1);
}

const wallet = `stage-${new Date().toISOString().slice(11, 16).replace(":", "")}`;
console.log(`\n  READY${warn.length ? `  (${warn.length} warning(s), none blocking)` : ""}\n`);
console.log("  Run the demo:\n");
console.log(`    1. open ${LIVE}  and watch wallet:  ${wallet}`);
console.log(`    2. $env:PAYAI_WALLET="${wallet}"`);
console.log("    3. npm run demo        <- click Send a call on the page instead, if you prefer");
console.log("       ...ten times, until it 402s");
console.log("    4. npm run demo:pay    <- real USDC, shows the tx hash");
console.log("    5. npm run demo        <- 401 on purpose: the wallet is locked now");
console.log("    6. npm run spend       <- signed with the key that paid\n");
