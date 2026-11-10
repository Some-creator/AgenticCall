import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CallError, type CallManager } from "./calls.js";

const INSTRUCTIONS = `AgenticCall lets you phone your user and talk with them by voice.

When to call: only for things that genuinely need the user's attention soon — urgent or time-sensitive
tasks, important notifications, decisions you are blocked on, security alerts. For routine updates use
send_sms (or don't contact them). Respect a refused call (quiet hours / rate limit): it means "text instead".

How a call works:
1. call_user speaks your opening message and listens. It returns what the user said (user_said).
2. Respond with say_on_call (listen=true) to keep talking. Every reply you send is spoken aloud by
   text-to-speech, so write short, natural spoken sentences: no markdown, lists, URLs or emoji.
3. While you think, the user hears silence on hold, so respond quickly and keep turns brief.
4. If a result has still_waiting=true, call wait_for_reply to keep listening.
5. Finish with end_call and a one-line goodbye. Confirm any decision the user made before hanging up.`;

const urgency = z
  .enum(["low", "normal", "high", "critical"])
  .default("normal")
  .describe('How important this is. "critical" bypasses quiet hours and the hourly call limit — use sparingly.');

const timeout = z
  .number()
  .int()
  .min(5)
  .max(110)
  .default(40)
  .describe("Max seconds to wait for the user's spoken reply before returning (keep below your tool-call timeout).");

const callId = z.string().describe("The call_id returned by call_user.");

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function fail(err: unknown) {
  const msg = err instanceof CallError ? err.message : `Unexpected error: ${(err as Error).message}`;
  return { content: [{ type: "text" as const, text: msg }], isError: true };
}

async function guard<T>(fn: () => Promise<T>) {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e);
  }
}

export function buildMcpServer(calls: CallManager): McpServer {
  const server = new McpServer({ name: "agentic-call", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "call_user",
    {
      title: "Phone the user",
      description:
        "Place a phone call to the user, speak an opening message, and listen for their spoken reply. " +
        "Use for important or time-sensitive tasks, alerts and decisions only. Returns call_id and what the user said.",
      inputSchema: {
        message: z
          .string()
          .min(1)
          .max(1500)
          .describe(
            "What to say after the automatic greeting. Plain spoken English, 1-3 short sentences, ending with a " +
              "question if you need input. E.g. 'Your 3pm meeting with Dana was moved to 2pm. Want me to accept?'",
          ),
        reason: z.string().max(300).optional().describe("Short internal note on why you are calling (kept in the log)."),
        caller_name: z
          .string()
          .max(60)
          .optional()
          .describe('How to introduce yourself, e.g. "Muse" or "Claude". Defaults to "your AI assistant".'),
        urgency,
        wait_for_reply: z.boolean().default(true).describe("Wait for the user to answer and reply before returning."),
        timeout_seconds: timeout,
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ message, reason, caller_name, urgency, wait_for_reply, timeout_seconds }) =>
      guard(async () => {
        const rec = await calls.startCall({ message, reason, urgency, callerName: caller_name });
        if (!wait_for_reply) {
          return { call_id: rec.id, status: rec.status, hint: "Dialing. Use wait_for_reply to hear the user." };
        }
        return calls.waitForReply(rec.id, timeout_seconds * 1000);
      }),
  );

  server.registerTool(
    "say_on_call",
    {
      title: "Speak on the active call",
      description:
        "Say something to the user on a live call. With listen=true (default) it then waits for and returns the " +
        "user's spoken reply. Keep it short and conversational; it is read aloud by text-to-speech.",
      inputSchema: {
        call_id: callId,
        message: z.string().min(1).max(1500).describe("What to say, as natural spoken sentences."),
        listen: z.boolean().default(true).describe("Listen for a reply after speaking."),
        timeout_seconds: timeout,
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ call_id, message, listen, timeout_seconds }) =>
      guard(() => calls.say(call_id, message, listen, timeout_seconds * 1000)),
  );

  server.registerTool(
    "wait_for_reply",
    {
      title: "Keep listening",
      description:
        "Keep waiting for the user to answer the phone or finish speaking. Use when a previous result had still_waiting=true.",
      inputSchema: { call_id: callId, timeout_seconds: timeout },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ call_id, timeout_seconds }) => guard(() => calls.waitForReply(call_id, timeout_seconds * 1000)),
  );

  server.registerTool(
    "end_call",
    {
      title: "Hang up",
      description: "Say an optional short goodbye and hang up the call. Returns the full transcript.",
      inputSchema: {
        call_id: callId,
        message: z.string().max(500).optional().describe('Goodbye line, e.g. "Great, I\'ll take care of it. Bye!"'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ call_id, message }) => guard(async () => calls.summarize(await calls.endCall(call_id, message))),
  );

  server.registerTool(
    "get_call",
    {
      title: "Call status and transcript",
      description: "Get the status and full transcript of a call.",
      inputSchema: { call_id: callId },
      annotations: { readOnlyHint: true },
    },
    async ({ call_id }) => guard(async () => calls.summarize(calls.get(call_id))),
  );

  server.registerTool(
    "list_calls",
    {
      title: "Recent calls",
      description: "List calls made since the server started (newest first), without transcripts.",
      inputSchema: { limit: z.number().int().min(1).max(50).default(10) },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) =>
      guard(async () =>
        calls
          .list()
          .slice(0, limit)
          .map((c) => {
            const { transcript, ...summary } = calls.summarize(c);
            return { ...summary, turns: transcript.length };
          }),
      ),
  );

  server.registerTool(
    "send_sms",
    {
      title: "Text the user",
      description:
        "Send the user a text message. Use for updates that matter but don't need a call, or as a follow-up summary after one.",
      inputSchema: { message: z.string().min(1).max(1500).describe("The text message body.") },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ message }) => guard(async () => ({ sent: true, sid: await calls.sendSms(message) })),
  );

  return server;
}
