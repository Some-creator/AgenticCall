import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import Groq from "groq-sdk";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "./config.js";
import { log } from "./log.js";

// ---------------------------------------------------------------- voice model

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** The fast model that holds the live conversation. A seam so tests can run without network access. */
export interface VoiceLLM {
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<string>;
  complete(messages: ChatMessage[]): Promise<string>;
}

export function groqLLM(apiKey: string, model: string): VoiceLLM {
  const client = new Groq({ apiKey, maxRetries: 1 });
  // Reasoning models think before speaking; keep that minimal so the first word comes fast.
  const reasoning = model.startsWith("openai/gpt-oss")
    ? { reasoning_effort: "low" as const, include_reasoning: false }
    : model.startsWith("qwen/")
      ? { reasoning_effort: "none" as const }
      : {};
  return {
    async *stream(messages, signal) {
      const stream = await client.chat.completions.create(
        { model, messages, stream: true, max_completion_tokens: 400, ...reasoning },
        { signal },
      );
      for await (const chunk of stream) {
        const token = chunk.choices[0]?.delta?.content;
        if (token) yield token;
      }
    },
    async complete(messages) {
      const res = await client.chat.completions.create({
        model,
        messages,
        max_completion_tokens: 800,
        ...reasoning,
      });
      return res.choices[0]?.message?.content ?? "";
    },
  };
}

// ---------------------------------------------------------------- one live call

export const END_MARKER = "[END_CALL]";

export interface SessionHooks {
  onUser(text: string): void;
  onAgent(text: string): void;
  onInterrupted(heard: string): void;
  /** The model said goodbye; the session will close shortly. */
  onWrapUp(): void;
}

/** Rough time for TTS to finish speaking `text`, so we don't cut off the goodbye. */
export function speechMs(text: string): number {
  return Math.min(15_000, 1_200 + (text.length / 15) * 1000);
}

/**
 * Drives one ConversationRelay WebSocket: Twilio sends transcribed speech ("prompt"), we stream the
 * model's reply back token by token ("text"), and Twilio speaks it. If the caller talks over the
 * reply, Twilio sends "interrupt" and we stop generating.
 */
export class RealtimeSession {
  private history: ChatMessage[];
  private inflight: AbortController | null = null;
  private ending = false;
  private closed = false;

  constructor(
    private ws: WebSocket,
    private llm: VoiceLLM,
    systemPrompt: string,
    opening: string,
    private hooks: SessionHooks,
  ) {
    this.history = [
      { role: "system", content: systemPrompt },
      { role: "assistant", content: opening },
    ];
    ws.on("close", () => {
      this.closed = true;
      this.inflight?.abort();
    });
  }

  handle(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "prompt": {
        if (msg.last === false) return; // only act on the final transcript of a turn
        const text = String(msg.voicePrompt ?? "").trim();
        if (!text || this.ending) return;
        this.hooks.onUser(text);
        this.history.push({ role: "user", content: text });
        void this.respond();
        return;
      }
      case "interrupt": {
        this.inflight?.abort();
        const heard = String(msg.utteranceUntilInterrupt ?? "");
        const last = this.history.at(-1);
        // Keep only what the caller actually heard, so the model doesn't think it said more.
        if (last?.role === "assistant") last.content = heard ? `${heard}…` : "…";
        this.hooks.onInterrupted(heard);
        return;
      }
      case "error":
        log.warn(`ConversationRelay error: ${String(msg.description ?? JSON.stringify(msg))}`);
        return;
      default:
        return; // dtmf, info, etc.
    }
  }

  /** Speak text from the calling agent, outside the model's own turns. */
  inject(text: string): void {
    this.inflight?.abort();
    this.history.push({ role: "assistant", content: text });
    this.send({ type: "text", token: text, last: true });
    this.hooks.onAgent(text);
  }

  /** Say an optional goodbye, then end the session once it has been spoken. */
  finish(goodbye?: string): void {
    if (this.ending) return;
    if (goodbye) this.inject(goodbye);
    this.wrapUp(goodbye ?? "");
  }

  private async respond(): Promise<void> {
    this.inflight?.abort();
    const ctrl = new AbortController();
    this.inflight = ctrl;
    const entry: ChatMessage = { role: "assistant", content: "" };
    const filter = new MarkerFilter(END_MARKER);
    let spoken = "";
    try {
      for await (const token of this.llm.stream(this.history, ctrl.signal)) {
        if (ctrl.signal.aborted) return;
        const out = filter.push(token);
        if (out) {
          if (!spoken) this.history.push(entry);
          spoken += out;
          entry.content = spoken;
          this.send({ type: "text", token: out, last: false });
        }
      }
      if (ctrl.signal.aborted) return;
      const tail = filter.flush();
      if (tail) {
        if (!spoken) this.history.push(entry);
        spoken += tail;
        entry.content = spoken;
      }
      this.send({ type: "text", token: tail, last: true });
      if (spoken.trim()) this.hooks.onAgent(spoken.trim());
      if (filter.found) this.wrapUp(spoken);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      log.error(`voice model failed: ${(err as Error).message}`);
      const sorry = "Sorry, I'm having trouble on my end. I'll follow up by text.";
      this.send({ type: "text", token: sorry, last: true });
      this.hooks.onAgent(sorry);
      this.wrapUp(sorry);
    } finally {
      if (this.inflight === ctrl) this.inflight = null;
    }
  }

  private wrapUp(lastSpoken: string): void {
    if (this.ending) return;
    this.ending = true;
    this.hooks.onWrapUp();
    setTimeout(() => {
      this.send({ type: "end", handoffData: JSON.stringify({ reason: "conversation_complete" }) });
    }, speechMs(lastSpoken)).unref();
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.closed && this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(msg));
  }
}

