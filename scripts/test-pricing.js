/**
 * The meter.
 *
 * Guards the unit conversion between published prices (USD per million tokens)
 * and the ledger's unit (micro-USD). These are numerically identical — USDC's
 * 6 decimals cancel the price denominator — and a stray 1e6 in either direction
 * is invisible in the demo, because MIN_REQUEST_MICRO_USD floors every small
 * request to the same $0.005 either way.
 *
 *   node scripts/test-pricing.js
 */

import { getModelRates, computeUsageCostMicro, estimateRequestCostMicro } from "../src/billing/pricing.js";

const MTOK = 1_000_000;

let passed = 0;
let failed = 0;

function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed += 1;
  } else {
    console.log(`  FAIL  ${name} ${detail}`);
    failed += 1;
  }
}

/** Cost in whole dollars for a given token count. */
const usd = (model, inputTokens, outputTokens) =>
  computeUsageCostMicro({ model, inputTokens, outputTokens }) / 1_000_000;

console.log("pricing meter\n");

// A million input tokens must cost exactly the published input rate. This is
// the assertion that fails if the 1e6 conversion is reintroduced.
const CASES = [
  { model: "claude-opus-5", input: 5, output: 25 },
  { model: "claude-sonnet-5", input: 3, output: 15 },
  { model: "claude-haiku-4-5", input: 1, output: 5 },
  { model: "claude-fable-5", input: 10, output: 50 },
];

for (const { model, input, output } of CASES) {
  check(`${model}: 1M input tokens costs $${input}`, usd(model, MTOK, 0) === input, `got $${usd(model, MTOK, 0)}`);
  check(`${model}: 1M output tokens costs $${output}`, usd(model, 0, MTOK) === output, `got $${usd(model, 0, MTOK)}`);
  check(
    `${model}: 1M in + 1M out costs $${input + output}`,
    usd(model, MTOK, MTOK) === input + output,
    `got $${usd(model, MTOK, MTOK)}`,
  );
}

console.log("");

// Output tokens cost more than input on every model — if the two rates were
// swapped or collapsed, this catches it.
for (const { model } of CASES) {
  const rates = getModelRates(model);
  check(`${model}: output rate exceeds input rate`, rates.outputMicro > rates.inputMicro);
}

console.log("");

// An unknown model must not bill at less than the cheapest known model, or an
// unpriced model becomes a way to buy inference below cost.
const cheapest = Math.min(...CASES.map((c) => c.output));
check(
  "unknown model bills at or above the cheapest known rate",
  getModelRates("some-model-that-does-not-exist").outputMicro >= cheapest,
  `got ${getModelRates("some-model-that-does-not-exist").outputMicro}`,
);

// Real usage must exceed the demo floor — otherwise metering is inert and every
// request costs the same regardless of size.
const floor = usd("claude-haiku-4-5", 1, 1);
check("a large request costs more than a small one", usd("claude-opus-5", MTOK, MTOK) > floor);
check(
  "a 200k-token Opus request is billed in dollars, not fractions of a cent",
  usd("claude-opus-5", 200_000, 50_000) > 1,
  `got $${usd("claude-opus-5", 200_000, 50_000)}`,
);

console.log("");

// The reservation must cover the worst case it is reserving for: max_tokens of
// output at the model's output rate. Under-reserving is written off, not billed.
const body = { model: "claude-opus-5", max_tokens: 100_000, messages: [{ role: "user", content: "hi" }] };
const reserved = estimateRequestCostMicro(body, "anthropic") / 1_000_000;
const worstCase = usd("claude-opus-5", 1, 100_000);
check(
  "reservation covers max_tokens of output",
  reserved >= worstCase * 0.99,
  `reserved $${reserved.toFixed(4)} vs worst case $${worstCase.toFixed(4)}`,
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
