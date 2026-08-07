/**
 * Onchain settlement verification, against a real Base Sepolia transaction.
 *
 * The synthetic suite (`npm run test:verify`) feeds the verifier logs that *we*
 * construct, so it can only prove the verifier agrees with our belief about
 * what a node returns. This one runs the same verdicts through the real RPC
 * path against a real USDC transfer, which is the only way to catch a wrong
 * belief — event encoding, log ordering, receipt field types, BigInt handling.
 *
 * It discovers a recent USDC transfer rather than pinning a hash, so the test
 * does not rot when a testnet prunes or a pinned transaction ages out.
 *
 *   npm run test:verify:live
 *   npm run test:verify:live -- 0x<tx-hash>     # verify a specific transaction
 *
 * Uses PAYAI_QUICKNODE_RPC_URL when set, otherwise the public Base Sepolia
 * node. Skips (exit 0) when no node is reachable — a flaky testnet should not
 * read as a broken verifier.
 */

// config.js snapshots process.env at import time, and the verifier must take
// the real publicClientFor() path rather than an injected client — so these are
// set before any of it loads. Imports below are dynamic for the same reason.
process.env.PAYAI_QUICKNODE_RPC_URL ||= "https://sepolia.base.org";
process.env.PAYAI_QUICKNODE_RPC_NETWORK ||= "eip155:84532";
process.env.PAYAI_VERIFY_SETTLEMENTS = "true";

const { createPublicClient, http, parseAbiItem } = await import("viem");
const { baseSepolia } = await import("viem/chains");
const { verifySettlement } = await import("../src/chain/verifier.js");
const { NETWORKS, explorerUrl } = await import("../src/chain/networks.js");
const { rpcStatus } = await import("../src/chain/rpc.js");

const BASE_SEPOLIA = "eip155:84532";
const BASE_MAINNET = "eip155:8453";
const USDC = NETWORKS[BASE_SEPOLIA].usdc;
const NOBODY = "0x000000000000000000000000000000000000dEaD";

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed += 1;
  } else {
    console.log(`  FAIL  ${name} ${detail}`);
    failed += 1;
  }
}

function skip(reason) {
  console.log(`\n  SKIP  ${reason}`);
  console.log("\nSkipped — the verifier was not exercised.");
  process.exit(0);
}

const chain = createPublicClient({
  chain: baseSepolia,
  transport: http(process.env.PAYAI_QUICKNODE_RPC_URL, { timeout: 15_000, retryCount: 1 }),
});

/**
 * Find a recent USDC transfer carrying a nonzero amount.
 *
 * Scans backward in windows because public nodes cap `getLogs` ranges, and a
 * quiet stretch of blocks is normal on a testnet.
 */
async function findTransfer(head) {
  const WINDOW = 400n;
  for (let i = 0n; i < 12n; i += 1n) {
    const toBlock = head - i * WINDOW;
    const fromBlock = toBlock - (WINDOW - 1n);
    let logs;
    try {
      logs = await chain.getLogs({ address: USDC, event: TRANSFER_EVENT, fromBlock, toBlock });
    } catch {
      continue; // range rejected by this node — try an older window
    }
    const usable = logs.filter((l) => (l.args.value ?? 0n) > 0n);
    if (usable.length) return usable[usable.length - 1];
  }
  return null;
}

async function main() {
  console.log("onchain settlement verification — live Base Sepolia\n");
  console.log(`  rpc  ${rpcStatus().endpoint}`);

  let head;
  try {
    head = await chain.getBlockNumber();
  } catch (err) {
    skip(`Base Sepolia unreachable: ${err.shortMessage ?? err.message}`);
  }
  console.log(`  head block ${head}`);

  // A hash passed on the command line is verified against its own recipient,
  // so an operator can check a settlement `npm run pay` just produced.
  const override = process.argv[2];
  let hash;
  let payTo;
  let amount;

  if (override) {
    const receipt = await chain.getTransactionReceipt({ hash: override }).catch(() => null);
    if (!receipt) skip(`transaction ${override} not found on Base Sepolia`);

    const transfers = await chain.getLogs({
      address: USDC,
      event: TRANSFER_EVENT,
      blockHash: receipt.blockHash,
    });
    const mine = transfers.find((l) => l.transactionHash.toLowerCase() === override.toLowerCase());
    if (!mine) skip(`transaction ${override} contains no USDC transfer`);

    hash = override;
    payTo = mine.args.to;
    amount = mine.args.value;
  } else {
    const found = await findTransfer(head);
    if (!found) skip("no USDC transfer found in the recent block range");

    hash = found.transactionHash;
    payTo = found.args.to;
    amount = found.args.value;
  }

  console.log(`  tx   ${hash}`);
  console.log(`  ${explorerUrl(BASE_SEPOLIA, hash)}`);
  console.log(`  pays ${amount} µUSD → ${payTo}\n`);

  // Correct recipient, amount exactly met. No injected client — this is the
  // real publicClientFor() path reading a real receipt.
  const ok = await verifySettlement({
    hash,
    caip2: BASE_SEPOLIA,
    payTo,
    expectedMicroUsd: Number(amount),
  });
  check("real transfer verifies", ok.status === "verified", JSON.stringify(ok));
  check(
    "amount read from chain matches the log",
    ok.amountMicroUsd === Number(amount),
    `got ${ok.amountMicroUsd}, expected ${amount}`,
  );
  check("block number is recorded", Number.isInteger(ok.blockNumber), `got ${ok.blockNumber}`);
  check("payer address is recovered", /^0x[0-9a-fA-F]{40}$/.test(ok.from ?? ""), `got ${ok.from}`);

  // Same transaction, an address that was not paid.
  const wrongRecipient = await verifySettlement({
    hash,
    caip2: BASE_SEPOLIA,
    payTo: NOBODY,
    expectedMicroUsd: Number(amount),
  });
  check("transfer to someone else fails", wrongRecipient.status === "failed", JSON.stringify(wrongRecipient));
  check(
    "wrong recipient is reported, not silently passed",
    /No USDC transfer to/.test(wrongRecipient.error ?? ""),
    wrongRecipient.error,
  );

  // Same transaction, demanding more than was actually paid.
  const underpaid = await verifySettlement({
    hash,
    caip2: BASE_SEPOLIA,
    payTo,
    expectedMicroUsd: Number(amount) * 10,
  });
  check("underpayment fails", underpaid.status === "failed", JSON.stringify(underpaid));
  check("underpayment reports the shortfall", /Underpaid/.test(underpaid.error ?? ""), underpaid.error);

  // A Sepolia endpoint must refuse to answer for mainnet rather than report a
  // mainnet hash as missing — that would record "the chain disagrees" when the
  // chain was never actually consulted.
  const crossChain = await verifySettlement({
    hash,
    caip2: BASE_MAINNET,
    payTo,
    expectedMicroUsd: Number(amount),
  });
  check("mainnet hash on a sepolia endpoint is unverifiable", crossChain.status === "unverifiable", JSON.stringify(crossChain));
  check(
    "cross-chain refusal never reports 'failed'",
    crossChain.status !== "failed",
    `got ${crossChain.status}`,
  );

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`\n${e.stack ?? e.message}`);
  process.exit(1);
});