/** Strips an end-of-call marker from a token stream, holding back text that might be its start. */
export class MarkerFilter {
  private buf = "";
  found = false;
  constructor(private marker: string) {}

  push(token: string): string {
    if (this.found) return "";
    this.buf += token;
    const idx = this.buf.indexOf(this.marker);
    if (idx >= 0) {
      this.found = true;
      const out = this.buf.slice(0, idx);
      this.buf = "";
      return out;
    }
    // Hold back the longest suffix that is a prefix of the marker.
    for (let k = Math.min(this.marker.length - 1, this.buf.length); k > 0; k--) {
      if (this.marker.startsWith(this.buf.slice(-k))) {
        const out = this.buf.slice(0, -k);
        this.buf = this.buf.slice(-k);
        return out;
      }
    }
    const out = this.buf;
    this.buf = "";
    return out;
  }

  flush(): string {
    const out = this.found ? "" : this.buf;
    this.buf = "";
    return out;
  }
}

// ---------------------------------------------------------------- prompt

export function buildSystemPrompt(o: {
  callerName: string;
  userName: string;
  opening: string;
  reason?: string;
  briefing?: string;
  goal?: string;
  timezone: string;
  now: Date;
}): string {
  const time = o.now.toLocaleString("en-US", { timeZone: o.timezone, dateStyle: "full", timeStyle: "short" });
  return [
    `You are ${o.callerName}, an AI assistant, on a live phone call with ${o.userName}.`,
    `You called them on behalf of their AI agent. You already opened the call by saying: "${o.opening}"`,
    o.reason ? `Why you're calling: ${o.reason}` : "",
    o.briefing ? `What you know (share what's relevant, don't read it out verbatim):\n${o.briefing}` : "",
    o.goal ? `What this call needs to achieve: ${o.goal}` : "",
    `It is currently ${time} for them.`,
    "",
    "How to talk:",
    "- This is a voice call. Everything you write is spoken aloud. Talk like a friendly, efficient person on the phone.",
    "- Keep each turn to one or two short sentences. Use contractions. Never use lists, markdown, emoji, URLs or symbols.",
    "- Speech-to-text can mishear. If something sounds odd, briefly check what they meant.",
    "- Only state facts from the briefing. If asked something you don't know, say you'll pass it on and follow up; never make things up.",
    "- You can't take actions during the call. Note what they want done; their agent will do it after you hang up.",
    "- Before ending, confirm any decision or request back to them in one sentence.",
    `- When the conversation is finished and you've said goodbye, put ${END_MARKER} at the very end of that last reply.`,
    `- If they ask to hang up or say goodbye, say a short goodbye and end with ${END_MARKER}.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildSummaryPrompt(transcript: { role: string; text: string }[], goal?: string): ChatMessage[] {
  const lines = transcript.map((t) => `${t.role === "user" ? "USER" : t.role === "agent" ? "ASSISTANT" : "NOTE"}: ${t.text}`);
  return [
    {
      role: "system",
      content:
        "You summarize phone calls between an AI assistant and its user for the AI agent that requested the call. " +
        'Reply with only a JSON object: {"summary": string, "user_decisions": string[], "follow_ups": string[]}. ' +
        "user_decisions: what the user decided, approved or declined. follow_ups: things the user asked the agent to do " +
        "or questions left unanswered. Be specific and faithful to the transcript; use [] when there are none.",
    },
    { role: "user", content: `${goal ? `Goal of the call: ${goal}\n\n` : ""}Transcript:\n${lines.join("\n")}` },
  ];
}

export function parseSummary(raw: string): { summary: string; user_decisions: string[]; follow_ups: string[] } {
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const o = JSON.parse(match[0]);
      const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
      return { summary: String(o.summary ?? ""), user_decisions: arr(o.user_decisions), follow_ups: arr(o.follow_ups) };
    } catch {
      /* fall through */
    }
  }
  return { summary: raw.trim(), user_decisions: [], follow_ups: [] };
}

// ---------------------------------------------------------------- WebSocket server

export const RELAY_PATH = "/twilio/relay";

export interface RelayHandler {
  /** Return true if the socket was accepted for a call. */
  attachRelay(ws: WebSocket, setup: Record<string, unknown>, query: URLSearchParams): boolean;
}

/** Accepts ConversationRelay WebSocket connections on RELAY_PATH. */
export function attachRelayServer(server: Server, handler: RelayHandler): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== RELAY_PATH) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let accepted = false;
      ws.on("message", (data) => {
        if (accepted) return; // after setup, the session owns the socket's messages
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (msg.type !== "setup") return;
        accepted = handler.attachRelay(ws, msg, url.searchParams);
        if (!accepted) {
          log.warn("rejected ConversationRelay connection: unknown call or bad secret");
          ws.close(1008, "unauthorized");
        }
      });
      setTimeout(() => {
        if (!accepted && ws.readyState === ws.OPEN) ws.close(1008, "no setup");
      }, 10_000).unref();
    });
  });
  return wss;
}

export function relayUrl(cfg: Config, cid: string): string {
  return `${cfg.publicBaseUrl.replace(/^http/, "ws")}${RELAY_PATH}?cid=${encodeURIComponent(cid)}`;
}
