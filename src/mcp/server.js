#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MCP_PAYMENT_REQUIRED_CODE } from "@x402/mcp";
import { z } from "zod";

/**
 * PayAI as an MCP server.
 *
 * This is the piece that makes PayAI agent-native rather than something a human
 * configures: an agent adds this server, calls a tool, and if the wallet is out
 * of credit the tool fails with a machine-readable x402 payment requirement the
 * agent can settle on its own and retry.
 *
 * It deliberately talks to the PayAI HTTP API rather than reaching into the
 * ledger directly, so metering, policy, and settlement all stay in one place.
 */

const PROXY_URL = process.env.PAYAI_PROXY_URL ?? "http://localhost:4020";
const WALLET = process.env.PAYAI_WALLET ?? "mcp-agent";
const DEFAULT_MODEL = process.env.PAYAI_MCP_MODEL ?? "claude-haiku-4-5";

function walletHeaders() {
  const headers = { "content-type": "application/json", "x-payai-wallet": WALLET };
  if (process.env.PAYAI_SIGNATURE && process.env.PAYAI_NONCE) {
    headers["x-payai-signature"] = process.env.PAYAI_SIGNATURE;
    headers["x-payai-nonce"] = process.env.PAYAI_NONCE;
  }
  return headers;
}

async function callProxy(path, init = {}) {
  const res = await fetch(`${PROXY_URL}${path}`, { ...init, headers: walletHeaders() });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // non-JSON upstream error — keep the raw text
  }
  return { res, text, json };
}

const server = new McpServer(
  { name: "payai", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "PayAI provides LLM inference paid per token in stablecoins over x402. " +
      "If a tool reports payment_required, settle the returned x402 requirement and retry.",
  },
);

server.registerTool(
  "payai_chat",
  {
    title: "Chat via PayAI (paid)",
    description:
      "Run an LLM completion through PayAI. Charged per token against the wallet's prepaid balance. " +
      "Returns an x402 payment requirement if the balance is insufficient.",
    inputSchema: {
      prompt: z.string().describe("The user message to send to the model"),
      model: z.string().optional().describe(`Model id (default ${DEFAULT_MODEL})`),
      max_tokens: z.number().int().positive().optional().describe("Max output tokens (default 512)"),
      system: z.string().optional().describe("Optional system prompt"),
    },
  },
  async ({ prompt, model, max_tokens, system }) => {
    const body = {
      model: model ?? DEFAULT_MODEL,
      max_tokens: max_tokens ?? 512,
      messages: [{ role: "user", content: prompt }],
    };
    if (system) body.system = system;

    const { res, text, json } = await callProxy("/v1/messages", {
      method: "POST",
      body: JSON.stringify(body),
    });

    // Out of credit. The agent needs the payment terms themselves, not just a
    // failure — so they go in the result body and in _meta. (Throwing an
    // McpError here would work too, but McpServer converts thrown errors into
    // isError results and discards the structured `data`, leaving the agent
    // with a message and no way to pay.)
    if (res.status === 402) {
      const requirement = json?.x402 ?? {
        x402Version: 2,
        error: json?.message ?? "Payment required",
        accepts: [],
      };
      const detail = {
        status: "payment_required",
        code: MCP_PAYMENT_REQUIRED_CODE,
        message: json?.message ?? "PayAI wallet has insufficient balance",
        walletId: json?.walletId ?? WALLET,
        balanceUsd: json?.balanceUsd,
        shortfallUsd: json?.shortfallUsd,
        topUpEndpoint: `${PROXY_URL}/api/wallet/${encodeURIComponent(WALLET)}/fund`,
        x402: requirement,
      };

      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `Payment required — the PayAI wallet is out of credit.\n\n` +
              `${JSON.stringify(detail, null, 2)}\n\n` +
              `Settle the x402 requirement above against topUpEndpoint, then retry.`,
          },
        ],
        structuredContent: detail,
        _meta: { "x402/payment-required": requirement },
      };
    }

    if (!res.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: `PayAI error ${res.status}: ${json ? JSON.stringify(json) : text}` }],
      };
    }

    const reply = json?.content?.find((b) => b.type === "text")?.text ?? "(no text content)";
    const usage = json?.usage
      ? `\n\n---\ntokens: ${json.usage.input_tokens} in / ${json.usage.output_tokens} out`
      : "";

    return { content: [{ type: "text", text: reply + usage }] };
  },
);

server.registerTool(
  "payai_wallet",
  {
    title: "PayAI wallet status",
    description: "Current balance, held funds, and lifetime spend for this agent's PayAI wallet.",
    inputSchema: {},
  },
  async () => {
    const { json, text } = await callProxy(`/api/wallet/${encodeURIComponent(WALLET)}`);
    if (!json) return { isError: true, content: [{ type: "text", text }] };
    return {
      content: [
        {
          type: "text",
          text: [
            `wallet:    ${json.id}`,
            `exists:    ${json.exists}`,
            `balance:   $${Number(json.balanceUsd).toFixed(6)}`,
            `held:      $${Number(json.heldUsd ?? 0).toFixed(6)}`,
            `spent:     $${((json.totalSpentMicroUsd ?? 0) / 1e6).toFixed(6)}`,
            `requests:  ${json.requestCount ?? 0}`,
            `owner:     ${json.ownerAddress ?? "(unclaimed)"}`,
            `x402:      ${json.x402Enabled ? "live" : "unavailable"}`,
          ].join("\n"),
        },
      ],
    };
  },
);

server.registerTool(
  "payai_receipts",
  {
    title: "PayAI spend receipts",
    description:
      "Verifiable spend history: each charge and the onchain settlement that funded it.",
    inputSchema: {
      limit: z.number().int().positive().max(200).optional().describe("Max entries (default 20)"),
    },
  },
  async ({ limit }) => {
    const { json, text } = await callProxy(
      `/api/wallet/${encodeURIComponent(WALLET)}/receipts?limit=${limit ?? 20}`,
    );
    if (!json) return { isError: true, content: [{ type: "text", text }] };
    return { content: [{ type: "text", text: JSON.stringify(json, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr only — stdout is the MCP transport.
console.error(`[payai-mcp] connected · proxy ${PROXY_URL} · wallet ${WALLET}`);
