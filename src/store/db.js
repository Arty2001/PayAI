import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/**
 * Durable store for balances, usage receipts, and settled payments.
 *
 * The ledger keeps a hot in-memory copy for the SSE/proxy path; this is the
 * source of truth that survives a restart. Balances people paid real USDC for
 * must not evaporate on redeploy.
 *
 * node:sqlite is built into Node 22.5+ — no dependency, no native build step,
 * which matters on hosts that will not compile better-sqlite3.
 */

const DB_PATH = process.env.PAYAI_DB_PATH ?? "./data/payai.db";

function openDatabase() {
  if (DB_PATH !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
  }
  const database = new DatabaseSync(DB_PATH);
  // WAL survives an unclean shutdown and lets the SSE readers run alongside writes.
  if (DB_PATH !== ":memory:") database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

export const db = openDatabase();

db.exec(`
  CREATE TABLE IF NOT EXISTS wallets (
    id                    TEXT PRIMARY KEY,
    balance_micro         INTEGER NOT NULL DEFAULT 0,
    held_micro            INTEGER NOT NULL DEFAULT 0,
    total_spent_micro     INTEGER NOT NULL DEFAULT 0,
    total_topup_micro     INTEGER NOT NULL DEFAULT 0,
    request_count         INTEGER NOT NULL DEFAULT 0,
    seeded                INTEGER NOT NULL DEFAULT 0,
    owner_address         TEXT,
    created_at            INTEGER NOT NULL,
    updated_at            INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS requests (
    id                    TEXT PRIMARY KEY,
    wallet_id             TEXT NOT NULL,
    at                    INTEGER NOT NULL,
    provider              TEXT,
    model                 TEXT,
    route                 TEXT,
    reserved_micro        INTEGER NOT NULL,
    actual_micro          INTEGER NOT NULL,
    under_reserved_micro  INTEGER NOT NULL DEFAULT 0,
    input_tokens          INTEGER,
    output_tokens         INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_requests_wallet ON requests (wallet_id, at DESC);

  CREATE TABLE IF NOT EXISTS settlements (
    nonce_key             TEXT PRIMARY KEY,
    wallet_id             TEXT NOT NULL,
    payer                 TEXT,
    transaction_hash      TEXT,
    network               TEXT,
    credited_micro        INTEGER NOT NULL,
    at                    INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_settlements_wallet ON settlements (wallet_id, at DESC);
`);

/**
 * Additive migrations.
 *
 * Databases created before onchain verification existed are already holding
 * real balances, so the schema is widened in place rather than recreated.
 */
function addColumnIfMissing(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  if (existing.some((col) => col.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

// 'pending' until the background verifier reports back; 'unverifiable' when
// this deployment has no RPC to check with — which is not the same as 'failed'.
addColumnIfMissing("settlements", "verify_status", "TEXT NOT NULL DEFAULT 'pending'");
addColumnIfMissing("settlements", "block_number", "INTEGER");
addColumnIfMissing("settlements", "verified_micro", "INTEGER");
addColumnIfMissing("settlements", "verified_at", "INTEGER");
addColumnIfMissing("settlements", "verify_error", "TEXT");

const statements = {
  allWallets: db.prepare("SELECT * FROM wallets"),
  upsertWallet: db.prepare(`
    INSERT INTO wallets (id, balance_micro, held_micro, total_spent_micro, total_topup_micro,
                         request_count, seeded, owner_address, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      balance_micro     = excluded.balance_micro,
      held_micro        = excluded.held_micro,
      total_spent_micro = excluded.total_spent_micro,
      total_topup_micro = excluded.total_topup_micro,
      request_count     = excluded.request_count,
      seeded            = excluded.seeded,
      owner_address     = COALESCE(excluded.owner_address, wallets.owner_address),
      updated_at        = excluded.updated_at
  `),
  insertRequest: db.prepare(`
    INSERT INTO requests (id, wallet_id, at, provider, model, route,
                          reserved_micro, actual_micro, under_reserved_micro,
                          input_tokens, output_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  recentRequests: db.prepare(
    "SELECT * FROM requests WHERE wallet_id = ? ORDER BY at DESC LIMIT ?",
  ),
  insertSettlement: db.prepare(`
    INSERT INTO settlements (nonce_key, wallet_id, payer, transaction_hash, network, credited_micro, at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `),
  settlementExists: db.prepare("SELECT 1 FROM settlements WHERE nonce_key = ?"),
  settlementsForWallet: db.prepare(
    "SELECT * FROM settlements WHERE wallet_id = ? ORDER BY at DESC LIMIT ?",
  ),
  countSeeded: db.prepare("SELECT COUNT(*) AS n FROM wallets WHERE seeded = 1"),
  updateVerification: db.prepare(`
    UPDATE settlements
       SET verify_status = ?, block_number = ?, verified_micro = ?, verified_at = ?, verify_error = ?
     WHERE nonce_key = ?
  `),
  pendingSettlements: db.prepare(
    "SELECT * FROM settlements WHERE verify_status = 'pending' ORDER BY at DESC LIMIT ?",
  ),
  verificationCounts: db.prepare(
    "SELECT verify_status, COUNT(*) AS n FROM settlements GROUP BY verify_status",
  ),
};

export const store = {
  loadWallets() {
    return statements.allWallets.all();
  },

  saveWallet(wallet) {
    statements.upsertWallet.run(
      wallet.id,
      wallet.balanceMicroUsd,
      wallet.heldMicroUsd,
      wallet.totalSpentMicroUsd,
      wallet.totalTopUpMicroUsd,
      wallet.requestCount,
      wallet.seeded ? 1 : 0,
      wallet.ownerAddress ?? null,
      wallet.createdAt,
      wallet.updatedAt,
    );
  },

  saveRequest(walletId, entry) {
    statements.insertRequest.run(
      entry.id,
      walletId,
      entry.at,
      entry.provider ?? null,
      entry.model ?? null,
      entry.route ?? null,
      entry.reservedMicroUsd,
      entry.actualMicroUsd,
      entry.underReservedMicroUsd ?? 0,
      entry.inputTokens ?? null,
      entry.outputTokens ?? null,
    );
  },

  recentRequests(walletId, limit = 20) {
    return statements.recentRequests.all(walletId, limit);
  },

  /** @returns {boolean} false when this payment was already settled (replay). */
  recordSettlement({ nonceKey, walletId, payer, transaction, network, creditedMicroUsd }) {
    if (statements.settlementExists.get(nonceKey)) return false;
    statements.insertSettlement.run(
      nonceKey,
      walletId,
      payer ?? null,
      transaction ?? null,
      network ?? null,
      creditedMicroUsd,
      Date.now(),
    );
    return true;
  },

  settlements(walletId, limit = 50) {
    return statements.settlementsForWallet.all(walletId, limit);
  },

  /** Record the verdict of an onchain check against a settled payment. */
  saveVerification(nonceKey, { status, blockNumber, amountMicroUsd, error }) {
    statements.updateVerification.run(
      status,
      blockNumber ?? null,
      amountMicroUsd ?? null,
      Date.now(),
      error ?? null,
      nonceKey,
    );
  },

  /** Settlements credited but never confirmed — re-checked on boot. */
  pendingVerifications(limit = 100) {
    return statements.pendingSettlements.all(limit);
  },

  /** @returns {Record<string, number>} verify_status → count */
  verificationStats() {
    const out = {};
    for (const row of statements.verificationCounts.all()) {
      out[row.verify_status] = row.n;
    }
    return out;
  },

  seededWalletCount() {
    return statements.countSeeded.get().n;
  },

  close() {
    try {
      db.close();
    } catch {
      // already closed
    }
  },
};
