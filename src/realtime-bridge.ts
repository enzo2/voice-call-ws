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
  twilioWs: WebSocket;
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
        id: `realtime-transcript-${Date.now()}`,
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

    realtime.onAudio((callId, audioData) => {
      const streamSid = this.callToStream.get(callId);
      if (!streamSid) return;
      const session = this.sessions.get(streamSid);
      if (!session) return;
      if (session.twilioWs.readyState !== WebSocket.OPEN) return;

      session.twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: audioData.toString("base64") },
        }),
      );
    });

    realtime.onError((callId, error) => {
      manager.processEvent({
        id: `realtime-error-${Date.now()}`,
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

  private async handleConnection(
    ws: WebSocket,
    _request: IncomingMessage,
  ): Promise<void> {
    let session: BridgeSession | null = null;
    let messageQueue = Promise.resolve();

    ws.on("message", (data: Buffer) => {
      messageQueue = messageQueue.then(async () => {
        try {
          const message = JSON.parse(data.toString()) as TwilioMediaMessage;

          switch (message.event) {
            case "connected":
              break;
            case "start":
              session = await this.handleStart(ws, message);
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
  ): Promise<BridgeSession> {
    const streamSid = message.streamSid || message.start?.streamSid || "";
    const callSid = message.start?.callSid || "";
    if (!callSid) {
      ws.close();
      throw new Error("Missing callSid in Twilio start event");
    }

    const callRecord =
      this.config.manager.getCallByProviderCallId(callSid) ??
      this.config.manager.getCall(callSid) ??
      null;
    let sessionOptions: RealtimeSessionOptions | null = null;
    if (this.config.agent) {
      try {
        sessionOptions = await this.config.agent.buildSessionOptions(callRecord);
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
      twilioWs: ws,
    };

    this.sessions.set(streamSid, session);
    this.callToStream.set(callSid, streamSid);

    await this.config.manager.speakInitialMessage(callSid);

    return session;
  }

  private handleStop(session: BridgeSession): void {
    this.config.realtime.disconnect(session.callId).catch((err) => {
      console.error("[voice-call-ws] Failed to disconnect realtime:", err);
    });
    this.sessions.delete(session.streamSid);
    this.callToStream.delete(session.callId);
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
