import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import twilio from "twilio";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import { CallManager, type Telephony } from "../src/calls.js";
import type { Config } from "../src/config.js";
import {
  attachRelayServer,
  MarkerFilter,
  speakable,
  isFiller,
  userSaidGoodbye,
  windowHistory,
  type ChatMessage,
  type LLMEvent,
  type VoiceLLM,
} from "../src/realtime.js";
import { similarRequests } from "../src/calls.js";

const AUTH = "test_auth_token";
const MCP_TOKEN = "secret-mcp-token";
let server: Server;
let base = "";
const dialed: { url: string; statusCallback: string }[] = [];
const llmCalls: ChatMessage[][] = [];
const llmTools: (boolean | undefined)[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Replies like a voice model would, streaming tokens. Splits the end marker across tokens on purpose.
const fakeLLM: VoiceLLM = {
  async *stream(messages, signal, opts): AsyncIterable<LLMEvent> {
    llmCalls.push(messages.map((m) => ({ ...m })));
    llmTools.push(opts?.tools);
    const lastMsg = messages.at(-1)!;
    const last = lastMsg.content.toLowerCase();
    if (last.includes("back office") && last.includes("dentist")) {
      for (const t of ["Friday you've got ", "the dentist at 10. ", "Anything else?"]) yield { type: "text", text: t };
      return;
    }
    if (last.includes("back office") && last.includes("call them back when it's done")) {
      for (const t of ["That'll take about 5 minutes. ", "Want to stay on, or should I call you back?"]) yield { type: "text", text: t };
      return;
    }
    if (lastMsg.role === "user" && last.includes("call me back")) {
      for (const t of ["Will do, I'll call you back. ", "Talk soon! [END_CALL]"]) yield { type: "text", text: t };
      return;
    }
    if (lastMsg.role === "user" && last.includes("taxes")) {
      yield {
        type: "tool_call",
        call: { id: "tc2", type: "function", function: { name: "ask_agent", arguments: '{"request":"Prepare my tax summary"}' } },
      };
      return;
    }
    if (lastMsg.role === "user" && last.includes("flights")) {
      for (const t of ["Okay, I'll look into flights ", "after the call. [END_CALL]"]) yield { type: "text", text: t };
      return;
    }
    if (lastMsg.role === "user" && last.includes("ramble")) {
      for (let i = 0; i < 20; i++) yield { type: "text", text: `This is sentence number ${i} of a very long answer. ` };
      return;
    }
    if (lastMsg.role === "user" && last.includes("honestly")) {
      for (const t of ["Honestly? ", "I think we should ", "talk about the new model."]) yield { type: "text", text: t };
      return;
    }
    if (lastMsg.role === "user" && last.includes("end the call")) {
      yield { type: "text", text: "Alright, ending the call now. Take care." };
      return;
    }
    if (lastMsg.role === "user" && last.includes("what's up")) {
      yield { type: "text", text: "Not much. What do you want to get into?" };
      return;
    }
    if (lastMsg.role === "user" && last.includes("hold on")) {
      yield { type: "tool_call", call: { id: "tc3", type: "function", function: { name: "ask_agent", arguments: '{"request":""}' } } };
      return;
    }
    if (lastMsg.role === "user" && last.includes("calendar")) {
      yield {
        type: "tool_call",
        call: { id: "tc1", type: "function", function: { name: "ask_agent", arguments: '{"request":"What is on my calendar Friday?"}' } },
      };
      return;
    }
    const tokens = last.includes("chat")
      ? ["Happy to! ", "Anything ", "else you'd like to test?", "No, ", "that's all. Goodbye! [END_CALL]"]
      : last.includes("bye")
        ? ["Okay, ", "talk soon!", " [END", "_CA", "LL]"]
        : last.includes("story")
          ? ["Once ", "upon ", "a ", "time ", "there ", "was ", "a ", "very ", "long ", "story."]
          : ["Sure, ", "I'll move it ", "to 2pm. ", "Anything else?"];
    for (const t of tokens) {
      if (signal.aborted) return;
      await sleep(last.includes("story") ? 40 : 2);
      yield { type: "text", text: t };
    }
  },
  async complete() {
    return 'Here you go: {"summary":"User approved moving the meeting to 2pm.","user_decisions":["Move meeting to 2pm"],"follow_ups":[]}';
  },
};

const tel: Telephony = {
  async createCall(o) {
    dialed.push(o);
    return { sid: `CA${dialed.length}` };
  },
  async hangup() {},
  async sendSms() {
    return { sid: "SM1" };
  },
};

before(async () => {
  const cfg = {
    twilio: { accountSid: "AC123", authToken: AUTH, fromNumber: "+15550000000", validateSignature: true },
    userPhoneNumber: "+15551112222",
    userName: "Sam",
    publicBaseUrl: "",
    port: 0,
    host: "127.0.0.1",
    transport: "http",
    mcpAuthToken: MCP_TOKEN,
    allowUnauthenticatedMcp: false,
    voice: "Polly.Joanna-Neural",
    language: "en-US",
    answeringMachineDetection: true,
    speechTimeoutSeconds: 8,
    speechEndTimeout: "auto",
    speechModel: "phone_call",
    ackPhrases: [],
    maxHoldSeconds: 120,
    maxCallSeconds: 900,
    maxCallsPerHour: 20,
    quietHours: null,
    timezone: "America/New_York",
    defaultMode: "realtime",
    agentAnswerTimeoutSeconds: 45,
    callbackThresholdSeconds: 60,
    groq: { apiKey: "x", model: "test", fallbackModel: "test" },
    relay: {},
  } satisfies Config as Config;
  const calls = new CallManager(cfg, tel, { llm: fakeLLM });
  const app = createApp(cfg, calls);
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  attachRelayServer(server, calls);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cfg.publicBaseUrl = base;
});

after(() => server.close());

async function twilioPost(url: string, params: Record<string, string>) {
  const headers = {
    "content-type": "application/x-www-form-urlencoded",
    "X-Twilio-Signature": twilio.getExpectedTwilioSignature(AUTH, url, params),
  };
  const res = await fetch(url, { method: "POST", headers, body: new URLSearchParams(params) });
  return { status: res.status, body: await res.text() };
}

async function mcp() {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
    }),
  );
  return client;
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&apos;/g, "'").replace(/&quot;/g, '"');
const attr = (xml: string, name: string) => decode(xml.match(new RegExp(`${name}="([^"]*)"`))![1]);
const param = (xml: string, name: string) =>
  decode(xml.match(new RegExp(`<Parameter name="${name}" value="([^"]*)"`))![1]);

