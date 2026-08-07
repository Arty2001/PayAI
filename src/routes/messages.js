import { Router } from "express";
import { walletGate } from "../middleware/wallet.js";
import { createBillingGate } from "../middleware/billing-gate.js";
import { enforcePolicy } from "../middleware/policy.js";
import { handleAnthropicMessages } from "../proxy/anthropic.js";

export const messagesRouter = Router();

/** Express 4 does not catch rejected async middleware — forward explicitly. */
const asyncMw = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

messagesRouter.post(
  "/v1/messages",
  asyncMw(walletGate),
  enforcePolicy({ provider: "anthropic" }),
  createBillingGate({ provider: "anthropic", routeLabel: "anthropic-messages" }),
  handleAnthropicMessages,
);
