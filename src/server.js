import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { initX402, resumePendingVerifications, x402Status } from "./x402/service.js";
import { ledger } from "./store/ledger.js";
import { store } from "./store/db.js";
import { policyConfig } from "./middleware/policy.js";
import { authMode } from "./middleware/wallet-auth.js";
import { walletRouter } from "./routes/wallet.js";
import { messagesRouter } from "./routes/messages.js";
import { chatRouter } from "./routes/chat.js";
import { discoveryRouter } from "./routes/discovery.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.disable("x-powered-by");
app.use(cors({ exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"] }));
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "../public")));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "payai",
    version: "1.0.0",
    mockAnthropic: config.mockAnthropic,
    x402: x402Status(),
    ledger: ledger.stats(),
    walletAuth: authMode(),
    policy: policyConfig(),
    routes: [
      "POST /v1/messages",
      "POST /v1/chat/completions",
      "GET  /api/wallet/:id",
      "GET  /api/wallet/:id/receipts",
      "POST /api/wallet/:id/challenge",
      "POST /api/wallet/:id/fund",
      "GET  /api/wallet/:id/events",
      "GET  /.well-known/x402",
    ],
  });
});

app.use(discoveryRouter);
app.use("/api/wallet", walletRouter);
app.use(messagesRouter);
app.use(chatRouter);

// Malformed JSON bodies and any error escaping a route land here rather than
// hanging the request or killing the process.
app.use((err, _req, res, _next) => {
  const status = err.status ?? err.statusCode ?? 500;
  if (res.headersSent) {
    res.end();
    return;
  }
  console.error("[payai] unhandled request error:", err.message);
  res.status(status).json({
    error: { type: status === 400 ? "bad_request" : "internal_error", message: err.message },
  });
});

// A facilitator outage must not prevent the proxy from serving traffic.
await initX402();

// Receipts left mid-verification by a restart must not stay 'pending' forever.
resumePendingVerifications();

const server = app.listen(config.port, () => {
  const x402 = x402Status();
  const x402Line = x402.configured
    ? x402.ready
      ? "x402 live"
      : "x402 DEGRADED (facilitator down)"
    : "x402 off (demo mode)";
  console.log(`
╔══════════════════════════════════════════════════════╗
║  PayAI — crypto-native LLM proxy (x402)             ║
╠══════════════════════════════════════════════════════╣
║  Dashboard   ${config.publicUrl.padEnd(36)}║
║  Anthropic   POST /v1/messages ${config.mockAnthropic ? "(MOCK)" : "          "}     ║
║  OpenAI      POST /v1/chat/completions                ║
║  Wallet API  GET  /api/wallet/:id                     ║
║  Live feed   GET  /api/wallet/:id/events (SSE)        ║
║  Settlement  ${x402Line.padEnd(36)}║
╚══════════════════════════════════════════════════════╝
`);
});

// Long-lived SSE connections must not be cut by the default 5s keep-alive race.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

// Failing to bind is fatal and must exit non-zero, or a broken deploy reports
// success to the platform's health check.
server.on("error", (err) => {
  console.error(`[payai] server error: ${err.message}`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[payai] unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[payai] uncaught exception:", err);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    console.log(`\n[payai] ${signal} — shutting down`);
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => {
      store.close();
      process.exit(0);
    }, 5_000).unref();
  });
}
