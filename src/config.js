/** @typedef {'anthropic' | 'openai'} Provider */

const MICRO_USD = 1_000_000;

export const config = {
  port: Number(process.env.PORT) || 4020,
  publicUrl: process.env.PAYAI_PUBLIC_URL ?? `http://localhost:${Number(process.env.PORT) || 4020}`,

  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  /** Fake Anthropic for demo/testing. Off only when PAYAI_MOCK_ANTHROPIC=false */
  mockAnthropic: process.env.PAYAI_MOCK_ANTHROPIC !== "false",
  openaiApiKey: process.env.OPENAI_API_KEY ?? "",
  openaiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",

  /** Starting demo credit for new wallets (USD). ~10 requests at $0.005 each. */
  initialBalanceUsd: Number(process.env.PAYAI_INITIAL_BALANCE_USD ?? "0.05"),
  /**
   * Faucet cap: how many wallets may claim the free starting balance on this
   * instance. Past the cap new wallets open at $0 and must pay via x402.
   * Without this a public URL is an unlimited free-credit dispenser.
   */
  maxFreeWallets: Number(process.env.PAYAI_MAX_FREE_WALLETS ?? "500"),
  /** Fixed top-up package when wallet is empty (USD charged via x402). */
  topUpPriceUsd: Number(process.env.PAYAI_TOPUP_USD ?? "0.10"),
  /** Credit granted per successful top-up (USD). */
  topUpCreditUsd: Number(process.env.PAYAI_TOPUP_CREDIT_USD ?? "0.10"),

  facilitatorUrl: process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator",
  evmPayTo: process.env.PAYAI_EVM_PAY_TO ?? "",
  svmPayTo: process.env.PAYAI_SVM_PAY_TO ?? "",

  /**
   * Onchain verification (QuickNode).
   *
   * QuickNode is not an x402 facilitator — it neither verifies nor settles for
   * third-party resource servers. It is the node provider PayAI reads through
   * to check the facilitator's work, and separately a paid service PayAI can
   * itself buy over x402.
   */
  /** Authenticated QuickNode HTTPS endpoint for the settlement chain. */
  quicknodeRpcUrl: process.env.PAYAI_QUICKNODE_RPC_URL ?? "",
  /** Pay QuickNode per RPC call over x402 instead of holding an API key. */
  quicknodeX402: process.env.PAYAI_QUICKNODE_X402 === "true",
  quicknodeX402BaseUrl: process.env.PAYAI_QUICKNODE_X402_URL ?? "https://x402.quicknode.com",
  /** Private key PayAI spends from when buying RPC. Separate from its revenue address. */
  quicknodeX402Key: process.env.PAYAI_QUICKNODE_X402_KEY ?? "",
  /** Chain PayAI pays QuickNode on — independent of the chain it reads. */
  quicknodeX402PayNetwork: process.env.PAYAI_QUICKNODE_X402_NETWORK ?? "eip155:84532",
  /** Verify settlements against the chain. Off only for offline development. */
  verifySettlements: process.env.PAYAI_VERIFY_SETTLEMENTS !== "false",

  /** Allow POST /api/wallet/:id/simulate-fund when x402 pay-to addresses are unset. */
  demoMode:
    process.env.PAYAI_DEMO_MODE === "true" ||
    (!process.env.PAYAI_EVM_PAY_TO && !process.env.PAYAI_SVM_PAY_TO),

  /** Optional bearer token guarding the cross-wallet admin listing. */
  adminToken: process.env.PAYAI_ADMIN_TOKEN ?? "",

  walletHeader: "x-payai-wallet",
};

export function usdToMicro(usd) {
  return Math.round(usd * MICRO_USD);
}

export function microToUsd(micro) {
  return micro / MICRO_USD;
}

export function formatUsd(micro) {
  return `$${microToUsd(micro).toFixed(6)}`;
}
