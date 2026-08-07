/**
 * Spend a wallet that a real x402 payment has already funded.
 *
 * Once `npm run pay` settles, the payer's address is bound to the wallet and a
 * wallet id alone no longer spends it — `npm run test:messages` gets a 401.
 * This is the other half: challenge, sign, spend, with the same key that paid.
 *
 * Nonces are single-use, so every request re-challenges. Reusing one signature
 * across a loop fails on the second call, which is the point of the nonce.
 *
 * Usage:
 *   PAYAI_WALLET=demo-agent npm run spend
 *   PAYAI_WALLET=demo-agent npm run spend -- 5      # 5 requests
 */

import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";

const PROXY_URL = process.env.PAYAI_PROXY_URL ?? "http://localhost:4020";
const WALLET = process.env.PAYAI_WALLET ?? "demo-agent";
const PRIVATE_KEY = process.env.PAYAI_PAYER_PRIVATE_KEY ?? "";
const COUNT = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 3);

const usd = (n) => `$${Number(n).toFixed(6)}`;

if (!PRIVATE_KEY) {
  console.error(`
Missing PAYAI_PAYER_PRIVATE_KEY — it must be the key that funded this wallet.

  PAYAI_WALLET=${WALLET} npm run pay     # fund it first
`);
  process.exit(1);
}

const account = privateKeyToAccount(
  PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`,
);

async function walletState() {
  const res = await fetch(`${PROXY_URL}/api/wallet/${encodeURIComponent(WALLET)}`);
  return res.json();
}

/**
 * Fresh proof of ownership for exactly one request.
 *
 * The server's challenge message is signed as-returned rather than rebuilt
 * here — the wallet id is normalised server-side, so reconstructing the string
 * locally would drift the moment that normalisation changes.
 */
async function signedHeaders() {
  const res = await fetch(
    `${PROXY_URL}/api/wallet/${encodeURIComponent(WALLET)}/challenge`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`Challenge failed (${res.status}): ${await res.text()}`);

  const { nonce, message } = await res.json();
  return {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "x-payai-wallet": WALLET,
    "x-payai-nonce": nonce,
    "x-payai-signature": await account.signMessage({ message }),
  };
}

async function ask(prompt) {
  const response = await fetch(`${PROXY_URL}/v1/messages`, {
    method: "POST",
    headers: await signedHeaders(),
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (response.status === 402) {
    const body = await response.json();
    console.error(`\n402 Payment Required — balance ${usd(body.balanceUsd)}, need ${usd(body.requiredUsd)}`);
    console.error(`Top up:  PAYAI_WALLET=${WALLET} npm run pay`);
    process.exit(1);
  }
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${await response.text()}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let lineEnd;
    while ((lineEnd = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, lineEnd).replace(/\r$/, "");
      buffer = buffer.slice(lineEnd + 1);
      if (!line.startsWith("data: ")) continue;

      const payload = line.slice(6);
      if (payload === "[DONE]") continue;
      try {
        const event = JSON.parse(payload);
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          text += event.delta.text;
        }
      } catch { /* keep-alive or partial frame */ }
    }
  }
  return text.trim();
}

async function main() {
  const before = await walletState();

  console.log(`
PayAI signed spend
────────────────────────────────────────
Proxy:   ${PROXY_URL}
Wallet:  ${WALLET}
Signer:  ${account.address}
Owner:   ${before.ownerAddress ?? "(unbound)"}
Balance: ${usd(before.balanceUsd ?? 0)}
`);

  if (!before.exists) {
    console.error(`Wallet does not exist yet. Fund it:  PAYAI_WALLET=${WALLET} npm run pay`);
    process.exit(1);
  }
  if (before.ownerAddress && before.ownerAddress.toLowerCase() !== account.address.toLowerCase()) {
    console.error(`This key is not the owner — it will be rejected with 403.`);
    process.exit(1);
  }

  for (let i = 1; i <= COUNT; i += 1) {
    const answer = await ask(`Reply in under 10 words: what is request #${i}?`);
    const after = await walletState();
    console.log(`  ${i}/${COUNT}  ${usd(after.balanceUsd)}  ← ${answer.slice(0, 60)}`);
  }

  const after = await walletState();
  console.log(`
Spent    ${usd((after.totalSpentMicroUsd - (before.totalSpentMicroUsd ?? 0)) / 1e6)} over ${COUNT} request(s)
Balance  ${usd(before.balanceUsd)} → ${usd(after.balanceUsd)}
Receipts ${PROXY_URL}/api/wallet/${encodeURIComponent(WALLET)}/receipts
`);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
