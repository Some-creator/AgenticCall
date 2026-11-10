import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import Groq from "groq-sdk";
import { WebSocketServer, type WebSocket } from "ws";
import type { Config } from "./config.js";
import { log } from "./log.js";

// ---------------------------------------------------------------- voice model

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export type LLMEvent = { type: "text"; text: string } | { type: "tool_call"; call: ToolCall };

/** The fast model that holds the live conversation. A seam so tests can run without network access. */
export interface VoiceLLM {
  stream(messages: ChatMessage[], signal: AbortSignal): AsyncIterable<LLMEvent>;
  complete(messages: ChatMessage[]): Promise<string>;
}

export const ASK_AGENT_TOOL = "ask_agent";

const VOICE_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: ASK_AGENT_TOOL,
      description:
        "Hand a question or command to your back office, which has the user's email, calendar, files, accounts and " +
        "the ability to take actions. Use it for anything not in your briefing, and for anything the user asks you to do.",
      parameters: {
        type: "object",
        properties: {
          request: {
            type: "string",
            description: "The user's question or instruction, restated clearly and completely with all details they gave.",
          },
        },
        required: ["request"],
      },
    },
  },
];

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
        {
          model,
          messages: messages as never,
          stream: true,
          max_completion_tokens: 400,
          tools: VOICE_TOOLS,
          tool_choice: "auto",
          parallel_tool_calls: false,
          ...reasoning,
        },
        { signal },
      );
      const calls = new Map<number, ToolCall>();
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (delta?.content) yield { type: "text", text: delta.content };
        for (const tc of delta?.tool_calls ?? []) {
          const cur = calls.get(tc.index) ?? { id: "", type: "function" as const, function: { name: "", arguments: "" } };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.function.name += tc.function.name;
          if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
          calls.set(tc.index, cur);
        }
      }
      for (const call of calls.values()) yield { type: "tool_call", call };
    },
    async complete(messages) {
      const res = await client.chat.completions.create({
        model,
        messages: messages as never,
        max_completion_tokens: 800,
        ...reasoning,
      });
      return res.choices[0]?.message?.content ?? "";
    },
  };
}

// ---------------------------------------------------------------- one live call

export const END_MARKER = "[END_CALL]";

const FILLERS = ["One sec, let me check.", "Sure, one moment.", "Okay, checking now.", "Give me a second."];

export interface SessionHooks {
  onUser(text: string): void;
  onAgent(text: string): void;
  onInterrupted(heard: string): void;
  /** The voice model needs the calling agent: a question or command it can't handle itself. */
  onAskAgent(request: string): void;
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
 * reply, Twilio sends "interrupt" and we stop generating. When the caller needs something only the
 * calling agent can do, the model calls ask_agent; the agent's answer comes back via deliver().
 */
export class RealtimeSession {
  private history: ChatMessage[];
  private inflight: AbortController | null = null;
  private respondAgain = false;
  private ending = false;
  private endTimer: NodeJS.Timeout | null = null;
  private fillerIdx = 0;
  private closed = false;

  /** True while a goodbye is being spoken and the session is about to close. */
  get isEnding(): boolean {
    return this.ending;
  }

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
        if (last?.role === "assistant" && !last.tool_calls) last.content = heard ? `${heard}…` : "…";
        // Talking over the goodbye means they're not done: keep the call open.
        if (this.ending && this.endTimer) {
          clearTimeout(this.endTimer);
          this.endTimer = null;
          this.ending = false;
        }
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

  /** Speak text from the calling agent verbatim, outside the model's own turns. */
  inject(text: string): void {
    this.inflight?.abort();
    this.history.push({ role: "assistant", content: text });
    this.send({ type: "text", token: text, last: true });
    this.hooks.onAgent(text);
  }

  /** Hand the model new information (e.g. the agent's answer) and let it tell the caller. */
  deliver(note: string): void {
    if (this.ending || this.closed) return;
    this.history.push({ role: "system", content: note });
    if (this.inflight) this.respondAgain = true;
    else void this.respond();
  }

  /** Say an optional goodbye, then end the session once it has been spoken. */
  finish(goodbye?: string): void {
    if (this.ending) return;
    if (goodbye) this.inject(goodbye);
    this.wrapUp(goodbye ?? "");
  }

