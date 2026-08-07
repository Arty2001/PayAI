import { Router } from "express";
import { config, microToUsd, formatUsd } from "../config.js";
import { ledger } from "../store/ledger.js";
import { topUpCreditMicro } from "../billing/pricing.js";
import {
  attachPaymentResponse,
  isX402Enabled,
  isX402Ready,
  sendPaymentRequired,
  settleIncomingPayment,
} from "../x402/service.js";
import { authMode, issueChallenge } from "../middleware/wallet-auth.js";

export const walletRouter = Router();

/** Express 4 does not catch rejected async handlers — forward them explicitly. */
const asyncRoute = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

/** How many demo credits a single wallet may mint when x402 is not configured. */
const MAX_SIMULATED_TOPUPS = Number(process.env.PAYAI_MAX_SIMULATED_TOPUPS ?? "10");
/** @type {Map<string, number>} */
const simulatedTopUps = new Map();

/**
 * Aggregate stats only. Enumerating every wallet id lets anyone watch (and
 * spend against) other people's balances, so the full listing is admin-gated.
 */
walletRouter.get("/", (req, res) => {
  if (!config.adminToken) {
    res.json({ stats: ledger.stats() });
    return;
  }
  if (req.headers.authorization !== `Bearer ${config.adminToken}`) {
    res.status(401).json({ error: "unauthorized", message: "Admin token required" });
    return;
  }
  res.json({ stats: ledger.stats(), wallets: ledger.list() });
});

/**
 * Read-only. Must not create the wallet: a GET that mints starting credit
 * turns any public deployment into an unlimited faucet.
 */
walletRouter.get("/:walletId", (req, res) => {
  const snapshot = ledger.peek(req.params.walletId);
  res.json({
    ...snapshot,
    balanceFormatted: formatUsd(snapshot.balanceMicroUsd),
    x402Enabled: isX402Ready(),
    x402Configured: isX402Enabled(),
    demoMode: config.demoMode,
    faucetRemaining: ledger.stats().faucetRemaining,
  });
});

/** Dedicated top-up endpoint — returns 402 with x402 payment options. */
walletRouter.post(
  "/:walletId/fund",
  asyncRoute(async (req, res) => {
    const walletId = req.params.walletId;

    try {
      const settlement = await settleIncomingPayment(req, walletId);
      if (settlement) {
        attachPaymentResponse(res, settlement);
        const wallet = ledger.get(walletId);
        return res.json({
          status: "credited",
          creditedUsd: microToUsd(settlement.creditedMicroUsd),
          balanceUsd: microToUsd(wallet.balanceMicroUsd),
          transaction: settlement.tx,
          payer: settlement.payer,
        });
      }
    } catch (err) {
      return res.status(402).json({ error: "payment_failed", message: err.message });
    }

    await sendPaymentRequired(res, req, {
      walletId,
      balanceMicroUsd: ledger.peek(walletId).balanceMicroUsd,
      requiredMicroUsd: 0,
      description: "PayAI wallet top-up",
      error: "Send PAYMENT-SIGNATURE to fund your PayAI wallet",
    });
  }),
);

/**
 * Verifiable spend history: every usage entry plus the onchain settlements that
 * funded it. This is the thing a centralized credit system cannot offer — each
 * charge traces back to a transaction the caller can independently check.
 */
walletRouter.get("/:walletId/receipts", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  res.json(ledger.receipts(req.params.walletId, limit));
});

/** Issue a nonce for proof-of-ownership signing. */
walletRouter.post("/:walletId/challenge", (req, res) => {
  const walletId = String(req.params.walletId).trim().toLowerCase();
  res.json({ walletId, authMode: authMode(), ...issueChallenge(walletId) });
});

/** Demo-only instant credit when crypto addresses aren't configured. */
walletRouter.post("/:walletId/simulate-fund", (req, res) => {
  if (!config.demoMode) {
    res.status(403).json({ error: "demo_mode_disabled", message: "Set PAYAI_DEMO_MODE=true or configure pay-to addresses" });
    return;
  }

  const walletId = String(req.params.walletId).trim().toLowerCase();
  const used = simulatedTopUps.get(walletId) ?? 0;
  if (used >= MAX_SIMULATED_TOPUPS) {
    res.status(429).json({
      error: "simulated_topup_limit",
      message: `This wallet has used all ${MAX_SIMULATED_TOPUPS} demo credits. Use a real x402 top-up.`,
    });
    return;
  }
  simulatedTopUps.set(walletId, used + 1);

  const credit = topUpCreditMicro();
  ledger.credit(walletId, credit, { simulated: true });
  const wallet = ledger.get(walletId);
  res.json({
    status: "simulated_credit",
    creditedUsd: microToUsd(credit),
    balanceUsd: microToUsd(wallet.balanceMicroUsd),
    remainingSimulatedTopUps: MAX_SIMULATED_TOPUPS - (used + 1),
  });
});

/** Server-sent events for live dashboard updates. */
walletRouter.get("/:walletId/events", (req, res) => {
  const walletId = String(req.params.walletId).trim().toLowerCase();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  // Prevent Node from buffering SSE
  if (typeof res.socket?.setNoDelay === "function") {
    res.socket.setNoDelay(true);
  }

  let closed = false;
  const write = (payload) => {
    if (closed || res.writableEnded) return;
    try {
      res.write(payload);
    } catch {
      closed = true;
    }
  };

  const send = (event) => {
    if (event.walletId && event.walletId !== walletId) return;
    write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Observing a wallet must not create it — watch before it exists and the
  // wallet_created event will stream in when the first request lands.
  send({ type: "snapshot", walletId, wallet: ledger.peek(walletId) });

  // keepalive so proxies don't kill the stream
  const ping = setInterval(() => {
    write(`: ping ${Date.now()}\n\n`);
  }, 15000);

  const unsub = ledger.subscribe(send);
  const cleanup = () => {
    closed = true;
    clearInterval(ping);
    unsub();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
});
