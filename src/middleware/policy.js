import { ledger } from "../store/ledger.js";
import { microToUsd, usdToMicro } from "../config.js";
import { estimateRequestCostMicro } from "../billing/pricing.js";

/**
 * Spend policy enforced before any money moves.
 *
 * A wallet held by an autonomous agent needs limits the agent cannot talk its
 * way past: a runaway loop should exhaust a budget window, not a bank account.
 * Everything here is a hard ceiling checked server-side.
 *
 *   PAYAI_RATE_LIMIT_RPM       requests per minute per wallet (0 = off)
 *   PAYAI_HOURLY_BUDGET_USD    max spend per rolling hour per wallet (0 = off)
 *   PAYAI_MAX_REQUEST_USD      reject a single request estimated above this (0 = off)
 *   PAYAI_ALLOWED_MODELS       comma-separated allowlist (empty = all)
 *   PAYAI_MAX_TOKENS_CEILING   clamp max_tokens so one call cannot drain a wallet
 */

const RATE_LIMIT_RPM = Number(process.env.PAYAI_RATE_LIMIT_RPM ?? 60);
const HOURLY_BUDGET_USD = Number(process.env.PAYAI_HOURLY_BUDGET_USD ?? 0);
const MAX_REQUEST_USD = Number(process.env.PAYAI_MAX_REQUEST_USD ?? 0);
const MAX_TOKENS_CEILING = Number(process.env.PAYAI_MAX_TOKENS_CEILING ?? 0);
const ALLOWED_MODELS = (process.env.PAYAI_ALLOWED_MODELS ?? "")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

/** @type {Map<string, number[]>} wallet -> request timestamps (rolling window) */
const requestTimes = new Map();

function recentCount(walletId, windowMs) {
  const now = Date.now();
  const times = (requestTimes.get(walletId) ?? []).filter((t) => now - t < windowMs);
  requestTimes.set(walletId, times);
  return times.length;
}

function markRequest(walletId) {
  const times = requestTimes.get(walletId) ?? [];
  times.push(Date.now());
  requestTimes.set(walletId, times);
}

/** Spend recorded in the wallet's usage history within the window. */
function spentInWindow(walletId, windowMs) {
  const wallet = ledger.get(walletId);
  if (!wallet) return 0;
  const cutoff = Date.now() - windowMs;
  return wallet.recentRequests
    .filter((r) => r.at >= cutoff)
    .reduce((sum, r) => sum + r.actualMicroUsd, 0);
}

export function policyConfig() {
  return {
    rateLimitRpm: RATE_LIMIT_RPM,
    hourlyBudgetUsd: HOURLY_BUDGET_USD,
    maxRequestUsd: MAX_REQUEST_USD,
    maxTokensCeiling: MAX_TOKENS_CEILING,
    allowedModels: ALLOWED_MODELS,
  };
}

export function enforcePolicy({ provider }) {
  return function policyGate(req, res, next) {
    const walletId = req.payaiWallet;
    if (!walletId) return next();

    const body = req.body ?? {};
    const model = body.model;

    if (ALLOWED_MODELS.length && model && !ALLOWED_MODELS.includes(model)) {
      res.status(403).json({
        error: {
          type: "model_not_allowed",
          message: `Model "${model}" is not on this proxy's allowlist`,
          allowedModels: ALLOWED_MODELS,
        },
      });
      return;
    }

    if (RATE_LIMIT_RPM > 0 && recentCount(walletId, 60_000) >= RATE_LIMIT_RPM) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({
        error: {
          type: "rate_limited",
          message: `Wallet exceeded ${RATE_LIMIT_RPM} requests/minute`,
        },
      });
      return;
    }

    if (HOURLY_BUDGET_USD > 0) {
      const spent = spentInWindow(walletId, 3_600_000);
      if (spent >= usdToMicro(HOURLY_BUDGET_USD)) {
        res.status(429).json({
          error: {
            type: "budget_exceeded",
            message: `Wallet exceeded its hourly budget of $${HOURLY_BUDGET_USD}`,
            spentThisHourUsd: microToUsd(spent),
          },
        });
        return;
      }
    }

    // Clamp before the billing gate estimates cost, so the reservation and the
    // request the provider actually receives agree.
    if (MAX_TOKENS_CEILING > 0) {
      if (Number(body.max_tokens) > MAX_TOKENS_CEILING) body.max_tokens = MAX_TOKENS_CEILING;
      if (Number(body.max_completion_tokens) > MAX_TOKENS_CEILING) {
        body.max_completion_tokens = MAX_TOKENS_CEILING;
      }
    }

    if (MAX_REQUEST_USD > 0) {
      const estimate = estimateRequestCostMicro(body, provider);
      if (estimate > usdToMicro(MAX_REQUEST_USD)) {
        res.status(413).json({
          error: {
            type: "request_too_expensive",
            message: `Estimated cost $${microToUsd(estimate).toFixed(6)} exceeds the per-request cap of $${MAX_REQUEST_USD}`,
          },
        });
        return;
      }
    }

    markRequest(walletId);
    next();
  };
}
