# AgenticCall

An MCP server that lets AI agents like **Meta Muse** and **Claude Duet** **phone you** through Twilio
when something important comes up, and then **hold a live two-way voice conversation**. The agent
speaks, hears what you say back, and responds, all on the same call.

```
 AI agent (Muse / Duet / Claude)                 AgenticCall server                    Twilio            You
 ───────────────────────────────                 ──────────────────                    ──────            ───
 call_user("Your 3pm moved to 2pm. Accept?") ──►  dial  ───────────────────────────►  rings  ───────►  📞 answer
                                                  <Say> greeting + message, <Gather> ◄──────────────── "Yes, accept it"
 ◄── { user_said: "Yes, accept it" }              speech-to-text result
 say_on_call("Done. Anything else?")         ──►  (you hear hold silence while the agent thinks)
                                                  <Say> + <Gather>  ─────────────────────────────────► "No, that's all"
 ◄── { user_said: "No, that's all" }
 end_call("Great, bye!")                     ──►  <Say> + <Hangup>
```

## Features

- **Two-way voice.** Twilio speech recognition turns your words into text for the agent, and neural
  TTS reads the agent's replies. You can interrupt (barge in) while it is talking.
- **Voicemail aware.** If voicemail picks up, it leaves the message and **texts it to you** too.
  It also texts you if you don't answer or the line is busy.
- **Guardrails.**
  - It can only call or text `USER_PHONE_NUMBER`, so an agent can't dial anyone else.
  - Quiet hours: only `urgency: "critical"` calls ring during that window.
  - There is an hourly call limit, and only one call can be active at a time.
  - Twilio webhook signatures are validated.
  - The MCP endpoint requires a bearer token.
- **Both MCP transports.**
  - Streamable HTTP at `/mcp` for cloud agents such as Muse, Duet and claude.ai connectors.
  - `stdio` for Claude Desktop and Claude Code.

## Tools exposed to the agent

| Tool | What it does |
|---|---|
| `call_user` | Rings you, greets you ("Hi Sam, this is Muse."), says the message, and returns what you said back. |
| `say_on_call` | Says the next line on the live call and returns your reply (`listen: false` just speaks). |
| `wait_for_reply` | Keeps listening if a result came back with `still_waiting: true`, for example while the phone is still ringing. |
| `end_call` | Says goodbye, hangs up, and returns the transcript. |
| `get_call` / `list_calls` | Return call status and transcripts. |
| `send_sms` | Texts you for things that don't need a call, or as a summary after one. |

The server also sends the agent **instructions** covering three things: when a call is warranted, how
to write for speech (short sentences, no markdown) and how to run the conversation loop.

---

## 1. Twilio setup

