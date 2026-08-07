import { createPublicClient, custom, http } from "viem";
import { config } from "../config.js";
import { networkInfo } from "./networks.js";

/**
 * Read-only chain access, used to verify that a settlement the facilitator
 * reported actually happened onchain.
 *
 * Two ways to reach a node, in priority order:
 *
 *  1. `PAYAI_QUICKNODE_RPC_URL` — a normal authenticated QuickNode endpoint.
 *  2. `PAYAI_QUICKNODE_X402=true` — pay QuickNode per RPC call over x402.
 *     PayAI is the *buyer* here, which is the same protocol it uses to sell
 *     inference. No API key, no QuickNode account on the request path.
 *
 * Mode 2 is the interesting one and the reason `@quicknode/x402` is a
 * dependency, but mode 1 is cheaper and is what you want under load.
 */

/** @type {Map<string, import('viem').PublicClient>} */
const clients = new Map();
/** @type {Promise<typeof globalThis.fetch> | null} */
let quicknodeFetchPromise = null;

export function rpcMode() {
  if (config.quicknodeRpcUrl) return "quicknode-rpc";
  if (config.quicknodeX402 && config.quicknodeX402Key) return "quicknode-x402";
  return "none";
}

export function rpcStatus() {
  return {
    mode: rpcMode(),
    verifySettlements: config.verifySettlements && rpcMode() !== "none",
    endpoint:
      rpcMode() === "quicknode-x402"
        ? config.quicknodeX402BaseUrl
        : config.quicknodeRpcUrl
          ? redact(config.quicknodeRpcUrl)
          : null,
  };
}

/** QuickNode URLs carry the credential in the path — never log them whole. */
function redact(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/…`;
  } catch {
    return "(invalid url)";
  }
}

/**
 * Build (once) a fetch that pays QuickNode per request over x402.
 *
 * Lazy and memoised: creating the client derives signers and may pre-auth over
 * the network, and a verification path must not pay that cost per settlement.
 */
async function quicknodeX402Fetch() {
  if (!quicknodeFetchPromise) {
    quicknodeFetchPromise = (async () => {
      const { createQuicknodeX402Client } = await import("@quicknode/x402");
      const client = await createQuicknodeX402Client({
        baseUrl: config.quicknodeX402BaseUrl,
        // The chain PayAI *pays on*, which is independent of the chain it reads.
        network: config.quicknodeX402PayNetwork,
        evmPrivateKey: config.quicknodeX402Key,
        paymentModel: "credit-drawdown",
        preAuth: true,
      });
      console.log(
        `[chain] QuickNode x402 client ready — paying on ${config.quicknodeX402PayNetwork} via ${config.quicknodeX402BaseUrl}`,
      );
      return client.fetch;
    })().catch((err) => {
      // Reset so a transient failure (QuickNode down, unfunded payer) doesn't
      // poison every later attempt with a permanently rejected promise.
      quicknodeFetchPromise = null;
      throw err;
    });
  }
  return quicknodeFetchPromise;
}

/**
 * A viem transport that speaks JSON-RPC over the x402-paying fetch.
 *
 * viem's `http()` transport owns its own fetch, so paying per call means
 * driving the request ourselves through `custom()`.
 */
function x402Transport(info) {
  const url = `${config.quicknodeX402BaseUrl}/${info.quicknodeSlug}`;
  let id = 0;

  return custom({
    async request({ method, params }) {
      const payingFetch = await quicknodeX402Fetch();
      id += 1;

      const res = await payingFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? [] }),
      });

      if (!res.ok) {
        throw new Error(`QuickNode x402 RPC ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }

      const body = await res.json();
      if (body.error) {
        throw new Error(`RPC ${method} failed: ${body.error.message ?? JSON.stringify(body.error)}`);
      }
      return body.result;
    },
  });
}

/**
 * Public client for a CAIP-2 network, or null when this deployment has no way
 * to reach that chain. Callers degrade to "unverified" rather than failing.
 *
 * @returns {import('viem').PublicClient | null}
 */
export function publicClientFor(caip2) {
  const info = networkInfo(caip2);
  if (!info) return null;

  const mode = rpcMode();
  if (mode === "none") return null;

  const cacheKey = `${mode}:${info.caip2}`;
  if (!clients.has(cacheKey)) {
    const transport =
      mode === "quicknode-x402"
        ? x402Transport(info)
        : http(config.quicknodeRpcUrl, { timeout: 15_000, retryCount: 2 });

    clients.set(cacheKey, createPublicClient({ chain: info.chain, transport }));
  }
  return clients.get(cacheKey);
}
