import express, { type Request, type Response } from "express";
import Telnyx from "telnyx";
import type { CallManager, Telephony } from "./calls.js";
import type { Config } from "./config.js";
import { log } from "./log.js";

type TelnyxConfig = NonNullable<Config["telnyx"]>;

/**
 * Telnyx Call Control: dial out, and when the call is answered start Telnyx's Conversation Relay, which streams
 * speech to the same real-time voice WebSocket the Twilio path uses.
 */
export function telnyxTelephony(cfg: TelnyxConfig, maxCallSeconds: number): Telephony {
  const client = new Telnyx({ apiKey: cfg.apiKey });
  return {
    provider: "telnyx",
    async createCall(o) {
      const res = await client.calls.dial({
        connection_id: cfg.connectionId,
        to: o.to,
        from: o.from,
        webhook_url: o.webhookUrl,
        webhook_url_method: "POST",
        // Echoed back on every event for this call, so events map to our call record.
        client_state: Buffer.from(o.cid).toString("base64"),
        timeout_secs: 30,
        time_limit_secs: maxCallSeconds,
        answering_machine_detection: "disabled",
      });
      const id = res.data?.call_control_id;
      if (!id) throw new Error("Telnyx didn't return a call_control_id");
      return { sid: id };
    },
    async hangup(sid) {
      await client.calls.actions.hangup(sid, {});
    },
    async sendSms() {
      throw new Error("Texting isn't set up for Telnyx on this server yet.");
    },
    async startRelay(sid, o) {
      await client.calls.actions.startConversationRelay(sid, {
        conversation_relay_url: o.url,
        greeting: o.greeting,
        interruptible: "any",
        interruptible_greeting: "any",
        language: o.language,
        custom_parameters: o.customParameters,
      });
    },
  };
}

/**
 * POST /telnyx/webhook: call events from Telnyx. Verified with the account's public key (Ed25519 signature) when
 * one is configured; otherwise with the per-call secret the server put in the webhook URL when dialing.
 */
export function telnyxRouter(cfg: TelnyxConfig, calls: CallManager): express.Router {
  const verifier = new Telnyx({ apiKey: cfg.apiKey, ...(cfg.publicKey ? { publicKey: cfg.publicKey } : {}) });
  const r = express.Router();
  // The signature covers the exact raw body, so it must not be parsed first.
  r.post("/webhook", express.text({ type: "*/*", limit: "1mb" }), async (req: Request, res: Response) => {
    const raw = String(req.body ?? "");
    let event: unknown;
    try {
      if (cfg.publicKey) {
        event = await verifier.webhooks.unwrap(raw, { headers: req.headers as Record<string, string> });
      } else {
        const cid = String(req.query.cid ?? "");
        if (!calls.telnyxTokenValid(cid, String(req.query.token ?? ""))) throw new Error("missing or wrong call token");
        event = JSON.parse(raw);
      }
    } catch (e) {
      log.warn(`rejected Telnyx webhook: ${(e as Error).message}`);
      res.status(403).send("Forbidden");
      return;
    }
    res.status(200).end(); // acknowledge fast; Telnyx retries slow webhooks
    calls.onTelnyxEvent(event).catch((e) => log.error(`Telnyx event failed: ${(e as Error).message}`));
  });
  return r;
}
