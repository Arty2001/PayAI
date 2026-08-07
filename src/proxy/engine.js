import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const PASSTHROUGH_HEADERS = [
  "content-type",
  "cache-control",
  "request-id",
  "openai-processing-ms",
  "x-request-id",
  "anthropic-ratelimit-requests-limit",
  "anthropic-ratelimit-requests-remaining",
  "anthropic-ratelimit-requests-reset",
  "anthropic-ratelimit-tokens-limit",
  "anthropic-ratelimit-tokens-remaining",
  "anthropic-ratelimit-tokens-reset",
];

export function forwardResponseHeaders(upstream, res) {
  for (const name of PASSTHROUGH_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
}

/**
 * Stream upstream body to client while capturing text for usage parsing.
 * @param {import('node:stream').Response} upstream
 * @param {import('express').Response} res
 * @param {{ onBodyComplete: (text: string) => void }} hooks
 */
export async function pipeUpstreamStream(upstream, res, { onBodyComplete }) {
  let captured = "";

  const tap = new Transform({
    transform(chunk, _enc, cb) {
      captured += chunk.toString("utf8");
      cb(null, chunk);
    },
  });

  res.status(upstream.status);
  forwardResponseHeaders(upstream, res);

  if (!upstream.body) {
    const text = await upstream.text();
    onBodyComplete(text);
    res.send(text);
    return;
  }

  try {
    await pipeline(Readable.fromWeb(upstream.body), tap, res);
    onBodyComplete(captured);
  } catch (err) {
    if (!res.headersSent) {
      throw err;
    }
    onBodyComplete(captured);
    res.end();
  }
}

/**
 * Read an upstream body as text, parsing JSON opportunistically.
 * Providers return HTML/plain-text on gateway errors — parsing must not throw
 * and swallow the body the caller needs to see.
 */
export async function readUpstreamJson(upstream) {
  const text = await upstream.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
}