/** A WebSocket client standing in for Twilio's ConversationRelay. */
async function relay(url: string) {
  const ws = new WebSocket(url);
  const inbox: any[] = [];
  let wake: (() => void) | null = null;
  ws.on("message", (d) => {
    inbox.push(JSON.parse(String(d)));
    wake?.();
  });
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  await new Promise((r, j) => {
    ws.on("open", r);
    ws.on("error", j);
  });
  return {
    ws,
    closed,
    send: (m: object) => ws.send(JSON.stringify(m)),
    async next(pred: (m: any) => boolean, ms = 5000) {
      const deadline = Date.now() + ms;
      for (;;) {
        const i = inbox.findIndex(pred);
        if (i >= 0) return inbox.splice(i, 1)[0];
        if (Date.now() > deadline) throw new Error("timed out waiting for relay message");
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, 50);
        });
      }
    },
    /** Collect streamed text tokens up to and including last:true. */
    async reply() {
      let text = "";
      for (;;) {
        const m = await this.next((x) => x.type === "text");
        text += m.token;
        if (m.last) return text;
      }
    },
  };
}

test("speech cleanup, request matching and history window", () => {
  assert.equal(speakable("**Step 1:** run `ping`\n\n- then # reboot"), "Step 1: run ping - then  reboot");
  const q = "Provide a brief explanation of why NVIDIA stock has declined in the past couple of days.";
  assert.ok(similarRequests(q, `${q} It's mostly a broad AI chip selloff, not Nvidia news.`));
  assert.ok(!similarRequests(q, "What's on my calendar Friday?"));
  const msgs: ChatMessage[] = [{ role: "system", content: "s" }];
  for (let i = 0; i < 40; i++) msgs.push({ role: i % 2 ? "assistant" : "user", content: String(i) });
  const w = windowHistory(msgs, 10);
  assert.equal(w[0].role, "system");
  assert.equal(w[1].role, "user");
  assert.ok(w.length <= 11);
});

