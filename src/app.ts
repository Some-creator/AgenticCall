import { timingSafeEqual } from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import type { CallManager } from "./calls.js";
import { buildMcpServer } from "./tools.js";
import { twilioRouter } from "./webhooks.js";
import { telnyxRouter } from "./telnyx.js";
import { log } from "./log.js";

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Accepts `Authorization: Bearer <token>` or `?token=<token>` (for clients that only take a URL). */
function mcpAuth(cfg: Config) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!cfg.mcpAuthToken) return next();
    const header = req.header("authorization") ?? "";
    const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const query = typeof req.query.token === "string" ? req.query.token : "";
    if (safeEqual(bearer, cfg.mcpAuthToken) || safeEqual(query, cfg.mcpAuthToken)) return next();
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  };
}

export function createApp(cfg: Config, calls: CallManager): express.Express {
  const app = express();
  app.set("trust proxy", true);
  app.get("/", (_req, res) => res.json({ ok: true, name: "agentic-call" }));
  if (cfg.twilio) app.use("/twilio", twilioRouter(cfg, calls));
  if (cfg.telnyx) app.use("/telnyx", telnyxRouter(cfg.telnyx, calls));

  if (cfg.transport === "http") {
    app.post("/mcp", mcpAuth(cfg), express.json({ limit: "1mb" }), async (req, res) => {
      // Stateless Streamable HTTP: a fresh MCP server per request; call state lives in the shared CallManager.
      const server = buildMcpServer(calls);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        log.error(`MCP request failed: ${(err as Error).message}`);
        if (!res.headersSent) {
          res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
        }
      }
    });
    const notAllowed = (_req: Request, res: Response) =>
      res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
    app.get("/mcp", notAllowed);
    app.delete("/mcp", notAllowed);
  }
  return app;
}
