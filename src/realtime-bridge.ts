import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocket, WebSocketServer } from "ws";

import type { CallManager } from "./manager.js";
import type {
  RealtimeProvider,
  RealtimeFunctionCall,
  RealtimeSessionOptions,
} from "./realtime/base.js";
import type { VoiceCallAgent } from "./voice-agent.js";
import type { NormalizedEvent } from "./types.js";

interface BridgeSession {
  callId: string;
  streamSid: string;
  token?: string;
  twilioWs: WebSocket;

  // Outbound (bot->Twilio) audio pacing.
  // Twilio expects ~20ms μ-law frames (8kHz) to be sent in real time.
  // Providers may emit larger chunks and may emit faster than real time.
  outboundAudioQueue: Buffer[];
  outboundAudioQueueHead: number;
  outboundAudioRemainder: Buffer;
  outboundAudioSending: boolean;
  outboundTimer?: NodeJS.Timeout | null;
}

type BridgeConfig = {
  manager: CallManager;
  realtime: RealtimeProvider;
  agent?: VoiceCallAgent;
  logger?: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
    debug: (message: string) => void;
  };
};

/**
 * Bridges Twilio Media Streams with realtime speech providers.
 */
export class RealtimeBridge {
  private wss: WebSocketServer | null = null;
  private sessions = new Map<string, BridgeSession>();
  private callToStream = new Map<string, string>();
  private config: BridgeConfig;

  constructor(config: BridgeConfig) {
    this.config = config;
    this.wireRealtimeCallbacks();
  }

