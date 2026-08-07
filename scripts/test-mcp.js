/**
 * Drive the PayAI MCP server the way an agent would: connect over stdio, list
 * tools, call the paid one, and confirm it reports payment required when the
 * wallet runs dry.
 *
 * Requires the HTTP proxy to be running:
 *   npm start
 *   node scripts/test-mcp.js
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PROXY_URL = process.env.PAYAI_PROXY_URL ?? "http://localhost:4020";
const WALLET = process.env.PAYAI_WALLET ?? `mcp-${Date.now().toString(36)}`;

async function main() {
  console.log(`Proxy:  ${PROXY_URL}`);
  console.log(`Wallet: ${WALLET}\n`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/mcp/server.js"],
    env: { ...process.env, PAYAI_PROXY_URL: PROXY_URL, PAYAI_WALLET: WALLET },
  });

  const client = new Client({ name: "payai-test-agent", version: "1.0.0" });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`tools: ${tools.map((t) => t.name).join(", ")}\n`);

  console.log("--- payai_chat ---");
  const chat = await client.callTool({
    name: "payai_chat",
    arguments: { prompt: "Reply with exactly: PayAI proxy is working.", max_tokens: 64 },
  });
  console.log(chat.content?.[0]?.text ?? JSON.stringify(chat));

  console.log("\n--- payai_wallet ---");
  const wallet = await client.callTool({ name: "payai_wallet", arguments: {} });
  console.log(wallet.content?.[0]?.text ?? JSON.stringify(wallet));

  console.log("\n--- drain the wallet, expect a payment requirement ---");
  // A tool that throws surfaces to the agent either as a protocol error
  // (client.callTool rejects) or as an isError result, depending on the error
  // type. Both are "the agent was told to pay", so accept either.
  let outcome = null;
  for (let i = 0; i < 20 && !outcome; i += 1) {
    try {
      const result = await client.callTool({
        name: "payai_chat",
        arguments: { prompt: "drain", max_tokens: 32 },
      });
      if (result.isError) {
        outcome = `isError result after ${i + 1} calls: ${result.content?.[0]?.text?.slice(0, 200)}`;
      }
    } catch (err) {
      outcome =
        `  payment required after ${i + 1} calls\n` +
        `  code:   ${err.code}\n` +
        `  message: ${err.message}\n` +
        `  data:   ${JSON.stringify(err.data)?.slice(0, 300)}`;
    }
  }

  console.log(outcome ?? "  never hit payment required — wallet may have been pre-funded");

  console.log("\n--- payai_receipts ---");
  const receipts = await client.callTool({ name: "payai_receipts", arguments: { limit: 3 } });
  const parsed = JSON.parse(receipts.content?.[0]?.text ?? "{}");
  console.log(`  ${parsed.usage?.length ?? 0} usage entries, ${parsed.settlements?.length ?? 0} settlements`);

  await client.close();
  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
