import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import Groq, { BadRequestError, InternalServerError, RateLimitError } from "groq-sdk";
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
  /** With tools=false the model must answer in words (used right after it was handed new information). */
  stream(messages: ChatMessage[], signal: AbortSignal, opts?: { tools?: boolean }): AsyncIterable<LLMEvent>;
  complete(messages: ChatMessage[]): Promise<string>;
}

export const ASK_AGENT_TOOL = "ask_agent";

const VOICE_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: ASK_AGENT_TOOL,
      description:
        "Look something up or get something done for the user: their email, calendar, files, accounts, the web, " +
        "and actions. Use it for ANY fact, name, price, recommendation or current info not already in " +
        "this conversation, and for anything the user asks you to do. Never answer those from memory.",
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

/** Keep the system prompt plus the recent conversation, so long calls stay fast and under rate limits. */
export function windowHistory(messages: ChatMessage[], max = 12, step = 1): ChatMessage[] {
  let out = messages;
  if (messages.length > max + 1) {
    const rest = messages.slice(1);
    // With step > 1 the window jumps forward in blocks instead of one message per turn, so the start of the
    // request stays identical between jumps and prompt caching keeps working.
    let start = Math.ceil((rest.length - max) / step) * step;
    // Start at a user turn so a tool result is never separated from its tool call.
    while (start < rest.length && rest[start].role !== "user") start++;
    // Everything the caller said before the window is kept (their own lines are short), so the model still knows
    // what they liked, ruled out or decided earlier in the call.
    const earlier = rest
      .slice(0, start)
      .filter((m) => m.role === "user" && !m.content.startsWith("[Result of your lookup"))
      .map((m) => `- ${m.content}`)
      .join("\n");
    const memory = earlier ? `\n\nEarlier in this call they said (oldest first):\n${earlier.slice(-2500)}` : "";
    out = [{ role: "system", content: messages[0].content + memory }, ...rest.slice(start)];
  }
  // Older long chat turns are clipped to save tokens; lookup results are never clipped (losing their details made
  // the voice think it had invented things), and the latest few messages stay whole.
  const keepWhole = out.length - 6;
  return out.map((m, i) =>
    i > 0 && i < keepWhole && m.content.length > 900 && !m.content.startsWith("[Result of your lookup")
      ? { ...m, content: `${m.content.slice(0, 900)}…` }
      : m,
  );
}

/**
 * The same conversation without tool-call details: assistant turns that called a tool become plain text and tool
 * results are dropped. Used when the provider rejects the full history, so the call can carry on.
 */
export function plainHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .filter((m) => m.role !== "tool")
    .map((m) => (m.role === "assistant" ? { role: "assistant" as const, content: m.content || "…" } : m));
}

/** Every model was rate-limited; retry after this long. */
export class RateLimitedError extends Error {
  constructor(public retryAfterMs: number) {
    super(`all voice models are rate-limited; retry in ${Math.round(retryAfterMs / 1000)}s`);
  }
}

/**
 * Groq client that rotates across models: each model has its own free-tier rate limit, so when one is
 * limited the next is tried straight away, and a limited model is skipped until its retry-after passes.
 * `fallbackModels` is a comma-separated list.
 */
