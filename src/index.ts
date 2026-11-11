#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { CallManager, twilioTelephony } from "./calls.js";
import { buildMcpServer } from "./tools.js";
import { createApp } from "./app.js";
import { attachRelayServer, groqLLM, logGroqModels, type VoiceLLM } from "./realtime.js";
import { anthropicLLM, withBackup } from "./anthropic.js";
import { MemoryStore } from "./memory.js";
import { log } from "./log.js";

async function main() {
  const cfg = loadConfig();
  if (cfg.transport === "http" && !cfg.mcpAuthToken && !cfg.allowUnauthenticatedMcp) {
    throw new Error(
      "MCP_AUTH_TOKEN is not set. Anyone who finds your URL could make your phone ring. " +
        "Set MCP_AUTH_TOKEN (recommended) or ALLOW_UNAUTHENTICATED_MCP=true.",
    );
  }

  // Claude (if configured) leads; Groq is the backup when Claude is rate-limited or overloaded.
  const groq = cfg.groq.apiKey ? groqLLM(cfg.groq.apiKey, cfg.groq.model, cfg.groq.fallbackModel) : undefined;
  const claude = cfg.anthropic.apiKey ? anthropicLLM(cfg.anthropic.apiKey, cfg.anthropic.model) : undefined;
  const llm: VoiceLLM | undefined =
    claude && groq ? withBackup(claude, groq, [cfg.anthropic.model, `Groq ${cfg.groq.model}`]) : (claude ?? groq);
  const memory = new MemoryStore(cfg.memoryFile);
  const calls = new CallManager(cfg, twilioTelephony(cfg), { llm, memory });
  const app = createApp(cfg, calls);
  const server = await new Promise<import("node:http").Server>((resolve) => {
    const s = app.listen(cfg.port, cfg.host, () => resolve(s));
  });
  attachRelayServer(server, calls);
  if (cfg.groq.apiKey) void logGroqModels(cfg.groq.apiKey);
  log.info(`Twilio webhooks at ${cfg.publicBaseUrl}/twilio/* (listening on ${cfg.host}:${cfg.port})`);
  log.info(
    cfg.defaultMode === "realtime"
      ? `Real-time voice: ${claude ? `${cfg.anthropic.model}${groq ? ` (backup: Groq ${cfg.groq.model})` : ""}` : `Groq ${cfg.groq.model}`}`
      : "Turn-by-turn voice (set ANTHROPIC_API_KEY or GROQ_API_KEY for real-time conversations)",
  );

  // On a redeploy, the platform sends SIGTERM. Don't drop a call that's in progress: keep this instance
  // running until active calls end (up to the max call length), then exit.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    const deadline = Date.now() + cfg.maxCallSeconds * 1000;
    if (calls.activeCount() > 0) {
      log.warn(`${signal}: waiting for ${calls.activeCount()} active call(s) to finish before shutting down`);
    }
    while (calls.activeCount() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
    log.info(`${signal}: shutting down`);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

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
