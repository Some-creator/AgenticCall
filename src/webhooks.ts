import express, { type Request, type Response, type NextFunction } from "express";
import twilio from "twilio";
import type { CallManager } from "./calls.js";
import type { Config } from "./config.js";
import { log } from "./log.js";

/** Express router for Twilio voice webhooks: /twilio/voice, /twilio/gather, /twilio/hold, /twilio/status. */
export function twilioRouter(cfg: Config, calls: CallManager): express.Router {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));

  // Reject anything not signed by Twilio with our auth token.
  r.use((req: Request, res: Response, next: NextFunction) => {
    if (!cfg.twilio.validateSignature) return next();
    const signature = req.header("X-Twilio-Signature") ?? "";
    const params = (req.body ?? {}) as Record<string, string>;
    const expectedUrl = cfg.publicBaseUrl + req.originalUrl;
    if (signature && twilio.validateRequest(cfg.twilio.authToken, signature, expectedUrl, params)) return next();

    // Fall back to the URL as the proxy saw it, in case PUBLIC_BASE_URL differs from the real host.
    const proto = (req.header("x-forwarded-proto") ?? req.protocol).split(",")[0].trim();
    const seenUrl = `${proto}://${req.header("host")}${req.originalUrl}`;
    if (signature && seenUrl !== expectedUrl && twilio.validateRequest(cfg.twilio.authToken, signature, seenUrl, params)) {
      log.warn(`Twilio webhook matched ${seenUrl}, not PUBLIC_BASE_URL ${cfg.publicBaseUrl}; set PUBLIC_BASE_URL to match.`);
      return next();
    }

    log.warn(
      `rejected Twilio webhook ${req.method} ${req.originalUrl}: ` +
        (signature ? "signature mismatch" : "no X-Twilio-Signature header") +
        `. Checked ${expectedUrl}${seenUrl !== expectedUrl ? ` and ${seenUrl}` : ""}. ` +
        `If this came from Twilio, TWILIO_AUTH_TOKEN is not the auth token of account ${params.AccountSid ?? "?"} ` +
        `(use that exact account's token, not a parent account's or an API key secret).`,
    );
    res.status(403).send("Invalid Twilio signature");
  });

  const cid = (req: Request) => String(req.query.cid ?? "");
  const body = (req: Request) => (req.body ?? {}) as Record<string, string>;
  const xml = (res: Response, twiml: string) => res.type("text/xml").send(twiml);

  r.post("/voice", (req, res) => xml(res, calls.onAnswered(cid(req), body(req))));
  r.post("/gather", (req, res) => xml(res, calls.onGather(cid(req), body(req))));
  r.post("/relay-done", (req, res) => xml(res, calls.onRelayDone(cid(req), body(req))));
  r.post("/hold", async (req, res) => xml(res, await calls.onHold(cid(req))));
  r.post("/status", (req, res) => {
    calls.onStatus(cid(req), body(req));
    res.status(204).end();
  });

  r.use((req, res) => {
    log.warn(`404 for Twilio webhook ${req.method} ${req.originalUrl}`);
    res.status(404).send("Not found");
  });

  return r;
}
