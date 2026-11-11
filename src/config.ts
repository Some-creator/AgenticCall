import "dotenv/config";

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name]?.trim();
  return v ? v : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (!v) return fallback;
  return ["1", "true", "yes", "on"].includes(v);
}

function int(name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a whole number, got "${v}"`);
  const n = Number(v);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}, got ${n}`);
  return n;
}

function callMode(raw: string | undefined, hasGroq: boolean): "realtime" | "turn_by_turn" {
  const v = raw?.trim().toLowerCase();
  if (!v) return hasGroq ? "realtime" : "turn_by_turn";
  if (v === "realtime" || v === "turn_by_turn") {
    if (v === "realtime" && !hasGroq) throw new Error("CALL_MODE=realtime needs GROQ_API_KEY (free at console.groq.com)");
    return v;
  }
  throw new Error(`CALL_MODE must be "realtime" or "turn_by_turn", got "${raw}"`);
}

function speechEnd(v: string): string {
  if (v === "auto" || /^\d+$/.test(v)) return v;
  throw new Error(`SPEECH_END_TIMEOUT must be "auto" or whole seconds, got "${v}"`);
}

export interface QuietHours {
  /** minutes after midnight */
  start: number;
  end: number;
}

function parseQuietHours(raw: string | undefined): QuietHours | null {
  if (!raw?.trim()) return null;
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`QUIET_HOURS must look like "22:00-07:00", got "${raw}"`);
  const [, h1, m1, h2, m2] = m.map(Number);
  return { start: h1 * 60 + m1, end: h2 * 60 + m2 };
}

