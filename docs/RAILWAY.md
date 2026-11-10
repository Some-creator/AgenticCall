# Deploying AgenticCall on Railway

Railway builds the repo's `Dockerfile` automatically. You add your variables, generate a public domain,
and get an HTTPS URL you can use for both Twilio and your AI agents.

You'll need:
- a [Railway](https://railway.com) account
- the Twilio details from the main README: Account SID, Auth Token and your Twilio number
- this repo on GitHub

---

## Option A: Dashboard (from GitHub)

### 1. Create the service
1. In Railway, create a **New Project** and choose **Deploy from GitHub repo**.
2. Pick `AgenticCall` and approve Railway's GitHub access if it asks.
3. Open the service's **Settings → Source** and set the **branch** to the one you want to deploy.
   Use `main` once this work is merged, or `claude/twilio-mcp-voice-calls-vpxjxv` for now.

Railway finds the `Dockerfile` and builds it. The first deploy will crash because the variables aren't
set yet. That's expected.

### 2. Add variables
Open **Variables**, click **Raw Editor**, and paste this with your values filled in:

```env
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_FROM_NUMBER=+15550001111
USER_PHONE_NUMBER=+15552223333
USER_NAME=YourName
MCP_AUTH_TOKEN=paste-a-long-random-string-here
PORT=3000
TIMEZONE=America/New_York
QUIET_HOURS=22:00-07:00
```

Generate `MCP_AUTH_TOKEN` with `openssl rand -hex 32`. Any password manager's 40+ character random
string also works. Phone numbers are in E.164 format (`+` then the country code).

You **don't need `PUBLIC_BASE_URL`** on Railway. If it's unset, the server builds it from Railway's
`RAILWAY_PUBLIC_DOMAIN` variable. If you later add a custom domain, set
`PUBLIC_BASE_URL=https://your.custom.domain`.

### 3. Give it a public URL
1. Go to **Settings → Networking → Generate Domain**.
2. When it asks for a port, enter **3000**, the same value as `PORT` above.

You'll get a domain like `agentic-call-production.up.railway.app`.

### 4. Recommended service settings
Under **Settings → Deploy**:

| Setting | Value | Why |
|---|---|---|
| Healthcheck Path | `/` | Railway waits for `{"ok":true}` before switching traffic over. |
| Replicas | **1** | Call state is in memory, so with 2+ replicas Twilio's webhooks can hit the wrong one. |
| Serverless / App Sleeping | **Off** | Sleeping drops in-memory call state, so a call can break partway through. |
| Restart Policy | On Failure | This is the default. |

Redeploying (for example after changing a variable) ends any call in progress. Avoid doing it mid-call.

### 5. Check it
Open `https://<your-domain>/`. It should return `{"ok":true,"name":"agentic-call"}`.

The **Deploy Logs** should show:

```
INFO  Twilio webhooks at https://<your-domain>/twilio/* (listening on 0.0.0.0:3000)
INFO  MCP endpoint at https://<your-domain>/mcp
```

If the deploy crashes instead, the log names the missing variable, such as
`Missing required environment variable TWILIO_AUTH_TOKEN`.

---

## Option B: Railway CLI

```bash
npm i -g @railway/cli
```

```bash
railway login
```

From the repo folder, create a project and deploy the local code:

```bash
railway init
```

```bash
railway up
```

Set the variables. Repeat `--set` for each one in the list above:

```bash
railway variables --set "TWILIO_ACCOUNT_SID=AC..." --set "TWILIO_AUTH_TOKEN=..." --set "TWILIO_FROM_NUMBER=+1..." --set "USER_PHONE_NUMBER=+1..." --set "MCP_AUTH_TOKEN=..." --set "PORT=3000"
```

Then generate the public domain:

```bash
railway domain
```

Finally, apply the settings from step 4 in the dashboard.

---

## Make a real test call

From your computer, inside the repo:

```bash
npm install
```

```bash
npm run test-call -- https://<your-domain>/mcp <MCP_AUTH_TOKEN>
```

Your phone rings. Whatever you say shows up in the terminal, and whatever you type back is spoken to
you on the call. Type `bye` to hang up and print the transcript. The test uses `urgency: "critical"`
so quiet hours don't block it.

## Connect your agents

Use this URL as a custom connector in Meta Muse, Claude Duet or claude.ai:

```
https://<your-domain>/mcp?token=<MCP_AUTH_TOKEN>
```

For clients that support headers, use `https://<your-domain>/mcp` with
`Authorization: Bearer <MCP_AUTH_TOKEN>`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Phone never rings, and the tool says "Twilio refused to place the call" | Check the SID, token and `TWILIO_FROM_NUMBER`. On a trial account, verify `USER_PHONE_NUMBER` in Twilio. |
| Call connects, then says "an application error has occurred" | Twilio couldn't reach or validate the webhooks. Check that `PUBLIC_BASE_URL` (or the generated domain) matches the URL you open in a browser exactly, then look for `rejected ... Twilio webhook` in the logs. |
| `401 Unauthorized` from `/mcp` | The token in the connector URL doesn't match `MCP_AUTH_TOKEN`. |
| "Application failed to respond" | The domain's port doesn't match `PORT`. Edit the domain to use 3000. |
| Call refused with "quiet hours" | Expected. Only `critical` calls ring inside `QUIET_HOURS`. |
