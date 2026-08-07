import { erc20Abi, parseEventLogs } from "viem";
import { config, usdToMicro } from "../config.js";
import { networkInfo } from "./networks.js";
import { publicClientFor, rpcMode } from "./rpc.js";

/**
 * Independent onchain verification of a settled x402 payment.
 *
 * Without this, PayAI credits a wallet purely on the facilitator's word:
 * `settleResult.success === true` and a transaction hash nobody checks. That is
 * a trust assumption the product's own pitch — verifiable, onchain-anchored
 * receipts — claims not to make. This closes it by reading the chain through
 * QuickNode and confirming the USDC actually moved to the configured pay-to
 * address, for at least the amount that was credited.
 *
 * Verification never gates crediting. The facilitator has already broadcast;
 * blocking the caller's HTTP response on block inclusion would add seconds to
 * a top-up for no benefit. Settlements are credited immediately and verified in
 * the background, so a receipt is `pending` briefly and then resolves.
 */

/** A freshly broadcast tx is usually not in a block yet — poll rather than fail. */
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @typedef {object} VerificationResult
 * @property {'verified' | 'failed' | 'unverifiable'} status
 * @property {number | null} blockNumber
 * @property {number | null} amountMicroUsd  USDC moved to payTo, in micro-USD
 * @property {string | null} from
 * @property {string | null} error
 */

export function verificationEnabled() {
  return config.verifySettlements && rpcMode() !== "none";
}

/**
 * Confirm that `hash` on `caip2` transferred at least `expectedMicroUsd` of
 * USDC to `payTo`.
 *
 * Distinguishes two very different negatives:
 *  - `unverifiable` — we could not check (no RPC, unknown chain, node error).
 *    Says nothing about the payment.
 *  - `failed` — we checked and the chain disagrees. That is a real alarm:
 *    either the facilitator is lying or the transaction reverted.
 *
 * @returns {Promise<VerificationResult>}
 */
export async function verifySettlement({ hash, caip2, payTo, expectedMicroUsd }) {
  const unverifiable = (error) => ({
    status: "unverifiable",
    blockNumber: null,
    amountMicroUsd: null,
    from: null,
    error,
  });

  if (!hash) return unverifiable("Facilitator returned no transaction hash");
  if (!verificationEnabled()) return unverifiable("Onchain verification is not configured");

  const info = networkInfo(caip2);
  if (!info) return unverifiable(`No chain config for network ${caip2}`);

  const client = publicClientFor(caip2);
  if (!client) return unverifiable(`No RPC available for ${info.name}`);

  let receipt = null;
  let lastError = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      receipt = await client.getTransactionReceipt({ hash });
      break;
    } catch (err) {
      // Not-yet-mined and node-unreachable are indistinguishable here, so keep
      // polling and let the caller decide what an exhausted budget means.
      lastError = err.shortMessage ?? err.message;
      if (attempt === RETRY_DELAYS_MS.length) break;
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }

  if (!receipt) {
    return unverifiable(`Transaction not found after ${RETRY_DELAYS_MS.length + 1} attempts: ${lastError}`);
  }

  if (receipt.status !== "success") {
    return {
      status: "failed",
      blockNumber: Number(receipt.blockNumber),
      amountMicroUsd: null,
      from: receipt.from ?? null,
      error: "Transaction reverted onchain",
    };
  }

  // Only USDC Transfer events from the canonical token contract count. A
  // transfer of some other token, or a lookalike contract, is not payment.
  const transfers = parseEventLogs({
    abi: erc20Abi,
    eventName: "Transfer",
    logs: receipt.logs,
  }).filter((log) => log.address.toLowerCase() === info.usdc.toLowerCase());

  const recipient = String(payTo).toLowerCase();
  const paid = transfers.filter((log) => log.args.to?.toLowerCase() === recipient);

  if (paid.length === 0) {
    return {
      status: "failed",
      blockNumber: Number(receipt.blockNumber),
      amountMicroUsd: 0,
      from: receipt.from ?? null,
      error: `No USDC transfer to ${payTo} in this transaction`,
    };
  }

  // USDC's 6 decimals make raw units identical to micro-USD.
  const amountMicroUsd = paid.reduce((sum, log) => sum + Number(log.args.value ?? 0n), 0);
  const payer = paid[0].args.from ?? receipt.from ?? null;

  if (expectedMicroUsd && amountMicroUsd < expectedMicroUsd) {
    return {
      status: "failed",
      blockNumber: Number(receipt.blockNumber),
      amountMicroUsd,
      from: payer,
      error: `Underpaid: chain shows ${amountMicroUsd} µUSD, expected ${expectedMicroUsd} µUSD`,
    };
  }

  return {
    status: "verified",
    blockNumber: Number(receipt.blockNumber),
    amountMicroUsd,
    from: payer,
    error: null,
  };
}

/** Expected onchain amount for one top-up, in micro-USD. */
export function expectedTopUpMicroUsd() {
  return usdToMicro(config.topUpPriceUsd);
}