export interface Config {
  twilio: {
    accountSid: string;
    authToken: string;
    fromNumber: string;
    validateSignature: boolean;
  };
  userPhoneNumber: string;
  userName: string;
  publicBaseUrl: string;
  port: number;
  host: string;
  transport: "http" | "stdio";
  mcpAuthToken: string | null;
  allowUnauthenticatedMcp: boolean;
  voice: string;
  language: string;
  answeringMachineDetection: boolean;
  speechTimeoutSeconds: number;
  /** Silence after speech before the turn ends: "auto" or whole seconds. */
  speechEndTimeout: string;
  speechModel: string;
  ackPhrases: string[];
  maxHoldSeconds: number;
  maxCallSeconds: number;
  maxCallsPerHour: number;
  quietHours: QuietHours | null;
  timezone: string;
  /** "realtime": a fast voice model on this server runs the conversation. "turn_by_turn": the calling agent answers each turn. */
  defaultMode: "realtime" | "turn_by_turn";
  /** How long the voice model waits for the calling agent to answer a mid-call request before saying so. */
  agentAnswerTimeoutSeconds: number;
  /** Requests estimated to take longer than this get a "stay on the line or call you back?" offer. */
  callbackThresholdSeconds: number;
  groq: { apiKey: string | null; model: string; fallbackModel: string };
  relay: { ttsProvider?: string; voice?: string; transcriptionProvider?: string; speechModel?: string };
}

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  let transport = optional("MCP_TRANSPORT", "http").toLowerCase();
  if (argv.includes("--stdio")) transport = "stdio";
  if (argv.includes("--http")) transport = "http";
  if (transport !== "http" && transport !== "stdio") {
    throw new Error(`MCP_TRANSPORT must be "http" or "stdio", got "${transport}"`);
  }

  // On Railway, fall back to the service's generated domain if PUBLIC_BASE_URL isn't set.
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (!process.env.PUBLIC_BASE_URL?.trim() && railwayDomain) {
    process.env.PUBLIC_BASE_URL = `https://${railwayDomain.replace(/^https?:\/\//, "")}`;
  }
  const rawBase = required("PUBLIC_BASE_URL");
  let parsed: URL;
  try {
    parsed = new URL(/^https?:\/\//i.test(rawBase) ? rawBase : `https://${rawBase}`);
  } catch {
    throw new Error(`PUBLIC_BASE_URL is not a valid URL: "${rawBase}"`);
  }
  // Webhooks are always served from the root (/twilio/...), so keep only scheme + host.
  // This tolerates values like "https://host/mcp" or "host.up.railway.app".
  const publicBaseUrl = parsed.origin;
  if (publicBaseUrl !== rawBase.replace(/\/+$/, "")) {
    console.error(`WARN  PUBLIC_BASE_URL "${rawBase}" normalised to "${publicBaseUrl}"`);
  }

  return {
    twilio: {
      accountSid: required("TWILIO_ACCOUNT_SID"),
      authToken: required("TWILIO_AUTH_TOKEN"),
      fromNumber: required("TWILIO_FROM_NUMBER"),
      validateSignature: bool("TWILIO_VALIDATE_SIGNATURE", true),
    },
    userPhoneNumber: required("USER_PHONE_NUMBER"),
    userName: optional("USER_NAME", "there"),
    publicBaseUrl,
    port: int("PORT", 3000, 1, 65535),
    host: optional("HOST", "0.0.0.0"),
    transport,
    mcpAuthToken: process.env.MCP_AUTH_TOKEN?.trim() || null,
    allowUnauthenticatedMcp: bool("ALLOW_UNAUTHENTICATED_MCP", false),
    voice: optional("TWILIO_VOICE", "Polly.Joanna-Neural"),
    language: optional("CALL_LANGUAGE", "en-US"),
    answeringMachineDetection: bool("ANSWERING_MACHINE_DETECTION", true),
    speechTimeoutSeconds: int("SPEECH_TIMEOUT_SECONDS", 8, 1, 60),
    speechEndTimeout: speechEnd(optional("SPEECH_END_TIMEOUT", "auto")),
    speechModel: optional("SPEECH_MODEL", "phone_call"),
    ackPhrases: (process.env.ACK_PHRASES ?? "Mm-hm.|Okay.|Hmm.|Right.")
      .split("|")
      .map((p) => p.trim())
      .filter(Boolean),
    maxHoldSeconds: int("MAX_HOLD_SECONDS", 120, 10, 3600),
    maxCallSeconds: int("MAX_CALL_SECONDS", 900, 30, 14400),
    maxCallsPerHour: int("MAX_CALLS_PER_HOUR", 6, 1, 1000),
    quietHours: parseQuietHours(process.env.QUIET_HOURS),
    timezone: optional("TIMEZONE", "America/New_York"),
    agentAnswerTimeoutSeconds: int("AGENT_ANSWER_TIMEOUT_SECONDS", 45, 5, 600),
    callbackThresholdSeconds: int("CALLBACK_THRESHOLD_SECONDS", 60, 5, 3600),
    defaultMode: callMode(process.env.CALL_MODE, Boolean(process.env.GROQ_API_KEY?.trim())),
    groq: {
      apiKey: process.env.GROQ_API_KEY?.trim() || null,
      model: optional("GROQ_MODEL", "openai/gpt-oss-120b"),
      // Comma-separated; each Groq model has its own rate limit, so more models = fewer stalls.
      fallbackModel: optional("GROQ_FALLBACK_MODEL", "openai/gpt-oss-120b,openai/gpt-oss-20b"),
    },
    relay: {
      ttsProvider: process.env.RELAY_TTS_PROVIDER?.trim() || undefined,
      voice: process.env.RELAY_VOICE?.trim() || undefined,
      transcriptionProvider: process.env.RELAY_TRANSCRIPTION_PROVIDER?.trim() || undefined,
      speechModel: process.env.RELAY_SPEECH_MODEL?.trim() || undefined,
    },
  };
}

/** Minutes after midnight in the given IANA timezone. */
export function minutesInZone(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return h * 60 + m;
}

export function isQuietTime(q: QuietHours | null, timeZone: string, now = new Date()): boolean {
  if (!q) return false;
  const t = minutesInZone(now, timeZone);
  return q.start <= q.end ? t >= q.start && t < q.end : t >= q.start || t < q.end;
}
