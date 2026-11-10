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

function int(name: string, fallback: number): number {
  const v = process.env[name]?.trim();
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be an integer, got "${v}"`);
  return n;
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
  maxHoldSeconds: number;
  maxCallSeconds: number;
  maxCallsPerHour: number;
  quietHours: QuietHours | null;
  timezone: string;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): Config {
  let transport = optional("MCP_TRANSPORT", "http").toLowerCase();
  if (argv.includes("--stdio")) transport = "stdio";
  if (argv.includes("--http")) transport = "http";
  if (transport !== "http" && transport !== "stdio") {
    throw new Error(`MCP_TRANSPORT must be "http" or "stdio", got "${transport}"`);
  }

  const publicBaseUrl = required("PUBLIC_BASE_URL").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(publicBaseUrl)) {
    throw new Error("PUBLIC_BASE_URL must start with https:// (Twilio needs to reach it)");
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
    port: int("PORT", 3000),
    host: optional("HOST", "0.0.0.0"),
    transport,
    mcpAuthToken: process.env.MCP_AUTH_TOKEN?.trim() || null,
    allowUnauthenticatedMcp: bool("ALLOW_UNAUTHENTICATED_MCP", false),
    voice: optional("TWILIO_VOICE", "Polly.Joanna-Neural"),
    language: optional("CALL_LANGUAGE", "en-US"),
    answeringMachineDetection: bool("ANSWERING_MACHINE_DETECTION", true),
    speechTimeoutSeconds: int("SPEECH_TIMEOUT_SECONDS", 8),
    maxHoldSeconds: int("MAX_HOLD_SECONDS", 120),
    maxCallSeconds: int("MAX_CALL_SECONDS", 900),
    maxCallsPerHour: int("MAX_CALLS_PER_HOUR", 6),
    quietHours: parseQuietHours(process.env.QUIET_HOURS),
    timezone: optional("TIMEZONE", "America/New_York"),
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
