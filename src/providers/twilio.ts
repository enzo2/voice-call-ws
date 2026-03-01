import crypto from "node:crypto";

import type { TwilioConfig } from "../config.js";
import type {
  HangupCallInput,
  InitiateCallInput,
  InitiateCallResult,
  NormalizedEvent,
  ProviderWebhookParseResult,
  WebhookContext,
  WebhookVerificationResult,
} from "../types.js";
import { escapeXml } from "../utils.js";
import type { TelephonyProvider } from "./base.js";
import { twilioApiRequest } from "./twilio/api.js";
import { verifyTwilioProviderWebhook } from "./twilio/webhook.js";

/**
 * Twilio Voice API provider implementation.
 *
 * Uses Twilio Programmable Voice API with Media Streams for real-time
 * bidirectional audio streaming.
 *
 * @see https://www.twilio.com/docs/voice
 * @see https://www.twilio.com/docs/voice/media-streams
 */
export interface TwilioProviderOptions {
  /** Allow ngrok free tier compatibility mode (less secure) */
  allowNgrokFreeTier?: boolean;
  /** Override public URL for signature verification */
  publicUrl?: string;
  /** Path for media stream WebSocket (e.g., /voice/stream) */
  streamPath?: string;
  /** Skip webhook signature verification (development only) */
  skipVerification?: boolean;
}

export class TwilioProvider implements TelephonyProvider {
  readonly name = "twilio" as const;

  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly baseUrl: string;
  private readonly options: TwilioProviderOptions;

  /** Current public webhook URL (set when tunnel starts or from config) */
  private currentPublicUrl: string | null = null;

  constructor(config: TwilioConfig, options: TwilioProviderOptions = {}) {
    if (!config.accountSid) {
      throw new Error("Twilio Account SID is required");
    }
    if (!config.authToken) {
      throw new Error("Twilio Auth Token is required");
    }

    this.accountSid = config.accountSid;
    this.authToken = config.authToken;
    this.baseUrl = `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}`;
    this.options = options;

    if (options.publicUrl) {
      this.currentPublicUrl = options.publicUrl;
    }
  }

  setPublicUrl(url: string): void {
    this.currentPublicUrl = url;
  }

  getPublicUrl(): string | null {
    return this.currentPublicUrl;
  }

  /**
   * Verify Twilio webhook signature.
   * We support ngrok free tier compatibility by optionally re-deriving
   * the public URL from forwarding headers.
   *
   * @see https://www.twilio.com/docs/usage/webhooks/webhooks-security
   */
  verifyWebhook(ctx: WebhookContext): WebhookVerificationResult {
    return verifyTwilioProviderWebhook({
      ctx,
      authToken: this.authToken,
      currentPublicUrl: this.currentPublicUrl,
      options: this.options,
    });
  }

  /**
   * Parse Twilio webhook event into normalized format.
   */
  parseWebhookEvent(ctx: WebhookContext): ProviderWebhookParseResult {
    try {
      const params = new URLSearchParams(ctx.rawBody);
      const callIdFromQuery =
        typeof ctx.query?.callId === "string" && ctx.query.callId.trim()
          ? ctx.query.callId.trim()
          : undefined;
      const event = this.normalizeEvent(params, callIdFromQuery);

      // For Twilio, we must return TwiML to drive the call flow.
      const twiml = this.generateTwimlResponse(ctx);

      return {
        events: event ? [event] : [],
        providerResponseBody: twiml,
        providerResponseHeaders: { "Content-Type": "application/xml" },
        statusCode: 200,
      };
    } catch {
      return { events: [], statusCode: 400 };
    }
  }

  /**
   * Parse Twilio direction to normalized format.
   */
  private static parseDirection(
    direction: string | null,
  ): "inbound" | "outbound" | undefined {
    if (direction === "inbound") return "inbound";
    if (direction === "outbound-api" || direction === "outbound-dial")
      return "outbound";
    return undefined;
  }

  /**
   * Convert Twilio webhook params to normalized event format.
   */
  private normalizeEvent(
    params: URLSearchParams,
    callIdOverride?: string,
  ): NormalizedEvent | null {
    const callSid = params.get("CallSid") || "";

    const baseEvent = {
      id: crypto.randomUUID(),
      callId: callIdOverride || callSid,
      providerCallId: callSid,
      timestamp: Date.now(),
      direction: TwilioProvider.parseDirection(params.get("Direction")),
      from: params.get("From") || undefined,
      to: params.get("To") || undefined,
    };

    // Handle DTMF (rare for media stream flows, but keep for completeness).
    const digits = params.get("Digits");
    if (digits) {
      return { ...baseEvent, type: "call.dtmf", digits };
    }

    // Handle call status changes
    const callStatus = params.get("CallStatus");
    switch (callStatus) {
      case "initiated":
        return { ...baseEvent, type: "call.initiated" };
      case "ringing":
        return { ...baseEvent, type: "call.ringing" };
      case "in-progress":
        return { ...baseEvent, type: "call.answered" };
      case "completed":
      case "busy":
      case "no-answer":
      case "failed":
        return { ...baseEvent, type: "call.ended", reason: callStatus };
      case "canceled":
        return { ...baseEvent, type: "call.ended", reason: "hangup-bot" };
      default:
        return null;
    }
  }