export function groqLLM(apiKey: string, model: string, fallbackModels?: string): VoiceLLM {
  // No automatic retries: on a rate limit, waiting out retry-after means dead air on the phone.
  const client = new Groq({ apiKey, maxRetries: 0, timeout: 20_000 });
  const models = [model, ...(fallbackModels ?? "").split(",").map((m) => m.trim())].filter(
    (m, i, all) => m && all.indexOf(m) === i,
  );
  const limitedUntil = new Map<string, number>();
  // Reasoning models think before speaking; keep that minimal so the first word comes fast.
  const reasoningFor = (m: string) =>
    m.startsWith("openai/gpt-oss")
      ? { reasoning_effort: "low" as const, include_reasoning: false }
      : m.startsWith("qwen/")
        ? { reasoning_effort: "none" as const, include_reasoning: false }
        : {};
  const retryAfterMs = (err: unknown): number => {
    const h = (err as { headers?: Headers | Record<string, string> }).headers;
    const raw = h instanceof Headers ? h.get("retry-after") : h?.["retry-after"];
    const secs = Number(raw);
    return Number.isFinite(secs) && secs > 0 ? secs * 1000 : 5000;
  };
  async function withFallback<T>(run: (m: string) => Promise<T>): Promise<T> {
    let lastErr: unknown;
    let soonest = Infinity;
    const now = Date.now();
    const available = models.filter((m) => (limitedUntil.get(m) ?? 0) <= now);
    for (const m of available.length ? available : models) {
      try {
        return await run(m);
      } catch (err) {
        lastErr = err;
        if (err instanceof RateLimitError) {
          const wait = retryAfterMs(err);
          limitedUntil.set(m, Date.now() + wait);
          soonest = Math.min(soonest, wait);
          log.warn(`Groq ${m} rate-limited (retry in ${Math.round(wait / 1000)}s)`);
          continue;
        }
        if (err instanceof InternalServerError) {
          log.warn(`Groq ${m} error (${(err as Error).message.slice(0, 120)}); trying the next model`);
          continue;
        }
        throw err;
      }
    }
    if (soonest !== Infinity) throw new RateLimitedError(soonest);
    throw lastErr;
  }
  return {
    async *stream(messages, signal, opts) {
      const t0 = Date.now();
      const open = (msgs: ChatMessage[], withTools: boolean) =>
        withFallback((m) =>
          client.chat.completions.create(
            {
              model: m,
              messages: msgs as never,
              stream: true,
              // Generous: reasoning models spend part of this on hidden thinking, and running out cuts the reply
              // mid-word. Spoken length is capped separately (MAX_TURN_CHARS).
              max_completion_tokens: 1500,
              ...(withTools
                ? { tools: VOICE_TOOLS, tool_choice: opts?.tools === false ? "none" : "auto", parallel_tool_calls: false }
                : {}),
              ...reasoningFor(m),
            },
            { signal },
          ),
        );
      // With tools off, offer none at all: some models call a tool anyway when tool_choice is "none", and the
      // provider then rejects the reply ("Tool choice is none, but model called a tool"), over and over.
      const toolsOff = opts?.tools === false;
      let stream;
      try {
        stream = toolsOff
          ? await open(plainHistory(windowHistory(messages)), false)
          : await open(windowHistory(messages), true);
      } catch (err) {
        if (!(err instanceof BadRequestError) || toolsOff) throw err;
        // The provider rejected this history outright (retrying it as-is would fail forever): carry on with a
        // plain-text version of the conversation instead.
        log.warn(`Groq rejected the request (${(err as Error).message.slice(0, 200)}); retrying with plain history`);
        stream = await open(plainHistory(windowHistory(messages)), true);
      }
      const calls = new Map<number, ToolCall>();
      let first = true;
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (first && (delta?.content || delta?.tool_calls)) {
          first = false;
          const ms = Date.now() - t0;
          if (ms > 2000) log.warn(`voice model slow to respond: ${ms}ms to first token`);
        }
        if (delta?.content) yield { type: "text", text: delta.content };
        if (chunk.choices[0]?.finish_reason === "length") log.warn("voice model hit its token limit; reply was cut short");
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
      const res = await withFallback((m) =>
        client.chat.completions.create({
          model: m,
          messages: messages as never,
          max_completion_tokens: 2000,
          ...reasoningFor(m),
        }),
      );
      return res.choices[0]?.message?.content ?? "";
    },
  };
}

// ---------------------------------------------------------------- one live call

export const END_MARKER = "[END_CALL]";

const FILLERS = ["Let me check.", "Give me a few seconds.", "Let me look that up.", "Hang on, checking now."];

const NOTE_PREFIX = "[Result of your lookup. The caller did NOT say this.]";

