/**
 * Anthropic Messages API test client (no wallet = no billing; set X-PayAI-Wallet).
 *
 * Usage:
 *   npm run test:messages
 *   PAYAI_WALLET=0xdemo npm run test:messages
 */

const PROXY_URL = process.env.PAYAI_PROXY_URL ?? "http://localhost:4020";
const WALLET = process.env.PAYAI_WALLET ?? "0xdemo";
const stream = !process.argv.includes("--no-stream");
const userArgs = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const prompt = userArgs.find((a) => !/[/\\]/.test(a)) ?? "Reply with exactly: PayAI proxy is working.";

async function main() {
  const healthRes = await fetch(`${PROXY_URL}/health`).catch(() => null);
  if (healthRes?.ok) {
    const health = await healthRes.json();
    if (health.service === "payai-proxy") {
      console.error("Wrong server on " + PROXY_URL + " — that's the OLD build.");
      console.error("Stop it, then run: npm run dev");
      console.error("(Look for 'PayAI — crypto-native LLM proxy' and '(MOCK)' in the banner.)\n");
      process.exit(1);
    }
    if (health.mockAnthropic === false) {
      console.warn("Warning: mockAnthropic is OFF — set PAYAI_MOCK_ANTHROPIC=true and restart.\n");
    }
  }

  console.log(`Proxy:  ${PROXY_URL}/v1/messages`);
  console.log(`Wallet: ${WALLET}`);
  console.log(`Stream: ${stream}\n`);

  const response = await fetch(`${PROXY_URL}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-payai-wallet": WALLET,
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 64,
      stream,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (response.status === 402) {
    const body = await response.json();
    console.error("402 Payment Required — top up wallet:");
    console.error(JSON.stringify(body, null, 2));
    // Suggest the route that actually works here. simulate-fund 403s whenever a
    // pay-to address is configured, which is exactly when you're demoing the
    // real thing — a hint that fails is worse than no hint.
    console.error(
      body.demoMode
        ? `\nTop up:  curl -X POST ${PROXY_URL}/api/wallet/${WALLET}/simulate-fund`
        : `\nTop up:  PAYAI_WALLET=${WALLET} npm run pay`,
    );
    process.exit(1);
  }

  if (!response.ok) {
    console.error(`Request failed (${response.status}):\n${await response.text()}`);
    process.exit(1);
  }

  if (!stream) {
    const data = await response.json();
    const text = data.content?.find((b) => b.type === "text")?.text ?? JSON.stringify(data, null, 2);
    console.log(text);
  } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    process.stdout.write("Response: ");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const lineEnd = buffer.indexOf("\n");
        if (lineEnd === -1) break;
        const line = buffer.slice(0, lineEnd).replace(/\r$/, "");
        buffer = buffer.slice(lineEnd + 1);
        if (!line.startsWith("data: ")) continue;
        const payload = line.slice(6);
        if (payload === "[DONE]") continue;
        try {
          const event = JSON.parse(payload);
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            process.stdout.write(event.delta.text);
          }
        } catch { /* ignore */ }
      }
    }
    console.log();
  }

  console.log(`\nDone.`);

  const balRes = await fetch(`${PROXY_URL}/api/wallet/${encodeURIComponent(WALLET)}`);
  if (balRes.ok) {
    const bal = await balRes.json();
    console.log(`Wallet ${WALLET} balance: $${Number(bal.balanceUsd).toFixed(6)}  (spent $${((bal.totalSpentMicroUsd ?? 0) / 1e6).toFixed(6)})`);
    console.log(`Dashboard: track wallet "${WALLET}" at ${PROXY_URL}`);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
