/**
 * Drain a wallet until HTTP 402, show the payment payload, then simulate top-up.
 *
 * Usage:
 *   npm run test:402
 *   PAYAI_WALLET=mywallet npm run test:402
 */

const PROXY_URL = process.env.PAYAI_PROXY_URL ?? "http://localhost:4020";
const WALLET = process.env.PAYAI_WALLET ?? `402demo-${Date.now().toString(36)}`;

async function balance() {
  const res = await fetch(`${PROXY_URL}/api/wallet/${encodeURIComponent(WALLET)}`);
  return res.json();
}

async function messages() {
  return fetch(`${PROXY_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-payai-wallet": WALLET,
    },
    body: JSON.stringify({
      model: "claude-3-haiku-20240307",
      max_tokens: 64,
      stream: false,
      messages: [{ role: "user", content: "Reply with exactly: PayAI proxy is working." }],
    }),
  });
}

async function main() {
  console.log(`Proxy:  ${PROXY_URL}`);
  console.log(`Wallet: ${WALLET}`);
  let bal = await balance();
  console.log(`Start:  $${Number(bal.balanceUsd).toFixed(6)}\n`);

  let hit = null;
  for (let i = 1; i <= 30; i += 1) {
    const res = await messages();
    if (res.status === 402) {
      hit = await res.json();
      console.log(`Request #${i} → HTTP 402 Payment Required\n`);
      console.log(JSON.stringify(hit, null, 2));
      break;
    }
    if (!res.ok) {
      throw new Error(`Unexpected ${res.status}: ${await res.text()}`);
    }
    bal = await balance();
    console.log(`#${i} OK · balance $${Number(bal.balanceUsd).toFixed(6)}`);
  }

  if (!hit) {
    console.error("Never hit 402 — try a fresh wallet or lower balance.");
    process.exit(1);
  }

  console.log("\n--- simulate top-up ---");
  const fundRes = await fetch(
    `${PROXY_URL}/api/wallet/${encodeURIComponent(WALLET)}/simulate-fund`,
    { method: "POST" },
  );
  const fund = await fundRes.json();
  console.log(JSON.stringify(fund, null, 2));

  console.log("\n--- retry after top-up ---");
  const retry = await messages();
  console.log(`HTTP ${retry.status}`);
  if (retry.ok) {
    const data = await retry.json();
    const text = data.content?.find((b) => b.type === "text")?.text ?? "(ok)";
    console.log(`Reply: ${text}`);
  } else {
    console.log(await retry.text());
  }

  bal = await balance();
  console.log(`\nFinal balance: $${Number(bal.balanceUsd).toFixed(6)}`);
  console.log(`Dashboard: track "${WALLET}" at ${PROXY_URL}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
