/**
 * OpenAI-compatible chat completions test client.
 *
 * Usage:
 *   npm run test:chat
 */

const PROXY_URL = process.env.PAYAI_PROXY_URL ?? "http://localhost:4020";
const WALLET = process.env.PAYAI_WALLET ?? "0xdemo-wallet";

async function main() {
  console.log(`Proxy:  ${PROXY_URL}/v1/chat/completions`);
  console.log(`Wallet: ${WALLET}\n`);

  const response = await fetch(`${PROXY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-payai-wallet": WALLET,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "Say exactly: PayAI OpenAI route works." }],
    }),
  });

  if (response.status === 402) {
    console.error("402 — fund wallet:", await response.json());
    process.exit(1);
  }

  if (!response.ok) {
    console.error(await response.text());
    process.exit(1);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  process.stdout.write("Response: ");
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (const line of buffer.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const event = JSON.parse(payload);
        const delta = event.choices?.[0]?.delta?.content;
        if (delta) process.stdout.write(delta);
      } catch { /* ignore */ }
    }
    buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
  }
  console.log("\n\nDone.");
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
