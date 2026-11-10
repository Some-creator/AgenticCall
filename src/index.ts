#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { CallManager, twilioTelephony } from "./calls.js";
import { buildMcpServer } from "./tools.js";
import { createApp } from "./app.js";
import { attachRelayServer, groqLLM, logGroqModels } from "./realtime.js";
import { log } from "./log.js";

async function main() {
  const cfg = loadConfig();
  if (cfg.transport === "http" && !cfg.mcpAuthToken && !cfg.allowUnauthenticatedMcp) {
    throw new Error(
      "MCP_AUTH_TOKEN is not set. Anyone who finds your URL could make your phone ring. " +
        "Set MCP_AUTH_TOKEN (recommended) or ALLOW_UNAUTHENTICATED_MCP=true.",
    );
  }

  const llm = cfg.groq.apiKey ? groqLLM(cfg.groq.apiKey, cfg.groq.model, cfg.groq.fallbackModel) : undefined;
  const calls = new CallManager(cfg, twilioTelephony(cfg), { llm });
  const app = createApp(cfg, calls);
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(cfg.port, cfg.host, () => resolve(s));
  });
  attachRelayServer(server, calls);
  if (cfg.groq.apiKey) void logGroqModels(cfg.groq.apiKey);
  log.info(`Twilio webhooks at ${cfg.publicBaseUrl}/twilio/* (listening on ${cfg.host}:${cfg.port})`);
  log.info(
    cfg.defaultMode === "realtime"
      ? `Real-time voice: Groq ${cfg.groq.model}`
      : "Turn-by-turn voice (set GROQ_API_KEY for real-time conversations)",
  );

  if (cfg.transport === "stdio") {
    await buildMcpServer(calls).connect(new StdioServerTransport());
    log.info("MCP server running on stdio");
  } else {
    log.info(`MCP endpoint at ${cfg.publicBaseUrl}/mcp`);
  }
}

main().catch((err) => {
  log.error((err as Error).message);
  process.exit(1);
});
