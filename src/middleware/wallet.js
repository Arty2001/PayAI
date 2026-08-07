import { config } from "../config.js";

export function extractWalletId(req) {
  const fromHeader = req.headers[config.walletHeader];
  if (fromHeader && String(fromHeader).trim()) {
    return String(fromHeader).trim();
  }

  const auth = req.headers.authorization;
  if (auth?.startsWith("PayAI wallet=")) {
    return auth.slice("PayAI wallet=".length).trim();
  }

  return null;
}

import { verifyWalletOwnership } from "./wallet-auth.js";

/**
 * Resolve the caller's wallet and prove they are allowed to spend it.
 * Shared by every billed route so the two checks can never drift apart.
 */
export async function walletGate(req, res, next) {
  const walletId = requireWallet(req, res);
  if (!walletId) return;

  const auth = await verifyWalletOwnership(req, walletId);
  if (!auth.ok) {
    res.status(auth.status).json(auth.body);
    return;
  }

  req.payaiWallet = walletId;
  next();
}

export function requireWallet(req, res) {
  const walletId = extractWalletId(req);
  if (!walletId) {
    res.status(400).json({
      error: {
        type: "wallet_required",
        message: `Set ${config.walletHeader} header or Authorization: PayAI wallet=<address>`,
      },
    });
    return null;
  }
  return walletId;
}
