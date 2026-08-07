import { config } from "../config.js";
import { pipeUpstreamStream, readUpstreamJson } from "./engine.js";
import { parseAnthropicUsage } from "./usage-parser.js";
import { computeUsageCostMicro } from "../billing/pricing.js";
import { finalizeBilling, releaseBilling } from "../middleware/billing-gate.js";
import { handleMockAnthropicMessages, buildReplyText, buildUsage } from "./mock-anthropic.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_VERSION = "2023-06-01";

function anthropicHeaders(req, apiKey) {
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": req.headers["anthropic-version"] ?? DEFAULT_VERSION,
    "content-type": "application/json",
  };
  if (req.headers["anthropic-beta"]) {
    headers["anthropic-beta"] = req.headers["anthropic-beta"];
  }
  return headers;
}

function finalizeFromBody(req, text, ok = true) {
  if (!req.payaiBilling) return;

  // Upstream refused the request — the caller owes nothing.
  if (!ok) {
    releaseBilling(req, "upstream_error");
    return;
  }

  const parsed = parseAnthropicUsage(text);
  if (!parsed) {
    // Response succeeded but carried no usage block: charge the reservation
    // rather than serve tokens for free.
    finalizeBilling(req, {
      model: req.body?.model,
      inputTokens: 0,
      outputTokens: 0,
      actualMicroUsd: req.payaiBilling.reservedMicroUsd,
    });
    return;
  }
  finalizeBilling(req, {
    model: parsed.model ?? req.body?.model,
    inputTokens: parsed.inputTokens,
    outputTokens: parsed.outputTokens,
    actualMicroUsd: computeUsageCostMicro({
      model: parsed.model ?? req.body?.model,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
    }),
  });
}

/** Run fake Anthropic provider and meter usage for billing. */
async function handleMockWithBilling(req, res) {
  const body = req.body ?? {};
  const replyText = buildReplyText(body);
  const usage = buildUsage(body, replyText);

  await handleMockAnthropicMessages(req, res);

  if (req.payaiBilling) {
    finalizeBilling(req, {
      model: body.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      actualMicroUsd: computeUsageCostMicro({
        model: body.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      }),
    });
  }
}

export async function handleAnthropicMessages(req, res) {
  if (config.mockAnthropic) {
    await handleMockWithBilling(req, res);
    return;
  }

  if (!config.anthropicApiKey) {
    releaseBilling(req, "provider_not_configured");
    res.status(500).json({
      error: {
        type: "configuration_error",
        message: "ANTHROPIC_API_KEY is not set. Set PAYAI_MOCK_ANTHROPIC=true to use the fake provider.",
      },
    });
    return;
  }

  let upstream;
  try {
    upstream = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: anthropicHeaders(req, config.anthropicApiKey),
      body: JSON.stringify(req.body),
    });
  } catch (err) {
    releaseBilling(req, "upstream_unreachable");
    res.status(502).json({
      error: { type: "upstream_error", message: "Failed to reach Anthropic API", detail: err.message },
    });
    return;
  }

  const isStream = Boolean(req.body?.stream);
  const onUsage = (text) => finalizeFromBody(req, text, true);

  if (!isStream) {
    try {
      const { text } = await readUpstreamJson(upstream);
      res.status(upstream.status);
      res.send(text);
      finalizeFromBody(req, text, upstream.ok);
    } catch (err) {
      releaseBilling(req, "upstream_read_failed");
      if (!res.headersSent) {
        res.status(502).json({ error: { type: "upstream_error", message: err.message } });
      } else {
        res.end();
      }
    }
    return;
  }

  try {
    await pipeUpstreamStream(upstream, res, {
      onBodyComplete: (text) => {
        if (upstream.ok) onUsage(text);
      },
    });
    if (!upstream.ok) releaseBilling(req, "upstream_error");
  } catch (err) {
    releaseBilling(req, "stream_failed");
    if (!res.headersSent) {
      res.status(502).json({ error: { type: "stream_error", message: err.message } });
    } else {
      res.end();
    }
  }
}
