import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import Groq, { InternalServerError, RateLimitError } from "groq-sdk";
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

/** Keep the system prompt plus the recent conversation, so long calls stay fast and under rate limits. */
export function windowHistory(messages: ChatMessage[], max = 24): ChatMessage[] {
  if (messages.length <= max + 1) return messages;
  const rest = messages.slice(1);
  let start = rest.length - max;
  // Start at a user turn so a tool result is never separated from its tool call.
  while (start < rest.length && rest[start].role !== "user") start++;
  return [messages[0], ...rest.slice(start)];
}

export function groqLLM(apiKey: string, model: string, fallbackModel?: string): VoiceLLM {
  // No automatic retries: on a rate limit, waiting out retry-after means dead air on the phone.
  const client = new Groq({ apiKey, maxRetries: 0, timeout: 20_000 });
  // Reasoning models think before speaking; keep that minimal so the first word comes fast.
  const reasoningFor = (m: string) =>
    m.startsWith("openai/gpt-oss")
      ? { reasoning_effort: "low" as const, include_reasoning: false }
      : m.startsWith("qwen/")
        ? { reasoning_effort: "none" as const, include_reasoning: false }
        : {};
  async function withFallback<T>(run: (m: string) => Promise<T>): Promise<T> {
    try {
      return await run(model);
    } catch (err) {
      const retryable = err instanceof RateLimitError || err instanceof InternalServerError;
      if (!retryable || !fallbackModel || fallbackModel === model) throw err;
      log.warn(`Groq ${model} failed (${(err as Error).message.slice(0, 120)}); using ${fallbackModel}`);
      return run(fallbackModel);
    }
  }
  return {
    async *stream(messages, signal, opts) {
      const t0 = Date.now();
      const stream = await withFallback((m) =>
        client.chat.completions.create(
          {
            model: m,
            messages: windowHistory(messages) as never,
            stream: true,
            max_completion_tokens: 300,
            tools: VOICE_TOOLS,
            tool_choice: opts?.tools === false ? "none" : "auto",
            parallel_tool_calls: false,
            ...reasoningFor(m),
          },
          { signal },
        ),
      );
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
          max_completion_tokens: 800,
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

const NOTE_PREFIX = "[Update from your back office. The caller did NOT say this.]";

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
  /** Notes delivered but not yet used in a reply. */
  private freshNotes: { entry: ChatMessage; after: string }[] = [];
  private fillerTimer: NodeJS.Timeout | null = null;
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
    const filter = new MarkerFilter(END_MARKER);
    let spoken = "";
    let turnClosed = false; // sent last:true already
    const toolCalls: ToolCall[] = [];
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
      // Right after being handed an answer or update, the model must say it, not go off and ask again.
      const tools = notes.length === 0;
      for await (const ev of this.llm.stream(this.history.slice(0, -1), ctrl.signal, { tools })) {
        if (ctrl.signal.aborted) break;
        if (ev.type === "tool_call") {
          toolCalls.push(ev.call);
          continue;
        }
        if (turnClosed) continue; // drain the rest only to pick up tool calls
        emit(speakable(filter.push(ev.text)));
      }
      if (ctrl.signal.aborted) {
        if (!spoken) {
          this.removeEntry(entry);
          this.freshNotes.unshift(...notes); // nothing was said: still to be shared
        } else {
          this.retireNotes(notes); // they heard some of it and talked over it
        }
        return;
      }
      this.retireNotes(notes);
      if (!turnClosed) emit(speakable(filter.flush()));
      if (held !== null && !turnClosed && afterQuestion(held, true) !== "cut") speak(held);
      held = null;

      const ask = toolCalls.find((c) => c.function.name === ASK_AGENT_TOOL);
      let request = "";
      if (ask) {
        try {
          request = String(JSON.parse(ask.function.arguments || "{}").request ?? "").trim();
        } catch {
          request = ask.function.arguments.trim();
        }
      }
      if (ask && request) {
        if (!spoken.trim()) speak(FILLERS[this.fillerIdx++ % FILLERS.length]);
        closeTurn();
        ask.id ||= `call_${Date.now()}`;
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
      const done = userSaidGoodbye(lastUser);
      // Hang up only when the caller signalled they're done, and the reply is a goodbye (marker or not:
      // some models never emit the marker). Never hang up on a question.
      if (spoken.trim() && !spoken.includes("?") && done && (filter.found || soundsLikeGoodbye(spoken))) {
        this.wrapUp(spoken);
      } else if (filter.found) {
        log.warn(`ignored end-of-call from the voice model; caller hadn't said goodbye ("${lastUser}")`);
      }
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
  return [
    `You are ${o.callerName}, an AI assistant, on a live phone call with ${o.userName}.`,
    `You called them on behalf of their AI agent. You already opened the call by saying: "${o.opening}"`,
    o.reason ? `Why you're calling: ${o.reason}` : "",
    o.briefing ? `What you know (share what's relevant, don't read it out verbatim):\n${o.briefing}` : "",
    o.goal ? `What this call needs to achieve: ${o.goal}` : "",
    `It is currently ${time} for them.`,
    "",
    "How to talk (this matters most):",
    "- This is a real phone call and everything you write is spoken aloud. Talk like a sharp, warm friend who happens to be",
    "  a great assistant, not like a chatbot or customer-service script.",
    "- React like a person first, then answer: \"Oh nice.\", \"Ugh, yeah.\", \"Got it.\", \"Hm, good question.\" Match their energy and slang.",
    "- Keep the conversation alive like a real person would. When it's your turn, actually say something: answer properly,",
    "  add a thought or opinion, and keep the ball rolling. Two to four sentences is normal; one-word replies are not.",
    "  Never stop halfway through a thought. Use contractions and everyday words, and vary how you start sentences.",
    "- Plain speech only: no lists, numbering, markdown, emoji, URLs or symbols. For steps, give ONE step, then wait.",
    "- Never use these: \"Sure thing\", \"Certainly\", \"Absolutely\", \"Great question\", \"Here's a quick rundown\",",
    "  \"I'd be happy to\", \"Is there anything else\", \"What would you like to explore/dive into/go over\", \"Let me know if\".",
    "- Don't tack a stock question onto every reply, but a genuine follow-up question is great, like a friend would ask.",
    `- Write ONLY your own words for this turn. Never write what ${o.userName} says or assume their answer.`,
    "- If you ask a question, make it the last thing you say, then stop.",
    "- If they say stop, skip, never mind, or change the subject, drop it immediately and don't bring it back.",
    "- If they ask you to wait, hold on or be quiet, say only \"Sure, take your time.\" and stay silent until they speak.",
    "- Speech-to-text can mishear. If something sounds odd, briefly check what they meant.",
    "- Casual opinions are fine. If asked what you think, give a real but balanced take; on money add a quick \"not financial advice\".",
    "- If they ask what you can do, suggest things you can actually do for them right now: check their calendar or email,",
    "  look something up, book or draft something. Not generic chatbot topics.",
    "- Never claim you checked something you didn't. If they ask for more or newer info, get it with ask_agent.",
    "",
    "Example of the right tone:",
    "  User: ugh what's my day look like tomorrow",
    "  You: Let me check. ... Okay, pretty chill day actually. HackerRank at eleven, then gym at eight tonight.",
    "  User: wait what time's the gym again",
    "  You: Eight, and it runs till ten. Leg day too, so good luck.",
    "",
    "Your back office (the ask_agent tool) has their email, calendar, files, accounts and the web, and can take actions:",
    "- Use it for anything you don't already know, anything current (news, prices, weather, flights), and anything they ask you to do.",
    "- Say a short natural line first, like \"Let me check.\" or \"Give me a few seconds.\", then call it with their full request.",
    "- Don't ask it again for something it already answered in this call, unless they want more or fresher info.",
    "- To them you're one assistant: never mention a back office, another agent, or passing things along.",
    "- While waiting, keep chatting normally if they talk. Never guess or invent an answer.",
    "- Answers arrive as messages starting with [Update from your back office...]. The caller didn't say those. As soon as",
    "  one arrives, tell the caller what it says, in your own natural words. Never say you're still waiting once it's there.",
    "  Don't say \"let me check\" again. If the answer asks them something, ask it. If it says something will happen after the call,",
    "  tell them that plainly; it is NOT a reason to hang up.",
    "- Only state facts from what you were told or from those answers.",
    "",
    "About this phone line, if they ask: it runs on a cloud server, so their computer doesn't need to be on; their agent can call them whenever something needs them." +
      (o.model ? ` Your voice runs on the ${o.model} model on Groq (with a backup model if it's rate-limited).` : ""),
    "",
    "Ending the call:",
    "- Before ending, confirm any decision or request back to them in one sentence.",
    `- Never end on your own initiative. If they sound done but haven't said goodbye, ask something casual like "Anything else, or are we good?"`,
    `- Only after they say goodbye or clearly say there's nothing else, say a short goodbye (no question) and put ${END_MARKER} at the very end.`,
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