test("stage directions are dropped and long turns are capped", async () => {
  const { BracketFilter, MAX_TURN_CHARS } = await import("../src/realtime.js");
  const b = new BracketFilter();
  assert.equal(["[No resp", "onse needed]", "Okay."].map((t) => b.push(t)).join("") + b.flush(), "Okay.");
  assert.ok(MAX_TURN_CHARS >= 200 && MAX_TURN_CHARS <= 400);
});

test("after-question judgement", async () => {
  const { afterQuestion } = await import("../src/realtime.js");
  assert.equal(afterQuestion(" No, that's all."), "cut");
  assert.equal(afterQuestion(" I think we should"), "continue");
  assert.equal(afterQuestion(" I"), "wait");
  assert.equal(afterQuestion(" I", true), "continue");
});

test("filler and goodbye detection", () => {
  for (const t of ["Okay.", "alright", "Hmm...", "Mm-hmm", "Uh huh."]) assert.ok(isFiller(t), t);
  for (const t of ["Yes.", "Okay, book it", "No breaking news?"]) assert.ok(!isFiller(t), t);
  for (const t of ["No, bye!", "That's all", "I'm good, thanks", "Just call me back."]) assert.ok(userSaidGoodbye(t), t);
  for (const t of ["Could you check flights to Utah?", "Okay.", "Good question"]) assert.ok(!userSaidGoodbye(t), t);
});

test("marker filter hides the end marker even when split across tokens", () => {
  const f = new MarkerFilter("[END_CALL]");
  const out = ["Bye", " now! [EN", "D_C", "ALL]", " ignored"].map((t) => f.push(t)).join("") + f.flush();
  assert.equal(out, "Bye now! ");
  assert.equal(f.found, true);
  const g = new MarkerFilter("[END_CALL]");
  assert.equal(["Use [brackets", "] fine"].map((t) => g.push(t)).join("") + g.flush(), "Use [brackets] fine");
});

