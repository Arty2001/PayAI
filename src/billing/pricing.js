import { config } from "../config.js";

/**
 * Micro-USD cost per token (6 decimal USD, same precision as USDC).
 * Rates derived from public list prices, scaled per token.
 */
const MODEL_RATES = {
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25 },
  "claude-3-5-haiku-20241022": { input: 0.25, output: 1.25 },
  "claude-3-5-sonnet-20241022": { input: 3, output: 15 },
  "claude-3-opus-20240229": { input: 15, output: 75 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
  default: { input: 1, output: 5 },
};

/** Minimum billable request (micro-USD).
 * Demo rate: ~$0.005 per call so balance visibly drains on stage. */
const MIN_REQUEST_MICRO_USD = Number(process.env.PAYAI_MIN_REQUEST_MICRO_USD ?? 5000);

/** Convert $/million-tokens to micro-USD per token. */
function perTokenMicro(ratePerMillion) {
  return ratePerMillion / 1_000_000;
}

export function getModelRates(model = "default") {
  const rates = MODEL_RATES[model] ?? MODEL_RATES.default;
  return {
    inputMicro: perTokenMicro(rates.input),
    outputMicro: perTokenMicro(rates.output),
  };
}

export function estimatePromptTokens(body, provider) {
  if (provider === "anthropic") {
    const text = JSON.stringify(body.messages ?? []);
    return Math.max(1, Math.ceil(text.length / 4));
  }
  const text = JSON.stringify(body.messages ?? body.prompt ?? "");
  return Math.max(1, Math.ceil(text.length / 4));
}

export function estimateRequestCostMicro(body, provider) {
  const model = body.model ?? (provider === "openai" ? "gpt-4o-mini" : "claude-3-5-haiku-20241022");
  const maxTokens = Number(body.max_tokens ?? body.max_completion_tokens ?? 256);
  const { inputMicro, outputMicro } = getModelRates(model);
  const promptTokens = estimatePromptTokens(body, provider);
  const estimate = Math.ceil(promptTokens * inputMicro + maxTokens * outputMicro);
  return Math.max(MIN_REQUEST_MICRO_USD, estimate);
}

export function computeUsageCostMicro({ model, inputTokens = 0, outputTokens = 0 }) {
  const { inputMicro, outputMicro } = getModelRates(model);
  const cost = Math.ceil(inputTokens * inputMicro + outputTokens * outputMicro);
  return Math.max(MIN_REQUEST_MICRO_USD, cost);
}

export function topUpCreditMicro() {
  return Math.round(config.topUpCreditUsd * 1_000_000);
}

export function topUpPriceLabel() {
  return `$${config.topUpPriceUsd.toFixed(2)}`;
}
