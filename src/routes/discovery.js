import { Router } from "express";
import { config } from "../config.js";
import { paymentOptions, isX402Ready } from "../x402/service.js";
import { getModelRates } from "../billing/pricing.js";

export const discoveryRouter = Router();

/**
 * Machine-readable service description for agent discovery.
 *
 * The x402 Bazaar and similar indexes let an agent search for a capability and
 * get back an endpoint it can pay for without a human ever registering an
 * account. Being findable is what turns this from a proxy you configure into a
 * service an agent can adopt on its own.
 */
function manifest() {
  const accepts = paymentOptions();

  return {
    x402Version: 2,
    name: "PayAI",
    description:
      "OpenAI- and Anthropic-compatible LLM inference, metered per token and paid in stablecoins over x402. No account, no API key.",
    category: "ai-inference",
    tags: ["llm", "inference", "openai-compatible", "anthropic-compatible", "proxy"],
    provider: { url: config.publicUrl },
    resources: [
      {
        resource: `${config.publicUrl}/v1/messages`,
        type: "http",
        method: "POST",
        description: "Anthropic Messages API. Drop-in for api.anthropic.com/v1/messages.",
        mimeType: "application/json",
        accepts,
      },
      {
        resource: `${config.publicUrl}/v1/chat/completions`,
        type: "http",
        method: "POST",
        description: "OpenAI Chat Completions API. Drop-in for api.openai.com/v1/chat/completions.",
        mimeType: "application/json",
        accepts,
      },
    ],
    pricing: {
      model: "per-token",
      currency: "USD",
      note: "Charged at provider list rates against a prepaid balance; unused reservation is refunded after each request.",
      topUp: {
        priceUsd: config.topUpPriceUsd,
        creditUsd: config.topUpCreditUsd,
        endpoint: `${config.publicUrl}/api/wallet/{walletId}/fund`,
      },
      rates: Object.fromEntries(
        ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "gpt-4o-mini", "gpt-4o"].map(
          (model) => {
            // micro-USD per token is numerically the same as USD per million
            // tokens (USDC's 6 decimals cancel the price denominator), so this
            // is a relabel, not a conversion.
            const { inputMicro, outputMicro } = getModelRates(model);
            return [
              model,
              {
                inputUsdPerMillionTokens: inputMicro,
                outputUsdPerMillionTokens: outputMicro,
              },
            ];
          },
        ),
      ),
    },
    settlement: {
      enabled: isX402Ready(),
      facilitator: config.facilitatorUrl,
      networks: accepts.map((option) => option.network),
    },
    documentation: `${config.publicUrl}/`,
  };
}

discoveryRouter.get("/.well-known/x402", (_req, res) => {
  res.json(manifest());
});

/** Conventional alias used by several discovery crawlers. */
discoveryRouter.get("/x402/discovery", (_req, res) => {
  res.json(manifest());
});