test("real-time call: natural streamed conversation, interruption, goodbye and outcome", async () => {
  const client = await mcp();
  const callP = client.callTool({
    name: "call_user",
    arguments: {
      message: "Your 3pm with Dana needs to move. Is 2pm okay?",
      caller_name: "Muse",
      briefing: "Dana asked to move the 3pm sync. Free slots: 2pm or 4:30pm.",
      goal: "Get a yes or no on 2pm",
      timeout_seconds: 30,
    },
  });
  while (dialed.length === 0) await sleep(10);
  const { url, statusCallback } = dialed[0];

  const twiml = (await twilioPost(url, { CallStatus: "in-progress", AnsweredBy: "human" })).body;
  assert.match(twiml, /<Connect action="[^"]*\/twilio\/relay-done\?cid=/);
  assert.equal(attr(twiml, "welcomeGreeting"), "Hi Sam, it's Muse. Your 3pm with Dana needs to move. Is 2pm okay?");
  const relayUrl = attr(twiml, "url");
  assert.match(relayUrl, /^ws:\/\/127\.0\.0\.1:\d+\/twilio\/relay\?cid=/);

  // Wrong secret is refused.
  const bad = await relay(relayUrl);
  bad.send({ type: "setup", callSid: "CAx", customParameters: { cid: param(twiml, "cid"), secret: "nope" } });
  assert.equal(await bad.closed, 1008);

  const tw = await relay(relayUrl);
  tw.send({ type: "setup", callSid: "CA1", customParameters: { cid: param(twiml, "cid"), secret: param(twiml, "secret") } });

  tw.send({ type: "prompt", voicePrompt: "Yeah, 2pm works.", last: true });
  assert.equal(await tw.reply(), "Sure, I'll move it to 2pm. Anything else?");

  // The model must not answer its own question for the user (and must not hang up on that basis).
  tw.send({ type: "prompt", voicePrompt: "Let's chat a bit", last: true });
  assert.equal(await tw.reply(), "Happy to! Anything else you'd like to test?");
  // The model saw the briefing and goal in its system prompt.
  assert.match(llmCalls[0][0].content, /Free slots: 2pm or 4:30pm/);
  assert.match(llmCalls[0][0].content, /Get a yes or no on 2pm/);

  // Interrupt a long reply: generation stops and history keeps only what was heard.
  tw.send({ type: "prompt", voicePrompt: "Tell me a story", last: true });
  await tw.next((m) => m.type === "text");
  tw.send({ type: "interrupt", utteranceUntilInterrupt: "Once upon", durationUntilInterruptMs: 500 });
  await sleep(150);
  tw.send({ type: "prompt", voicePrompt: "Never mind. Bye!", last: true });
  const goodbye = await tw.reply();
  assert.ok(goodbye.endsWith("Okay, talk soon! "), JSON.stringify(goodbye));
  assert.doesNotMatch(goodbye, /END/);
  const lastCall = llmCalls.at(-1)!;
  assert.equal(lastCall.at(-2)!.content, "Once upon…");

  // Talking over the goodbye keeps the call open.
  tw.send({ type: "interrupt", utteranceUntilInterrupt: "Okay,", durationUntilInterruptMs: 300 });
  await assert.rejects(tw.next((m) => m.type === "end", 3000));
  tw.send({ type: "prompt", voicePrompt: "Wait, one more thing. Actually no, bye!", last: true });
  assert.equal(await tw.reply(), "Okay, talk soon! ");

  // After the goodbye is spoken, the server ends the relay session; Twilio then hits the Connect action.
  const end = await tw.next((m) => m.type === "end", 6000);
  assert.ok(end.handoffData);
  const done = await twilioPost(statusCallback.replace("/status", "/relay-done"), { SessionStatus: "ended" });
  assert.match(done.body, /<Hangup\/>/);
  await twilioPost(statusCallback, { CallStatus: "completed" });

  const res: any = await callP;
  const out = JSON.parse(res.content[0].text);
  assert.equal(out.status, "completed");
  assert.deepEqual(out.outcome.user_decisions, ["Move meeting to 2pm"]);
  assert.deepEqual(
    out.transcript.filter((t: any) => t.role === "user").map((t: any) => t.text),
    ["Yeah, 2pm works.", "Let's chat a bit", "Tell me a story", "Never mind. Bye!", "Wait, one more thing. Actually no, bye!"],
  );
  tw.ws.close();
  await client.close();
});

