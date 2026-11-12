#!/usr/bin/env node
// Place a real test call through a deployed AgenticCall server and play "the agent" from your terminal.
// Usage: node scripts/test-call.mjs https://<host>/mcp <MCP_AUTH_TOKEN> ["opening message"]
import readline from "node:readline/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [url, token, message = "This is a test call from AgenticCall. Can you hear me? Say something back."] =
  process.argv.slice(2);
if (!url || !token) {
  console.error('Usage: node scripts/test-call.mjs https://<host>/mcp <MCP_AUTH_TOKEN> ["opening message"]');
  process.exit(1);
}

const client = new Client({ name: "agentic-call-test", version: "1.0.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}

const live = (s) => ["dialing", "ringing", "in_progress"].includes(s);

console.log("Calling you…");
let r;
try {
  r = await call("call_user", { message, caller_name: "AgenticCall test", urgency: "critical", timeout_seconds: 60 });
} catch (e) {
  console.error(`Could not place the call: ${e.message}`);
  process.exit(1);
}
while (true) {
  while (r.still_waiting) r = await call("wait_for_reply", { call_id: r.call_id, timeout_seconds: 60 });
  if (!live(r.status)) {
    console.log(`Call ended: ${r.status}. ${r.hint}`);
    break;
  }
  console.log(r.user_said ? `\nYou said: "${r.user_said}"` : "\n(silence)");
  const reply = (await rl.question('Type the agent\'s reply (or "bye" to hang up): ')).trim();
  if (!reply || reply.toLowerCase() === "bye") {
    const done = await call("end_call", { call_id: r.call_id, message: "Thanks, that's the end of the test. Goodbye!" });
    console.log("\nTranscript:");
    for (const t of done.transcript) console.log(`  ${t.role.padEnd(6)} ${t.text}`);
    break;
  }
  r = await call("say_on_call", { call_id: r.call_id, message: reply, timeout_seconds: 60 });
}
rl.close();
await client.close();
