/**
 * Demo script: fake Anthropic calls that drain wallet balance.
 * Works with PAYAI_MOCK_ANTHROPIC (default when no API key).
 *
 * Usage:
 *   npm run demo:anthropic
 *   PAYAI_WALLET=0xdemo npm run demo:anthropic
 */

const PROXY_URL = process.env.PAYAI_PROXY_URL ?? "http://localhost:4020";
const WALLET = process.env.PAYAI_WALLET ?? "0xdemo";

const PROMPTS = [
  "Reply with exactly: PayAI proxy is working.",
  "Explain x402 in one sentence.",
  "What is a stablecoin?",
];

async function getBalance() {
  const res = await fetch(`${PROXY_URL}/api/wallet/${encodeURIComponent(WALLET)}`);
  const data = await res.json();
  return data.balanceUsd;
}

async function simulateFund() {
  const res = await fetch(`${PROXY_URL}/api/wallet/${encodeURIComponent(WALLET)}/simulate-fund`, {
    method: "POST",
  });
  if (!res.ok) {
    console.warn("simulate-fund unavailable:", await res.text());
    return false;
  }
  const data = await res.json();
  console.log(`  ↳ simulated top-up → balance $${data.balanceUsd.toFixed(6)}`);
  return true;
}

async function callMessages(prompt, i) {
  const res = await fetch(`${PROXY_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-payai-wallet": WALLET,
    },
    body: JSON.stringify({
      model: "claude-3-haiku-20240307",
      max_tokens: 128,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (res.status === 402) {
    console.log(`\n[${i + 1}] 402 — wallet empty, simulating top-up…`);
    await simulateFund();
    return callMessages(prompt, i);
  }

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reply = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const line of buffer.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6));
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          reply += event.delta.text;
        }
      } catch { /* ignore */ }
    }
    buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
  }

  const balance = await getBalance();
  console.log(`[${i + 1}] "${prompt.slice(0, 40)}…"`);
  console.log(`     → ${reply.trim().slice(0, 100)}${reply.length > 100 ? "…" : ""}`);
  console.log(`     balance: $${balance.toFixed(6)}\n`);
}

async function main() {
  console.log("PayAI fake Anthropic demo");
  console.log(`Proxy:  ${PROXY_URL}`);
  console.log(`Wallet: ${WALLET}`);
  console.log(`Start:  $${(await getBalance()).toFixed(6)}\n`);

  for (let i = 0; i < PROMPTS.length; i += 1) {
    await callMessages(PROMPTS[i], i);
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(`Done. Final balance: $${(await getBalance()).toFixed(6)}`);
  console.log(`Dashboard: ${PROXY_URL}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
