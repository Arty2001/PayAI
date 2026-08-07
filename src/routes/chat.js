import { Router } from "express";
import { walletGate } from "../middleware/wallet.js";
import { createBillingGate } from "../middleware/billing-gate.js";
import { enforcePolicy } from "../middleware/policy.js";
import { handleOpenAIChatCompletions } from "../proxy/openai.js";

export const chatRouter = Router();

/** Express 4 does not catch rejected async middleware — forward explicitly. */
const asyncMw = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

chatRouter.post(
  "/v1/chat/completions",
  asyncMw(walletGate),
  enforcePolicy({ provider: "openai" }),
  createBillingGate({ provider: "openai", routeLabel: "openai-chat" }),
  handleOpenAIChatCompletions,
);
