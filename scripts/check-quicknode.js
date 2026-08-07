/**
 * Prove QuickNode is wired up correctly, before you depend on it for receipts.
 *
 * Tests whichever mode is configured:
 *   PAYAI_QUICKNODE_RPC_URL      → authenticated endpoint (recommended)
 *   PAYAI_QUICKNODE_X402=true    → PayAI pays QuickNode per RPC call over x402
 *
 * Usage:
 *   npm run check:quicknode
 *   npm run check:quicknode -- 0x<settlement-tx-hash>
 */

import "dotenv/config";
import { config } from "../src/config.js";
import { NETWORKS } from "../src/chain/networks.js";
import { publicClientFor, rpcMode, rpcStatus } from "../src/chain/rpc.js";
import { verifySettlement, expectedTopUpMicroUsd } from "../src/chain/verifier.js";

const NETWORK = process.env.PAYAI_SETTLEMENT_NETWORK ?? "eip155:84532";
const txHash = process.argv[2];

async function main() {
  const status = rpcStatus();
  console.log(`
QuickNode connectivity
─────────────────────────────────────────────────────────
  mode      ${status.mode}
  endpoint  ${status.endpoint ?? "—"}
  network   ${NETWORKS[NETWORK]?.name ?? NETWORK}
`);

  if (rpcMode() === "none") {
    console.error(`No QuickNode access configured. Pick one:

  # 1. Authenticated endpoint — Base Sepolia, from your QuickNode dashboard
  PAYAI_QUICKNODE_RPC_URL=https://<your-endpoint>.base-sepolia.quiknode.pro/<token>/

  # 2. Pay-per-call over x402 (no account on the request path)
  PAYAI_QUICKNODE_X402=true
  PAYAI_QUICKNODE_X402_KEY=0x<funded testnet key>
`);
    process.exit(1);
  }

  const client = publicClientFor(NETWORK);
  if (!client) {
    console.error(`No client for ${NETWORK} — unsupported network.`);
    process.exit(1);
  }

  const startedAt = Date.now();
  const blockNumber = await client.getBlockNumber();
  console.log(`  ✓ eth_blockNumber → ${blockNumber}  (${Date.now() - startedAt}ms)`);

  const block = await client.getBlock({ blockNumber });
  const ageSeconds = Math.round(Date.now() / 1000 - Number(block.timestamp));
  console.log(`  ✓ head is ${ageSeconds}s old, ${block.transactions.length} txs`);

  if (!txHash) {
    console.log(`
Reads are working. To verify a real settlement:

  npm run check:quicknode -- 0x<tx-hash-from-npm-run-pay>
`);
    return;
  }

  console.log(`\nVerifying ${txHash}…`);
  const result = await verifySettlement({
    hash: txHash,
    caip2: NETWORK,
    payTo: config.evmPayTo,
    expectedMicroUsd: expectedTopUpMicroUsd(),
  });

  const mark = { verified: "✓", failed: "✗", unverifiable: "?" }[result.status];
  console.log(`
  ${mark} ${result.status}
    block     ${result.blockNumber ?? "—"}
    onchain   ${result.amountMicroUsd == null ? "—" : `${result.amountMicroUsd} µUSD`}
    expected  ${expectedTopUpMicroUsd()} µUSD → ${config.evmPayTo || "(PAYAI_EVM_PAY_TO unset)"}
    from      ${result.from ?? "—"}
    ${result.error ? `error     ${result.error}` : ""}
`);

  if (result.status === "failed") process.exit(1);
}

main().catch((err) => {
  console.error(`\nFailed: ${err.message}`);
  console.error("\nCheck that the endpoint is a Base Sepolia endpoint and the token is valid.");
  process.exit(1);
});
