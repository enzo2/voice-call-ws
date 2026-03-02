import { z } from "zod";

// -----------------------------------------------------------------------------
// Phone Number Validation
// -----------------------------------------------------------------------------

/**
 * E.164 phone number format: +[country code][number]
 * Examples use 555 prefix (reserved for fictional numbers)
 */
export const E164Schema = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, "Expected E.164 format, e.g. +15550001234");

// -----------------------------------------------------------------------------
// Inbound Policy
// -----------------------------------------------------------------------------

/**
 * Controls how inbound calls are handled:
 * - "disabled": Block all inbound calls (outbound only)
 * - "allowlist": Only accept calls from numbers in allowFrom
 * - "pairing": Unknown callers can request pairing (future)
 * - "open": Accept all inbound calls (dangerous!)
 */
export const InboundPolicySchema = z.enum([
  "disabled",
  "allowlist",
  "pairing",
  "open",
]);
export type InboundPolicy = z.infer<typeof InboundPolicySchema>;

// -----------------------------------------------------------------------------
// Telephony Configuration
// -----------------------------------------------------------------------------

export const TwilioConfigSchema = z
  .object({
    /** Twilio Account SID */
    accountSid: z.string().min(1).optional(),
    /** Twilio Auth Token */
    authToken: z.string().min(1).optional(),
  })
  .strict();
export type TwilioConfig = z.infer<typeof TwilioConfigSchema>;

export const TelephonyConfigSchema = z
  .object({
    provider: z.enum(["twilio"]).default("twilio"),
    twilio: TwilioConfigSchema.optional(),
  })
  .strict()
  .default({ provider: "twilio" });
export type TelephonyConfig = z.infer<typeof TelephonyConfigSchema>;

// -----------------------------------------------------------------------------
// Webhook Server Configuration
// -----------------------------------------------------------------------------

export const VoiceCallServeConfigSchema = z
  .object({
    /** Port to listen on */
    port: z.number().int().positive().default(3334),
    /** Bind address */
    bind: z.string().default("127.0.0.1"),
    /** Webhook path */
    path: z.string().min(1).default("/voice/webhook"),
  })
  .strict()
  .default({ port: 3334, bind: "127.0.0.1", path: "/voice/webhook" });
export type VoiceCallServeConfig = z.infer<typeof VoiceCallServeConfigSchema>;

export const VoiceCallTailscaleConfigSchema = z
  .object({
    /**
     * Tailscale exposure mode:
     * - "off": No Tailscale exposure
     * - "serve": Tailscale serve (private to tailnet)
     * - "funnel": Tailscale funnel (public HTTPS)
     */
    mode: z.enum(["off", "serve", "funnel"]).default("off"),
    /** Path for Tailscale serve/funnel (should usually match serve.path) */
    path: z.string().min(1).default("/voice/webhook"),
  })
  .strict()
  .default({ mode: "off", path: "/voice/webhook" });
export type VoiceCallTailscaleConfig = z.infer<
  typeof VoiceCallTailscaleConfigSchema
>;

// -----------------------------------------------------------------------------
// Tunnel Configuration (unified ngrok/tailscale)
// -----------------------------------------------------------------------------

export const VoiceCallTunnelConfigSchema = z
  .object({
    /**
     * Tunnel provider:
     * - "none": No tunnel (use publicUrl if set, or manual setup)
     * - "ngrok": Use ngrok for public HTTPS tunnel
     * - "tailscale-serve": Tailscale serve (private to tailnet)
     * - "tailscale-funnel": Tailscale funnel (public HTTPS)
     */
    provider: z
      .enum(["none", "ngrok", "tailscale-serve", "tailscale-funnel"])
      .default("none"),
    /** ngrok auth token (optional, enables longer sessions and more features) */
    ngrokAuthToken: z.string().min(1).optional(),
    /** ngrok custom domain (paid feature, e.g., "myapp.ngrok.io") */
    ngrokDomain: z.string().min(1).optional(),
    /**
     * Allow ngrok free tier compatibility mode.
     * When true, signature verification failures on ngrok-free.app URLs
     * will be logged but allowed through. Less secure, but necessary
     * for ngrok free tier which may modify URLs.
     */
    allowNgrokFreeTier: z.boolean().default(false),
  })
  .strict()
  .default({ provider: "none", allowNgrokFreeTier: false });
export type VoiceCallTunnelConfig = z.infer<typeof VoiceCallTunnelConfigSchema>;

// -----------------------------------------------------------------------------
// Outbound Call Configuration
// -----------------------------------------------------------------------------