test("real-time call: user asks something only the agent knows, mid-call", async () => {
  const client = await mcp();
  const callP = client.callTool({ name: "call_user", arguments: { message: "Quick check-in.", timeout_seconds: 20 } });
  while (dialed.length < 2) await sleep(10);
  const { url, statusCallback } = dialed.at(-1)!;
  const twiml = (await twilioPost(url, { CallStatus: "in-progress", AnsweredBy: "human" })).body;
  const tw = await relay(attr(twiml, "url"));
  tw.send({ type: "setup", callSid: "CA2", customParameters: { cid: param(twiml, "cid"), secret: param(twiml, "secret") } });

  tw.send({ type: "prompt", voicePrompt: "What's on my calendar Friday?", last: true });
  // The voice model covers the gap naturally...
  assert.equal(await tw.reply(), "Let me check.");
  // ...and the agent's pending call_user returns right away with the request.
  const first = JSON.parse(((await callP) as any).content[0].text);
  assert.deepEqual(first.agent_requests, [{ request_id: "req_1", request: "What is on my calendar Friday?" }]);
  assert.equal(first.status, "in_progress");

  // The agent answers; the voice model tells the user in its own words. (say_on_call works too, for older clients.)
  await client.callTool({
    name: process.env.VIA_SAY ? "say_on_call" : "answer_on_call",
    arguments: process.env.VIA_SAY
      ? { call_id: first.call_id, message: "Friday: dentist at 10am." }
      : { call_id: first.call_id, request_id: "req_1", answer: "Friday: dentist at 10am." },
  });
  assert.equal(await tw.reply(), "Friday you've got the dentist at 10. Anything else?");
  assert.equal(llmTools.at(-1), false); // answering, not re-asking
  const sent = llmCalls.at(-1)!;
  assert.equal(sent.at(-1)!.role, "user");
  assert.match(sent.at(-1)!.content, /^\[Update from your back office/);
  assert.equal((sent.at(-2) as any).role, "tool");
  assert.equal((sent.at(-3) as any).tool_calls[0].function.name, "ask_agent");

  // The answer note is retired once used, so it can't keep prompting the model ("skip it" sticks).
  await sleep(50);
  tw.send({ type: "prompt", voicePrompt: "Okay cool", last: true });
  await tw.reply();
  const later = llmCalls.at(-1)!.map((m) => m.content).join("\n");
  assert.match(later, /Already given to the user/);
  assert.doesNotMatch(later, /Share it now/);

  // Asking again for something already answered reuses the answer instead of bothering the agent.
  tw.send({ type: "prompt", voicePrompt: "Wait, what's on my calendar Friday again?", last: true });
  const again = (await tw.reply()) + (await tw.reply());
  assert.match(again, /dentist at 10/);
  const check = JSON.parse(
    ((await client.callTool({ name: "wait_for_reply", arguments: { call_id: first.call_id, timeout_seconds: 5 } })) as any)
      .content[0].text,
  );
  assert.equal(check.agent_requests, undefined);
  assert.equal(check.still_waiting, true);

  // An empty ask_agent call (e.g. "hold on") doesn't trigger "let me check".
  tw.send({ type: "prompt", voicePrompt: "Hold on a sec", last: true });
  assert.equal(await tw.reply(), "");

  tw.send({ type: "prompt", voicePrompt: "No, bye!", last: true });
  await tw.reply();
  await tw.next((m) => m.type === "end", 6000);
  await twilioPost(statusCallback, { CallStatus: "completed" });
  const done = JSON.parse(
    ((await client.callTool({ name: "wait_for_reply", arguments: { call_id: first.call_id, timeout_seconds: 10 } })) as any)
      .content[0].text,
  );
  assert.equal(done.status, "completed");
  assert.ok(done.transcript.some((t: any) => t.text.startsWith("Agent answered")));
  tw.ws.close();
  await client.close();
});

test("long request: agent estimates, user picks a call back, result lists open requests", async () => {
  const client = await mcp();
  const n = dialed.length;
  const callP = client.callTool({ name: "call_user", arguments: { message: "Hey.", timeout_seconds: 20 } });
  while (dialed.length <= n) await sleep(10);
  const { url, statusCallback } = dialed.at(-1)!;
  const twiml = (await twilioPost(url, { CallStatus: "in-progress", AnsweredBy: "human" })).body;
  const tw = await relay(attr(twiml, "url"));
  tw.send({ type: "setup", callSid: `CA${dialed.length}`, customParameters: { cid: param(twiml, "cid"), secret: param(twiml, "secret") } });

  tw.send({ type: "prompt", voicePrompt: "Can you put together my taxes summary?", last: true });
  assert.equal(await tw.reply(), "Let me check.");
  const first = JSON.parse(((await callP) as any).content[0].text);
  const reqId = first.agent_requests[0].request_id;

  await client.callTool({ name: "acknowledge_request", arguments: { call_id: first.call_id, request_id: reqId, eta_seconds: 300 } });
  assert.equal(await tw.reply(), "That'll take about 5 minutes. Want to stay on, or should I call you back?");
  assert.match(llmCalls.at(-1)!.at(-1)!.content, /about 5 minutes/);

  tw.send({ type: "prompt", voicePrompt: "Just call me back.", last: true });
  assert.equal(await tw.reply(), "Will do, I'll call you back. Talk soon! ");
  await tw.next((m) => m.type === "end", 6000);
  await twilioPost(statusCallback, { CallStatus: "completed" });

  const done = JSON.parse(
    ((await client.callTool({ name: "wait_for_reply", arguments: { call_id: first.call_id, timeout_seconds: 10 } })) as any)
      .content[0].text,
  );
  assert.deepEqual(done.open_requests, [{ request_id: reqId, request: "Prepare my tax summary", eta_seconds: 300 }]);
  assert.match(done.hint, /call_user/);
  tw.ws.close();
  await client.close();
});

test("natural turn-taking: no double greeting, no reply to 'okay', never hangs up unasked", async () => {
  const client = await mcp();
  const n = dialed.length;
  const callP = client.callTool({ name: "call_user", arguments: { message: "Hey, it's Claude again.", timeout_seconds: 15 } });
  while (dialed.length <= n) await sleep(10);
  const { url, statusCallback } = dialed.at(-1)!;
  const twiml = (await twilioPost(url, { CallStatus: "in-progress", AnsweredBy: "human" })).body;
  assert.equal(attr(twiml, "welcomeGreeting"), "Hey, it's Claude again.");
  const tw = await relay(attr(twiml, "url"));
  tw.send({ type: "setup", callSid: `CA${dialed.length}`, customParameters: { cid: param(twiml, "cid"), secret: param(twiml, "secret") } });

  tw.send({ type: "prompt", voicePrompt: "Hey, what's up", last: true });
  assert.equal(await tw.reply(), "Not much. What do you want to get into?");
  // "Okay." right after an open question means "let me think": stay quiet.
  tw.send({ type: "prompt", voicePrompt: "Okay.", last: true });
  await assert.rejects(tw.next((m) => m.type === "text", 1500));
  // The model tries to hang up although the caller never said goodbye: the server refuses.
  tw.send({ type: "prompt", voicePrompt: "Could you check flights to Utah?", last: true });
  assert.equal(await tw.reply(), "Okay, I'll look into flights after the call. ");
  await assert.rejects(tw.next((m) => m.type === "end", 3000));

  // A rhetorical question mid-reply is not the end of the turn.
  tw.send({ type: "prompt", voicePrompt: "What should we talk about, honestly", last: true });
  assert.equal(await tw.reply(), "Honestly? I think we should talk about the new model.");

  // A rambling reply is cut at a sentence boundary once it gets too long.
  tw.send({ type: "prompt", voicePrompt: "Go on, ramble", last: true });
  const long = await tw.reply();
  assert.ok(long.length < 420 && long.trim().endsWith("."), long);

  // The caller asks to end the call; the model says goodbye without the marker: still hangs up.
  tw.send({ type: "prompt", voicePrompt: "Okay, end the call.", last: true });
  assert.equal(await tw.reply(), "Alright, ending the call now. Take care.");
  await tw.next((m) => m.type === "end", 6000);

  await twilioPost(statusCallback, { CallStatus: "completed" });
  await callP;
  tw.ws.close();
  await client.close();
});

test("falls back to turn-by-turn if real-time voice never connects", async () => {
  const client = await mcp();
  const n = dialed.length;
  const callP = client.callTool({ name: "call_user", arguments: { message: "Quick question.", timeout_seconds: 10 } });
  while (dialed.length <= n) await sleep(10);
  const { url, statusCallback } = dialed.at(-1)!;
  await twilioPost(url, { CallStatus: "in-progress", AnsweredBy: "human" });
  // Relay failed to start: Twilio goes straight to the Connect action.
  const fb = await twilioPost(statusCallback.replace("/status", "/relay-done"), { SessionStatus: "failed" });
  assert.match(fb.body, /<Gather[^>]*input="speech".*Quick question\./s);
  await twilioPost(statusCallback.replace("/status", "/gather"), { SpeechResult: "Sure, go ahead." });
  const out = JSON.parse(((await callP) as any).content[0].text);
  assert.equal(out.user_said, "Sure, go ahead.");
  await twilioPost(statusCallback, { CallStatus: "completed" });
  await client.close();
});
