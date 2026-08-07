import { randomUUID, timingSafeEqual } from "node:crypto";
import { recoverMessageAddress } from "viem";
import { ledger } from "../store/ledger.js";

/**
 * Proof of wallet ownership.
 *
 * A wallet id alone is a bearer secret: anyone who learns it can spend the
 * balance. Once a wallet has been funded by a real x402 payer, that payer's
 * address is bound to it (ledger.claimOwner), and spending requires a signature
 * from the same key.
 *
 * Modes (PAYAI_WALLET_AUTH):
 *   off    — id only. Demo/local convenience.
 *   owned  — default. Wallets with a bound owner require a signature; faucet
 *            wallets nobody has paid for stay open, so the demo path is
 *            unchanged while real money is protected.
 *   strict — every wallet requires a signature.
 */

const MODE = process.env.PAYAI_WALLET_AUTH ?? "owned";
const NONCE_TTL_MS = Number(process.env.PAYAI_NONCE_TTL_MS ?? 5 * 60_000);

/** @type {Map<string, { walletId: string, expiresAt: number }>} */
const nonces = new Map();

function sweepNonces() {
  const now = Date.now();
  for (const [nonce, entry] of nonces) {
    if (entry.expiresAt <= now) nonces.delete(nonce);
  }
}

export function authMode() {
  return MODE;
}

/** Text the client signs. Readable in a wallet prompt, bound to one wallet+nonce. */
export function challengeMessage(walletId, nonce) {
  return `PayAI wallet authorization\nwallet: ${walletId}\nnonce: ${nonce}`;
}

export function issueChallenge(walletId) {
  sweepNonces();
  const nonce = randomUUID();
  const expiresAt = Date.now() + NONCE_TTL_MS;
  nonces.set(nonce, { walletId: String(walletId).trim().toLowerCase(), expiresAt });
  return { nonce, message: challengeMessage(walletId, nonce), expiresAt };
}

function addressesMatch(a, b) {
  if (!a || !b) return false;
  const left = Buffer.from(String(a).toLowerCase());
  const right = Buffer.from(String(b).toLowerCase());
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * @returns {Promise<{ ok: true } | { ok: false, status: number, body: object }>}
 */
export async function verifyWalletOwnership(req, walletId) {
  if (MODE === "off") return { ok: true };

  const wallet = ledger.get(walletId);
  const owner = wallet?.ownerAddress ?? null;

  // Nobody has staked a claim to this wallet yet — nothing to protect.
  if (MODE === "owned" && !owner) return { ok: true };

  const signature = req.headers["x-payai-signature"];
  const nonce = req.headers["x-payai-nonce"];

  if (!signature || !nonce) {
    return {
      ok: false,
      status: 401,
      body: {
        error: { type: "wallet_auth_required", message: "This wallet requires proof of ownership. POST /api/wallet/:id/challenge, sign the returned message, then resend with x-payai-nonce and x-payai-signature." },
      },
    };
  }

  sweepNonces();
  const issued = nonces.get(String(nonce));
  if (!issued) {
    return {
      ok: false,
      status: 401,
      body: { error: { type: "invalid_nonce", message: "Nonce unknown or expired" } },
    };
  }

  const normalizedWallet = String(walletId).trim().toLowerCase();
  if (issued.walletId !== normalizedWallet) {
    return {
      ok: false,
      status: 401,
      body: { error: { type: "invalid_nonce", message: "Nonce was issued for a different wallet" } },
    };
  }

  // Single use, whatever the outcome — prevents replaying a captured signature.
  nonces.delete(String(nonce));

  let recovered;
  try {
    recovered = await recoverMessageAddress({
      message: challengeMessage(normalizedWallet, String(nonce)),
      signature: String(signature),
    });
  } catch (err) {
    return {
      ok: false,
      status: 401,
      body: { error: { type: "invalid_signature", message: err.message } },
    };
  }

  if (owner && !addressesMatch(recovered, owner)) {
    return {
      ok: false,
      status: 403,
      body: {
        error: { type: "wallet_owner_mismatch", message: "Signature does not match the address that funded this wallet" },
      },
    };
  }

  // strict mode on an unowned wallet: the signer becomes the owner.
  if (!owner) ledger.claimOwner(normalizedWallet, recovered);

  req.payaiSigner = recovered;
  return { ok: true };
}
