import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApp } from "../src/app.js";
import { CallManager, type Telephony } from "../src/calls.js";
import type { Config } from "../src/config.js";
import { attachRelayServer, type LLMEvent, type VoiceLLM } from "../src/realtime.js";

const MCP_TOKEN = "secret-mcp-token";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A key pair standing in for Telnyx's webhook signing key.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawPublicKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");

let server: Server;
let base = "";
const dialed: { cid: string; webhookUrl: string }[] = [];
const relays: { sid: string; url: string; greeting: string; customParameters: Record<string, string> }[] = [];
const hungUp: string[] = [];

const tel: Telephony = {
  provider: "telnyx",
  async createCall(o) {
    dialed.push({ cid: o.cid, webhookUrl: o.webhookUrl });
    return { sid: `v3:ctrl-${dialed.length}` };
  },
  async hangup(sid) {
    hungUp.push(sid);
  },
  async sendSms() {
    throw new Error("no sms");
  },
  async startRelay(sid, o) {
    relays.push({ sid, ...o });
  },
};

const llm: VoiceLLM = {
  async *stream(messages): AsyncIterable<LLMEvent> {
    const last = messages.at(-1)!.content.toLowerCase();
    yield { type: "text", text: last.includes("bye") ? "Talk soon! [END_CALL]" : "Hey! Yeah, I can hear you fine." };
  },
  async complete() {
    return '{"summary":"Quick test.","user_decisions":[],"follow_ups":[]}';
  },
};

function cfgFor(telnyx: boolean): Config {
  return {
    twilio: null,
    telnyx: telnyx ? { apiKey: "KEY", connectionId: "conn", fromNumber: "+15550000000", publicKey: rawPublicKey, voice: "AWS.Polly.Matthew-Neural" } : null,
    phoneProvider: telnyx ? "telnyx" : null,
    userPhoneNumber: "+15551112222",
    userName: "Sam",
    publicBaseUrl: "",
    port: 0,
    host: "127.0.0.1",
    transport: "http",
    mcpAuthToken: MCP_TOKEN,
    allowUnauthenticatedMcp: false,
    voice: "x",
    language: "en-US",
    answeringMachineDetection: false,
    speechTimeoutSeconds: 8,
    speechEndTimeout: "auto",
    speechModel: "phone_call",
    ackPhrases: [],
    maxHoldSeconds: 120,
    maxCallSeconds: 900,
    maxCallsPerHour: 20,
    quietHours: null,
    timezone: "America/Chicago",
    defaultMode: "realtime",
    agentAnswerTimeoutSeconds: 45,
    callbackThresholdSeconds: 60,
    groq: { apiKey: null, model: "test", fallbackModel: "test" },
    anthropic: { apiKey: "x", model: "test" },
    memoryFile: null,
    relay: {},
  };
}

before(async () => {
  const cfg = cfgFor(true);
  const calls = new CallManager(cfg, tel, { llm });
  const app = createApp(cfg, calls);
  server = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  attachRelayServer(server, calls);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cfg.publicBaseUrl = base;
});
after(() => server.close());

async function telnyxEvent(event_type: string, payload: Record<string, unknown>, signed = true) {
  const body = JSON.stringify({ data: { event_type, payload, record_type: "event" } });
  const ts = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = { "content-type": "application/json", "telnyx-timestamp": ts };
  headers["telnyx-signature-ed25519"] = signed
    ? sign(null, Buffer.from(`${ts}|${body}`), privateKey).toString("base64")
    : Buffer.alloc(64).toString("base64");
  return fetch(`${base}/telnyx/webhook`, { method: "POST", headers, body });
}

async function mcp(url = base) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
    }),
  );
  return client;
}

test("unsigned Telnyx webhooks are rejected", async () => {
  assert.equal((await telnyxEvent("call.answered", {}, false)).status, 403);
});

