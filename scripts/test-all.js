/**
 * Full regression suite. Spawns its own server on a scratch database, exercises
 * every guarantee PayAI claims, and cleans up after itself.
 *
 *   npm run test:all
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PAYAI_TEST_PORT ?? 4055);
const BASE = `http://localhost:${PORT}`;
const DB = path.resolve("./data/test-all.db");

let passed = 0;
let failed = 0;
const failures = [];

function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed += 1;
  } else {
    console.log(`  FAIL  ${name} ${detail}`);
    failures.push(`${name} ${detail}`);
    failed += 1;
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function cleanDb() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(DB + suffix);
    } catch {
      // not there
    }
  }
}

function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, ["src/server.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      PAYAI_DB_PATH: DB,
      PAYAI_MOCK_ANTHROPIC: "true",
      PAYAI_RATE_LIMIT_RPM: "0",
      OPENAI_API_KEY: "",

      // Pin everything the suite asserts on. The server loads .env via dotenv,
      // which fills in any key the child does not already have — so without
      // these, a developer's real settlement address or auth mode leaks in and
      // the suite starts testing their machine instead of the code. An empty
      // string still counts as "already set", so dotenv leaves it alone.
      PAYAI_EVM_PAY_TO: "",
      PAYAI_SVM_PAY_TO: "",
      PAYAI_DEMO_MODE: "true",
      PAYAI_WALLET_AUTH: "off",
      PAYAI_INITIAL_BALANCE_USD: "0.05",
      PAYAI_MAX_FREE_WALLETS: "500",
      PAYAI_MAX_SIMULATED_TOPUPS: "10",
      PAYAI_HOURLY_BUDGET_USD: "0",
      PAYAI_MAX_REQUEST_USD: "0",
      PAYAI_ALLOWED_MODELS: "",
      PAYAI_ADMIN_TOKEN: "",
      PAYAI_VERIFY_SETTLEMENTS: "false",
      PAYAI_QUICKNODE_RPC_URL: "",
      PAYAI_QUICKNODE_X402: "false",

      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

async function waitForHealth(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not become healthy");
}

async function stopServer(child) {
  child.kill();
  await new Promise((r) => setTimeout(r, 600));
}

const json = async (url, init) => {
  const res = await fetch(url, init);
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const ask = (wallet, body = {}) =>
  json(`${BASE}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-payai-wallet": wallet },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 64,
      messages: [{ role: "user", content: "regression" }],
      ...body,
    }),
  });

const balance = async (wallet) => (await json(`${BASE}/api/wallet/${encodeURIComponent(wallet)}`)).body;

/**
 * A minimal OpenAI-compatible upstream that answers in SSE chunks and reports
 * usage in a final frame, so the proxy's streaming path runs for real.
 */
