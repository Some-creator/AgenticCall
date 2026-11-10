import { randomUUID } from "node:crypto";
import twilio from "twilio";
import { isQuietTime, type Config } from "./config.js";
import { log } from "./log.js";

const { VoiceResponse } = twilio.twiml;

export type Urgency = "low" | "normal" | "high" | "critical";

export type CallStatus =
  | "dialing"
  | "ringing"
  | "in_progress"
  | "voicemail"
  | "completed"
  | "no_answer"
  | "busy"
  | "failed"
  | "canceled";

const TERMINAL: ReadonlySet<CallStatus> = new Set([
  "voicemail",
  "completed",
  "no_answer",
  "busy",
  "failed",
  "canceled",
]);

export interface Turn {
  role: "agent" | "user" | "system";
  text: string;
  at: string;
}

type NextAction =
  | { kind: "listen"; say: string } // speak, then listen for a reply
  | { kind: "say"; say: string } // speak, then keep the line open (hold) without listening
  | { kind: "hangup"; say?: string }; // speak (optional), then hang up

type Reply = { kind: "speech"; text: string; confidence?: number } | { kind: "silence" };

interface CallRecord {
  id: string;
  sid?: string;
  reason?: string;
  urgency: Urgency;
  initialMessage: string;
  callerName: string;
  status: CallStatus;
  answeredBy?: string;
  createdAt: number;
  answeredAt?: number;
  endedAt?: number;
  transcript: Turn[];
  next: NextAction | null;
  replies: Reply[];
  silentStreak: number;
  holdingSince?: number;
  smsFallbackSent: boolean;
  /** Wakes anyone waiting for a change on this call (agent-side reply waits, Twilio hold long-polls). */
  listeners: Set<() => void>;
}

/** Thin seam over the Twilio REST API so the call logic can be tested without network access. */
export interface Telephony {
  createCall(opts: {
    to: string;
    from: string;
    url: string;
    statusCallback: string;
    machineDetection: boolean;
    timeLimit: number;
  }): Promise<{ sid: string }>;
  hangup(sid: string): Promise<void>;
  sendSms(opts: { to: string; from: string; body: string }): Promise<{ sid: string }>;
}

export function twilioTelephony(cfg: Config): Telephony {
  const client = twilio(cfg.twilio.accountSid, cfg.twilio.authToken);
  return {
    async createCall(o) {
      const call = await client.calls.create({
        to: o.to,
        from: o.from,
        url: o.url,
        method: "POST",
        statusCallback: o.statusCallback,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
        timeLimit: o.timeLimit,
        ...(o.machineDetection
          ? { machineDetection: "DetectMessageEnd", machineDetectionTimeout: 30 }
          : {}),
      });
      return { sid: call.sid };
    },
    async hangup(sid) {
      await client.calls(sid).update({ status: "completed" });
    },
    async sendSms(o) {
      const msg = await client.messages.create({ to: o.to, from: o.from, body: o.body });
      return { sid: msg.sid };
    },
  };
}

export class CallError extends Error {}

export interface WaitResult {
  call_id: string;
  status: CallStatus;
  /** What the user said since the agent last heard from them (joined if they spoke more than once). */
  user_said?: string;
  /** True if the user stayed silent through a re-prompt. */
  user_silent?: boolean;
  /** True if the wait timed out with the call still live; call wait_for_reply again to keep listening. */
  still_waiting?: boolean;
  hint: string;
}

export class CallManager {
  private calls = new Map<string, CallRecord>();
  private dialTimestamps: number[] = [];

  constructor(
    private cfg: Config,
    private tel: Telephony,
    private now: () => number = Date.now,
  ) {}

  // ---------------------------------------------------------------- agent side

