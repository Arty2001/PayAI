/**
 * Extract token usage from provider responses (JSON or SSE text accumulated).
 */

export function parseAnthropicUsage(text) {
  if (!text) return null;

  try {
    const json = JSON.parse(text);
    if (json.usage) {
      return {
        inputTokens: json.usage.input_tokens ?? 0,
        outputTokens: json.usage.output_tokens ?? 0,
        model: json.model,
      };
    }
  } catch {
    // streaming SSE
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let model;

  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const event = JSON.parse(payload);
      if (event.message?.usage) {
        inputTokens = event.message.usage.input_tokens ?? inputTokens;
        outputTokens = event.message.usage.output_tokens ?? outputTokens;
      }
      if (event.usage) {
        inputTokens = event.usage.input_tokens ?? inputTokens;
        outputTokens = event.usage.output_tokens ?? outputTokens;
      }
      if (event.message?.model) model = event.message.model;
      if (event.model) model = event.model;
    } catch {
      // ignore partial lines
    }
  }

  if (inputTokens || outputTokens) {
    return { inputTokens, outputTokens, model };
  }
  return null;
}

export function parseOpenAIUsage(text) {
  if (!text) return null;

  try {
    const json = JSON.parse(text);
    if (json.usage) {
      return {
        inputTokens: json.usage.prompt_tokens ?? 0,
        outputTokens: json.usage.completion_tokens ?? 0,
        model: json.model,
      };
    }
  } catch {
    // SSE
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let model;

  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const event = JSON.parse(payload);
      if (event.usage) {
        inputTokens = event.usage.prompt_tokens ?? inputTokens;
        outputTokens = event.usage.completion_tokens ?? outputTokens;
      }
      if (event.model) model = event.model;
    } catch {
      // ignore
    }
  }

  if (inputTokens || outputTokens) {
    return { inputTokens, outputTokens, model };
  }
  return null;
}
