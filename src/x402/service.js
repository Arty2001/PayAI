import {
  HTTPFacilitatorClient,
  x402ResourceServer,
} from "@x402/core/server";
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { createHash } from "node:crypto";
import { config, usdToMicro, microToUsd } from "../config.js";
import { topUpCreditMicro, topUpPriceLabel } from "../billing/pricing.js";
import { ledger } from "../store/ledger.js";
import { store } from "../store/db.js";
import { expectedTopUpMicroUsd, verificationEnabled, verifySettlement } from "../chain/verifier.js";
import { rpcStatus } from "../chain/rpc.js";

/** @type {x402ResourceServer | null} */
let resourceServer = null;
let initialized = false;

/** Pay-to addresses are configured — the operator intends to accept crypto. */
export function isX402Enabled() {
  return Boolean(config.evmPayTo || config.svmPayTo);
}

/** Configured *and* the facilitator handshake succeeded — payments can settle. */
export function isX402Ready() {
  return Boolean(resourceServer && initialized);
}

/** Why x402 is unavailable, surfaced in /health and 402 bodies. */
let initError = null;

export function x402Status() {
  return {
    configured: isX402Enabled(),
    ready: initialized,
    facilitatorUrl: config.facilitatorUrl,
    error: initError,
    /**
     * Settlement is delegated to the facilitator; verification is ours. These
     * are separate services — QuickNode is a node provider here, not a
     * facilitator, and cannot verify or settle on PayAI's behalf.
     */
    verification: { ...rpcStatus(), counts: store.verificationStats() },
  };
}

/**
 * Bring up the x402 resource server.
 *
 * Never throws: reaching the facilitator is a network call, and a facilitator
 * outage must not take the whole proxy down with it. On failure the server
 * still serves LLM traffic and returns plain 402s until initX402() succeeds on
 * a later retry.
 */
export async function initX402() {
  if (!isX402Enabled()) {
    console.log("[x402] No PAYAI_EVM_PAY_TO / PAYAI_SVM_PAY_TO — crypto top-up disabled (demo mode available)");
    return null;
  }

  try {
    const facilitatorClient = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
    const server = new x402ResourceServer(facilitatorClient);

    if (config.evmPayTo) {
      registerExactEvmScheme(server, { networks: ["eip155:84532", "eip155:8453"] });
    }
    if (config.svmPayTo) {
      registerExactSvmScheme(server, {
        networks: ["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"],
      });
    }

    await server.initialize();

    resourceServer = server;
    initialized = true;
    initError = null;
    console.log(`[x402] Facilitator ${config.facilitatorUrl} — EVM ${config.evmPayTo || "—"} / SVM ${config.svmPayTo || "—"}`);
    return resourceServer;
  } catch (err) {
    resourceServer = null;
    initialized = false;
    initError = err.message;
    console.error(
      `[x402] Facilitator ${config.facilitatorUrl} unreachable — continuing without crypto settlement: ${err.message}`,
    );
    return null;
  }
}

export function paymentOptions() {
  /** @type {import('@x402/core/types').PaymentOption[]} */
  const options = [];

  if (config.evmPayTo) {
    options.push({
      scheme: "exact",
      price: topUpPriceLabel(),
      network: "eip155:84532",
      payTo: config.evmPayTo,
      maxTimeoutSeconds: 120,
      extra: { name: "USDC", version: "2" },
    });
  }

  if (config.svmPayTo) {
    options.push({
      scheme: "exact",
      price: topUpPriceLabel(),
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      payTo: config.svmPayTo,
      maxTimeoutSeconds: 120,
    });
  }

  return options;
}

function resourceInfo(req, description) {
  const url = `${config.publicUrl}${req.originalUrl}`;
  return {
    url,
    description,
    mimeType: req.headers["content-type"] ?? "application/json",
  };
}

export async function buildTopUpRequirements(req, description = "PayAI wallet top-up") {
  if (!resourceServer || !initialized) {
    throw new Error("x402 is not configured on this server");
  }

  return resourceServer.buildPaymentRequirementsFromOptions(paymentOptions(), {
    adapter: "express",
    path: req.path,
    method: req.method,
    headers: req.headers,
    url: `${config.publicUrl}${req.originalUrl}`,
  });
}

export async function sendPaymentRequired(res, req, {
  error,
  walletId,
  balanceMicroUsd,
  requiredMicroUsd,
  description,
}) {
  const shortfallMicroUsd = Math.max(0, requiredMicroUsd - balanceMicroUsd);

  const body = {
    error: "payment_required",
    message: error ?? "Insufficient PayAI balance. Top up via x402 to continue.",
    walletId,
    balanceUsd: microToUsd(balanceMicroUsd),
    requiredUsd: microToUsd(requiredMicroUsd),
    shortfallUsd: microToUsd(shortfallMicroUsd),
    topUpPriceUsd: config.topUpPriceUsd,
    topUpCreditUsd: config.topUpCreditUsd,
    x402Enabled: isX402Ready(),
    demoMode: config.demoMode,
  };

  // Configured but the facilitator never came up — still answer 402, just
  // without machine-readable payment terms.
  if (!isX402Ready()) {
    if (initError) body.x402Error = initError;
    res.status(402).json(body);
    return;
  }

  const requirements = await buildTopUpRequirements(req, description);
  const paymentRequired = await resourceServer.createPaymentRequiredResponse(
    requirements,
    resourceInfo(req, description),
    body.message,
  );

  res.setHeader("PAYMENT-REQUIRED", encodePaymentRequiredHeader(paymentRequired));
  res.setHeader("Cache-Control", "no-store");
  res.status(402).json({ ...body, x402: paymentRequired });
}

