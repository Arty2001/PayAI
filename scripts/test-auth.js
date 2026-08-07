/**
 * Wallet ownership proof end-to-end.
 *
 * Verifies that once a wallet is bound to an address, only that key can spend
 * it — the hole that made a wallet id a bearer secret.
 *
 * Run against a server started with PAYAI_WALLET_AUTH=strict:
 *   PORT=4031 PAYAI_WALLET_AUTH=strict PAYAI_DB_PATH=./data/auth-test.db npm start
 *   PAYAI_PROXY_URL=http://localhost:4031 node scripts/test-auth.js
 */

import { privateKeyToAccount } from "viem/accounts";

const PROXY_URL = process.env.PAYAI_PROXY_URL ?? "http://localhost:4031";
const WALLET = process.env.PAYAI_WALLET ?? `auth-${Date.now().toString(36)}`;

// Deterministic throwaway keys — test fixtures, never used for real funds.
const OWNER = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);
const IMPOSTER = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
);

let passed = 0;
let failed = 0;

function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed += 1;
  } else {
    console.log(`  FAIL  ${name} ${detail}`);
    failed += 1;
  }
}

async function challenge() {
  const res = await fetch(`${PROXY_URL}/api/wallet/${encodeURIComponent(WALLET)}/challenge`, {
    method: "POST",
  });
  return res.json();
}

async function ask(account) {
  const headers = {
    "content-type": "application/json",
    "x-payai-wallet": WALLET,
  };

  if (account) {
    const { nonce, message } = await challenge();
    headers["x-payai-nonce"] = nonce;
    headers["x-payai-signature"] = await account.signMessage({ message });
  }

  const res = await fetch(`${PROXY_URL}/v1/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 32,
      messages: [{ role: "user", content: "auth check" }],
    }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function main() {
  console.log(`Proxy:    ${PROXY_URL}`);
  console.log(`Wallet:   ${WALLET}`);
  console.log(`Owner:    ${OWNER.address}`);
  console.log(`Imposter: ${IMPOSTER.address}\n`);

  const unsigned = await ask(null);
  check("unsigned request is rejected", unsigned.status === 401, `got ${unsigned.status}`);

  const first = await ask(OWNER);
  check("owner's signed request succeeds", first.status === 200, `got ${first.status}`);

  const wallet = await (await fetch(`${PROXY_URL}/api/wallet/${encodeURIComponent(WALLET)}`)).json();
  check(
    "wallet is now bound to the owner address",
    wallet.ownerAddress?.toLowerCase() === OWNER.address.toLowerCase(),
    `got ${wallet.ownerAddress}`,
  );

  const stolen = await ask(null);
  check("wallet id alone no longer spends", stolen.status === 401, `got ${stolen.status}`);

  const imposter = await ask(IMPOSTER);
  check(
    "a different key is rejected as owner mismatch",
    imposter.status === 403,
    `got ${imposter.status} ${JSON.stringify(imposter.body)}`,
  );

  const again = await ask(OWNER);
  check("owner can still spend", again.status === 200, `got ${again.status}`);

  // Nonces are single-use: replaying a captured signature must fail.
  const { nonce, message } = await challenge();
  const signature = await OWNER.signMessage({ message });
  const replayHeaders = {
    "content-type": "application/json",
    "x-payai-wallet": WALLET,
    "x-payai-nonce": nonce,
    "x-payai-signature": signature,
  };
  const body = JSON.stringify({
    model: "claude-haiku-4-5",
    max_tokens: 32,
    messages: [{ role: "user", content: "replay" }],
  });
  const one = await fetch(`${PROXY_URL}/v1/messages`, { method: "POST", headers: replayHeaders, body });
  const two = await fetch(`${PROXY_URL}/v1/messages`, { method: "POST", headers: replayHeaders, body });
  check("first use of a nonce succeeds", one.status === 200, `got ${one.status}`);
  check("replayed nonce is rejected", two.status === 401, `got ${two.status}`);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
