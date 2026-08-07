import { config } from "../config.js";

/**
 * USD per million tokens, at provider list prices.
 *
 * This table is the meter. A model missing from it bills at `default`, so a
 * stale table silently under-charges: every entry here was a retired model id
 * whose rates predated the current lineup, and the old $1/$5 default happened
 * to match the cheapest model on the menu — meaning every real request lost
 * money.
 *
 * Keep this in sync with the published price list when models ship.
 */
const MODEL_RATES = {
  // Anthropic
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  // Sonnet 5 has promotional pricing ($2/$10) through 2026-08-31; list rates
  // are used so the meter doesn't need a dated cutover.
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },

  // OpenAI
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },

  /**
   * Unknown models bill at the most expensive tier on the menu. An unpriced
   * model is a revenue leak in one direction only — over-reservation is
   * refunded by reconcile(), under-charging is unrecoverable.
   */
  default: { input: 10, output: 50 },
};

/** Minimum billable request (micro-USD).
 * Demo rate: ~$0.005 per call so balance visibly drains on stage. */
const MIN_REQUEST_MICRO_USD = Number(process.env.PAYAI_MIN_REQUEST_MICRO_USD ?? 5000);

/**
 * USD per million tokens → micro-USD per token.
 *
 * These are the same number, and the conversion is the identity. USDC has 6
 * decimals, so 1 USD = 1e6 micro-USD; a rate of $R per 1e6 tokens is R/1e6 USD
 * per token, which is exactly R micro-USD per token. The 1e6 in the price
 * denominator and the 1e6 in the currency unit cancel.
 *
 * Dividing by 1e6 here made the meter read one-millionth of actual cost, which
 * MIN_REQUEST_MICRO_USD then floored — so every request billed $0.005 no matter
 * how many tokens it burned, and usage-based pricing never actually ran.
 */
function perTokenMicro(ratePerMillion) {
  return ratePerMillion;
}

/**
 * Callers request an alias (`claude-haiku-4-5`), but providers echo back the
 * dated snapshot it resolved to (`claude-haiku-4-5-20251001`). Reservation
 * reads the request, reconciliation reads the response — so without this the
 * two price against different rows, and a model priced correctly on the way in
 * lands on `default` on the way out.
 */
function resolveRates(model) {
  if (MODEL_RATES[model]) return MODEL_RATES[model];

  const alias = String(model ?? "").replace(/-\d{8}$/, "");
  if (alias !== model && MODEL_RATES[alias]) return MODEL_RATES[alias];

  return MODEL_RATES.default;
}

export function getModelRates(model = "default") {
  const rates = resolveRates(model);
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
  const model = body.model ?? (provider === "openai" ? "gpt-4o-mini" : "claude-sonnet-5");
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
