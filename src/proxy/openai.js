import { config } from "../config.js";
import { pipeUpstreamStream, readUpstreamJson } from "./engine.js";
import { parseOpenAIUsage } from "./usage-parser.js";
import { computeUsageCostMicro } from "../billing/pricing.js";
import { finalizeBilling, releaseBilling } from "../middleware/billing-gate.js";

function openaiHeaders(req, apiKey) {
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  if (req.headers["openai-organization"]) {
    headers["OpenAI-Organization"] = req.headers["openai-organization"];
  }
  return headers;
}

export async function handleOpenAIChatCompletions(req, res) {
  if (!config.openaiApiKey) {
    releaseBilling(req, "provider_not_configured");
    res.status(500).json({
      error: { type: "configuration_error", message: "OPENAI_API_KEY is not set" },
    });
    return;
  }

  const body = { ...req.body };
  if (body.stream && !body.stream_options) {
    body.stream_options = { include_usage: true };
  }

  let upstream;
  try {
    upstream = await fetch(`${config.openaiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: openaiHeaders(req, config.openaiApiKey),
      body: JSON.stringify(body),
    });
  } catch (err) {
    releaseBilling(req, "upstream_unreachable");
    res.status(502).json({
      error: { type: "upstream_error", message: "Failed to reach OpenAI API", detail: err.message },
    });
    return;
  }

  const isStream = Boolean(body.stream);

  const onUsage = (text) => {
    const parsed = parseOpenAIUsage(text);
    if (!req.payaiBilling) return;
    if (!parsed) {
      finalizeBilling(req, {
        model: body.model,
        inputTokens: 0,
        outputTokens: 0,
        actualMicroUsd: req.payaiBilling.reservedMicroUsd,
      });
      return;
    }
    finalizeBilling(req, {
      model: parsed.model ?? body.model,
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens,
      actualMicroUsd: computeUsageCostMicro({
        model: parsed.model ?? body.model,
        inputTokens: parsed.inputTokens,
        outputTokens: parsed.outputTokens,
      }),
    });
  };

  if (!isStream) {
    try {
      const { text } = await readUpstreamJson(upstream);
      res.status(upstream.status);
      res.send(text);
      if (upstream.ok) onUsage(text);
      else if (req.payaiBilling) {
        finalizeBilling(req, { model: body.model, inputTokens: 0, outputTokens: 0, actualMicroUsd: 0 });
      }
    } catch (err) {
      res.status(502).json({ error: { type: "upstream_error", message: err.message } });
    }
    return;
  }

  try {
    await pipeUpstreamStream(upstream, res, {
      onBodyComplete: (text) => {
        if (upstream.ok) onUsage(text);
      },
    });
    if (!upstream.ok && req.payaiBilling) {
      finalizeBilling(req, { model: body.model, inputTokens: 0, outputTokens: 0, actualMicroUsd: 0 });
    }
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).json({ error: { type: "stream_error", message: err.message } });
    }
    if (req.payaiBilling) {
      finalizeBilling(req, { model: body.model, inputTokens: 0, outputTokens: 0, actualMicroUsd: 0 });
    }
  }
}