  async startCall(input: {
    message: string;
    reason?: string;
    urgency?: Urgency;
    callerName?: string;
  }): Promise<CallRecord> {
    const urgency = input.urgency ?? "normal";
    const active = [...this.calls.values()].find((c) => !TERMINAL.has(c.status));
    if (active) {
      throw new CallError(
        `A call is already active (call_id ${active.id}, status ${active.status}). ` +
          `Use say_on_call / end_call on it instead of starting another.`,
      );
    }
    if (urgency !== "critical" && isQuietTime(this.cfg.quietHours, this.cfg.timezone, new Date(this.now()))) {
      throw new CallError(
        `It is currently the user's quiet hours, so only urgency="critical" calls are placed. ` +
          `Use send_sms for anything that can wait, or retry with urgency "critical" if it truly cannot.`,
      );
    }
    const hourAgo = this.now() - 3_600_000;
    this.dialTimestamps = this.dialTimestamps.filter((t) => t > hourAgo);
    if (urgency !== "critical" && this.dialTimestamps.length >= this.cfg.maxCallsPerHour) {
      throw new CallError(
        `Call limit reached (${this.cfg.maxCallsPerHour} per hour). Batch updates into one call or use send_sms.`,
      );
    }

    const id = randomUUID();
    const who = input.callerName?.trim() || "your AI assistant";
    const opening = `Hi ${this.cfg.userName}, this is ${who}. ${input.message}`;
    const rec: CallRecord = {
      id,
      reason: input.reason,
      urgency,
      initialMessage: input.message,
      status: "dialing",
      createdAt: this.now(),
      transcript: [],
      callerName: who,
      next: { kind: "listen", say: opening },
      replies: [],
      silentStreak: 0,
      smsFallbackSent: false,
      listeners: new Set(),
    };
    rec.transcript.push(this.turn("agent", opening));
    this.calls.set(id, rec);
    this.dialTimestamps.push(this.now());

    const q = `cid=${encodeURIComponent(id)}`;
    try {
      const { sid } = await this.tel.createCall({
        to: this.cfg.userPhoneNumber,
        from: this.cfg.twilio.fromNumber,
        url: `${this.cfg.publicBaseUrl}/twilio/voice?${q}`,
        statusCallback: `${this.cfg.publicBaseUrl}/twilio/status?${q}`,
        machineDetection: this.cfg.answeringMachineDetection,
        timeLimit: this.cfg.maxCallSeconds,
      });
      rec.sid = sid;
      log.info(`call ${id} dialing (twilio sid ${sid}), urgency=${urgency}`);
    } catch (err) {
      rec.status = "failed";
      rec.endedAt = this.now();
      throw new CallError(`Twilio refused to place the call: ${(err as Error).message}`);
    }
    return rec;
  }

  /** Queue something to say. With listen=true the user's reply is awaited and returned. */
  async say(id: string, message: string, listen: boolean, timeoutMs: number): Promise<WaitResult> {
    const rec = this.mustGetLive(id);
    rec.next = listen ? { kind: "listen", say: message } : { kind: "say", say: message };
    rec.silentStreak = 0;
    rec.transcript.push(this.turn("agent", message));
    this.notify(rec);
    if (!listen) {
      return {
        call_id: id,
        status: rec.status,
        hint: "Message queued; the user is on hold afterwards. Use say_on_call or end_call next.",
      };
    }
    return this.waitForReply(id, timeoutMs);
  }

  async endCall(id: string, message?: string): Promise<CallRecord> {
    const rec = this.get(id);
    if (TERMINAL.has(rec.status)) return rec;
    if (rec.status === "in_progress") {
      rec.next = { kind: "hangup", say: message };
      if (message) rec.transcript.push(this.turn("agent", message));
      this.notify(rec);
      // Give Twilio a moment to pick up the goodbye; force hang-up if it doesn't.
      await this.waitFor(rec, () => TERMINAL.has(rec.status), 20_000);
    }
    if (!TERMINAL.has(rec.status) && rec.sid) {
      await this.tel.hangup(rec.sid).catch((e) => log.warn(`hangup failed: ${e.message}`));
      this.setStatus(rec, "canceled");
    }
    return rec;
  }

  async waitForReply(id: string, timeoutMs: number): Promise<WaitResult> {
    const rec = this.get(id);
    await this.waitFor(rec, () => rec.replies.length > 0 || TERMINAL.has(rec.status), timeoutMs);

    if (rec.replies.length > 0) {
      const replies = rec.replies.splice(0);
      const speech = replies.filter((r): r is Extract<Reply, { kind: "speech" }> => r.kind === "speech");
      if (speech.length > 0) {
        return {
          call_id: id,
          status: rec.status,
          user_said: speech.map((s) => s.text).join(" "),
          hint:
            "The user is on hold waiting for you. Reply promptly with say_on_call (listen=true to hear them), " +
            "or end_call with a short goodbye when the conversation is done.",
        };
      }
      return {
        call_id: id,
        status: rec.status,
        user_silent: true,
        hint: "The user did not answer after a re-prompt. Try say_on_call once more, or end_call.",
      };
    }
    if (TERMINAL.has(rec.status)) {
      return {
        call_id: id,
        status: rec.status,
        hint: terminalHint(rec),
      };
    }
    return {
      call_id: id,
      status: rec.status,
      still_waiting: true,
      hint:
        rec.status === "in_progress"
          ? "The user is still talking or thinking. Call wait_for_reply again to keep listening."
          : "The phone is still ringing / connecting. Call wait_for_reply again to keep waiting.",
    };
  }

