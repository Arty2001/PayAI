import { randomUUID } from "node:crypto";

const DEFAULT_MODEL = "claude-3-haiku-20240307";

function lastUserText(body) {
  const messages = body.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      const text = msg.content.find((b) => b.type === "text")?.text;
      if (text) return text;
    }
  }
  return "Hello";
}

function buildReplyText(body) {
  const userText = lastUserText(body).trim();
  if (/payai proxy is working/i.test(userText)) {
    return "PayAI proxy is working.";
  }
  if (/^say exactly:/i.test(userText)) {
    return userText.replace(/^say exactly:\s*/i, "").replace(/\.$/, "") + ".";
  }
  return (
    `[PayAI mock] Claude would answer: "${userText.slice(0, 120)}${userText.length > 120 ? "…" : ""}" — ` +
    `paid via x402, streamed through the proxy. No Anthropic key required.`
  );
}

function estimateTokens(text) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function buildUsage(body, replyText) {
  const promptText = JSON.stringify(body.messages ?? []);
  const inputTokens = estimateTokens(promptText);
  const outputTokens = estimateTokens(replyText);
  return { inputTokens, outputTokens };
}

function sseLine(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamAnthropicEvents(body, replyText, model) {
  const messageId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const usage = buildUsage(body, replyText);
  const words = replyText.split(/(\s+)/);

  const events = [
    sseLine("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: usage.inputTokens, output_tokens: 0 },
      },
    }),
    sseLine("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
  ];

  for (const word of words) {
    if (!word) continue;
    events.push(
      sseLine("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: word },
      }),
    );
  }

  events.push(
    sseLine("content_block_stop", { type: "content_block_stop", index: 0 }),
    sseLine("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: usage.outputTokens },
    }),
    sseLine("message_stop", { type: "message_stop" }),
  );

  return { events: events.join(""), usage, messageId, model };
}

function jsonResponse(body, replyText, model) {
  const usage = buildUsage(body, replyText);
  const messageId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  return {
    id: messageId,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: replyText }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
    },
  };
}

/**
 * Handle mock Anthropic /v1/messages — same shape as real API, no network call.
 */
export async function handleMockAnthropicMessages(req, res) {
  const body = req.body ?? {};
  const model = body.model ?? DEFAULT_MODEL;
  const replyText = buildReplyText(body);
  const isStream = Boolean(body.stream);

  res.setHeader("request-id", `req_mock_${randomUUID().slice(0, 8)}`);

  if (!isStream) {
    res.status(200).json(jsonResponse(body, replyText, model));
    return;
  }

  const { events } = streamAnthropicEvents(body, replyText, model);
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.write(events);
  res.end();
}

export { buildReplyText, buildUsage };