  private async respond(): Promise<void> {
    this.inflight?.abort();
    this.respondAgain = false;
    const ctrl = new AbortController();
    this.inflight = ctrl;
    const entry: { role: "assistant"; content: string; tool_calls?: ToolCall[] } = { role: "assistant", content: "" };
    this.history.push(entry);
    const filter = new MarkerFilter(END_MARKER);
    let spoken = "";
    let turnClosed = false; // sent last:true already
    const toolCalls: ToolCall[] = [];
    const speak = (text: string) => {
      if (!text || turnClosed) return;
      spoken += text;
      entry.content = spoken;
      this.send({ type: "text", token: text, last: false });
    };
    const closeTurn = () => {
      if (turnClosed) return;
      turnClosed = true;
      this.send({ type: "text", token: "", last: true });
    };
    try {
      for await (const ev of this.llm.stream(this.history.slice(0, -1), ctrl.signal)) {
        if (ctrl.signal.aborted) break;
        if (ev.type === "tool_call") {
          toolCalls.push(ev.call);
          continue;
        }
        if (turnClosed) continue; // drain the rest only to pick up tool calls
        const out = filter.push(ev.text);
        // A question hands the turn to the caller: stop speaking there so the model can't answer for them.
        const q = out.indexOf("?");
        if (q >= 0) {
          speak(out.slice(0, q + 1));
          closeTurn();
        } else {
          speak(out);
        }
      }
      if (ctrl.signal.aborted) {
        if (!spoken) this.removeEntry(entry);
        return;
      }
      if (!turnClosed) speak(filter.flush());

      const ask = toolCalls.find((c) => c.function.name === ASK_AGENT_TOOL);
      if (ask) {
        if (!spoken.trim()) speak(FILLERS[this.fillerIdx++ % FILLERS.length]);
        closeTurn();
        ask.id ||= `call_${Date.now()}`;
        entry.tool_calls = [ask];
        let request = "";
        try {
          request = String(JSON.parse(ask.function.arguments || "{}").request ?? "");
        } catch {
          request = ask.function.arguments;
        }
        this.history.push({
          role: "tool",
          tool_call_id: ask.id,
          content:
            "Sent. The answer will arrive in a later system message. Until then keep chatting naturally if the user " +
            "talks to you, but never guess or make up the answer.",
        });
        if (spoken.trim()) this.hooks.onAgent(spoken.trim());
        if (request.trim()) this.hooks.onAskAgent(request.trim());
        return;
      }

      closeTurn();
      if (spoken.trim()) this.hooks.onAgent(spoken.trim());
      else this.removeEntry(entry);
      if (filter.found && spoken.trim() && !spoken.includes("?")) this.wrapUp(spoken);
    } catch (err) {
      if (ctrl.signal.aborted) return;
      log.error(`voice model failed: ${(err as Error).message}`);
      const sorry = "Sorry, I'm having trouble on my end. I'll follow up by text.";
      turnClosed = false;
      speak(` ${sorry}`);
      closeTurn();
      this.hooks.onAgent(sorry);
      this.wrapUp(sorry);
    } finally {
      if (this.inflight === ctrl) {
        this.inflight = null;
        if (this.respondAgain && !this.ending) void this.respond();
      }
    }
  }

  private removeEntry(entry: ChatMessage): void {
    const i = this.history.lastIndexOf(entry);
    if (i >= 0) this.history.splice(i, 1);
  }

  private wrapUp(lastSpoken: string): void {
    if (this.ending) return;
    this.ending = true;
    this.hooks.onWrapUp();
    this.endTimer = setTimeout(() => {
      this.endTimer = null;
      this.send({ type: "end", handoffData: JSON.stringify({ reason: "conversation_complete" }) });
    }, speechMs(lastSpoken));
    this.endTimer.unref();
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
    `- Write ONLY your own words for this one turn. Never write what ${o.userName} says, never continue the conversation for them, and never assume their answer.`,
    "- If you ask a question, make it the last thing you say, then stop and wait for their reply.",
    "- Speech-to-text can mishear. If something sounds odd, briefly check what they meant.",
    "- You have a back office (the ask_agent tool) with their email, calendar, files and accounts, which can also take actions.",
    "  Whenever they ask something not covered by what you know, or ask you to do anything (send, schedule, look up, change,",
    "  remind), call ask_agent right away with their full request. Say a short natural line first, like \"One sec, let me check.\"",
    "- To them you are one assistant. Never mention a back office, another agent, or passing things along.",
    "- While waiting for an answer, keep chatting normally if they talk. Never guess or invent an answer.",
    "- When an answer arrives (as a system message), tell them right away in a sentence or two, then ask if they need anything else.",
    "- Only state facts from what you know or from those answers.",
    "- Before ending, confirm any decision or request back to them in one sentence.",
    `- Never end the call on your own initiative. If ${o.userName} sounds finished but hasn't said goodbye, ask something like "Anything else before I let you go?" and wait.`,
    `- Only after they say goodbye, or clearly say there's nothing else, reply with a short goodbye (no question) and put ${END_MARKER} at the very end.`,
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