  private static readonly EMPTY_TWIML =
    '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

  private static readonly PAUSE_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="30"/>
</Response>`;

  /**
   * Generate TwiML response for webhook.
   * When a call is answered, connects to media stream for bidirectional audio.
   */
  private generateTwimlResponse(ctx?: WebhookContext): string {
    if (!ctx) return TwilioProvider.EMPTY_TWIML;

    const params = new URLSearchParams(ctx.rawBody);
    const type =
      typeof ctx.query?.type === "string" ? ctx.query.type.trim() : undefined;
    const isStatusCallback = type === "status";
    const callStatus = params.get("CallStatus");
    const direction = params.get("Direction");

    // Status callbacks should not receive TwiML.
    if (isStatusCallback) {
      return TwilioProvider.EMPTY_TWIML;
    }

    // For inbound calls, answer immediately with stream.
    if (direction === "inbound") {
      const streamUrl = this.getStreamUrl(params.get("CallSid") || "");
      return streamUrl
        ? this.getStreamConnectXml(streamUrl)
        : TwilioProvider.PAUSE_TWIML;
    }

    // For outbound calls, only connect to stream when call is in-progress.
    if (callStatus !== "in-progress") {
      return TwilioProvider.EMPTY_TWIML;
    }

    const streamUrl = this.getStreamUrl(params.get("CallSid") || "");
    return streamUrl
      ? this.getStreamConnectXml(streamUrl)
      : TwilioProvider.PAUSE_TWIML;
  }


  private computeStreamToken(callSid: string): string {
    // Deterministic token derived from Twilio auth token + CallSid.
    // Used to bind the Media Stream websocket URL to a specific call.
    return crypto
      .createHmac("sha256", this.authToken)
      .update(callSid)
      .digest("hex")
      .slice(0, 32);
  }

  /**
   * Get the WebSocket URL for media streaming.
   * Derives from the public URL origin + stream path.
   */
  private getStreamUrl(callSid: string): string | null {
    if (!this.currentPublicUrl || !this.options.streamPath) {
      return null;
    }

    // Extract just the origin (host) from the public URL, ignoring any path.
    const url = new URL(this.currentPublicUrl);
    const origin = url.origin;

    // Convert https:// to wss:// for WebSocket.
    const wsOrigin = origin
      .replace(/^https:\/\//, "wss://")
      .replace(/^http:\/\//, "ws://");

    // Append the stream path.
    const path = this.options.streamPath.startsWith("/")
      ? this.options.streamPath
      : `/${this.options.streamPath}`;

    const u = new URL(`${wsOrigin}${path}`);
    if (callSid) {
      u.searchParams.set("callSid", callSid);
      u.searchParams.set("token", this.computeStreamToken(callSid));
    }
    return u.toString();
  }

  /**
   * Generate TwiML to connect a call to a WebSocket media stream.
   *
   * @param streamUrl - WebSocket URL (wss://...) for the media stream
   */
  getStreamConnectXml(streamUrl: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(streamUrl)}" />
  </Connect>
</Response>`;
  }

  /**
   * Initiate an outbound call via Twilio API.
   */
  async initiateCall(input: InitiateCallInput): Promise<InitiateCallResult> {
    const url = new URL(input.webhookUrl);
    url.searchParams.set("callId", input.callId);

    // Create separate URL for status callbacks (required by Twilio).
    const statusUrl = new URL(input.webhookUrl);
    statusUrl.searchParams.set("callId", input.callId);
    statusUrl.searchParams.set("type", "status");

    const params: Record<string, string | string[]> = {
      To: input.to,
      From: input.from,
      Url: url.toString(),
      StatusCallback: statusUrl.toString(),
      StatusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      Timeout: "30",
    };

    const result = await this.apiRequest<TwilioCallResponse>(
      "/Calls.json",
      params,
    );

    return {
      providerCallId: result.sid,
      status: result.status === "queued" ? "queued" : "initiated",
    };
  }

  /**
   * Hang up a call via Twilio API.
   */
  async hangupCall(input: HangupCallInput): Promise<void> {
    await this.apiRequest(
      `/Calls/${input.providerCallId}.json`,
      { Status: "completed" },
      { allowNotFound: true },
    );
  }

  /**
   * Low-level Twilio API request with proper auth.
   */
  private async apiRequest<T>(
    path: string,
    params: Record<string, string | string[]>,
    options?: { allowNotFound?: boolean },
  ): Promise<T> {
    return twilioApiRequest<T>({
      baseUrl: this.baseUrl,
      accountSid: this.accountSid,
      authToken: this.authToken,
      endpoint: path,
      body: params,
      allowNotFound: options?.allowNotFound,
    });
  }
}

// -----------------------------------------------------------------------------
// Twilio-specific types
// -----------------------------------------------------------------------------

interface TwilioCallResponse {
  sid: string;
  status: string;
  direction: string;
  from: string;
  to: string;
  uri: string;
}