/**
 * After a "?" the model sometimes keeps going and answers for the caller ("Anything else? No, that's all.").
 * Decide from the text after the question: cut (it's a fake reply), continue (a rhetorical "Honestly? I think…"),
 * or wait for a few more characters.
 */
export function afterQuestion(rest: string, final = false): "cut" | "continue" | "wait" {
  const t = rest.replace(/^[\s"'”’)\]]+/, "");
  if (/^(yes|no|yeah|yep|nope|nah|sure|okay|ok|alright|that'?s|i'?m|we'?re|user|haider|me)\b/i.test(t)) return "cut";
  if (!final && t.length < 14 && !/[.!?,;]/.test(t)) return "wait";
  return "continue";
}

/** Does a reply sound like a goodbye? */
function soundsLikeGoodbye(text: string): boolean {
  return /\b(bye|goodbye|take care|talk (to you )?(soon|later)|see (you|ya)|have a good|ending the call|hanging up|catch you later)\b/i.test(text);
}

export interface SessionHooks {
  onUser(text: string): void;
  onAgent(text: string): void;
  onInterrupted(heard: string): void;
  /**
   * The voice model needs the calling agent: a question or command it can't handle itself.
   * May return a note to deliver right away instead (e.g. an answer already given earlier in the call).
   */
  onAskAgent(request: string): DeliveredNote | null;
  /** The model said goodbye; the session will close shortly. */
  onWrapUp(): void;
  /** Something worth keeping in the call log (e.g. a voice-model error). */
  onNote?(text: string): void;
}

/** Information handed to the voice model mid-call. `after` replaces it once it has been used ("" removes it). */
export interface DeliveredNote {
  note: string;
  after: string;
}

export function answerNote(request: string, answer: string): DeliveredNote {
  return {
    note:
      `Answer for the user's request "${request}": ${answer}\nShare it now, briefly and naturally (unless they asked ` +
      "you to wait). If it's a question for the user, ask it, and pass their reply on with ask_agent.",
    after:
      `Earlier answer for "${request}": ${answer} (Already given to the user. Don't repeat it unless they ask again, ` +
      "and don't look it up again.)",
  };
}

/** Strip things text-to-speech would read badly: markdown, bullets, line breaks. */
export function speakable(text: string): string {
  return text
    .replace(/<\/?think>/gi, "")
    .replace(/[*`#_~•]+/g, "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/([.!?])([A-Z])/g, "$1 $2");
}

/** "Okay." / "Alright." / "Hmm." — sounds that mean "go on" or "let me think", not a new request. */
export function isFiller(text: string): boolean {
  return /^(ok(ay)?|alright|all right|hmm+|mm+[- ]?hmm*|uh[- ]?huh|um+|uh+|so+|well|let'?s see)[.!,…\s]*$/i.test(text.trim());
}

/** Did the caller actually signal they're done? The model may only hang up if so. */
export function userSaidGoodbye(text: string): boolean {
  return /\b(bye|goodbye|good night|that'?s (all|it)|nothing else|i'?m (good|done|all set)|we'?re (good|done)|hang up|end the call|talk (to you )?later|see (you|ya)|gotta go|got to go|call (me )?back|no,? thanks?)\b/i.test(
    text,
  );
}

/** The caller explicitly asked to end the call. */
export function userAskedToEnd(text: string): boolean {
  return /\b(end the call|hang up|you can go( now)?|gotta go|got to go|bye|goodbye|let'?s end it|that'?s all for now)\b/i.test(text);
}

function parseRequest(args: string): string {
  try {
    return String(JSON.parse(args || "{}").request ?? "").trim();
  } catch {
    return args.trim();
  }
}

/** "No" / "not really" in reply to "anything else?" means the caller is done. */
export function declinedMore(lastAssistant: string, lastUser: string): boolean {
  const askedIfDone = /\b(anything else|are we good|before I let you go|need anything|that it for now|all set)\b/i.test(lastAssistant);
  const saidNo = /^\s*(no|nope|nah|not really|not right now|i think that'?s it|all good|we'?re good|i'?m good|nothing)\b/i.test(lastUser);
  return askedIfDone && saidNo;
}

function isOpenQuestion(text: string): boolean {
  return /\?\W*$/.test(text.trim()) && /\b(what|where|when|who|how|which|anything)\b/i.test(text);
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
  private toolSeq = 0;
  /** Notes delivered but not yet used in a reply. */
  private freshNotes: { entry: ChatMessage; after: string }[] = [];
  private fillerTimer: NodeJS.Timeout | null = null;
  /** When the current run of voice-model failures started (null when things are working). */
  private failingSince: number | null = null;
  private lastSorryAt = 0;
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
        if (this.fillerTimer) clearTimeout(this.fillerTimer);
        this.fillerTimer = null;
        this.hooks.onUser(text);
        this.history.push({ role: "user", content: text });
        // "Okay." after "What would you like to talk about?" means they're thinking: don't fire another question
        // at them. Answer only if they don't continue within a few seconds.
        const lastSaid = [...this.history].reverse().find((m) => m.role === "assistant")?.content ?? "";
        if (isFiller(text) && isOpenQuestion(lastSaid) && this.freshNotes.length === 0) {
          this.fillerTimer = setTimeout(() => {
            this.fillerTimer = null;
            void this.respond();
          }, 4000);
          this.fillerTimer.unref();
          return;
        }
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
  deliver(n: DeliveredNote): void {
    if (this.ending || this.closed) return;
    // Delivered as a clearly labelled user-role message: some models ignore system messages mid-conversation.
    const entry: ChatMessage = { role: "user", content: `${NOTE_PREFIX}\n${n.note}` };
    this.history.push(entry);
    this.freshNotes.push({ entry, after: n.after });
    if (this.inflight) this.respondAgain = true;
    else void this.respond();
  }

  /** Once a note has been acted on, stop it from prompting the model again (so "skip it" sticks). */
  private retireNotes(notes: { entry: ChatMessage; after: string }[]): void {
    for (const { entry, after } of notes) {
      if (after) entry.content = `${NOTE_PREFIX}\n${after}`;
      else this.removeEntry(entry);
    }
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
    const notes = this.freshNotes.splice(0);
    const ctrl = new AbortController();
    this.inflight = ctrl;
    const entry: { role: "assistant"; content: string; tool_calls?: ToolCall[] } = { role: "assistant", content: "" };
    this.history.push(entry);
    let filter = new MarkerFilter(END_MARKER);
    let brackets = new BracketFilter();
    let spoken = "";
    let turnClosed = false; // sent last:true already
    let toolCalls: ToolCall[] = [];
    const speak = (raw: string) => {
      let text = speakable(raw);
      if (!text || turnClosed) return;
      if (/[.!?]$/.test(spoken) && /^[A-Z]/.test(text)) text = ` ${text}`;
      spoken += text;
      entry.content = spoken;
      this.send({ type: "text", token: text, last: false });
    };
    // Text after a "?" is held back until we know it isn't the model answering for the caller.
    let held: string | null = null;
    const emit = (text: string): void => {
      if (turnClosed || !text) return;
      if (held !== null) {
        held += text;
        const d = afterQuestion(held);
        if (d === "wait") return;
        const rest = held;
        held = null;
        if (d === "cut") return closeTurn();
        return emit(rest);
      }
      // Phone turns stay short: past the limit, finish the current sentence and stop. Relaying a result with
      // several parts gets more room so later parts aren't dropped. "Perfume.com" is not a sentence end.
      if (spoken.length >= (notes.length > 0 ? MAX_RELAY_CHARS : MAX_TURN_CHARS)) {
        const end = text.search(/[.!?](?=\s)/);
        if (end >= 0) {
          speak(text.slice(0, end + 1));
          return closeTurn();
        }
      }
      const q = text.indexOf("?");
      if (q < 0) return speak(text);
      speak(text.slice(0, q + 1));
      held = "";
      emit(text.slice(q + 1));
    };
    const closeTurn = () => {
      if (turnClosed) return;
      turnClosed = true;
      this.send({ type: "text", token: "", last: true });
    };
    try {
      // The first sentence is held until it's complete: some models start a sentence ("Got") and then switch to
      // a broken tool call, which would leave the caller hearing a single word.
      let pre: string | null = "";
      const run = async (tools: boolean): Promise<boolean> => {
        filter = new MarkerFilter(END_MARKER);
        brackets = new BracketFilter();
        toolCalls = [];
        pre = "";
        for await (const ev of this.llm.stream(this.history.slice(0, -1), ctrl.signal, { tools })) {
          if (ctrl.signal.aborted) return false;
          if (ev.type === "tool_call") {
            toolCalls.push(ev.call);
            continue;
          }
          if (turnClosed) continue; // drain the rest only to pick up tool calls
          const text = speakable(brackets.push(filter.push(ev.text)));
          if (pre !== null) {
            pre += text;
            if (!/[.!?]/.test(pre) && pre.length < 60) continue;
            const first = pre;
            pre = null;
            emit(first);
          } else {
            emit(text);
          }
        }
        return !ctrl.signal.aborted;
      };
      // Right after being handed an answer or update, the model must say it, not go off and ask again.
      let ok = await run(notes.length === 0);
      const validAsk = () =>
        toolCalls.some((c) => c.function.name === ASK_AGENT_TOOL && parseRequest(c.function.arguments));
      if (ok && !spoken && toolCalls.length > 0 && !validAsk()) {
        log.warn(`voice model made an unusable tool call (${JSON.stringify(toolCalls).slice(0, 200)}); retrying without tools`);
        ok = await run(false);
      }
      if (!ok || ctrl.signal.aborted) {
        if (!spoken) {
          this.removeEntry(entry);
          this.freshNotes.unshift(...notes); // nothing was said: still to be shared
        } else {
          this.retireNotes(notes); // they heard some of it and talked over it
        }
        return;
      }
      this.retireNotes(notes);
      this.failingSince = null;
      const tail = speakable(brackets.push(filter.flush()) + brackets.flush());
      const unreleased: string = (pre ?? "") + tail;
      pre = null;
      // A fragment followed by a real hand-off ("Let me" + ask_agent) is replaced by a proper filler line.
      if (!(validAsk() && !spoken && !/[.!?]\s*$/.test(unreleased))) {
        if (!turnClosed) emit(unreleased);
      }
      if (held !== null && !turnClosed && afterQuestion(held, true) !== "cut") speak(held);
      held = null;

      const ask = toolCalls.find((c) => c.function.name === ASK_AGENT_TOOL);
      let request = "";
      if (ask) request = parseRequest(ask.function.arguments);
      if (ask && request) {
        if (!spoken.trim()) speak(FILLERS[this.fillerIdx++ % FILLERS.length]);
        closeTurn();
        // Always our own id: some models reuse ids, and duplicate ids make the provider reject the whole history.
        ask.id = `call_${++this.toolSeq}_${Date.now().toString(36)}`;
        entry.tool_calls = [ask];
        this.history.push({
          role: "tool",
          tool_call_id: ask.id,
          content:
            "Sent. The answer will arrive in a later system message. Until then keep chatting naturally if the user " +
            "talks to you, but never guess or make up the answer.",
        });
        if (spoken.trim()) this.hooks.onAgent(spoken.trim());
        const immediate = this.hooks.onAskAgent(request);
        if (immediate) this.deliver(immediate);
        return;
      }

      closeTurn();
      if (spoken.trim()) this.hooks.onAgent(spoken.trim());
      else this.removeEntry(entry);
      const lastUser =
        [...this.history].reverse().find((m) => m.role === "user" && !m.content.startsWith(NOTE_PREFIX))?.content ?? "";
      // The assistant line before this reply (what the caller was responding to).
      const prevAssistant =
        this.history
          .slice(0, this.history.lastIndexOf(entry))
          .reverse()
          .find((m) => m.role === "assistant" && m.content)?.content ?? "";
      const done = userSaidGoodbye(lastUser) || declinedMore(prevAssistant, lastUser);
      const askedToEnd = userAskedToEnd(lastUser);
      // Hang up when the caller asked to, or when they signalled they're done and the reply is a goodbye
      // (marker or not: some models never emit it). Never hang up on a question.
      if (!spoken.includes("?") && (askedToEnd || (done && spoken.trim() && (filter.found || soundsLikeGoodbye(spoken))))) {
        if (!spoken.trim()) {
          turnClosed = false;
          speak("Alright, talk soon!");
          closeTurn();
          this.hooks.onAgent("Alright, talk soon!");
        }
        this.wrapUp(spoken);
      } else if (filter.found) {
        log.warn(`ignored end-of-call from the voice model; caller hadn't said goodbye ("${lastUser}")`);
      }
    } catch (err) {
      if (ctrl.signal.aborted) return;
      const status = (err as { status?: number }).status;
      log.error(`voice model failed (${status ?? "no status"}): ${(err as Error).message.slice(0, 300)}`);
      this.hooks.onNote?.(`Voice model error (${status ?? "no status"}): ${(err as Error).message.slice(0, 300)}`);
      this.freshNotes.unshift(...notes); // nothing was relayed: keep them for the retry
      const now = Date.now();
      this.failingSince ??= now;
      const lastUser = [...this.history].reverse().find((m) => m.role === "user" && !m.content.startsWith(NOTE_PREFIX))?.content ?? "";
      if (now - this.failingSince < 45_000) {
        // Usually a rate limit: keep the call, say something once (not on every retry, and not in reply to a
        // bare "okay"), wait as long as the provider asks, and try again.
        const wait = Math.min(Math.max(err instanceof RateLimitedError ? err.retryAfterMs : 2500, 1500), 20_000);
        if (!spoken.trim() && now - this.lastSorryAt > 20_000 && !isFiller(lastUser)) {
          turnClosed = false;
          speak(wait > 4000 ? "Sorry, give me a few seconds." : "Sorry, one sec.");
          this.lastSorryAt = now;
        }
        closeTurn();
        if (spoken.trim()) this.hooks.onAgent(spoken.trim());
        else this.removeEntry(entry);
        setTimeout(() => {
          if (!this.inflight && !this.ending && !this.closed) void this.respond();
        }, wait).unref();
      } else {
        const sorry = "Sorry, I'm having trouble on my end right now. I'll text you instead.";
        turnClosed = false;
        speak(` ${sorry}`);
        closeTurn();
        this.hooks.onAgent(sorry);
        this.wrapUp(sorry);
      }
      return;
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

/** Drops bracketed stage directions like "[No response needed]" from a token stream. */
export class BracketFilter {
  private buf: string | null = null;
  push(token: string): string {
    let out = "";
    for (const ch of token) {
      if (this.buf !== null) {
        this.buf += ch;
        if (ch === "]") this.buf = null; // drop the whole bracketed note
        else if (this.buf.length > 120) {
          out += this.buf; // not a note after all
          this.buf = null;
        }
      } else if (ch === "[") {
        this.buf = "[";
      } else {
        out += ch;
      }
    }
    return out;
  }
  flush(): string {
    const out = this.buf ?? "";
    this.buf = null;
    return out;
  }
}

/** Longest a single spoken turn should get (about 20 seconds of speech); ends at the next sentence. */
export const MAX_TURN_CHARS = 320;
/** Relaying a lookup result (often several options) may run longer, about 45 seconds. */
export const MAX_RELAY_CHARS = 700;

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

/** Best effort: log which models the Groq key can use, to help pick GROQ_MODEL. */
export async function logGroqModels(apiKey: string): Promise<void> {
  try {
    const list = await new Groq({ apiKey, maxRetries: 0, timeout: 10_000 }).models.list();
    const ids = list.data.map((m) => m.id).sort();
    log.info(`Groq models available to your key: ${ids.join(", ")}`);
  } catch (e) {
    log.warn(`couldn't list Groq models: ${(e as Error).message}`);
  }
}

export function buildSystemPrompt(o: {
  model?: string;
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
  const u = o.userName;
  // Kept short on purpose: it's sent on every turn and counts against the provider's rate limits.
  return [
    `You're ${o.callerName}, ${u}'s AI assistant, on a live phone call with them. It's ${time} for them.`,
    `You opened with: "${o.opening}"`,
    o.reason ? `Why you called: ${o.reason}` : "",
    o.briefing ? `What you know:\n${o.briefing}` : "",
    o.goal ? `Goal of the call: ${o.goal}` : "",
    "",
    "Talk like a sharp, warm friend on the phone, not a chatbot. Everything you write is spoken aloud:",
    "- Two or three natural sentences per turn. React first (\"Oh nice.\", \"Got it.\"), use contractions, match their vibe.",
    "- Plain speech only: no lists, markdown, emoji, URLs, or notes in brackets. For steps or news, one or a few items at a time.",
    "- Never say \"Sure thing\", \"Absolutely\", \"Certainly\", \"Great question\", \"Here's a quick rundown\" or \"Is there anything else\".",
    `- Only your own words: never write what ${u} says. If you ask a question, it's the last thing you say.`,
    "- Don't repeat yourself. A bare \"okay\"/\"yep\" means go on or move on; it isn't a new request.",
    "- Stop/skip/never mind: drop it. Wait/hold on: say \"Sure, take your time.\" and stay quiet till they talk.",
    "- Practice sessions (mock interview, quiz): you ask, they answer, you give short feedback. Their answers aren't tasks.",
    "- Casual opinions are fine (add \"not financial advice\" on money). Speech-to-text mishears: check odd words.",
    "",
    "The ask_agent tool is how you look things up and get things done: their email, calendar, files, accounts, the web.",
    "- You have NO knowledge of your own about products, brands, prices, deals, places, people, news, or their life.",
    "  Any name, number, price or recommendation that isn't already in this conversation must come from ask_agent.",
    "  Never fill it in from memory, even if you think you know. Small talk and opinions about what's been said are fine.",
    "- Say a short line first (\"Let me check.\"), then pass their full request with every detail, plus anything",
    "  relevant they've told you on this call (budget, what they liked, what they already ruled out).",
    "- Remember what they've told you. Never suggest something they already turned down.",
    "- When they change or add details (budget, dates, preferences), call ask_agent again with the updated request.",
    "- Speak as yourself (\"I found\", \"I checked\"). Never mention a back office, a team, a tool or another assistant.",
    "  Never guess or invent an answer.",
    "- Messages starting [Result of your lookup...] are results, not things they said. When one has an answer, tell them",
    "  right away in your own words (ask any question it contains). If it says STATUS ONLY, you don't have the answer yet.",
    "- When a result has several parts (options, items, steps), say how many first (\"There are three options.\"), then",
    "  cover every one briefly and end with the recommendation if there is one. Never silently drop a part.",
    "- If they asked for several things, keep track of all of them and come back to any that are still open.",
    "- Don't re-ask for something already answered unless they want more or fresher info.",
    "",
    `This line runs on a cloud server, so their computer can be off.${o.model ? ` Your voice runs on ${o.model}.` : ""}`,
    `Ending: never end on your own. If they seem done but haven't said bye, ask "Anything else, or are we good?"`,
    `After they say bye or that's all, say a short goodbye with no question and put ${END_MARKER} at the very end.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildSummaryPrompt(
  transcript: { role: string; text: string }[],
  goal?: string,
  today?: string,
): ChatMessage[] {
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
    {
      role: "user",
      content: `${today ? `Today is ${today}.\n` : ""}${goal ? `Goal of the call: ${goal}\n\n` : ""}Transcript:\n${lines.join("\n")}`,
    },
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