  async sendSms(body: string): Promise<string> {
    const { sid } = await this.tel.sendSms({
      to: this.cfg.userPhoneNumber,
      from: this.cfg.twilio.fromNumber,
      body,
    });
    return sid;
  }

  get(id: string): CallRecord {
    const rec = this.calls.get(id);
    if (!rec) throw new CallError(`Unknown call_id ${id}`);
    return rec;
  }

  list(): CallRecord[] {
    return [...this.calls.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  summarize(rec: CallRecord) {
    return {
      call_id: rec.id,
      status: rec.status,
      urgency: rec.urgency,
      caller_name: rec.callerName,
      reason: rec.reason,
      answered_by: rec.answeredBy,
      created_at: new Date(rec.createdAt).toISOString(),
      answered_at: rec.answeredAt ? new Date(rec.answeredAt).toISOString() : undefined,
      ended_at: rec.endedAt ? new Date(rec.endedAt).toISOString() : undefined,
      transcript: rec.transcript,
    };
  }

  // ---------------------------------------------------------------- Twilio side (return TwiML)

  /** Call was answered. */
  onAnswered(id: string, params: Record<string, string>): string {
    const rec = this.calls.get(id);
    if (!rec) return hangupTwiml();
    rec.answeredAt = this.now();
    rec.answeredBy = params.AnsweredBy;

    const ab = params.AnsweredBy ?? "";
    if (ab.startsWith("machine") || ab === "fax") {
      const text = `Hi ${this.cfg.userName}, this is ${rec.callerName}. ${rec.initialMessage} I'll also send you a text.`;
      rec.transcript.push(this.turn("system", `Answering machine detected (${ab}); left voicemail.`));
      this.setStatus(rec, "voicemail");
      void this.smsFallback(rec);
      const vr = new VoiceResponse();
      vr.say(this.sayAttrs(), text);
      vr.hangup();
      return vr.toString();
    }

    this.setStatus(rec, "in_progress");
    return this.serveNextOrHold(rec);
  }

  /** Result of a <Gather>. */
  onGather(id: string, params: Record<string, string>): string {
    const rec = this.calls.get(id);
    if (!rec || TERMINAL.has(rec.status)) return hangupTwiml();
    const text = (params.SpeechResult ?? "").trim();

    if (text) {
      rec.silentStreak = 0;
      rec.transcript.push(this.turn("user", text));
      rec.replies.push({ kind: "speech", text, confidence: num(params.Confidence) });
      this.notify(rec);
      return this.serveNextOrHold(rec);
    }

    rec.silentStreak += 1;
    if (rec.silentStreak === 1) {
      const prompt = "Sorry, I didn't catch that. Are you still there?";
      rec.transcript.push(this.turn("system", prompt));
      return this.gatherTwiml(rec, prompt);
    }
    rec.replies.push({ kind: "silence" });
    this.notify(rec);
    return this.serveNextOrHold(rec);
  }

  /** Twilio polls this while the agent is thinking. Long-polls so the agent's reply is spoken ASAP. */
  async onHold(id: string): Promise<string> {
    const rec = this.calls.get(id);
    if (!rec || TERMINAL.has(rec.status)) return hangupTwiml();
    if (!rec.next) await this.waitFor(rec, () => rec.next !== null || TERMINAL.has(rec.status), 10_000);
    if (TERMINAL.has(rec.status)) return hangupTwiml();
    if (rec.next) return this.serve(rec);

    const held = this.now() - (rec.holdingSince ?? this.now());
    if (held > this.cfg.maxHoldSeconds * 1000) {
      const msg = "Sorry, I'm taking too long. I'll follow up with you later. Goodbye.";
      rec.transcript.push(this.turn("system", `Hold timeout; said: ${msg}`));
      const vr = new VoiceResponse();
      vr.say(this.sayAttrs(), msg);
      vr.hangup();
      return vr.toString();
    }
    return this.holdTwiml(rec);
  }

  onStatus(id: string, params: Record<string, string>): void {
    const rec = this.calls.get(id);
    if (!rec) return;
    const map: Record<string, CallStatus> = {
      queued: "dialing",
      initiated: "dialing",
      ringing: "ringing",
      "in-progress": "in_progress",
      completed: "completed",
      busy: "busy",
      "no-answer": "no_answer",
      failed: "failed",
      canceled: "canceled",
    };
    const next = map[params.CallStatus ?? ""];
    if (!next) return;
    // Don't downgrade a voicemail outcome to "completed", or a live call back to "ringing".
    if (TERMINAL.has(rec.status)) return;
    if (next === "ringing" && rec.status === "in_progress") return;
    this.setStatus(rec, next);
    if (next === "no_answer" || next === "busy" || (next === "failed" && !rec.answeredAt)) {
      void this.smsFallback(rec);
    }
  }

  // ---------------------------------------------------------------- internals

  private serveNextOrHold(rec: CallRecord): string {
    return rec.next ? this.serve(rec) : this.holdTwiml(rec);
  }

  private serve(rec: CallRecord): string {
    const action = rec.next!;
    rec.next = null;
    rec.holdingSince = undefined;
    switch (action.kind) {
      case "listen":
        return this.gatherTwiml(rec, action.say);
      case "say": {
        const vr = new VoiceResponse();
        vr.say(this.sayAttrs(), action.say);
        vr.redirect({ method: "POST" }, this.url("hold", rec));
        return vr.toString();
      }
      case "hangup": {
        const vr = new VoiceResponse();
        if (action.say) vr.say(this.sayAttrs(), action.say);
        vr.hangup();
        return vr.toString();
      }
    }
  }

  private gatherTwiml(rec: CallRecord, text: string): string {
    const vr = new VoiceResponse();
    const g = vr.gather({
      input: ["speech"],
      action: this.url("gather", rec),
      method: "POST",
      speechTimeout: "auto",
      timeout: this.cfg.speechTimeoutSeconds,
      actionOnEmptyResult: true,
      language: this.cfg.language as never,
      speechModel: "phone_call",
      enhanced: true,
    });
    // <Say> nested inside <Gather> lets the user interrupt (barge in).
    g.say(this.sayAttrs(), text);
    return vr.toString();
  }

  private holdTwiml(rec: CallRecord): string {
    rec.holdingSince ??= this.now();
    const vr = new VoiceResponse();
    vr.pause({ length: 1 });
    vr.redirect({ method: "POST" }, this.url("hold", rec));
    return vr.toString();
  }

  private sayAttrs() {
    return { voice: this.cfg.voice as never, language: this.cfg.language as never };
  }

  private url(path: string, rec: CallRecord): string {
    return `${this.cfg.publicBaseUrl}/twilio/${path}?cid=${encodeURIComponent(rec.id)}`;
  }

  private async smsFallback(rec: CallRecord): Promise<void> {
    if (rec.smsFallbackSent) return;
    rec.smsFallbackSent = true;
    try {
      await this.sendSms(`[${rec.callerName}] Tried to call you: ${rec.initialMessage}`);
      rec.transcript.push(this.turn("system", "Sent SMS fallback with the call message."));
    } catch (e) {
      log.warn(`SMS fallback failed: ${(e as Error).message}`);
    }
    this.notify(rec);
  }

  private setStatus(rec: CallRecord, status: CallStatus) {
    if (rec.status === status) return;
    rec.status = status;
    if (TERMINAL.has(status)) rec.endedAt ??= this.now();
    log.info(`call ${rec.id} -> ${status}`);
    this.notify(rec);
  }

  private mustGetLive(id: string): CallRecord {
    const rec = this.get(id);
    if (TERMINAL.has(rec.status)) {
      throw new CallError(`Call ${id} has already ended (${rec.status}). Start a new call with call_user.`);
    }
    return rec;
  }

  private notify(rec: CallRecord) {
    for (const l of [...rec.listeners]) l();
  }

  private waitFor(rec: CallRecord, cond: () => boolean, timeoutMs: number): Promise<void> {
    if (cond()) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        rec.listeners.delete(check);
        resolve();
      };
      const check = () => {
        if (cond()) done();
      };
      const timer = setTimeout(done, timeoutMs);
      rec.listeners.add(check);
    });
  }

  private turn(role: Turn["role"], text: string): Turn {
    return { role, text, at: new Date(this.now()).toISOString() };
  }
}

function terminalHint(rec: CallRecord): string {
  switch (rec.status) {
    case "voicemail":
      return "Went to voicemail; the message was left and an SMS was sent. Try again later only if it is still important.";
    case "no_answer":
    case "busy":
      return "The user didn't pick up; an SMS with the message was sent. Retry later only if it is urgent.";
    case "completed":
      return rec.answeredAt ? "The call ended (the user may have hung up)." : "The call ended without being answered.";
    default:
      return `The call ended with status ${rec.status}.`;
  }
}

function hangupTwiml(): string {
  const vr = new VoiceResponse();
  vr.hangup();
  return vr.toString();
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
