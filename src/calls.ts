import { randomBytes, randomUUID } from "node:crypto";
import twilio from "twilio";
import type { WebSocket } from "ws";
import { isQuietTime, type Config } from "./config.js";
import { log } from "./log.js";
import type { MemoryStore } from "./memory.js";
import {
  RealtimeSession,
  answerNote,
  type DeliveredNote,
  buildSummaryPrompt,
  buildSystemPrompt,
  parseSummary,
  relayUrl,
  speechMs,
  type VoiceLLM,
} from "./realtime.js";

const { VoiceResponse } = twilio.twiml;

export type Urgency = "low" | "normal" | "high" | "critical";
export type CallMode = "realtime" | "turn_by_turn";

export interface AgentRequest {
  request_id: string;
  request: string;
  asked_at: string;
  /** pending: not yet seen by the agent; delivered: returned to the agent; answered: answer spoken to the user. */
  status: "pending" | "delivered" | "acknowledged" | "answered";
  answer?: string;
  eta_seconds?: number;
}

export interface CallOutcome {
  summary: string;
  user_decisions: string[];
  follow_ups: string[];
}

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
  lastAck?: string;
  smsFallbackSent: boolean;
  mode: CallMode;
  opening: string;
  briefing?: string;
  goal?: string;
  /** Per-call secret handed to Twilio in TwiML and checked when the relay WebSocket connects. */
  relaySecret: string;
  session?: RealtimeSession;
  outcome?: CallOutcome;
  summarizing: boolean;
  agentRequests: AgentRequest[];
  requestTimers: Map<string, NodeJS.Timeout>;
  /** Wakes anyone waiting for a change on this call (agent-side reply waits, Twilio hold long-polls). */
  listeners: Set<() => void>;
}

/** Thin seam over the phone provider's API so the call logic can be tested without network access. */
export interface Telephony {
  provider: "twilio" | "telnyx";
  createCall(opts: {
    to: string;
    from: string;
    /** Twilio: TwiML webhook and status callback. */
    url: string;
    statusCallback: string;
    machineDetection: boolean;
    /** Telnyx: our call id (sent as client_state) and the events webhook. */
    cid: string;
    webhookUrl: string;
  }): Promise<{ sid: string }>;
  hangup(sid: string): Promise<void>;
  sendSms(opts: { to: string; from: string; body: string }): Promise<{ sid: string }>;
  /** Telnyx: start Conversation Relay on an answered call. */
  startRelay?(
    sid: string,
    opts: { url: string; greeting: string; language: string; customParameters: Record<string, string> },
  ): Promise<void>;
}

