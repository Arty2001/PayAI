/**
 * Fund a PayAI wallet with real USDC over x402 on Base Sepolia.
 *
 * This is the payer side — the half that `simulate-fund` was standing in for.
 * It signs an EIP-3009 authorization, PayAI's facilitator settles it onchain,
 * and the wallet is credited against a transaction you can look up yourself.
 *
 * Setup:
 *   1. Generate a throwaway key:  npm run keygen
 *   2. Fund it with testnet USDC:  https://faucet.circle.com  (pick Base Sepolia)
 *   3. PAYAI_PAYER_PRIVATE_KEY=0x... npm run pay
 *
 * No ETH needed. EIP-3009 transfers are gasless for the payer — the
 * facilitator broadcasts and pays gas.
 *
 * Usage:
 *   npm run pay
 *   PAYAI_WALLET=alice npm run pay
 *   PAYAI_PROXY_URL=https://payai.example.com npm run pay
 */

import "dotenv/config";
import { createPublicClient, formatUnits, http } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client, wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

const PROXY_URL = process.env.PAYAI_PROXY_URL ?? "http://localhost:4020";
const WALLET = process.env.PAYAI_WALLET ?? `payer-${Date.now().toString(36)}`;
const PRIVATE_KEY = process.env.PAYAI_PAYER_PRIVATE_KEY ?? "";
const RPC_URL = process.env.PAYAI_QUICKNODE_RPC_URL || undefined;

const USDC_BASE_SEPOLIA = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NETWORK = "eip155:84532";

const usd = (n) => `$${Number(n).toFixed(6)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!PRIVATE_KEY) {
  console.error(`
Missing PAYAI_PAYER_PRIVATE_KEY.

  npm run keygen                       # make a throwaway key
  https://faucet.circle.com            # fund it with Base Sepolia USDC

Then re-run with the key in .env or inline.
`);
  process.exit(1);
}

const account = privateKeyToAccount(
  PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`,
);

/** Fail with a useful message instead of an opaque signature error downstream. */
async function preflight() {
  const chain = createPublicClient({
    chain: baseSepolia,
    transport: http(RPC_URL, { timeout: 15_000 }),
  });

  const balance = await chain.readContract({
    address: USDC_BASE_SEPOLIA,
    abi: [
      {
        name: "balanceOf",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
    ],
    functionName: "balanceOf",
    args: [account.address],
  });

  const human = formatUnits(balance, 6);
  console.log(`USDC:   ${human} (Base Sepolia)${RPC_URL ? " · via QuickNode" : ""}`);

  if (balance === 0n) {
    console.error(`
This address holds no testnet USDC, so there is nothing to pay with.

  Faucet:  https://faucet.circle.com   (select Base Sepolia)
  Address: ${account.address}
`);
    process.exit(1);
  }
  return balance;
}

async function walletState() {
  const res = await fetch(`${PROXY_URL}/api/wallet/${encodeURIComponent(WALLET)}`);
  return res.json();
}

/** Poll until the background verifier reaches a verdict on this settlement. */
async function awaitVerification(txHash, attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    const res = await fetch(`${PROXY_URL}/api/wallet/${encodeURIComponent(WALLET)}/receipts`);
    const { settlements = [] } = await res.json();
    const match = settlements.find((s) => s.transaction === txHash) ?? settlements[0];

    if (match && match.verification?.status !== "pending") return match;
    await sleep(3_000);
  }
  return null;
}

async function main() {
  console.log(`
PayAI x402 payer
────────────────────────────────────────
Proxy:  ${PROXY_URL}
Wallet: ${WALLET}
Payer:  ${account.address}`);

  await preflight();

  const health = await (await fetch(`${PROXY_URL}/health`)).json();
  if (!health.x402?.configured) {
    console.error(`
PayAI is not configured to accept crypto — it is in demo mode.

Set PAYAI_EVM_PAY_TO to a Base Sepolia address you control, set
PAYAI_DEMO_MODE=false, and restart the server.
`);
    process.exit(1);
  }
  if (!health.x402?.ready) {
    console.error(`\nPayAI is DEGRADED — facilitator unreachable: ${health.x402?.error}`);
    process.exit(1);
  }

  const before = await walletState();
  console.log(`Before: ${usd(before.balanceUsd)}\n`);

  // Register the payer key, then let the wrapper handle the 402 handshake:
  // request → 402 with terms → sign → retry with PAYMENT-SIGNATURE.
  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: account,
    networks: [NETWORK],
    ...(RPC_URL ? { schemeOptions: { rpcUrl: RPC_URL } } : {}),
  });
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  console.log("Paying…  (402 → sign EIP-3009 → settle onchain)");
  const res = await fetchWithPay(
    `${PROXY_URL}/api/wallet/${encodeURIComponent(WALLET)}/fund`,
    { method: "POST", headers: { "content-type": "application/json" } },
  );

  const body = await res.json();
  if (!res.ok) {
    console.error(`\nHTTP ${res.status}: ${JSON.stringify(body, null, 2)}`);
    process.exit(1);
  }

  const settled = decodePaymentResponseHeader(res.headers.get("PAYMENT-RESPONSE") ?? "");
  const txHash = body.transaction ?? settled?.transaction;

  console.log(`
Settled ✓
  credited   ${usd(body.creditedUsd)}
  balance    ${usd(body.balanceUsd)}
  payer      ${body.payer}
  tx         ${txHash}
  explorer   https://sepolia.basescan.org/tx/${txHash}
`);

  console.log("Verifying onchain (PayAI reads the chain through QuickNode)…");
  const receipt = await awaitVerification(txHash);

  if (!receipt) {
    console.log("  still pending — check GET /api/wallet/:id/receipts shortly");
  } else {
    const v = receipt.verification;
    const mark = { verified: "✓", failed: "✗", unverifiable: "?" }[v.status] ?? "?";
    console.log(`  ${mark} ${v.status}${v.blockNumber ? ` · block ${v.blockNumber}` : ""}${
      v.onchainUsd != null ? ` · ${usd(v.onchainUsd)} onchain` : ""
    }`);
    if (v.error) console.log(`    ${v.error}`);
    if (v.status === "unverifiable") {
      console.log("    (set PAYAI_QUICKNODE_RPC_URL to verify independently)");
    }
  }

  console.log(`\nSpend it:  PAYAI_WALLET=${WALLET} npm run test:messages`);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  if (String(err.message).includes("does not match")) {
    console.error(
      "\nHint: PAYAI_PUBLIC_URL on the server must exactly match the origin you\n" +
      `are calling (${PROXY_URL}). A mismatch makes the signed resource URL differ.`,
    );
  }
  process.exit(1);
});
