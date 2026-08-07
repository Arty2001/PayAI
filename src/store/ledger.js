import { EventEmitter } from "node:events";
import { config, usdToMicro, microToUsd } from "../config.js";
import { explorerUrl } from "../chain/networks.js";
import { store } from "./db.js";

const normalizeId = (walletId) => String(walletId ?? "").trim().toLowerCase();

/**
 * Prepaid ledger: an in-memory working set backed by SQLite.
 *
 * Reads (SSE snapshots, the proxy hot path) hit memory; every mutation is
 * written through to disk before the event is published, so a crash between
 * the two can only lose the notification, never the money.
 *
 * Invariants:
 *  - balanceMicroUsd never goes negative
 *  - every reserve() is matched by exactly one reconcile() or release()
 *  - heldMicroUsd is the sum of in-flight reservations
 */
class Ledger extends EventEmitter {
  constructor() {
    super();
    // One listener per open SSE dashboard — the default cap of 10 would warn.
    this.setMaxListeners(0);
    /** @type {Map<string, WalletRecord>} */
    this.wallets = new Map();
    this.faucetClaims = 0;
    this.hydrate();
  }

  /** Restore balances from disk. Held funds are dropped: any request that was
   *  in flight when the process died is gone, so its escrow is returned. */
  hydrate() {
    for (const row of store.loadWallets()) {
      this.wallets.set(row.id, {
        id: row.id,
        balanceMicroUsd: row.balance_micro + row.held_micro,
        heldMicroUsd: 0,
        totalSpentMicroUsd: row.total_spent_micro,
        totalTopUpMicroUsd: row.total_topup_micro,
        requestCount: row.request_count,
        seeded: Boolean(row.seeded),
        ownerAddress: row.owner_address ?? null,
        recentRequests: store.recentRequests(row.id, 50).map(fromRequestRow),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      });
    }
    this.faucetClaims = store.seededWalletCount();
    if (this.wallets.size) {
      console.log(`[ledger] restored ${this.wallets.size} wallet(s) from disk`);
    }
  }

  persist(wallet) {
    store.saveWallet(wallet);
  }

  /** Starting balance for a brand-new wallet, subject to the faucet cap. */
  seedMicroUsd() {
    if (this.faucetClaims >= config.maxFreeWallets) return 0;
    return usdToMicro(config.initialBalanceUsd);
  }