/**
 * Call mode determines how outbound calls behave:
 * - "notify": Deliver message and auto-hangup after delay (one-way notification)
 * - "conversation": Stay open for back-and-forth until explicit end or timeout
 */
export const CallModeSchema = z.enum(["notify", "conversation"]);
export type CallMode = z.infer<typeof CallModeSchema>;

export const OutboundConfigSchema = z
  .object({
    /** Default call mode for outbound calls */
    defaultMode: CallModeSchema.default("notify"),
    /** Seconds to wait after initial message before auto-hangup in notify mode */
    notifyHangupDelaySec: z.number().int().nonnegative().default(3),
  })
  .strict()
  .default({ defaultMode: "notify", notifyHangupDelaySec: 3 });
export type OutboundConfig = z.infer<typeof OutboundConfigSchema>;

// -----------------------------------------------------------------------------
// Realtime Provider Configuration
// -----------------------------------------------------------------------------

export const XaiVoiceAgentConfigSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    voice: z.enum(["Ara", "Rex", "Sal", "Eve", "Leo"]).default("Rex"),
    vadThreshold: z.number().min(0).max(1).default(0.5),
  })
  .strict()
  .default({ voice: "Rex", vadThreshold: 0.5 });
export type XaiVoiceAgentConfig = z.infer<typeof XaiVoiceAgentConfigSchema>;

export const GeminiLiveConfigSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    model: z
      .string()
      .min(1)
      .default("gemini-2.5-flash-native-audio-preview-12-2025"),
    voice: z.string().min(1).optional(),
    inputTranscription: z.boolean().default(true),
    outputTranscription: z.boolean().default(true),
  })
  .strict()
  .default({
    model: "gemini-2.5-flash-native-audio-preview-12-2025",
    inputTranscription: true,
    outputTranscription: true,
  });
export type GeminiLiveConfig = z.infer<typeof GeminiLiveConfigSchema>;

export const MockRealtimeConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .strict()
  .default({ enabled: false });
export type MockRealtimeConfig = z.infer<typeof MockRealtimeConfigSchema>;

export const RealtimeConfigSchema = z
  .object({
    provider: z
      .enum(["xai-voice-agent", "gemini-live", "mock"])
      .default("xai-voice-agent"),
    streamPath: z.string().min(1).default("/voice/stream"),
    xai: XaiVoiceAgentConfigSchema.optional(),
    gemini: GeminiLiveConfigSchema.optional(),
    mock: MockRealtimeConfigSchema.optional(),
  })
  .strict()
  .default({ provider: "xai-voice-agent", streamPath: "/voice/stream" });
export type RealtimeConfig = z.infer<typeof RealtimeConfigSchema>;

// -----------------------------------------------------------------------------
// Voice Agent Tool Policy
// -----------------------------------------------------------------------------

export const VoiceCallWsToolPolicySchema = z
  .object({
    /**
     * Tool profile:
     * - "minimal": session_status only
     * - "messaging": messaging + sessions tools (default)
     * - "full": all tools allowed by core policy
     */
    profile: z.enum(["minimal", "messaging", "full"]).default("messaging"),
    /** Explicit allowlist (merged with profile allowlist) */
    allow: z.array(z.string()).optional(),
    /** Explicit denylist (merged with profile denylist) */
    deny: z.array(z.string()).optional(),
  })
  .strict()
  .default({ profile: "messaging" });
export type VoiceCallWsToolPolicy = z.infer<typeof VoiceCallWsToolPolicySchema>;

// -----------------------------------------------------------------------------
// Voice Agent Identity (publishable, optional)
// -----------------------------------------------------------------------------

export const VoiceAgentIdentitySchema = z
  .object({
    /** Owner name shown to the caller (optional). */
    ownerName: z.string().min(1).optional(),
    /** Agent name shown to the caller (optional). */
    agentName: z.string().min(1).optional(),
  })
  .strict()
  .default({});
export type VoiceAgentIdentity = z.infer<typeof VoiceAgentIdentitySchema>;

// -----------------------------------------------------------------------------
// Privacy / Retention (publishable defaults)
// -----------------------------------------------------------------------------

export const PrivacyConfigSchema = z
  .object({
    /** Persist call transcript entries to calls.jsonl */
    persistTranscript: z.boolean().default(false),
    /** When returning status, allow including transcript entries */
    allowTranscriptInStatus: z.boolean().default(true),
    /** Mask phone numbers in status payloads */
    redactPhoneNumbersInStatus: z.boolean().default(true),
  })
  .strict()
  .default({
    persistTranscript: false,
    allowTranscriptInStatus: true,
    redactPhoneNumbersInStatus: true,
  });
export type PrivacyConfig = z.infer<typeof PrivacyConfigSchema>;

