import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimitError } from "@anthropic-ai/sdk";
import { toAnthropic, withBackup } from "../src/anthropic.js";
import type { ChatMessage, LLMEvent, VoiceLLM } from "../src/realtime.js";

test("history converts to the Messages API shape", () => {
  const history: ChatMessage[] = [
    { role: "system", content: "You are on a call." },
    { role: "assistant", content: "Hey, it's Claude." },
    { role: "user", content: "What's on my calendar?" },
    {
      role: "assistant",
      content: "Let me check.",
      tool_calls: [{ id: "call_1_x", type: "function", function: { name: "ask_agent", arguments: '{"request":"calendar"}' } }],
    },
    { role: "tool", tool_call_id: "call_1_x", content: "Sent." },
    { role: "user", content: "[Update from your back office] Gym at 8." },
  ];
  const { system, messages } = toAnthropic(history);
  assert.equal(system, "You are on a call.");
  // Must open with a user turn even though we spoke first on the call.
  assert.equal(messages[0].role, "user");
  assert.equal(messages[1].role, "assistant");
  const withTool = messages[3].content as any[];
  assert.deepEqual(withTool.map((b) => b.type), ["text", "tool_use"]);
  assert.deepEqual(withTool[1].input, { request: "calendar" });
  assert.equal((messages[4].content as any[])[0].type, "tool_result");
  assert.equal((messages[4].content as any[])[0].tool_use_id, "call_1_x");
});

function fake(events: LLMEvent[], fail?: Error): VoiceLLM {
  return {
    async *stream() {
      if (fail) throw fail;
      for (const e of events) yield e;
    },
    async complete() {
      if (fail) throw fail;
      return "ok";
    },
  };
}

test("falls back to the backup model when Claude is rate-limited", async () => {
  const limited = new RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, "slow down", new Headers());
  const llm = withBackup(fake([], limited), fake([{ type: "text", text: "from backup" }]), ["claude", "groq"]);
  const out: string[] = [];
  for await (const ev of llm.stream([], new AbortController().signal)) if (ev.type === "text") out.push(ev.text);
  assert.deepEqual(out, ["from backup"]);
});

test("a bad request is not hidden by the backup", async () => {
  const llm = withBackup(fake([], new Error("bad request")), fake([{ type: "text", text: "x" }]), ["claude", "groq"]);
  await assert.rejects(async () => {
    for await (const _ of llm.stream([], new AbortController().signal)) {
      /* drain */
    }
  });
});
