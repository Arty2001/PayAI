/**
 * Stage wrapper. Runs the demo against the deployed site with no environment
 * setup, because typing `$env:PAYAI_PROXY_URL=...` in front of judges is a
 * great way to make a typo in front of judges.
 *
 *   npm run demo        one metered call
 *   npm run demo:pay    top up with real USDC over x402
 *
 * Override either default the usual way:
 *   $env:PAYAI_WALLET="alice"; npm run demo
 *   $env:PAYAI_PROXY_URL="http://localhost:4020"; npm run demo
 */

const LIVE_URL = "https://payai.lanvar.ai";
const STAGE_WALLET = "stage";

// Only fill in what the operator hasn't chosen, so an explicit env var still
// wins — local development against localhost keeps working.
process.env.PAYAI_PROXY_URL ||= LIVE_URL;
process.env.PAYAI_WALLET ||= STAGE_WALLET;

const action = process.argv[2] ?? "call";
const target = action === "pay" ? "./pay-x402.js" : "./test-messages.js";

console.log(`→ ${process.env.PAYAI_PROXY_URL}  ·  wallet "${process.env.PAYAI_WALLET}"\n`);

await import(target);