async function startFakeStreamingUpstream() {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    chunk({ id: "x", model: "gpt-4o-mini", choices: [{ delta: { content: "hello" }, index: 0 }] });
    chunk({ id: "x", model: "gpt-4o-mini", choices: [{ delta: {}, finish_reason: "stop", index: 0 }] });
    chunk({ id: "x", model: "gpt-4o-mini", choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => server.close() };
}

async function main() {
  cleanDb();
  let server = startServer();
  await waitForHealth();

  try {
    section("health + discovery");
    const health = await json(`${BASE}/health`);
    check("health is ok", health.body.status === "ok");
    check("health reports wallet auth mode", typeof health.body.walletAuth === "string");
    check("health reports x402 state", typeof health.body.x402?.configured === "boolean");

    const manifest = await json(`${BASE}/.well-known/x402`);
    check("discovery manifest is served", manifest.status === 200);
    check("manifest advertises both endpoints", manifest.body.resources?.length === 2, JSON.stringify(manifest.body.resources?.length));
    check("manifest declares per-token pricing", manifest.body.pricing?.model === "per-token");

    section("faucet cannot be farmed");
    const unknown = await balance(`ghost-${Date.now()}`);
    check("GET on an unknown wallet mints nothing", unknown.balanceUsd === 0 && unknown.exists === false);
    const listing = await json(`${BASE}/api/wallet`);
    check("wallet listing is not enumerable", listing.body.wallets === undefined && !!listing.body.stats);

    section("metering");
    const w = `reg-${Date.now().toString(36)}`;
    const first = await ask(w);
    check("first request succeeds", first.status === 200, `got ${first.status}`);
    const afterOne = await balance(w);
    check("balance dropped by one request", afterOne.balanceUsd === 0.045, `got ${afterOne.balanceUsd}`);
    check("held funds settle back to zero", afterOne.heldUsd === 0, `got ${afterOne.heldUsd}`);
    check("usage was recorded", afterOne.requestCount === 1, `got ${afterOne.requestCount}`);

    section("failed requests do not charge");
    const before = (await balance(w)).balanceUsd;
    const broken = await json(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-payai-wallet": w },
      body: JSON.stringify({ model: "gpt-4o-mini", max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
    });
    check("misconfigured provider returns an error", broken.status >= 400, `got ${broken.status}`);
    const after = await balance(w);
    check("balance is unchanged after failure", after.balanceUsd === before, `${before} -> ${after.balanceUsd}`);
    check("no hold left dangling", after.heldUsd === 0, `got ${after.heldUsd}`);

    section("402 at exhaustion, then top-up");
    let last = null;
    for (let i = 0; i < 20; i += 1) {
      last = await ask(w);
      if (last.status === 402) break;
    }
    check("drains to HTTP 402", last.status === 402, `got ${last.status}`);
    check("402 body states the shortfall", typeof last.body.shortfallUsd === "number");

    const funded = await json(`${BASE}/api/wallet/${encodeURIComponent(w)}/simulate-fund`, { method: "POST" });
    check("demo top-up credits the wallet", funded.body.status === "simulated_credit", JSON.stringify(funded.body));
    const retry = await ask(w);
    check("request succeeds after top-up", retry.status === 200, `got ${retry.status}`);

    section("receipts");
    const receipts = (await json(`${BASE}/api/wallet/${encodeURIComponent(w)}/receipts`)).body;
    check("usage receipts are recorded", receipts.usage?.length > 0, `got ${receipts.usage?.length}`);
    check("receipts carry token counts", receipts.usage?.[0]?.inputTokens > 0);
    check("receipts carry cost", receipts.usage?.[0]?.costUsd > 0);

    section("policy engine");
    await stopServer(server);
    server = startServer({ PAYAI_RATE_LIMIT_RPM: "3", PAYAI_ALLOWED_MODELS: "claude-haiku-4-5" });
    await waitForHealth();

    const pw = `pol-${Date.now().toString(36)}`;
    const denied = await ask(pw, { model: "gpt-4o" });
    check("model allowlist is enforced", denied.status === 403, `got ${denied.status}`);

    const codes = [];
    for (let i = 0; i < 5; i += 1) codes.push((await ask(pw)).status);
    check("rate limit returns 429", codes.includes(429), codes.join(","));

    section("streamed responses are charged");
    // The mock provider writes its body directly and finalizes synchronously,
    // so it never exercises pipeUpstreamStream - the path a real provider takes.
    // A streamed call there once billed $0.00: 'close' fired before usage was
    // parsed, the safety-net refund marked the request settled, and the real
    // charge silently became a no-op. Every streamed call was free. This stands
    // up a fake SSE upstream so that path is covered without a provider key.
    const upstream = await startFakeStreamingUpstream();
    await stopServer(server);
    server = startServer({
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: `http://127.0.0.1:${upstream.port}`,
    });
    await waitForHealth();

    const sw = `stream-${Date.now().toString(36)}`;
    const streamed = await json(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-payai-wallet": sw },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "stream" }],
      }),
    });
    check("streamed request succeeds", streamed.status === 200, `got ${streamed.status}`);

    await new Promise((r) => setTimeout(r, 400));
    const afterStream = await balance(sw);
    check(
      "a streamed call is actually charged",
      afterStream.totalSpentMicroUsd > 0,
      `spent ${afterStream.totalSpentMicroUsd} micro-USD - 0 means the refund beat the charge`,
    );
    check("streamed call leaves no hold", afterStream.heldUsd === 0, `got ${afterStream.heldUsd}`);
    upstream.close();

    section("persistence across restart");
    const survivor = `persist-${Date.now().toString(36)}`;
    await ask(survivor);
    const beforeRestart = await balance(survivor);
    await stopServer(server);
    server = startServer();
    await waitForHealth();
    const afterRestart = await balance(survivor);
    check(
      "balance survives a restart",
      afterRestart.balanceUsd === beforeRestart.balanceUsd,
      `${beforeRestart.balanceUsd} -> ${afterRestart.balanceUsd}`,
    );
    check("request history survives a restart", afterRestart.requestCount === beforeRestart.requestCount);
    const survivorReceipts = (await json(`${BASE}/api/wallet/${encodeURIComponent(survivor)}/receipts`)).body;
    check("receipts survive a restart", survivorReceipts.usage?.length > 0);
  } finally {
    await stopServer(server);
    cleanDb();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
