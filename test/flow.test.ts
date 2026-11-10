import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import twilio from "twilio";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import { CallManager, type Telephony } from "../src/calls.js";
import type { Config } from "../src/config.js";

const AUTH = "test_auth_token";
const MCP_TOKEN = "secret-mcp-token";

let server: Server;
let base = "";
let cfg: Config;
const dialed: { url: string; statusCallback: string }[] = [];
const sms: string[] = [];
let quiet = false;

const fakeTel: Telephony = {
  async createCall(o) {
    dialed.push(o);
    return { sid: `CA${dialed.length}` };
  },
  async hangup() {},
  async sendSms(o) {
    sms.push(o.body);
    return { sid: `SM${sms.length}` };
  },
};

before(async () => {
  cfg = {
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
    ackPhrases: ["Mm-hm."],
    maxHoldSeconds: 120,
    maxCallSeconds: 900,
    maxCallsPerHour: 6,
    quietHours: null,
    timezone: "America/New_York",
    defaultMode: "turn_by_turn",
    agentAnswerTimeoutSeconds: 45,
    callbackThresholdSeconds: 60,
    groq: { apiKey: null, model: "test" },
    relay: {},
  };
  const calls = new CallManager(cfg, fakeTel);
  const app = createApp(cfg, calls);
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cfg.publicBaseUrl = base; // CallManager reads cfg lazily
  // quiet-hours toggle for one test
  Object.defineProperty(cfg, "quietHours", { get: () => (quiet ? { start: 0, end: 24 * 60 } : null) });
});

after(() => server.close());

async function twilioPost(url: string, params: Record<string, string>, sign = true): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (sign) headers["X-Twilio-Signature"] = twilio.getExpectedTwilioSignature(AUTH, url, params);
  const res = await fetch(url, { method: "POST", headers, body: new URLSearchParams(params) });
  return { status: res.status, body: await res.text() };
}

async function mcpClient(token = MCP_TOKEN) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

function parse(result: any) {
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
}

const urlFor = (path: string, statusCallback: string) => statusCallback.replace("/twilio/status", `/twilio/${path}`);

test("rejects MCP requests without the token", async () => {
  await assert.rejects(mcpClient("wrong"));
});

test("rejects unsigned Twilio webhooks", async () => {
  const r = await twilioPost(`${base}/twilio/voice?cid=x`, { CallStatus: "in-progress" }, false);
  assert.equal(r.status, 403);
});

test("full two-way conversation", async () => {
  const client = await mcpClient();
  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(tools, ["acknowledge_request", "answer_on_call", "call_user", "end_call", "get_call", "list_calls", "say_on_call", "send_sms", "wait_for_reply"]);

  const callP = client.callTool({
    name: "call_user",
    arguments: { message: "Your 3pm meeting moved to 2pm. Should I accept?", caller_name: "Muse", urgency: "high", timeout_seconds: 10 },
  });
  while (dialed.length === 0) await new Promise((r) => setTimeout(r, 10));
  const { url, statusCallback } = dialed[0];

  await twilioPost(statusCallback, { CallStatus: "ringing" });
  const answered = await twilioPost(url, { CallStatus: "in-progress", AnsweredBy: "human" });
  assert.match(answered.body, /<Gather[^>]*input="speech"/);
  assert.match(answered.body, /Hi Sam, this is Muse\. Your 3pm meeting moved to 2pm\. Should I accept\?/);

  const afterSpeech = await twilioPost(urlFor("gather", statusCallback), { SpeechResult: "Yes, accept it.", Confidence: "0.93" });
  assert.match(afterSpeech.body, /<Say[^>]*>Mm-hm\.<\/Say><Redirect[^>]*>[^<]*\/twilio\/hold/);
  assert.doesNotMatch(afterSpeech.body, /<Pause/);

  const first = parse(await callP);
  assert.equal(first.user_said, "Yes, accept it.");
  assert.equal(first.status, "in_progress");

  // Twilio is long-polling /hold while the agent decides what to say.
  const holdP = twilioPost(urlFor("hold", statusCallback), {});
  const sayP = client.callTool({
    name: "say_on_call",
    arguments: { call_id: first.call_id, message: "Done, it's accepted. Anything else?", timeout_seconds: 10 },
  });
  const hold = await holdP;
  assert.match(hold.body, /<Gather.*Done, it&apos;s accepted\. Anything else\?|<Gather.*Done, it's accepted\. Anything else\?/s);

  // Silence once -> server re-prompts by itself; then the user answers.
  const reprompt = await twilioPost(urlFor("gather", statusCallback), { SpeechResult: "" });
  assert.match(reprompt.body, /Are you still there\?/);
  await twilioPost(urlFor("gather", statusCallback), { SpeechResult: "No, that's all." });
  const second = parse(await sayP);
  assert.equal(second.user_said, "No, that's all.");

  const hold2P = twilioPost(urlFor("hold", statusCallback), {});
  const endP = client.callTool({ name: "end_call", arguments: { call_id: first.call_id, message: "Great, bye!" } });
  const hold2 = await hold2P;
  assert.match(hold2.body, /Great, bye!<\/Say><Hangup\/>/);
  await twilioPost(statusCallback, { CallStatus: "completed" });
  const ended = parse(await endP);
  assert.equal(ended.status, "completed");
  assert.deepEqual(
    ended.transcript.map((t: any) => t.role),
    ["agent", "user", "agent", "system", "user", "agent"],
  );
  await client.close();
});

test("voicemail leaves a message and texts the user", async () => {
  const client = await mcpClient();
  const callP = client.callTool({ name: "call_user", arguments: { message: "Server is down.", timeout_seconds: 10 } });
  while (dialed.length < 2) await new Promise((r) => setTimeout(r, 10));
  const r = await twilioPost(dialed[1].url, { CallStatus: "in-progress", AnsweredBy: "machine_end_beep" });
  assert.match(r.body, /Server is down\. I'll also send you a text\.<\/Say><Hangup\/>/);
  const res = parse(await callP);
  assert.equal(res.status, "voicemail");
  await new Promise((r) => setTimeout(r, 20));
  assert.match(sms.at(-1)!, /Tried to call you: Server is down\./);
  await client.close();
});

test("quiet hours refuse non-critical calls", async () => {
  quiet = true;
  try {
    const client = await mcpClient();
    const res: any = await client.callTool({ name: "call_user", arguments: { message: "FYI", urgency: "normal" } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /quiet hours/);
    await client.close();
  } finally {
    quiet = false;
  }
});
