import { base, baseSepolia } from "viem/chains";

/**
 * Chain facts needed to independently verify an x402 settlement.
 *
 * USDC has 6 decimals, so a raw token amount is already denominated in
 * micro-dollars — the same unit the ledger uses. No conversion, no rounding.
 */

/** @type {Record<string, ChainInfo>} */
export const NETWORKS = {
  "eip155:84532": {
    caip2: "eip155:84532",
    chain: baseSepolia,
    name: "Base Sepolia",
    testnet: true,
    usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    explorerTx: (hash) => `https://sepolia.basescan.org/tx/${hash}`,
    /** Path segment on x402.quicknode.com serving this chain's RPC. */
    quicknodeSlug: "base-sepolia",
  },
  "eip155:8453": {
    caip2: "eip155:8453",
    chain: base,
    name: "Base",
    testnet: false,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    explorerTx: (hash) => `https://basescan.org/tx/${hash}`,
    quicknodeSlug: "base-mainnet",
  },
};

/**
 * Look up a network by CAIP-2 id.
 *
 * The facilitator reports the network it settled on, and it is not required to
 * be one we know about (an SVM settlement, or a chain added after this map was
 * written). Callers treat `null` as "cannot verify", never as "invalid".
 *
 * @returns {ChainInfo | null}
 */
export function networkInfo(caip2) {
  if (!caip2) return null;
  return NETWORKS[String(caip2)] ?? null;
}

export function explorerUrl(caip2, hash) {
  const info = networkInfo(caip2);
  return info && hash ? info.explorerTx(hash) : null;
}

/**
 * @typedef {object} ChainInfo
 * @property {string} caip2
 * @property {import('viem').Chain} chain
 * @property {string} name
 * @property {boolean} testnet
 * @property {string} usdc
 * @property {(hash: string) => string} explorerTx
 * @property {string} quicknodeSlug
 */
