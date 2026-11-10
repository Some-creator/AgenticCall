#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { CallManager, twilioTelephony } from "./calls.js";
import { buildMcpServer } from "./tools.js";
import { createApp } from "./app.js";
import { log } from "./log.js";

async function main() {
  const cfg = loadConfig();
  if (cfg.transport === "http" && !cfg.mcpAuthToken && !cfg.allowUnauthenticatedMcp) {
    throw new Error(
      "MCP_AUTH_TOKEN is not set. Anyone who finds your URL could make your phone ring. " +
        "Set MCP_AUTH_TOKEN (recommended) or ALLOW_UNAUTHENTICATED_MCP=true.",
    );
  }

  const calls = new CallManager(cfg, twilioTelephony(cfg));
  const app = createApp(cfg, calls);
  await new Promise<void>((resolve) => app.listen(cfg.port, cfg.host, () => resolve()));
  log.info(`Twilio webhooks at ${cfg.publicBaseUrl}/twilio/* (listening on ${cfg.host}:${cfg.port})`);

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