  /** @returns {WalletRecord} */
  getOrCreate(walletId) {
    const normalized = normalizeId(walletId);
    if (!this.wallets.has(normalized)) {
      const seed = this.seedMicroUsd();
      if (seed > 0) this.faucetClaims += 1;

      const record = {
        id: normalized,
        balanceMicroUsd: seed,
        heldMicroUsd: 0,
        totalSpentMicroUsd: 0,
        totalTopUpMicroUsd: 0,
        requestCount: 0,
        seeded: seed > 0,
        ownerAddress: null,
        recentRequests: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.wallets.set(normalized, record);
      this.persist(record);
      this.publish({
        type: "wallet_created",
        walletId: normalized,
        amountMicroUsd: seed,
        balanceMicroUsd: seed,
        faucet: seed > 0,
        wallet: this.snapshot(record),
      });
    }
    return this.wallets.get(normalized);
  }

  /** @returns {WalletRecord | undefined} */
  get(walletId) {
    return this.wallets.get(normalizeId(walletId));
  }

  /** @returns {WalletSnapshot[]} */
  list() {
    return [...this.wallets.values()].map((w) => this.snapshot(w));
  }

  /**
   * Bind a wallet to the address that funded it. First payer wins; later
   * payments from other addresses top it up but never take over ownership.
   */
  claimOwner(walletId, address) {
    if (!address) return null;
    const wallet = this.getOrCreate(walletId);
    if (!wallet.ownerAddress) {
      wallet.ownerAddress = String(address).toLowerCase();
      wallet.updatedAt = Date.now();
      this.persist(wallet);
    }
    return wallet.ownerAddress;
  }

  credit(walletId, amountMicroUsd, meta = {}) {
    const wallet = this.getOrCreate(walletId);
    wallet.balanceMicroUsd += amountMicroUsd;
    wallet.totalTopUpMicroUsd += amountMicroUsd;
    wallet.updatedAt = Date.now();
    this.persist(wallet);
    this.publish({
      type: "top_up",
      walletId: wallet.id,
      amountMicroUsd,
      balanceMicroUsd: wallet.balanceMicroUsd,
      wallet: this.snapshot(wallet),
      ...meta,
    });
    return wallet;
  }

  reserve(walletId, amountMicroUsd, meta = {}) {
    const wallet = this.getOrCreate(walletId);
    if (wallet.balanceMicroUsd < amountMicroUsd) {
      return { ok: false, wallet, shortfallMicroUsd: amountMicroUsd - wallet.balanceMicroUsd };
    }
    wallet.balanceMicroUsd -= amountMicroUsd;
    wallet.heldMicroUsd += amountMicroUsd;
    wallet.updatedAt = Date.now();
    this.persist(wallet);
    this.publish({
      type: "reserve",
      walletId: wallet.id,
      amountMicroUsd,
      balanceMicroUsd: wallet.balanceMicroUsd,
      wallet: this.snapshot(wallet),
      ...meta,
    });
    return { ok: true, wallet };
  }

  /**
   * Return a reservation to the wallet without recording usage.
   * Used when a request fails before the provider bills us for anything.
   */
  release(walletId, reservedMicroUsd, meta = {}) {
    const wallet = this.getOrCreate(walletId);
    wallet.balanceMicroUsd += reservedMicroUsd;
    wallet.heldMicroUsd = Math.max(0, wallet.heldMicroUsd - reservedMicroUsd);
    wallet.updatedAt = Date.now();
    this.persist(wallet);
    this.publish({
      type: "release",
      walletId: wallet.id,
      amountMicroUsd: reservedMicroUsd,
      balanceMicroUsd: wallet.balanceMicroUsd,
      wallet: this.snapshot(wallet),
      ...meta,
    });
    return wallet;
  }

  reconcile(walletId, reservedMicroUsd, actualMicroUsd, meta = {}) {
    const wallet = this.getOrCreate(walletId);

    // Never charge more than was actually held for this request, and never let
    // an underestimated reservation push the balance below zero.
    const charged = Math.max(0, Math.min(actualMicroUsd, reservedMicroUsd));
    const refund = reservedMicroUsd - charged;

    wallet.balanceMicroUsd = Math.max(0, wallet.balanceMicroUsd + refund);
    wallet.heldMicroUsd = Math.max(0, wallet.heldMicroUsd - reservedMicroUsd);
    wallet.totalSpentMicroUsd += charged;
    wallet.requestCount += 1;
    wallet.updatedAt = Date.now();

    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: Date.now(),
      provider: meta.provider,
      model: meta.model,
      reservedMicroUsd,
      actualMicroUsd: charged,
      /** Set when the estimate under-reserved and the excess was written off. */
      underReservedMicroUsd: Math.max(0, actualMicroUsd - reservedMicroUsd),
      inputTokens: meta.inputTokens ?? null,
      outputTokens: meta.outputTokens ?? null,
      route: meta.route,
    };
    wallet.recentRequests.unshift(entry);
    wallet.recentRequests = wallet.recentRequests.slice(0, 50);

    this.persist(wallet);
    store.saveRequest(wallet.id, entry);

    this.publish({
      type: "usage",
      walletId: wallet.id,
      amountMicroUsd: charged,
      balanceMicroUsd: wallet.balanceMicroUsd,
      wallet: this.snapshot(wallet),
      entry,
    });
    return wallet;
  }

  /**
   * Persist a settled x402 payment and credit the wallet exactly once.
   * @returns {{ credited: boolean, replay: boolean }}
   */
  settle({ nonceKey, walletId, payer, transaction, network, creditedMicroUsd }) {
    const accepted = store.recordSettlement({
      nonceKey,
      walletId: normalizeId(walletId),
      payer,
      transaction,
      network,
      creditedMicroUsd,
    });

    if (!accepted) return { credited: false, replay: true };

    this.claimOwner(walletId, payer);
    this.credit(walletId, creditedMicroUsd, { tx: transaction, network, payer });
    return { credited: true, replay: false };
  }

