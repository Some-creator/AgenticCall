# Calling through Telnyx

Telnyx places real phone calls like Twilio, at a lower per-minute price. The server uses Telnyx Call Control
to dial, and Telnyx's Conversation Relay to stream the call to the same real-time voice (Claude/Groq) as before.

Menu names below may differ slightly in Telnyx's portal; the pieces you need are the same.

## 1. Telnyx account
1. Sign up at telnyx.com and add a little credit (calls cost cents).
2. **Buy a phone number** (Numbers -> Search & Buy) with voice enabled.

## 2. Voice API application
1. Go to **Voice -> Programmable Voice** (Call Control / Voice API applications) and create an application.
2. Set its **webhook URL** to `https://<your-railway-domain>/telnyx/webhook` (method POST).
3. Give it an **Outbound Voice Profile** that allows calls to your country (create one if needed); without
   this, outbound calls are refused.
4. Assign your new phone number to this application.
5. Copy the application's **ID**: that's `TELNYX_CONNECTION_ID`.

## 3. Keys
- **API key:** Account -> API Keys -> create one. That's `TELNYX_API_KEY`.
- **Public key (optional):** Account -> Keys & Credentials -> Public Key. If one is shown, set it as
  `TELNYX_PUBLIC_KEY` and webhooks are checked by signature. If it says "No key found", leave it out: each call's
  webhook URL then carries a random per-call secret, and webhooks without it are rejected.

## 4. Railway variables
```env
TELNYX_API_KEY=KEY...
TELNYX_CONNECTION_ID=...
TELNYX_FROM_NUMBER=+1...
# TELNYX_PUBLIC_KEY=...   (optional)
```
You can delete the `TWILIO_*` variables, or keep them: when Telnyx is set up it's used by default
(`PHONE_PROVIDER=twilio` switches back). After redeploying, the logs should say `Phone calls via telnyx`.

## Notes
- Telnyx calls always use the real-time voice, so `ANTHROPIC_API_KEY` or `GROQ_API_KEY` must be set.
- Texting (`send_sms`) isn't wired up for Telnyx yet; texts are skipped.
- On the first calls, the logs show `relay frame: type=... keys=...` lines. If the voice doesn't hear you,
  send those lines over: they show exactly what Telnyx sends so any field naming can be matched.
- With no provider at all, the server still runs; calls just return "phone calls are turned off".
