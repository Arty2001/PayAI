import { config, microToUsd } from "../config.js";
import { ledger } from "../store/ledger.js";
import { estimateRequestCostMicro } from "../billing/pricing.js";
import {
  attachPaymentResponse,
  sendPaymentRequired,
  settleIncomingPayment,
} from "../x402/service.js";

/**
 * Billing gate for LLM proxy routes.
 * 1. Optionally settle x402 PAYMENT-SIGNATURE (top-up)
 * 2. Reserve estimated cost from wallet
 * 3. Return 402 if insufficient
 *
 * Every reservation is guaranteed to settle exactly once: either the proxy
 * reports real usage via finalizeBilling(), or the response-close hook
 * releases the hold. Without that hook any error path (upstream 5xx, missing
 * API key, client abort) silently keeps the caller's money.
 */
export function createBillingGate({ provider, routeLabel }) {
  return async function billingGate(req, res, next) {
    const walletId = req.payaiWallet;
    if (!walletId) return next();

    try {
      const settlement = await settleIncomingPayment(req, walletId);
      if (settlement) {
        req.payaiSettlement = settlement;
        attachPaymentResponse(res, settlement);
      }
    } catch (err) {
      res.status(402).json({
        error: "payment_failed",
        message: err.message,
      });
      return;
    }

    const requiredMicroUsd = estimateRequestCostMicro(req.body ?? {}, provider);
    const wallet = ledger.getOrCreate(walletId);

    if (wallet.balanceMicroUsd < requiredMicroUsd) {
      await safeSendPaymentRequired(res, req, {
        walletId,
        balanceMicroUsd: wallet.balanceMicroUsd,
        requiredMicroUsd,
        description: `PayAI ${routeLabel} — LLM inference credits`,
        error: `Need ~${microToUsd(requiredMicroUsd).toFixed(6)} USD; balance ${microToUsd(wallet.balanceMicroUsd).toFixed(6)} USD`,
      });
      return;
    }

    const reserve = ledger.reserve(walletId, requiredMicroUsd, {
      provider,
      route: routeLabel,
      model: req.body?.model,
    });

    if (!reserve.ok) {
      await safeSendPaymentRequired(res, req, {
        walletId,
        balanceMicroUsd: wallet.balanceMicroUsd,
        requiredMicroUsd,
        description: `PayAI ${routeLabel} — LLM inference credits`,
      });
      return;
    }

    req.payaiBilling = {
      walletId,
      reservedMicroUsd: requiredMicroUsd,
      provider,
      routeLabel,
      model: req.body?.model,
      settled: false,
    };

    // Safety net: whatever happens downstream, the hold is never left dangling.
    //
    // Deferred by one turn of the event loop on purpose. On a streamed response
    // the proxy reads usage out of the body *after* piping it to the client, so
    // 'close' fires before the real charge is recorded. Releasing synchronously
    // here would mark the request settled and make the subsequent
    // finalizeBilling() a no-op — the refund would win the race against the
    // charge, and every streamed call would be free.
    //
    // setImmediate runs in the check phase, after promise continuations have
    // drained, so a legitimate settlement always lands first and this becomes
    // the no-op instead.
    res.on("close", () => {
      setImmediate(() => releaseBilling(req, "response_closed_before_settlement"));
    });

    next();
  };
}

/**
 * Building a 402 body talks to the x402 facilitator, which can fail. An
 * unhandled rejection here would crash the process on the exact code path the
 * product exists to serve, so degrade to a plain 402 instead.
 */
async function safeSendPaymentRequired(res, req, options) {
  try {
    await sendPaymentRequired(res, req, options);
  } catch (err) {
    if (res.headersSent) return;
    res.status(402).json({
      error: "payment_required",
      message: options.error ?? "Insufficient PayAI balance.",
      walletId: options.walletId,
      balanceUsd: microToUsd(options.balanceMicroUsd),
      requiredUsd: microToUsd(options.requiredMicroUsd),
      topUpPriceUsd: config.topUpPriceUsd,
      topUpCreditUsd: config.topUpCreditUsd,
      x402Enabled: false,
      x402Error: err.message,
      demoMode: config.demoMode,
    });
  }
}

/** Record real usage against the reservation. Idempotent. */
export function finalizeBilling(req, usage) {
  const billing = req.payaiBilling;
  if (!billing || billing.settled) return;
  billing.settled = true;

  ledger.reconcile(
    billing.walletId,
    billing.reservedMicroUsd,
    usage.actualMicroUsd,
    {
      provider: billing.provider,
      model: usage.model ?? billing.model,
      route: billing.routeLabel,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    },
  );
}

/** Refund the full reservation — the request never produced billable usage. */
export function releaseBilling(req, reason = "request_failed") {
  const billing = req.payaiBilling;
  if (!billing || billing.settled) return;
  billing.settled = true;

  ledger.release(billing.walletId, billing.reservedMicroUsd, {
    provider: billing.provider,
    route: billing.routeLabel,
    model: billing.model,
    reason,
  });
}
