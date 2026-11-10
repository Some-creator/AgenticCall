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
    const url = cfg.publicBaseUrl + req.originalUrl;
    const ok = twilio.validateRequest(cfg.twilio.authToken, signature, url, req.body ?? {});
    if (!ok) {
      log.warn(`rejected unsigned/invalid Twilio webhook for ${req.originalUrl}`);
      res.status(403).send("Invalid Twilio signature");
      return;
    }
    next();
  });

  const cid = (req: Request) => String(req.query.cid ?? "");
  const body = (req: Request) => (req.body ?? {}) as Record<string, string>;
  const xml = (res: Response, twiml: string) => res.type("text/xml").send(twiml);

  r.post("/voice", (req, res) => xml(res, calls.onAnswered(cid(req), body(req))));
  r.post("/gather", (req, res) => xml(res, calls.onGather(cid(req), body(req))));
  r.post("/hold", async (req, res) => xml(res, await calls.onHold(cid(req))));
  r.post("/status", (req, res) => {
    calls.onStatus(cid(req), body(req));
    res.status(204).end();
  });

  return r;
}
