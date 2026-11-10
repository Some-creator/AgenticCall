import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CallError, type CallManager } from "./calls.js";

const INSTRUCTIONS = `AgenticCall lets you phone your user and talk with them by voice.

Real-time mode (the default when the server has it): a fast voice assistant runs the whole conversation for
you, naturally, like a person. Give call_user a clear opening message, a briefing with every fact the user may
ask about, and the goal (what you need decided or learned). Then call wait_for_reply until the call ends; you
get a summary, the user's decisions and follow-ups, and the transcript. Act on them afterwards.

During a real-time call you stay on the line in the background: keep calling wait_for_reply in a loop.
When a result contains agent_requests, the user just asked something only you can answer or do (check
email, look at the calendar, send a message, ...). They are on the phone waiting, so handle it IMMEDIATELY
with your own tools, then call answer_on_call with a short spoken-style answer (or what you did), then go
back to wait_for_reply. Speed matters more than polish here.
- Do the work DURING the call. Never answer "I'll do it after the call" unless the user asked for a call back.
- If it will take more than ~10 seconds, FIRST call acknowledge_request with an honest eta_seconds, then do
  the work. For long tasks the user is offered a call back; if the call ends before you answer, the result
  lists open_requests: finish them and call_user back (or send_sms) with the result.
- If you need something from the user to proceed, answer_on_call with the question; their reply comes back
  as a new agent_request.
Turn-by-turn mode: you answer each turn yourself, as described below.

When to call: only for things that genuinely need the user's attention soon — urgent or time-sensitive
tasks, important notifications, decisions you are blocked on, security alerts. For routine updates use
send_sms (or don't contact them). Respect a refused call (quiet hours / rate limit): it means "text instead".

How a call works:
1. call_user speaks your opening message and listens. It returns what the user said (user_said).
2. Respond with say_on_call (listen=true) to keep talking. Every reply you send is spoken aloud by
   text-to-speech, so write short, natural spoken sentences: no markdown, lists, URLs or emoji.
3. Every second you spend thinking is dead air on the phone. Reply IMMEDIATELY with one or two short
   sentences, like a person on a call. Don't plan, research or use other tools between turns unless the
   user asked you to; if you must, first say so ("Let me check that, one sec") with say_on_call listen=false.
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
  .describe(
    "Max seconds to wait before returning (capped at 50 so it returns before typical 60s client tool timeouts). " +
      "Just call again if still_waiting.",
  );

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
        "Phone the user and talk with them by voice. Use for important or time-sensitive tasks, alerts and decisions only. " +
        "In realtime mode a voice assistant holds the conversation using your briefing and returns the outcome; " +
        "in turn_by_turn mode it returns what the user said so you can reply with say_on_call.",
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
        mode: z
          .enum(["realtime", "turn_by_turn"])
          .optional()
          .describe(
            "Leave this unset. The default (realtime) sounds natural and still sends you anything only you can " +
              "handle, mid-call. Only use turn_by_turn if the user explicitly asks for it: it has a different, " +
              "robotic voice and multi-second pauses on every turn.",
          ),
        briefing: z
          .string()
          .max(6000)
          .optional()
          .describe(
            "Realtime mode: everything the voice assistant may need to discuss — facts, options, deadlines, names, " +
              "what you recommend. It only knows what you put here.",
          ),
        goal: z
          .string()
          .max(500)
          .optional()
          .describe('Realtime mode: what the call must achieve, e.g. "Get a yes/no on moving the meeting to 2pm".'),
        wait_for_reply: z.boolean().default(true).describe("Wait for the user to answer and reply before returning."),
        timeout_seconds: timeout,
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ message, reason, caller_name, urgency, mode, briefing, goal, wait_for_reply, timeout_seconds }) =>
      guard(async () => {
        const rec = await calls.startCall({ message, reason, urgency, callerName: caller_name, mode, briefing, goal });
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
        "Keep waiting. Realtime calls: returns as soon as the user asks something only you can handle (agent_requests " +
        "— answer them with answer_on_call), or when the call ends, with summary, decisions, follow-ups and transcript. " +
        "Turn-by-turn calls: returns the user's next reply. Use whenever a result had still_waiting=true.",
      inputSchema: { call_id: callId, timeout_seconds: timeout },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ call_id, timeout_seconds }) => guard(() => calls.waitForReply(call_id, timeout_seconds * 1000)),
  );

  server.registerTool(
    "answer_on_call",
    {
      title: "Answer the user mid-call",
      description:
        "Answer a request the user made during a real-time call (from wait_for_reply's agent_requests). The voice " +
        "assistant tells them right away, in its own words. Give the facts or what you did, in 1-3 plain sentences.",
      inputSchema: {
        call_id: callId,
        request_id: z.string().describe("The request_id from agent_requests."),
        answer: z
          .string()
          .min(1)
          .max(2000)
          .describe('The answer or result, e.g. "Friday you have the dentist at 10am and lunch with Priya at 1."'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ call_id, request_id, answer }) => guard(async () => calls.answerRequest(call_id, request_id, answer)),
  );

  server.registerTool(
    "acknowledge_request",
    {
      title: "Give a time estimate mid-call",
      description:
        "Tell the user (via the voice assistant) how long a mid-call request will take, before doing slow work. " +
        "Short estimates keep them on the line; long ones offer a call back when it's done.",
      inputSchema: {
        call_id: callId,
        request_id: z.string().describe("The request_id from agent_requests."),
        eta_seconds: z.number().int().min(1).max(86_400).describe("Honest estimate of how long until you can answer."),
        note: z.string().max(300).optional().describe('Optional context, e.g. "Searching three months of email".'),
      },
      annotations: { destructiveHint: false, openWorldHint: true },
    },
    async ({ call_id, request_id, eta_seconds, note }) =>
      guard(async () => calls.acknowledgeRequest(call_id, request_id, eta_seconds, note)),
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