1. Create an account at [twilio.com](https://www.twilio.com) and buy a **voice-capable phone number**.
2. From the Console dashboard, copy your **Account SID** and **Auth Token**.
3. On a **trial account**:
   - Verify your own phone number under *Phone Numbers → Verified Caller IDs*.
   - Calls will start with a short Twilio trial notice. Upgrading removes it.
4. Calling some countries needs Geo Permissions enabled (*Voice → Settings → Geo permissions*).

You don't need to configure webhooks on the number. The server passes its URLs to Twilio on every call.

## 2. Configure

```bash
cp .env.example .env
```

Fill in `TWILIO_*`, `USER_PHONE_NUMBER`, `PUBLIC_BASE_URL` and `MCP_AUTH_TOKEN`. Generate the token with:

```bash
openssl rand -hex 32
```

## 3. Run it somewhere Twilio can reach

Twilio has to reach your server over public HTTPS. Cloud agents like Muse and Duet run in the cloud,
so they need a public URL too. A server on your laptop's localhost won't work for them.

**Option A: deploy the Docker image (recommended).** Works on Render, Railway, Fly.io, a VPS, and so on.

```bash
docker build -t agentic-call .
```

```bash
docker run -p 3000:3000 --env-file .env agentic-call
```

Set `PUBLIC_BASE_URL` to the service's public URL, for example `https://agentic-call.onrender.com`.

**Option B: run locally with a tunnel** (handy for testing).

```bash
npm install && npm run build
```

```bash
ngrok http 3000
```

Put the ngrok `https://…` URL into `PUBLIC_BASE_URL`, then start the server:

```bash
npm start
```

To check it's up, `GET https://<your-host>/` should return `{"ok":true}`.

## 4. Connect your agents

Your MCP URL:

```
https://<your-host>/mcp
```

The URL needs auth in one of two forms:
- The header `Authorization: Bearer <MCP_AUTH_TOKEN>`
- For clients that only accept a URL: `https://<your-host>/mcp?token=<MCP_AUTH_TOKEN>`

Treat the token like a password, because anyone holding the URL with the token can make your phone ring.

### Meta Muse
Muse doesn't have a documented "add MCP server" setting. Third-party guides describe adding one
through a **Custom Connector**: you tell Muse to connect to a remote MCP server over Streamable HTTP
and give it the URL above. Muse Code takes MCP servers in its settings file. Use the `?token=` URL
form if it can't send headers.

### Claude Duet / Claude (claude.ai, desktop, mobile)
Go to **Settings → Connectors → Add custom connector** and paste
`https://<your-host>/mcp?token=<MCP_AUTH_TOKEN>`.

### Claude Desktop / Claude Code (local, stdio)
In stdio mode the server still opens `PORT` for Twilio webhooks, so you still need `PUBLIC_BASE_URL`
(a tunnel works).

```json
{
  "mcpServers": {
    "agentic-call": {
      "command": "node",
      "args": ["/path/to/AgenticCall/dist/index.js", "--stdio"],
      "env": {
        "TWILIO_ACCOUNT_SID": "AC…",
        "TWILIO_AUTH_TOKEN": "…",
        "TWILIO_FROM_NUMBER": "+1…",
        "USER_PHONE_NUMBER": "+1…",
        "PUBLIC_BASE_URL": "https://your-tunnel.ngrok.app"
      }
    }
  }
}
```

Or connect Claude Code to the remote HTTP server:

```bash
claude mcp add --transport http agentic-call https://<your-host>/mcp --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

## 5. Tell your agent when to call you

An MCP server only gives the agent the *ability* to call you. The agent still decides *when*.

To get calls for important tasks and notifications, give the agent something that runs on its own:
a scheduled task, a background check, or a standing instruction. For example:

> Every hour, check my email, calendar and task list. If anything is urgent or time-sensitive
> (a meeting change in the next 3 hours, a message from my boss, a failed payment, a security alert),
> call me with `call_user`. Briefly explain it and ask what I want to do, then act on my answer.
> Text me with `send_sms` for anything that matters but can wait. Otherwise do nothing.

## Configuration reference

All options are listed in [`.env.example`](.env.example). The main ones:

| Variable | Default | Notes |
|---|---|---|
| `QUIET_HOURS` / `TIMEZONE` | unset / `America/New_York` | Example: `22:00-07:00`. Only `critical` calls ring during this window. |
| `MAX_CALLS_PER_HOUR` | `6` | `critical` calls bypass this limit. |
| `TWILIO_VOICE` | `Polly.Joanna-Neural` | Any voice Twilio `<Say>` supports. |
| `ANSWERING_MACHINE_DETECTION` | `true` | Uses Twilio AMD; adds a few seconds before the greeting. |
| `SPEECH_TIMEOUT_SECONDS` | `8` | Silence before the "are you still there?" re-prompt. |
| `MAX_HOLD_SECONDS` | `120` | Hangs up politely if the agent stops responding. |

## Development

```bash
npm install
```

```bash
npm test
```

```bash
npm run dev
```

The tests run a full simulated call with no network access. They drive signed Twilio webhooks and a
real MCP client through answer → speech → agent reply → re-prompt on silence → hang-up, and they also
cover voicemail with the SMS fallback, quiet hours and auth.

### Notes and limits
- Call state is kept in memory. Run a **single instance**, and calls in progress are lost on restart.
- While the agent is thinking, you hear silence. Turn latency is speech recognition time plus the
  agent's own response time, typically a few seconds.
- Twilio bills per call minute, per speech-recognition request and per SMS. See Twilio pricing.
