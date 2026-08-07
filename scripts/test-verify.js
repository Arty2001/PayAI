/**
 * Onchain settlement verification logic.
 *
 * Exercises the verifier against synthetic transaction receipts so the
 * money-critical decisions — did USDC actually reach our address, in the right
 * amount, from the canonical token contract — are checked without depending on
 * a live node or a funded testnet wallet.
 *
 *   node scripts/test-verify.js
 */

import { encodeEventTopics, erc20Abi, pad, toHex } from "viem";
import { verifySettlement } from "../src/chain/verifier.js";
import { NETWORKS } from "../src/chain/networks.js";

const BASE_SEPOLIA = "eip155:84532";
const USDC = NETWORKS[BASE_SEPOLIA].usdc;
const PAY_TO = "0x1111111111111111111111111111111111111111";
const PAYER = "0x2222222222222222222222222222222222222222";
const OTHER_TOKEN = "0x9999999999999999999999999999999999999999";

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

/** Build an ERC-20 Transfer log the way a node would return it. */
function transferLog({ token = USDC, from = PAYER, to = PAY_TO, value }) {
  const topics = encodeEventTopics({
    abi: erc20Abi,
    eventName: "Transfer",
    args: { from, to },
  });
  return {
    address: token,
    topics,
    data: pad(toHex(BigInt(value)), { size: 32 }),
    blockNumber: 123n,
    logIndex: 0,
    transactionHash: "0xdead",
    transactionIndex: 0,
    blockHash: "0xbeef",
    removed: false,
  };
}

/** Minimal viem-shaped client returning a canned receipt. */
function clientReturning(receipt) {
  return {
    async getTransactionReceipt() {
      if (!receipt) throw new Error("transaction not found");
      return receipt;
    },
  };
}

const receipt = (logs, status = "success") => ({
  status,
  blockNumber: 123n,
  from: PAYER,
  logs,
});

const verify = (client, expectedMicroUsd = 100_000) =>
  verifySettlement({
    hash: "0xdead",
    caip2: BASE_SEPOLIA,
    payTo: PAY_TO,
    expectedMicroUsd,
    client,
  });

async function main() {
  console.log("onchain settlement verification\n");

  // $0.10 = 100000 micro-USD; USDC's 6 decimals make raw units == micro-USD.
  const exact = await verify(clientReturning(receipt([transferLog({ value: 100_000 })])));
  check("exact payment verifies", exact.status === "verified", JSON.stringify(exact));
  check("verified amount is read from the chain", exact.amountMicroUsd === 100_000, `got ${exact.amountMicroUsd}`);
  check("payer is recovered from the transfer", exact.from?.toLowerCase() === PAYER.toLowerCase(), `got ${exact.from}`);
  check("block number is recorded", exact.blockNumber === 123, `got ${exact.blockNumber}`);

  const over = await verify(clientReturning(receipt([transferLog({ value: 250_000 })])));
  check("overpayment verifies", over.status === "verified", JSON.stringify(over));

  const under = await verify(clientReturning(receipt([transferLog({ value: 99_999 })])));
  check("underpayment fails", under.status === "failed", JSON.stringify(under));
  check("underpayment reports the shortfall", /Underpaid/.test(under.error ?? ""), under.error);

  const reverted = await verify(clientReturning(receipt([transferLog({ value: 100_000 })], "reverted")));
  check("reverted transaction fails", reverted.status === "failed", JSON.stringify(reverted));

  const wrongRecipient = await verify(
    clientReturning(receipt([transferLog({ value: 100_000, to: OTHER_TOKEN })])),
  );
  check("transfer to someone else fails", wrongRecipient.status === "failed", JSON.stringify(wrongRecipient));

  // A lookalike token paying the right address for the right amount is not payment.
  const wrongToken = await verify(
    clientReturning(receipt([transferLog({ value: 100_000, token: OTHER_TOKEN })])),
  );
  check("non-USDC token fails", wrongToken.status === "failed", JSON.stringify(wrongToken));

  const empty = await verify(clientReturning(receipt([])));
  check("transaction with no transfers fails", empty.status === "failed", JSON.stringify(empty));

  // Two transfers to us in one tx should count together.
  const split = await verify(
    clientReturning(receipt([transferLog({ value: 60_000 }), transferLog({ value: 40_000 })])),
  );
  check("split transfers sum to the total", split.status === "verified", JSON.stringify(split));
  check("summed amount is correct", split.amountMicroUsd === 100_000, `got ${split.amountMicroUsd}`);

  // Everything below must degrade to 'unverifiable' — "we could not check" is
  // materially different from "the chain disagrees", and must never alarm.
  const noHash = await verifySettlement({
    hash: null,
    caip2: BASE_SEPOLIA,
    payTo: PAY_TO,
    expectedMicroUsd: 100_000,
    client: clientReturning(receipt([])),
  });
  check("missing hash is unverifiable, not failed", noHash.status === "unverifiable", JSON.stringify(noHash));

  const noPayTo = await verifySettlement({
    hash: "0xdead",
    caip2: BASE_SEPOLIA,
    payTo: "",
    expectedMicroUsd: 100_000,
    client: clientReturning(receipt([])),
  });
  check("missing pay-to is unverifiable, not failed", noPayTo.status === "unverifiable", JSON.stringify(noPayTo));

  const unknownChain = await verifySettlement({
    hash: "0xdead",
    caip2: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    payTo: PAY_TO,
    expectedMicroUsd: 100_000,
    client: clientReturning(receipt([])),
  });
  check("unknown chain is unverifiable", unknownChain.status === "unverifiable", JSON.stringify(unknownChain));

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
