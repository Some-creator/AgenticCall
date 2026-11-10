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
import { attachRelayServer, MarkerFilter, type ChatMessage, type VoiceLLM } from "../src/realtime.js";

const AUTH = "test_auth_token";
const MCP_TOKEN = "secret-mcp-token";
let server: Server;
let base = "";
const dialed: { url: string; statusCallback: string }[] = [];
const llmCalls: ChatMessage[][] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Replies like a voice model would, streaming tokens. Splits the end marker across tokens on purpose.
const fakeLLM: VoiceLLM = {
  async *stream(messages, signal) {
    llmCalls.push(messages.map((m) => ({ ...m })));
    const last = messages.at(-1)!.content.toLowerCase();
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
      yield t;
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
    groq: { apiKey: "x", model: "test" },
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
  assert.equal(attr(twiml, "welcomeGreeting"), "Hi Sam, this is Muse. Your 3pm with Dana needs to move. Is 2pm okay?");
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
    ["Yeah, 2pm works.", "Let's chat a bit", "Tell me a story", "Never mind. Bye!"],
  );
  tw.ws.close();
  await client.close();
});

test("falls back to turn-by-turn if real-time voice never connects", async () => {
  const client = await mcp();
  const callP = client.callTool({ name: "call_user", arguments: { message: "Quick question.", timeout_seconds: 10 } });
  while (dialed.length < 2) await sleep(10);
  const { url, statusCallback } = dialed[1];
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