/**
 * Verify + settle PAYMENT-SIGNATURE and credit wallet.
 * @returns {Promise<{ creditedMicroUsd: number, payer?: string, tx?: string } | null>}
 */
export async function settleIncomingPayment(req, walletId) {
  const signatureHeader = req.headers["payment-signature"];
  if (!signatureHeader || !resourceServer) return null;

  const payload = decodePaymentSignatureHeader(String(signatureHeader));
  const requirements = await buildTopUpRequirements(req);
  const matched = resourceServer.findMatchingRequirements(requirements, payload);
  if (!matched) {
    throw new Error("Payment signature does not match any accepted requirement");
  }

  const verifyResult = await resourceServer.verifyPayment(payload, matched);
  if (!verifyResult.isValid) {
    throw new Error(verifyResult.invalidMessage ?? verifyResult.invalidReason ?? "Payment verification failed");
  }

  const settleResult = await resourceServer.settlePayment(payload, matched);
  if (!settleResult.success) {
    throw new Error(settleResult.errorMessage ?? settleResult.errorReason ?? "Payment settlement failed");
  }

  const creditedMicroUsd = topUpCreditMicro();

  // A settled payment must credit exactly once. The onchain transaction is the
  // strongest unique key; fall back to the signed payload when a facilitator
  // settles off-chain and returns no hash.
  const nonceKey =
    settleResult.transaction ??
    `payload:${createHash("sha256").update(String(signatureHeader)).digest("hex")}`;

  const { replay } = ledger.settle({
    nonceKey,
    walletId,
    payer: settleResult.payer,
    transaction: settleResult.transaction,
    network: settleResult.network,
    creditedMicroUsd,
  });

  if (replay) {
    throw new Error("Payment already settled — replayed PAYMENT-SIGNATURE rejected");
  }

  // Confirm against the chain, but do not make the caller wait for a block.
  scheduleVerification({
    nonceKey,
    walletId,
    hash: settleResult.transaction,
    caip2: settleResult.network ?? matched?.network,
  });

  return {
    creditedMicroUsd,
    payer: settleResult.payer,
    tx: settleResult.transaction,
    settleResult,
    payload,
    matched,
  };
}

/**
 * Verify a settlement against the chain, out of band.
 *
 * Detached on purpose: the payment is already settled and credited by the time
 * this runs, so a slow node or a chain we cannot read must not delay — or fail
 * — the caller's top-up. Failures here are recorded on the receipt, and a
 * `failed` verdict is logged loudly because it means the facilitator's report
 * and the chain disagree.
 */
function scheduleVerification({ nonceKey, walletId, hash, caip2 }) {
  if (!verificationEnabled()) {
    ledger.recordVerification(nonceKey, walletId, {
      status: "unverifiable",
      blockNumber: null,
      amountMicroUsd: null,
      error: "Onchain verification not configured (set PAYAI_QUICKNODE_RPC_URL)",
    });
    return;
  }

  verifySettlement({
    hash,
    caip2,
    payTo: config.evmPayTo,
    expectedMicroUsd: expectedTopUpMicroUsd(),
  })
    .then((result) => {
      ledger.recordVerification(nonceKey, walletId, result);
      if (result.status === "verified") {
        console.log(`[verify] ${hash} confirmed in block ${result.blockNumber} (${result.amountMicroUsd} µUSD)`);
      } else if (result.status === "failed") {
        console.error(`[verify] SETTLEMENT MISMATCH for ${hash}: ${result.error}`);
      } else {
        console.warn(`[verify] could not confirm ${hash}: ${result.error}`);
      }
    })
    .catch((err) => {
      console.error(`[verify] verifier crashed for ${hash}: ${err.message}`);
      ledger.recordVerification(nonceKey, walletId, {
        status: "unverifiable",
        blockNumber: null,
        amountMicroUsd: null,
        error: err.message,
      });
    });
}

/**
 * Re-check settlements that were credited but never confirmed — a restart
 * mid-verification would otherwise leave a receipt stuck on `pending` forever.
 */
export function resumePendingVerifications() {
  if (!verificationEnabled()) return 0;
  const pending = store.pendingVerifications(100);
  for (const row of pending) {
    scheduleVerification({
      nonceKey: row.nonce_key,
      walletId: row.wallet_id,
      hash: row.transaction_hash,
      caip2: row.network,
    });
  }
  if (pending.length) console.log(`[verify] re-checking ${pending.length} pending settlement(s)`);
  return pending.length;
}

export function attachPaymentResponse(res, settleResult) {
  if (settleResult?.settleResult?.success) {
    res.setHeader(
      "PAYMENT-RESPONSE",
      encodePaymentResponseHeader({
        success: true,
        transaction: settleResult.settleResult.transaction,
        network: settleResult.settleResult.network,
        payer: settleResult.settleResult.payer,
      }),
    );
  }
}

export { resourceServer };
