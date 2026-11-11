import Anthropic, {
  APIConnectionError,
  InternalServerError,
  OverloadedError,
  RateLimitError,
  ServiceUnavailableError,
} from "@anthropic-ai/sdk";
import { log } from "./log.js";
import {
  ASK_AGENT_TOOL,
  REMEMBER_DESCRIPTION,
  REMEMBER_TOOL,
  RateLimitedError,
  plainHistory,
  windowHistory,
  type ChatMessage,
  type LLMEvent,
  type VoiceLLM,
} from "./realtime.js";

const ASK_AGENT: Anthropic.Tool = {
  name: ASK_AGENT_TOOL,
  description:
    "Look something up or get something done for the user: their email, calendar, files, accounts, the web, " +
    "and actions. Use it for ANY fact, name, price, recommendation or current info not already in " +
    "this conversation, and for anything the user asks you to do. Never answer those from memory.",
  input_schema: {
    type: "object",
    properties: {
      request: {
        type: "string",
        description: "The user's question or instruction, restated clearly and completely with all details they gave.",
      },
    },
    required: ["request"],
  },
};

const REMEMBER: Anthropic.Tool = {
  name: REMEMBER_TOOL,
  description: REMEMBER_DESCRIPTION,
  input_schema: {
    type: "object",
    properties: { fact: { type: "string", description: "One short fact, in the third person." } },
    required: ["fact"],
  },
};

/** Convert the server's OpenAI-style history to the Messages API shape. */
export function toAnthropic(messages: ChatMessage[]): { system: string; messages: Anthropic.MessageParam[] } {
  const system: string[] = [];
  const out: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      if (out.length === 0) system.push(m.content);
      else out.push({ role: "user", content: `[Note] ${m.content}` });
      continue;
    }
    if (m.role === "tool") {
      out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }] });
      continue;
    }
    if (m.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content.trim()) blocks.push({ type: "text", text: m.content });
      for (const c of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(c.function.arguments || "{}");
        } catch {
          input = { request: c.function.arguments };
        }
        blocks.push({ type: "tool_use", id: c.id, name: c.function.name, input });
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : [{ type: "text", text: "…" }] });
      continue;
    }
    out.push({ role: "user", content: m.content });
  }
  // The conversation must open with a user turn; on a call we spoke first.
  if (out[0]?.role !== "user") out.unshift({ role: "user", content: "(The call has connected.)" });
  return { system: system.join("\n\n"), messages: out };
}

/**
 * Claude as the voice model. Thinking is off and effort low: on a phone call the first word has to come fast,
 * and these turns are short.
 */
export function anthropicLLM(apiKey: string, model: string): VoiceLLM {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 20_000 });
  return {
    async *stream(history, signal, opts) {
      const toolsOff = opts?.tools === false;
      // Claude keeps much more of the call in view than Groq (no tight per-minute token limit). The window moves in
      // blocks of 20 and the tools stay the same on every request (tool_choice "none" when it must just talk), so
      // each request starts the same way as the last and is mostly read from the prompt cache at a tenth the price.
      const { system, messages } = toAnthropic(windowHistory(history, 60, 20));
      const stream = client.messages.stream(
        {
          model,
          max_tokens: 1024,
          system,
          messages,
          thinking: { type: "disabled" },
          output_config: { effort: "low" },
          tools: [ASK_AGENT, REMEMBER],
          tool_choice: toolsOff ? { type: "none" } : { type: "auto" },
          cache_control: { type: "ephemeral" },
        },
        { signal },
      );
      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          yield { type: "text", text: ev.delta.text } satisfies LLMEvent;
        }
      }
      const final = await stream.finalMessage();
      if (final.stop_reason === "refusal") log.warn("voice model declined to answer this turn");
      if (final.stop_reason === "max_tokens") log.warn("voice model hit its token limit; reply was cut short");
      for (const b of final.content) {
        if (b.type === "tool_use") {
          yield {
            type: "tool_call",
            call: { id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input) } },
          } satisfies LLMEvent;
        }
      }
    },
    async complete(history) {
      const { system, messages } = toAnthropic(plainHistory(history));
      const res = await client.messages.create({
        model,
        max_tokens: 2000,
        system,
        messages,
        thinking: { type: "disabled" },
        output_config: { effort: "low" },
      });
      return res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    },
  };
}

/** Errors worth trying the backup provider for (capacity or connectivity, not a bad request). */
function isTransient(err: unknown): boolean {
  return (
    err instanceof RateLimitError ||
    err instanceof OverloadedError ||
    err instanceof InternalServerError ||
    err instanceof ServiceUnavailableError ||
    err instanceof APIConnectionError ||
    err instanceof RateLimitedError ||
    (typeof (err as { status?: number }).status === "number" && (err as { status: number }).status >= 500)
  );
}

/**
 * Use `primary`, and switch to `backup` for a turn when the primary fails before saying anything
 * (rate limit, overload, outage). Once a reply has started streaming, it can't be switched mid-sentence.
 */
export function withBackup(primary: VoiceLLM, backup: VoiceLLM, names: [string, string]): VoiceLLM {
  return {
    async *stream(messages, signal, opts) {
      let started = false;
      try {
        for await (const ev of primary.stream(messages, signal, opts)) {
          started = true;
          yield ev;
        }
      } catch (err) {
        if (started || signal.aborted || !isTransient(err)) throw err;
        log.warn(`${names[0]} unavailable (${(err as Error).message.slice(0, 120)}); using ${names[1]} for this turn`);
        yield* backup.stream(messages, signal, opts);
      }
    },
    async complete(messages) {
      try {
        return await primary.complete(messages);
      } catch (err) {
        if (!isTransient(err)) throw err;
        return backup.complete(messages);
      }
    },
  };
}