export function twilioTelephony(cfg: NonNullable<Config["twilio"]>): Telephony {
  const client = twilio(cfg.accountSid, cfg.authToken);
  return {
    provider: "twilio",
    async createCall(o) {
      const call = await client.calls.create({
        to: o.to,
        from: o.from,
        url: o.url,
        method: "POST",
        statusCallback: o.statusCallback,
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
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

/** Longest a single wait may block. */
export const MAX_WAIT_MS = 50_000;

const STOPWORDS = new Set("a an the is are was were be to of for on in at my me i you your it this that and or what whats how can could would please".split(" "));

function words(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}

/** True when two requests are about the same thing (one mostly contained in the other). */
export function similarRequests(a: string, b: string): boolean {
  const A = words(a);
  const B = words(b);
  const small = Math.min(A.size, B.size);
  if (small < 2) return false;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / small >= 0.7;
}

export interface WaitResult {
  call_id: string;
  status: CallStatus;
  /** What the user said since the agent last heard from them (joined if they spoke more than once). */
  user_said?: string;
  /** True if the user stayed silent through a re-prompt. */
  user_silent?: boolean;
  /** True if the wait timed out with the call still live; call wait_for_reply again to keep listening. */
  still_waiting?: boolean;
  /** Real-time calls: questions/commands from the user that only you (the agent) can handle. Answer with answer_on_call. */
  agent_requests?: { request_id: string; request: string }[];
  /** With agent_requests: the recent conversation, so answers fit what the user already said. */
  conversation_so_far?: string[];
  /** Real-time calls that ended with requests still unanswered: finish them, then call back or text. */
  open_requests?: { request_id: string; request: string; eta_seconds?: number }[];
  /** Real-time calls: what was said and decided, once the call has ended. */
  outcome?: CallOutcome;
  transcript?: Turn[];
  hint: string;
}

export class CallManager {
  private calls = new Map<string, CallRecord>();
  private dialTimestamps: number[] = [];

  private now: () => number;
  private llm?: VoiceLLM;
  /** Long-term notes about the user, shared with the agents. */
  readonly memory?: MemoryStore;

  constructor(
    private cfg: Config,
    private tel: Telephony | null,
    opts: { llm?: VoiceLLM; now?: () => number; memory?: MemoryStore } = {},
  ) {
    this.llm = opts.llm;
    this.now = opts.now ?? Date.now;
    this.memory = opts.memory;
  }

  // ---------------------------------------------------------------- agent side

  async startCall(input: {
    message: string;
    reason?: string;
    urgency?: Urgency;
    callerName?: string;
    mode?: CallMode;
    briefing?: string;
    goal?: string;
  }): Promise<CallRecord> {
    const urgency = input.urgency ?? "normal";
    if (!this.tel) {
      throw new CallError(
        "Phone calls are turned off on this server right now (no Twilio or Telnyx account is set up). " +
          "Tell the user in chat instead.",
      );
    }
    // Telnyx calls always use the real-time voice.
    const mode = this.tel.provider === "telnyx" ? "realtime" : (input.mode ?? this.cfg.defaultMode);
    if (mode === "realtime" && !this.llm) {
      throw new CallError(
        'Real-time mode is not configured on this server (no ANTHROPIC_API_KEY or GROQ_API_KEY). Use mode "turn_by_turn".',
      );
    }
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
    // Don't stack a second greeting on a message that already says hi.
    const name = this.cfg.userName && this.cfg.userName !== "there" ? ` ${this.cfg.userName}` : "";
    const greets = /^\s*(hi|hey|hello|yo|good (morning|afternoon|evening))\b|^\s*it'?s \w+/i.test(input.message);
    const opening = greets ? input.message.trim() : `Hi${name}, it's ${who}. ${input.message.trim()}`;
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
      mode,
      opening,
      briefing: input.briefing,
      goal: input.goal,
      relaySecret: randomBytes(24).toString("hex"),
      summarizing: false,
      agentRequests: [],
      requestTimers: new Map(),
      listeners: new Set(),
    };
    rec.transcript.push(this.turn("agent", opening));
    this.calls.set(id, rec);
    this.dialTimestamps.push(this.now());

    const q = `cid=${encodeURIComponent(id)}`;
    try {
      const { sid } = await this.tel.createCall({
        to: this.cfg.userPhoneNumber,
        from: this.fromNumber(),
        url: `${this.cfg.publicBaseUrl}/twilio/voice?${q}`,
        statusCallback: `${this.cfg.publicBaseUrl}/twilio/status?${q}`,
        cid: id,
        webhookUrl: `${this.cfg.publicBaseUrl}/telnyx/webhook`,
        machineDetection: this.cfg.answeringMachineDetection,
      });
      rec.sid = sid;
      log.info(`call ${id} dialing (${this.tel.provider} id ${sid}), urgency=${urgency}, mode=${mode}`);
    } catch (err) {
      rec.status = "failed";
      rec.endedAt = this.now();
      throw new CallError(`${this.tel.provider} refused to place the call: ${(err as Error).message}`);
    }
    return rec;
  }

  /** Queue something to say. With listen=true the user's reply is awaited and returned. */
  async say(id: string, message: string, listen: boolean, timeoutMs: number): Promise<WaitResult> {
    const prev = this.get(id);
    if (TERMINAL.has(prev.status) && prev.mode === "realtime") {
      const open = prev.agentRequests.filter((r) => r.status !== "answered");
      if (open.length > 0) return this.callBack(prev, open, message);
    }
    const rec = this.mustGetLive(id);
    if (rec.mode === "realtime") {
      if (!rec.session) throw new CallError("The call hasn't connected yet. Try again once the user has picked up.");
      // Agents with an older tool list answer mid-call requests with say_on_call: treat it as the answer.
      const open = rec.agentRequests.filter((r) => r.status !== "answered");
      if (open.length > 0) {
        for (const r of open) {
          r.status = "answered";
          r.answer = message;
          clearTimeout(rec.requestTimers.get(r.request_id));
        }
        const what = open.map((r) => r.request).join("; ");
        rec.transcript.push(this.turn("system", `Agent answered "${what}": ${message}`));
        rec.session.deliver(answerNote(what, message));
        this.notify(rec);
        return {
          call_id: id,
          status: rec.status,
          hint: "Delivered as the answer. Call wait_for_reply to keep listening for more requests or the outcome.",
        };
      }
      rec.session.inject(message);
      return {
        call_id: id,
        status: rec.status,
        hint: "Spoken. The voice assistant keeps handling the conversation; use wait_for_reply for the outcome.",
      };
    }
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
    if (rec.mode === "realtime" && rec.session) {
      rec.session.finish(message);
      await this.waitFor(rec, () => TERMINAL.has(rec.status), speechMs(message ?? "") + 10_000);
    } else if (rec.status === "in_progress") {
      rec.next = { kind: "hangup", say: message };
      if (message) rec.transcript.push(this.turn("agent", message));
      this.notify(rec);
      // Give Twilio a moment to pick up the goodbye; force hang-up if it doesn't.
      await this.waitFor(rec, () => TERMINAL.has(rec.status), 20_000);
    }
    if (!TERMINAL.has(rec.status) && rec.sid) {
      await this.hangupSid(rec.sid);
      this.setStatus(rec, "canceled");
    }
    await this.waitFor(rec, () => !rec.summarizing, 15_000);
    return rec;
  }

  async waitForReply(id: string, timeoutMs: number): Promise<WaitResult> {
    // Many MCP clients give up on a tool call after 60s; a result returned after that is lost.
    timeoutMs = Math.min(timeoutMs, MAX_WAIT_MS);
    const rec = this.get(id);
    if (rec.mode === "realtime") return this.waitForRealtime(rec, timeoutMs);
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

  private async waitForRealtime(rec: CallRecord, timeoutMs: number): Promise<WaitResult> {
    // Wait for the call to end (and its summary), or for a fallback to turn-by-turn mode.
    const pending = () => rec.agentRequests.filter((r) => r.status === "pending");
    await this.waitFor(
      rec,
      () => rec.mode !== "realtime" || pending().length > 0 || (TERMINAL.has(rec.status) && !rec.summarizing),
      timeoutMs,
    );
    if (rec.mode !== "realtime") return this.waitForReply(rec.id, timeoutMs);
    const asks = pending();
    if (asks.length > 0 && !TERMINAL.has(rec.status)) {
      for (const a of asks) {
        a.status = "delivered";
        // If the agent never answers or estimates (say its wait timed out on its side and the result was lost),
        // hand the request out again on the next wait instead of losing it.
        setTimeout(() => {
          if (a.status === "delivered" && !TERMINAL.has(rec.status)) {
            a.status = "pending";
            this.notify(rec);
          }
        }, 20_000).unref();
      }
      return {
        call_id: rec.id,
        status: rec.status,
        agent_requests: asks.map((a) => ({ request_id: a.request_id, request: a.request })),
        conversation_so_far: rec.transcript
          .filter((t) => t.role !== "system")
          .slice(-20)
          .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`),
        hint:
          "The user is ON THE LINE right now waiting for this. Handle it immediately with your own tools, then call " +
          "answer_on_call with a short plain-spoken answer (or what you did). Use conversation_so_far so the answer " +
          "respects what they already said (e.g. don't suggest something they rejected). Then call wait_for_reply again.",
      };
    }
    if (TERMINAL.has(rec.status)) {
      const open = rec.agentRequests
        .filter((r) => r.status !== "answered")
        .map((r) => ({ request_id: r.request_id, request: r.request, eta_seconds: r.eta_seconds }));
      return {
        call_id: rec.id,
        status: rec.status,
        outcome: rec.outcome,
        open_requests: open.length > 0 ? open : undefined,
        transcript: rec.answeredAt ? rec.transcript : undefined,
        hint:
          open.length > 0
            ? "The call is over but the user is still waiting on open_requests. Finish them now. If the transcript " +
              "shows they agreed to a call back, call_user with the results (or if it needs their input); otherwise " +
              "send_sms the results."
            : rec.outcome
              ? "The call is over. Act on the user's decisions and follow-ups now; send_sms a short confirmation if useful."
              : terminalHint(rec),
      };
    }
    return {
      call_id: rec.id,
      status: rec.status,
      still_waiting: true,
      hint:
        rec.status === "in_progress"
          ? "A voice assistant is talking with the user live. Call wait_for_reply again to get the outcome when it ends."
          : "The phone is still ringing / connecting. Call wait_for_reply again to keep waiting.",
    };
  }

  /** The agent's answer to a mid-call request: the voice model tells the user right away. */
  async answerRequest(id: string, requestId: string, answer: string): Promise<WaitResult> {
    const ended = this.get(id);
    const req = ended.agentRequests.find((r) => r.request_id === requestId);
    if (!req) throw new CallError(`Unknown request_id ${requestId} on call ${id}`);
    // They hung up before the answer was ready (e.g. they chose a call back): ring them back with it.
    if (TERMINAL.has(ended.status)) return this.callBack(ended, [req], answer);
    const rec = this.mustGetLive(id);
    if (!rec.session) throw new CallError("This call isn't in real-time mode; use say_on_call instead.");
    req.status = "answered";
    req.answer = answer;
    clearTimeout(rec.requestTimers.get(requestId));
    rec.transcript.push(this.turn("system", `Agent answered "${req.request}": ${answer}`));
    rec.session.deliver(answerNote(req.request, answer));
    this.notify(rec);
    return {
      call_id: id,
      status: rec.status,
      hint: "Delivered; it's being spoken now. Call wait_for_reply to keep listening for more requests or the outcome.",
    };
  }

  private fromNumber(): string {
    return (this.tel?.provider === "telnyx" ? this.cfg.telnyx?.fromNumber : this.cfg.twilio?.fromNumber) ?? "";
  }

  private async hangupSid(sid: string): Promise<void> {
    await this.tel?.hangup(sid).catch((e) => log.warn(`hangup failed: ${(e as Error).message}`));
  }

  /** A Telnyx call event (already signature-checked). */
  async onTelnyxEvent(body: unknown): Promise<void> {
    const ev = ((body as { data?: unknown })?.data ?? body) as {
      event_type?: string;
      payload?: { call_control_id?: string; client_state?: string; hangup_cause?: string };
    };
    const p = ev?.payload ?? {};
    let cid = "";
    try {
      cid = Buffer.from(p.client_state ?? "", "base64").toString("utf8");
    } catch {
      /* not ours */
    }
    const rec = this.calls.get(cid) ?? [...this.calls.values()].find((r) => r.sid && r.sid === p.call_control_id);
    if (!rec) return;
    switch (ev.event_type) {
      case "call.answered": {
        if (TERMINAL.has(rec.status)) return;
        rec.answeredAt = this.now();
        this.setStatus(rec, "in_progress");
        this.armMaxDuration(rec);
        try {
          await this.tel?.startRelay?.(p.call_control_id ?? rec.sid ?? "", {
            url: relayUrl(this.cfg, rec.id),
            greeting: rec.opening,
            language: this.cfg.language,
            customParameters: { cid: rec.id, secret: rec.relaySecret },
          });
        } catch (e) {
          log.error(`call ${rec.id}: couldn't start Telnyx Conversation Relay: ${(e as Error).message}`);
          rec.transcript.push(this.turn("system", `Real-time voice failed to start: ${(e as Error).message}`));
          if (rec.sid) await this.hangupSid(rec.sid);
        }
        return;
      }
      case "call.conversation.start_failed":
        log.error(`call ${rec.id}: Telnyx Conversation Relay failed to start`);
        rec.transcript.push(this.turn("system", "Real-time voice failed to start (Telnyx)."));
        if (rec.sid) await this.hangupSid(rec.sid);
        return;
      case "call.hangup": {
        const cause = p.hangup_cause ?? "";
        const status: CallStatus =
          cause === "user_busy"
            ? "busy"
            : ["no_answer", "timeout", "call_rejected", "originator_cancel"].includes(cause) && !rec.answeredAt
              ? "no_answer"
              : cause === "normal_clearing" || cause === "time_limit" || rec.answeredAt
                ? "completed"
                : "failed";
        this.setStatus(rec, status);
        if (status === "no_answer" || status === "busy") void this.smsFallback(rec);
        return;
      }
      default:
        return;
    }
  }

  /** An answer arrived after the user hung up: call them back with it (or text it if a call isn't allowed now). */
  private async callBack(prev: CallRecord, reqs: AgentRequest[], answer: string): Promise<WaitResult> {
    for (const r of reqs) {
      r.status = "answered";
      r.answer = answer;
      clearTimeout(prev.requestTimers.get(r.request_id));
    }
    const about = reqs.map((r) => r.request).join("; ");
    const name = this.cfg.userName && this.cfg.userName !== "there" ? ` ${this.cfg.userName}` : "";
    try {
      const call = await this.startCall({
        message: `Hey${name}, it's ${prev.callerName}, calling back with what you asked for. ${answer}`,
        reason: `Call back with the result of: ${about}`,
        urgency: prev.urgency,
        callerName: prev.callerName,
        mode: this.llm ? "realtime" : "turn_by_turn",
        briefing: `On the previous call they asked: ${about}\nThe result (already said in your opening): ${answer}`,
        goal: "Give them the result and help with any follow-up questions.",
      });
      prev.transcript.push(this.turn("system", `Answer arrived after the call; calling back (call_id ${call.id}).`));
      log.info(`call ${prev.id}: calling the user back with the answer (call ${call.id})`);
      return {
        call_id: call.id,
        status: call.status,
        hint:
          `The user had already hung up, so I'm calling them back with this answer on a NEW call (call_id ${call.id}). ` +
          "Use wait_for_reply with that call_id, and answer any new agent_requests on it.",
      };
    } catch (err) {
      // Quiet hours, rate limit or another active call: text the result instead.
      await this.sendSms(`[${prev.callerName}] ${answer}`).catch((e) => log.warn(`SMS failed: ${e.message}`));
      prev.transcript.push(this.turn("system", `Answer arrived after the call; couldn't call back, texted it instead.`));
      return {
        call_id: prev.id,
        status: prev.status,
        hint: `The user had hung up and a call back wasn't possible (${(err as Error).message}), so the answer was texted to them.`,
      };
    }
  }

  /** The agent's quick estimate of how long a mid-call request will take. */
  acknowledgeRequest(id: string, requestId: string, etaSeconds: number, note?: string): WaitResult {
    const rec = this.mustGetLive(id);
    const req = rec.agentRequests.find((r) => r.request_id === requestId);
    if (!req) throw new CallError(`Unknown request_id ${requestId} on call ${id}`);
    if (!rec.session) throw new CallError("This call isn't in real-time mode.");
    req.eta_seconds = etaSeconds;
    if (req.status !== "answered") req.status = "acknowledged";
    const extra = note ? ` Note: ${note}` : "";
    const long = etaSeconds > this.cfg.callbackThresholdSeconds;
    const human = etaSeconds < 90 ? `about ${etaSeconds} seconds` : `about ${Math.round(etaSeconds / 60)} minutes`;
    rec.transcript.push(this.turn("system", `Agent estimated ${human} for "${req.request}".${extra}`));
    rec.session.deliver({
      note: long
        ? `STATUS ONLY, NO ANSWER YET: "${req.request}" will take ${human}.${extra} You do NOT have the answer, so ` +
          "don't give any of it or guess. Tell the user how long it'll take, then ask whether they'd like to stay on " +
          "the line or have you call them back when it's done. If they want a call back, confirm, say goodbye and " +
          `end the call with ${"[END_CALL]"}. If they stay, keep chatting until the answer arrives.`
        : `STATUS ONLY, NO ANSWER YET: "${req.request}" will take ${human}.${extra} You do NOT have the answer, so ` +
          `don't give any of it or guess. Just tell the user briefly (like "Give me about ${etaSeconds} seconds"), ` +
          "then keep chatting normally if they talk.",
      after: `(Already told the user "${req.request}" would take ${human}.)`,
    });
    // Restart the "no answer yet" timer from the estimate.
    this.armRequestTimer(rec, req, (etaSeconds + 20) * 1000);
    this.notify(rec);
    return {
      call_id: id,
      status: rec.status,
      hint: long
        ? "The user is being offered a call back. Keep working; call wait_for_reply to see if they stay or hang up."
        : "Estimate delivered. Finish the work, then answer_on_call.",
    };
  }

  private armRequestTimer(rec: CallRecord, req: AgentRequest, ms: number): void {
    clearTimeout(rec.requestTimers.get(req.request_id));
    const t = setTimeout(() => {
      if (req.status !== "answered" && !TERMINAL.has(rec.status)) {
        rec.session?.deliver({
          note:
            `Still no answer for "${req.request}". Tell the user it's taking longer than expected and offer to call ` +
            "them back when it's done. Don't make up an answer.",
          after: `(Already told the user "${req.request}" is taking longer than expected.)`,
        });
      }
    }, ms);
    t.unref();
    rec.requestTimers.set(req.request_id, t);
  }

  async sendSms(body: string): Promise<string> {
    if (!this.tel) throw new CallError("Texting is turned off (no phone provider is set up).");
    const { sid } = await this.tel.sendSms({
      to: this.cfg.userPhoneNumber,
      from: this.fromNumber(),
      body,
    });
    return sid;
  }

  get(id: string): CallRecord {
    const rec = this.calls.get(id);
    if (!rec) throw new CallError(`Unknown call_id ${id}`);
    return rec;
  }

  /** Calls that haven't ended yet. */
  activeCount(): number {
    return [...this.calls.values()].filter((c) => !TERMINAL.has(c.status)).length;
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
      mode: rec.mode,
      outcome: rec.outcome,
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
    this.armMaxDuration(rec);
    if (rec.mode === "realtime") return this.relayTwiml(rec);
    return this.serveNextOrHold(rec);
  }

  /** <Connect><ConversationRelay>: Twilio streams speech to us over a WebSocket and speaks our streamed text. */
  private relayTwiml(rec: CallRecord): string {
    rec.next = null; // the opening is spoken as the relay's welcome greeting
    const vr = new VoiceResponse();
    const connect = vr.connect({ action: this.url("relay-done", rec), method: "POST" });
    const r = this.cfg.relay;
    const relay = connect.conversationRelay({
      url: relayUrl(this.cfg, rec.id),
      welcomeGreeting: rec.opening,
      welcomeGreetingInterruptible: "any",
      interruptible: "any",
      language: this.cfg.language,
      ...(r.ttsProvider ? { ttsProvider: r.ttsProvider } : {}),
      ...(r.voice ? { voice: r.voice } : {}),
      ...(r.transcriptionProvider ? { transcriptionProvider: r.transcriptionProvider } : {}),
      ...(r.speechModel ? { speechModel: r.speechModel } : {}),
    });
    relay.parameter({ name: "cid", value: rec.id });
    relay.parameter({ name: "secret", value: rec.relaySecret });
    return vr.toString();
  }

  /** The relay WebSocket connected and sent its "setup" message. */
  attachRelay(ws: WebSocket, setup: Record<string, unknown>, query: URLSearchParams): boolean {
    // Twilio and Telnyx name these fields slightly differently.
    const params = (setup.customParameters ?? setup.custom_parameters ?? {}) as Record<string, string>;
    const callId = setup.callSid ?? setup.call_control_id ?? setup.callControlId;
    const rec = this.calls.get(params.cid ?? query.get("cid") ?? "");
    if (!rec || rec.mode !== "realtime" || TERMINAL.has(rec.status) || rec.session) return false;
    // Only the provider knows the per-call secret (it came over a signed webhook/API call) or the call id.
    const ok = params.secret ? params.secret === rec.relaySecret : Boolean(rec.sid) && callId === rec.sid;
    if (!ok) return false;

    const llm = this.llm!;
    const system = buildSystemPrompt({
      memory: this.memory?.list().map((n) => n.text),
      model: this.cfg.anthropic.apiKey ? this.cfg.anthropic.model : `${this.cfg.groq.model} on Groq`,
      callerName: rec.callerName,
      userName: this.cfg.userName,
      opening: rec.opening,
      reason: rec.reason,
      briefing: rec.briefing,
      goal: rec.goal,
      timezone: this.cfg.timezone,
      now: new Date(this.now()),
    });
    const session = new RealtimeSession(ws, llm, system, rec.opening, {
      onUser: (text) => {
        rec.transcript.push(this.turn("user", text));
        this.notify(rec);
      },
      onAgent: (text) => {
        rec.transcript.push(this.turn("agent", text));
        this.notify(rec);
      },
      onAskAgent: (request): DeliveredNote | null => {
        // Don't bother the agent twice for the same thing.
        const wantsFresh = /\b(again|latest|update|newer|more|recheck|refresh|other)\b/i.test(request);
        const same = wantsFresh ? undefined : rec.agentRequests.find((r) => similarRequests(r.request, request));
        if (same?.status === "answered" && same.answer) {
          rec.transcript.push(this.turn("system", `Reused earlier answer for: ${request}`));
          return answerNote(same.request, same.answer);
        }
        if (same) {
          return {
            note:
              `STATUS ONLY, NO ANSWER YET: "${same.request}" is still being worked on. Tell the user briefly that ` +
              "you're still on it. Don't guess the answer.",
            after: `(Already told the user you're still working on "${same.request}".)`,
          };
        }
        const req: AgentRequest = {
          request_id: `req_${rec.agentRequests.length + 1}`,
          request,
          asked_at: new Date(this.now()).toISOString(),
          status: "pending",
        };
        rec.agentRequests.push(req);
        rec.transcript.push(this.turn("system", `Asked agent: ${request}`));
        log.info(`call ${rec.id}: request for agent: ${request}`);
        this.notify(rec);
        // If the agent doesn't answer (or estimate) in time, the voice model says so instead of leaving silence.
        this.armRequestTimer(rec, req, this.cfg.agentAnswerTimeoutSeconds * 1000);
        return null;
      },
      onRemember: (fact) => {
        this.memory?.add(fact, "voice");
        rec.transcript.push(this.turn("system", `Remembered: ${fact}`));
        log.info(`call ${rec.id}: remembered "${fact}"`);
      },
      onEnded: () => {
        // Telnyx keeps the line open after the relay ends, so hang up once the goodbye has been spoken.
        if (this.tel?.provider === "telnyx" && rec.sid) {
          const sid = rec.sid;
          setTimeout(() => void this.hangupSid(sid), 1500).unref();
        }
      },
      onNote: (text) => {
        rec.transcript.push(this.turn("system", text));
      },
      onInterrupted: (heard) => {
        rec.transcript.push(this.turn("system", `User interrupted after: "${heard}"`));
      },
      onWrapUp: () => {
        // Safety net: if Twilio doesn't end the call after the goodbye, hang up ourselves.
        setTimeout(() => {
          if (!TERMINAL.has(rec.status) && rec.sid && rec.session?.isEnding) {
            void this.hangupSid(rec.sid);
          }
        }, 20_000).unref();
      },
    });
    ws.on("message", (data) => {
      try {
        session.handle(JSON.parse(String(data)));
      } catch (e) {
        log.warn(`bad relay message: ${(e as Error).message}`);
      }
    });
    rec.session = session;
    log.info(`call ${rec.id} real-time voice connected`);
    return true;
  }

  /** <Connect action>: the relay session ended (normally, or because it failed to start). */
  onRelayDone(id: string, params: Record<string, string>): string {
    const rec = this.calls.get(id);
    if (!rec || TERMINAL.has(rec.status)) return hangupTwiml();
    if (!rec.session) {
      // ConversationRelay never connected (e.g. not enabled on the Twilio account). Fall back to turn-by-turn.
      log.warn(
        `call ${rec.id}: real-time voice didn't start (${params.SessionStatus ?? "?"} ${params.ErrorCode ?? ""}); ` +
          "falling back to turn-by-turn",
      );
      rec.transcript.push(this.turn("system", "Real-time voice failed to start; switched to turn-by-turn."));
      rec.mode = "turn_by_turn";
      this.notify(rec);
      return this.gatherTwiml(rec, rec.opening);
    }
    return hangupTwiml();
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
      if (rec.next) return this.serve(rec);
      return this.ackThenHold(rec);
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
      speechTimeout: this.cfg.speechEndTimeout,
      timeout: this.cfg.speechTimeoutSeconds,
      actionOnEmptyResult: true,
      language: this.cfg.language as never,
      speechModel: this.cfg.speechModel as never,
      ...(this.cfg.speechModel === "phone_call" ? { enhanced: true } : {}),
    });
    // <Say> nested inside <Gather> lets the user interrupt (barge in).
    g.say(this.sayAttrs(), text);
    return vr.toString();
  }

  /** A short "Mm-hm." while the agent thinks, so the gap doesn't sound like dead air. */
  private ackThenHold(rec: CallRecord): string {
    const phrases = this.cfg.ackPhrases;
    if (phrases.length === 0) return this.holdTwiml(rec);
    let pick = phrases[Math.floor(Math.random() * phrases.length)];
    if (phrases.length > 1 && pick === rec.lastAck) pick = phrases[(phrases.indexOf(pick) + 1) % phrases.length];
    rec.lastAck = pick;
    rec.holdingSince ??= this.now();
    const vr = new VoiceResponse();
    vr.say(this.sayAttrs(), pick);
    vr.redirect({ method: "POST" }, this.url("hold", rec));
    return vr.toString();
  }

  private holdTwiml(rec: CallRecord): string {
    rec.holdingSince ??= this.now();
    const vr = new VoiceResponse();
    // No <Pause>: /hold long-polls, so the agent's reply is spoken the moment it arrives.
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

  /** Hang up calls that run past MAX_CALL_SECONDS (enforced here instead of Twilio's TimeLimit). */
  private armMaxDuration(rec: CallRecord) {
    const timer = setTimeout(() => {
      if (TERMINAL.has(rec.status)) return;
      log.warn(`call ${rec.id} hit MAX_CALL_SECONDS (${this.cfg.maxCallSeconds}s); hanging up`);
      rec.transcript.push(this.turn("system", "Maximum call length reached; hung up."));
      if (rec.sid) void this.hangupSid(rec.sid);
      this.setStatus(rec, "completed");
    }, this.cfg.maxCallSeconds * 1000);
    timer.unref();
  }

  private async summarizeCall(rec: CallRecord): Promise<void> {
    if (!rec.transcript.some((t) => t.role === "user")) return;
    rec.summarizing = true;
    try {
      const raw = await Promise.race([
        this.llm!.complete(
          buildSummaryPrompt(
            rec.transcript,
            rec.goal,
            new Date(this.now()).toLocaleDateString("en-US", { timeZone: this.cfg.timezone, dateStyle: "full" }),
          ),
        ),
        new Promise<string>((_, rej) => setTimeout(() => rej(new Error("timed out")), 12_000).unref()),
      ]);
      rec.outcome = parseSummary(raw);
    } catch (e) {
      log.warn(`call summary failed: ${(e as Error).message}`);
    } finally {
      this.trackPromisedCallback(rec);
      rec.summarizing = false;
      this.notify(rec);
    }
  }

  /**
   * The user asked to be called back but nothing is left open (the agent had already replied "I'll do it after
   * the call"): open a request for it, so answering it rings them back automatically.
   */
  private trackPromisedCallback(rec: CallRecord): void {
    const asked = rec.transcript.some((t) => t.role === "user" && /\bcall (me )?back\b/i.test(t.text));
    if (!asked || rec.agentRequests.some((r) => r.status !== "answered")) return;
    const what = rec.outcome?.follow_ups.length
      ? rec.outcome.follow_ups.join("; ")
      : rec.outcome?.summary || "the task they asked for during the call";
    rec.agentRequests.push({
      request_id: "req_callback",
      request: `Finish this and call them back with the result: ${what}`,
      asked_at: new Date(this.now()).toISOString(),
      status: "delivered",
    });
    rec.transcript.push(this.turn("system", "User asked for a call back; opened req_callback."));
  }

  private setStatus(rec: CallRecord, status: CallStatus) {
    if (rec.status === status) return;
    rec.status = status;
    if (TERMINAL.has(status)) rec.endedAt ??= this.now();
    log.info(`call ${rec.id} -> ${status}`);
    if (TERMINAL.has(status) && rec.mode === "realtime" && rec.session && !rec.outcome) void this.summarizeCall(rec);
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