// -----------------------------------------------------------------------------
// Main Voice Call WS Configuration
// -----------------------------------------------------------------------------

export const VoiceCallWsConfigSchema = z
  .object({
    /** Enable voice call functionality */
    enabled: z.boolean().default(false),

    /** Telephony provider configuration */
    telephony: TelephonyConfigSchema,

    /** Phone number to call from (E.164) */
    fromNumber: E164Schema.optional(),

    /** Default phone number to call (E.164) */
    toNumber: E164Schema.optional(),

    /** Inbound call policy */
    inboundPolicy: InboundPolicySchema.default("disabled"),

    /** Allowlist of phone numbers for inbound calls (E.164) */
    allowFrom: z.array(E164Schema).default([]),

    /** Greeting message for inbound calls */
    inboundGreeting: z.string().optional(),

    /** Voice agent identity shown to callers (optional) */
    voiceAgent: VoiceAgentIdentitySchema,

    /** Privacy/retention controls */
    privacy: PrivacyConfigSchema,

    /** Outbound call configuration */
    outbound: OutboundConfigSchema,

    /** Maximum call duration in seconds */
    maxDurationSeconds: z.number().int().positive().default(300),

    /** Timeout for user transcript (ms) */
    transcriptTimeoutMs: z.number().int().positive().default(180000),

    /** Ring timeout for outbound calls (ms) */
    ringTimeoutMs: z.number().int().positive().default(30000),

    /** Maximum concurrent calls */
    maxConcurrentCalls: z.number().int().positive().default(1),

    /** Webhook server configuration */
    serve: VoiceCallServeConfigSchema,

    /** Tailscale exposure configuration (legacy, prefer tunnel config) */
    tailscale: VoiceCallTailscaleConfigSchema,

    /** Tunnel configuration (unified ngrok/tailscale) */
    tunnel: VoiceCallTunnelConfigSchema,

    /** Realtime voice provider configuration */
    realtime: RealtimeConfigSchema,

    /** Tool policy for voice-call agent (restricts available tools) */
    tools: VoiceCallWsToolPolicySchema,

    /** Public webhook URL override (if set, bypasses tunnel auto-detection) */
    publicUrl: z.string().url().optional(),

    /** Skip webhook signature verification (development only, NOT for production) */
    skipSignatureVerification: z.boolean().default(false),

    /** Store path for call logs */
    store: z.string().optional(),
  })
  .strict();

export type VoiceCallWsConfig = z.infer<typeof VoiceCallWsConfigSchema>;

// -----------------------------------------------------------------------------
// Configuration Helpers
// -----------------------------------------------------------------------------

/**
 * Validate that the configuration has all required fields for the selected providers.
 */
export function validateVoiceCallWsConfig(config: VoiceCallWsConfig): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!config.enabled) {
    return { valid: true, errors: [] };
  }

  if (!config.fromNumber) {
    errors.push("plugins.entries.voice-call-ws.config.fromNumber is required");
  }

  if (!config.voiceAgent?.ownerName) {
    errors.push(
      "plugins.entries.voice-call-ws.config.voiceAgent.ownerName is required",
    );
  }

  if (config.telephony.provider !== "twilio") {
    errors.push("plugins.entries.voice-call-ws.config.telephony.provider must be twilio");
  }

  const accountSid =
    config.telephony.twilio?.accountSid ?? process.env.TWILIO_ACCOUNT_SID;
  const authToken =
    config.telephony.twilio?.authToken ?? process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid) {
    errors.push(
      "plugins.entries.voice-call-ws.config.telephony.twilio.accountSid is required (or set TWILIO_ACCOUNT_SID env)",
    );
  }
  if (!authToken) {
    errors.push(
      "plugins.entries.voice-call-ws.config.telephony.twilio.authToken is required (or set TWILIO_AUTH_TOKEN env)",
    );
  }

  if (config.realtime.provider === "xai-voice-agent") {
    const apiKey = config.realtime.xai?.apiKey ?? process.env.XAI_API_KEY;
    if (!apiKey) {
      errors.push(
        "plugins.entries.voice-call-ws.config.realtime.xai.apiKey is required (or set XAI_API_KEY env)",
      );
    }
  }
  if (config.realtime.provider === "gemini-live") {
    const apiKey =
      config.realtime.gemini?.apiKey ??
      process.env.GEMINI_API_KEY ??
      process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      errors.push(
        "plugins.entries.voice-call-ws.config.realtime.gemini.apiKey is required (or set GEMINI_API_KEY/GOOGLE_API_KEY env)",
      );
    }
  }

  return { valid: errors.length === 0, errors };
}