  /**
   * Handle WebSocket upgrade from Twilio.
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (!this.wss) {
      this.wss = new WebSocketServer({ noServer: true });
      this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss?.emit("connection", ws, request);
    });
  }

  private wireRealtimeCallbacks(): void {
    const { realtime, manager } = this.config;

    realtime.onTranscript((callId, transcript) => {
      const event: NormalizedEvent = {
        id: `realtime-transcript-${crypto.randomUUID()}`,
        type: "call.speech",
        callId,
        providerCallId: callId,
        timestamp: Date.now(),
        transcript,
        isFinal: true,
      };
      manager.processEvent(event);
    });

    realtime.onPartialTranscript((_callId, _partial) => {});

    realtime.onOutputTranscript?.((callId, transcript) => {
      manager.recordAssistantTranscript(callId, transcript);
    });

    realtime.onAudio((callId, audioData) => {
      const streamSid = this.callToStream.get(callId);
      if (!streamSid) return;
      const session = this.sessions.get(streamSid);
      if (!session) return;
      if (session.twilioWs.readyState !== WebSocket.OPEN) return;

      // Twilio expects 8kHz μ-law. Typical 20ms frame is 160 bytes.
      // Providers may emit larger chunks and may emit faster than real time.
      // If we push too fast, Twilio buffers and playback becomes delayed/"slow".
      const FRAME_BYTES = 160;
      const MAX_QUEUE_FRAMES = 250; // ~5 seconds of audio at 20ms/frame

      // Carry remainder across callbacks so we always send full 20ms frames.
      let buf =
        session.outboundAudioRemainder.length > 0
          ? Buffer.concat([session.outboundAudioRemainder, audioData])
          : audioData;

      const fullLen = buf.length - (buf.length % FRAME_BYTES);
      for (let i = 0; i < fullLen; i += FRAME_BYTES) {
        session.outboundAudioQueue.push(buf.subarray(i, i + FRAME_BYTES));
      }
      session.outboundAudioRemainder = buf.subarray(fullLen);

      // Bound the queue to avoid unbounded latency/memory growth.
      const queued = session.outboundAudioQueue.length - session.outboundAudioQueueHead;
      if (queued > MAX_QUEUE_FRAMES) {
        const drop = queued - MAX_QUEUE_FRAMES;
        session.outboundAudioQueueHead += drop;
        if (session.outboundAudioQueueHead > 1024) {
          session.outboundAudioQueue = session.outboundAudioQueue.slice(
            session.outboundAudioQueueHead,
          );
          session.outboundAudioQueueHead = 0;
        }
        this.config.logger?.warn?.(
          `[voice-call-ws] Outbound audio queue overflow; dropped ${drop} frames`,
        );
      }

      this.pumpOutboundAudio(session);
    });

    realtime.onError((callId, error) => {
      manager.processEvent({
        id: `realtime-error-${crypto.randomUUID()}`,
        type: "call.error",
        callId,
        providerCallId: callId,
        timestamp: Date.now(),
        error,
        retryable: false,
      });
      void manager.endCall(callId);
    });

    realtime.onFunctionCall((_callId, _call: RealtimeFunctionCall) => {
      void this.handleFunctionCall(_callId, _call);
    });
  }

  private pumpOutboundAudio(session: BridgeSession): void {
    if (session.outboundAudioSending) return;
    session.outboundAudioSending = true;

    session.outboundTimer = setInterval(() => {
      if (session.twilioWs.readyState !== WebSocket.OPEN) {
        if (session.outboundTimer) clearInterval(session.outboundTimer);
        session.outboundTimer = undefined;
        session.outboundAudioQueue.length = 0;
        session.outboundAudioQueueHead = 0;
        session.outboundAudioRemainder = Buffer.alloc(0);
        session.outboundAudioSending = false;
        return;
      }

      const frame =
        session.outboundAudioQueueHead < session.outboundAudioQueue.length
          ? session.outboundAudioQueue[session.outboundAudioQueueHead]
          : undefined;

      if (!frame) {
        if (session.outboundTimer) clearInterval(session.outboundTimer);
        session.outboundTimer = undefined;
        session.outboundAudioSending = false;

        // Compact the queue when idle.
        if (session.outboundAudioQueueHead > 0) {
          session.outboundAudioQueue = session.outboundAudioQueue.slice(
            session.outboundAudioQueueHead,
          );
          session.outboundAudioQueueHead = 0;
        }
        return;
      }

      session.outboundAudioQueueHead += 1;

      try {
        // track="outbound" is required for bidirectional streams.
        session.twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid: session.streamSid,
            media: { payload: frame.toString("base64"), track: "outbound" },
          }),
        );
      } catch (err) {
        console.error("[voice-call-ws] Failed to send outbound audio:", err);
        if (session.outboundTimer) clearInterval(session.outboundTimer);
        session.outboundTimer = undefined;
        session.outboundAudioQueue.length = 0;
        session.outboundAudioQueueHead = 0;
        session.outboundAudioRemainder = Buffer.alloc(0);
        session.outboundAudioSending = false;
      }

      // Periodic compaction to prevent unbounded array growth.
      if (session.outboundAudioQueueHead > 2048) {
        session.outboundAudioQueue = session.outboundAudioQueue.slice(
          session.outboundAudioQueueHead,
        );
        session.outboundAudioQueueHead = 0;
      }
    }, 20);
  }

  private async handleConnection(
    ws: WebSocket,
    request: IncomingMessage,
  ): Promise<void> {
    let session: BridgeSession | null = null;
    let messageQueue = Promise.resolve();

    const reqUrl = new URL(request.url || "/", `http://${request.headers.host}`);
    const token = reqUrl.searchParams.get("token") || undefined;

    ws.on("message", (data: Buffer) => {
      messageQueue = messageQueue.then(async () => {
        try {
          const message = JSON.parse(data.toString()) as TwilioMediaMessage;

          switch (message.event) {
            case "connected":
              break;
            case "start":
              session = await this.handleStart(ws, message, token);
              break;
            case "media":
              if (session && message.media?.payload) {
                const audioBuffer = Buffer.from(message.media.payload, "base64");
                this.config.realtime.sendAudio(session.callId, audioBuffer);
              }
              break;
            case "stop":
              if (session) {
                this.handleStop(session);
                session = null;
              }
              break;
          }
        } catch (error) {
          console.error("[voice-call-ws] Realtime bridge error:", error);
        }
      });
    });

    ws.on("close", () => {
      if (session) {
        this.handleStop(session);
      }
    });

    ws.on("error", (error) => {
      console.error("[voice-call-ws] Bridge WebSocket error:", error);
    });
  }

  private async handleStart(
    ws: WebSocket,
    message: TwilioMediaMessage,
    token?: string,
  ): Promise<BridgeSession> {
    const streamSid = message.streamSid || message.start?.streamSid || "";
    const callSid = message.start?.callSid || "";
    if (!callSid.trim() || !streamSid.trim()) {
      ws.close();
      throw new Error("Missing callSid/streamSid in Twilio start event");
    }
    if (!callSid) {
      ws.close();
      throw new Error("Missing callSid in Twilio start event");
    }

    const callRecord =
      this.config.manager.getCallByProviderCallId(callSid) ??
      this.config.manager.getCall(callSid) ??
      null;

    if (!callRecord) {
      // Unknown call: refuse to connect provider sessions.
      ws.close();
      throw new Error("Unknown callSid");
    }

    if (token) {
      const ok = this.config.manager.validateStreamToken(callSid, token);
      if (!ok) {
        this.config.logger?.warn?.("[voice-call-ws] Invalid stream token; closing socket");
        ws.close();
        throw new Error("Invalid stream token");
      }
    }

    let sessionOptions: RealtimeSessionOptions | null = null;
    if (this.config.agent) {
      try {
        sessionOptions = await this.config.agent.buildSessionOptions(callRecord);

        if (process.env.VOICE_CALL_WS_DEBUG_PROMPT === "1") {
          const instr = sessionOptions?.instructions ?? "";
          const initial =
            callRecord && typeof callRecord.metadata?.initialMessage === "string"
              ? String(callRecord.metadata.initialMessage)
              : "";
          this.config.logger?.info(
            `[voice-call-ws][debug] buildSessionOptions: instructions_len=${instr.length} instructions_preview=${JSON.stringify(instr.slice(0, 120))} initialMessage_len=${initial.length}`,
          );
        }

      } catch (err) {
        this.config.logger?.error(
          `[voice-call-ws] Failed to build voice session prompt: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    try {
      await this.config.realtime.connect(callSid, sessionOptions ?? undefined);
    } catch (err) {
      console.error("[voice-call-ws] Failed to connect realtime session:", err);
      ws.close();
      throw err;
    }

    const session: BridgeSession = {
      callId: callSid,
      streamSid,
      token,
      twilioWs: ws,
      outboundAudioQueue: [],
      outboundAudioQueueHead: 0,
      outboundAudioRemainder: Buffer.alloc(0),
      outboundAudioSending: false,
    };

    this.sessions.set(streamSid, session);
    this.callToStream.set(callSid, streamSid);

    await this.config.manager.speakInitialMessage(callSid);

    return session;
  }

  private handleStop(session: BridgeSession): void {
    if (session.outboundTimer) {
      clearInterval(session.outboundTimer);
      session.outboundTimer = undefined;
    }
    session.outboundAudioQueue.length = 0;
    session.outboundAudioQueueHead = 0;
    session.outboundAudioRemainder = Buffer.alloc(0);
    session.outboundAudioSending = false;

    this.config.realtime.disconnect(session.callId).catch((err) => {
      console.error("[voice-call-ws] Failed to disconnect realtime:", err);
    });
    this.sessions.delete(session.streamSid);
    const current = this.callToStream.get(session.callId);
    if (current === session.streamSid) {
      this.callToStream.delete(session.callId);
    }
  }

  closeAll(): void {
    for (const session of this.sessions.values()) {
      session.twilioWs.close();
    }
    this.sessions.clear();
    this.callToStream.clear();
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }

  private async handleFunctionCall(
    providerCallId: string,
    call: RealtimeFunctionCall,
  ): Promise<void> {
    const { agent, realtime, manager, logger } = this.config;
    if (!agent) return;

    const callRecord =
      manager.getCallByProviderCallId(providerCallId) ??
      manager.getCall(providerCallId) ??
      null;

    try {
      const result = await agent.executeFunctionCall(callRecord, call);
      if (!realtime.sendFunctionResult) {
        logger?.warn(
          `[voice-call-ws] Realtime provider does not support function results (${call.name})`,
        );
        return;
      }
      realtime.sendFunctionResult(providerCallId, call.callId, result);
    } catch (err) {
      logger?.error(
        `[voice-call-ws] Failed to handle function call ${call.name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      if (realtime.sendFunctionResult) {
        realtime.sendFunctionResult(providerCallId, call.callId, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

interface TwilioMediaMessage {
  event: "connected" | "start" | "media" | "stop" | "mark" | "clear";
  sequenceNumber?: string;
  streamSid?: string;
  start?: {
    streamSid: string;
    accountSid: string;
    callSid: string;
    tracks: string[];
    mediaFormat: {
      encoding: string;
      sampleRate: number;
      channels: number;
    };
  };
  media?: {
    track?: string;
    chunk?: string;
    timestamp?: string;
    payload?: string;
  };
  mark?: {
    name: string;
  };
}