test("a Telnyx call: dial, answer, relay conversation, goodbye, hang up", async () => {
  const client = await mcp();
  const callP = client.callTool({ name: "call_user", arguments: { message: "Quick test call.", timeout_seconds: 15 } });
  while (dialed.length === 0) await sleep(10);
  const { cid, webhookUrl } = dialed[0];
  assert.ok(webhookUrl.startsWith(`${base}/telnyx/webhook?cid=`), webhookUrl);
  const client_state = Buffer.from(cid).toString("base64");

  assert.equal((await telnyxEvent("call.initiated", { call_control_id: "v3:ctrl-1", client_state })).status, 200);
  await telnyxEvent("call.answered", { call_control_id: "v3:ctrl-1", client_state });
  while (relays.length === 0) await sleep(10);
  const relay = relays[0];
  assert.equal(relay.sid, "v3:ctrl-1");
  assert.equal((relay as any).voice, "AWS.Polly.Matthew-Neural");
  assert.equal(relay.greeting, "Hi Sam, it's your AI assistant. Quick test call.");
  assert.match(relay.url, /^ws:\/\/127\.0\.0\.1:\d+\/twilio\/relay\?cid=/);

  // Telnyx-style (snake_case) frames are understood.
  const ws = new WebSocket(relay.url);
  const inbox: any[] = [];
  ws.on("message", (d) => inbox.push(JSON.parse(String(d))));
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "setup", call_control_id: "v3:ctrl-1", custom_parameters: relay.customParameters }));
  ws.send(JSON.stringify({ type: "prompt", voice_prompt: "Can you hear me?", last: true }));
  const until = async (pred: (m: any) => boolean) => {
    for (let i = 0; i < 300 && !inbox.some(pred); i++) await sleep(20);
    return inbox.find(pred);
  };
  assert.ok(await until((m) => m.type === "text" && /hear you fine/.test(m.token)));

  // One sentence split into two fragments gets ONE reply, not two that run together.
  inbox.length = 0;
  ws.send(JSON.stringify({ type: "prompt", voice_prompt: "Yeah.", last: true }));
  await sleep(150);
  ws.send(JSON.stringify({ type: "prompt", voice_prompt: "I can hear you.", last: true }));
  await sleep(1500);
  assert.equal(inbox.filter((m) => m.type === "text" && m.last).length, 1);

  ws.send(JSON.stringify({ type: "prompt", voice_prompt: "Okay bye!", last: true }));
  for (let i = 0; i < 200 && !inbox.some((m) => m.type === "text" && /Talk soon/.test(m.token)); i++) await sleep(20);
  // Telnyx reports an "interrupt" carrying the whole reply when the caller speaks after it finished playing:
  // that must not cancel the hang-up.
  ws.send(JSON.stringify({ type: "interrupt", utterance_until_interrupt: "Talk soon! " }));
  assert.ok(await until((m) => m.type === "end"));
  // Telnyx keeps the line open after the relay ends, so the server hangs up itself.
  for (let i = 0; i < 200 && !hungUp.includes("v3:ctrl-1"); i++) await sleep(20);
  assert.ok(hungUp.includes("v3:ctrl-1"));

  await telnyxEvent("call.hangup", { call_control_id: "v3:ctrl-1", client_state, hangup_cause: "normal_clearing" });
  const res = JSON.parse(((await callP) as any).content[0].text);
  const done =
    res.status === "completed"
      ? res
      : JSON.parse(((await client.callTool({ name: "wait_for_reply", arguments: { call_id: res.call_id, timeout_seconds: 10 } })) as any).content[0].text);
  assert.equal(done.status, "completed");
  ws.close();
  await client.close();
});

test("without a Telnyx public key, webhooks are checked with the per-call URL secret", async () => {
  const cfg = cfgFor(true);
  cfg.telnyx!.publicKey = null;
  const local: { cid: string; webhookUrl: string }[] = [];
  const t2: Telephony = { ...tel, async createCall(o) { local.push({ cid: o.cid, webhookUrl: o.webhookUrl }); return { sid: "v3:ctrl-x" }; } };
  const calls = new CallManager(cfg, t2, { llm });
  const app = createApp(cfg, calls);
  const s = await new Promise<Server>((r) => {
    const x = app.listen(0, "127.0.0.1", () => r(x));
  });
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  cfg.publicBaseUrl = url;
  await calls.startCall({ message: "hi" });
  const hook = new URL(local[0].webhookUrl);
  assert.equal(hook.pathname, "/telnyx/webhook");
  const body = JSON.stringify({ data: { event_type: "call.initiated", payload: { call_control_id: "v3:ctrl-x" } } });
  const post = (u: string) => fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body });
  assert.equal((await post(local[0].webhookUrl)).status, 200);
  const wrong = new URL(local[0].webhookUrl);
  wrong.searchParams.set("token", "nope");
  assert.equal((await post(wrong.toString())).status, 403);
  assert.equal((await post(`${url}/telnyx/webhook`)).status, 403);
  s.close();
});

test("with no phone provider, calling fails with a clear message instead of crashing", async () => {
  const cfg = cfgFor(false);
  const calls = new CallManager(cfg, null, { llm });
  const app = createApp(cfg, calls);
  const s = await new Promise<Server>((r) => {
    const x = app.listen(0, "127.0.0.1", () => r(x));
  });
  const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  const client = await mcp(url);
  const res: any = await client.callTool({ name: "call_user", arguments: { message: "hi" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Phone calls are turned off/);
  await client.close();
  s.close();
});