  /**
   * Record an onchain verification verdict and tell any listening dashboard.
   * Balances are untouched: the money moved when the facilitator settled, and
   * this only annotates the receipt with what the chain says about it.
   */
  recordVerification(nonceKey, walletId, result) {
    store.saveVerification(nonceKey, result);
    this.publish({
      type: "settlement_verified",
      walletId: normalizeId(walletId),
      status: result.status,
      blockNumber: result.blockNumber,
      error: result.error,
    });
  }

  /** Verifiable spend history: usage entries plus the settlements funding them. */
  receipts(walletId, limit = 50) {
    const id = normalizeId(walletId);
    return {
      walletId: id,
      settlements: store.settlements(id, limit).map((row) => ({
        transaction: row.transaction_hash,
        network: row.network,
        payer: row.payer,
        creditedUsd: microToUsd(row.credited_micro),
        at: row.at,
        /** What the chain says, read independently of the facilitator. */
        verification: {
          status: row.verify_status ?? "pending",
          blockNumber: row.block_number ?? null,
          onchainUsd: row.verified_micro == null ? null : microToUsd(row.verified_micro),
          checkedAt: row.verified_at ?? null,
          error: row.verify_error ?? null,
          explorerUrl: explorerUrl(row.network, row.transaction_hash),
        },
      })),
      usage: store.recentRequests(id, limit).map((row) => ({
        id: row.id,
        at: row.at,
        provider: row.provider,
        model: row.model,
        route: row.route,
        costUsd: microToUsd(row.actual_micro),
        reservedUsd: microToUsd(row.reserved_micro),
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
      })),
    };
  }

  snapshot(wallet) {
    return {
      id: wallet.id,
      exists: true,
      balanceMicroUsd: wallet.balanceMicroUsd,
      balanceUsd: microToUsd(wallet.balanceMicroUsd),
      heldMicroUsd: wallet.heldMicroUsd,
      heldUsd: microToUsd(wallet.heldMicroUsd),
      totalSpentMicroUsd: wallet.totalSpentMicroUsd,
      totalTopUpMicroUsd: wallet.totalTopUpMicroUsd,
      requestCount: wallet.requestCount,
      ownerAddress: wallet.ownerAddress,
      recentRequests: wallet.recentRequests.slice(0, 20),
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }

  /** Read-only view of a wallet that may not exist yet — never mints credit. */
  peek(walletId) {
    const wallet = this.get(walletId);
    if (wallet) return this.snapshot(wallet);
    return {
      id: normalizeId(walletId),
      exists: false,
      balanceMicroUsd: 0,
      balanceUsd: 0,
      heldMicroUsd: 0,
      heldUsd: 0,
      totalSpentMicroUsd: 0,
      totalTopUpMicroUsd: 0,
      requestCount: 0,
      ownerAddress: null,
      recentRequests: [],
      createdAt: null,
      updatedAt: null,
    };
  }

  /** Aggregate stats safe to expose without leaking wallet ids. */
  stats() {
    let balance = 0;
    let spent = 0;
    let requests = 0;
    for (const w of this.wallets.values()) {
      balance += w.balanceMicroUsd;
      spent += w.totalSpentMicroUsd;
      requests += w.requestCount;
    }
    return {
      wallets: this.wallets.size,
      faucetClaims: this.faucetClaims,
      faucetRemaining: Math.max(0, config.maxFreeWallets - this.faucetClaims),
      totalBalanceUsd: microToUsd(balance),
      totalSpentUsd: microToUsd(spent),
      totalRequests: requests,
    };
  }

  publish(event) {
    this.emit("event", event);
  }

  subscribe(listener) {
    this.on("event", listener);
    return () => this.off("event", listener);
  }
}

function fromRequestRow(row) {
  return {
    id: row.id,
    at: row.at,
    provider: row.provider,
    model: row.model,
    route: row.route,
    reservedMicroUsd: row.reserved_micro,
    actualMicroUsd: row.actual_micro,
    underReservedMicroUsd: row.under_reserved_micro,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
  };
}

export const ledger = new Ledger();
