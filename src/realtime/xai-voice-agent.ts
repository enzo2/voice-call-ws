import WebSocket from "ws";

import type { XaiVoiceAgentConfig } from "../config.js";
import type {
  RealtimeFunctionCall,
  RealtimeProvider,
  RealtimeSessionOptions,
  RealtimeToolDefinition,
} from "./base.js";

type XaiEvent =
  | { type: "conversation.created"; conversation: { id: string } }
  | { type: "session.updated"; session: unknown }
  | { type: "input_audio_buffer.speech_started"; item_id: string }
  | { type: "input_audio_buffer.speech_stopped"; item_id: string }
  | {
      type: "conversation.item.input_audio_transcription.delta";
      delta: string;
      item_id: string;
    }
  | {
      type: "conversation.item.input_audio_transcription.completed";
      transcript: string;
      item_id: string;
    }
  | {
      type: "response.output_audio.delta";
      delta: string;
      response_id: string;
      item_id: string;
    }
  | {
      type: "response.output_audio_transcript.delta";
      delta: string;
      response_id: string;
      item_id: string;
    }
  | {
      type: "response.function_call_arguments.done";
      name: string;
      arguments: string;
      call_id: string;
      response_id: string;
    }
  | { type: "response.created"; response: { id: string } }
  | { type: "response.done"; response: { id: string } }
  | { type: "error"; error: unknown };

interface XaiSession {
  callId: string;
  ws: WebSocket | null;
  connected: boolean;
  reconnectAttempts: number;
  pendingTranscript: string;
  sessionOptions?: RealtimeSessionOptions;
}

export class XaiVoiceAgentProvider implements RealtimeProvider {
  readonly name = "xai-voice-agent" as const;

  private apiKey: string;
  private voice: string;
  private vadThreshold: number;
  private sessions = new Map<string, XaiSession>();

  private onTranscriptCallback:
    | ((callId: string, transcript: string) => void)
    | null = null;
  private onPartialTranscriptCallback:
    | ((callId: string, partial: string) => void)
    | null = null;
  private onAudioCallback: ((callId: string, audioData: Buffer) => void) | null =
    null;
  private onErrorCallback: ((callId: string, error: string) => void) | null =
    null;
  private onFunctionCallCallback:
    | ((callId: string, call: RealtimeFunctionCall) => void)
    | null = null;

  constructor(config: XaiVoiceAgentConfig, apiKey?: string) {
    const resolvedApiKey = apiKey || config.apiKey;
    if (!resolvedApiKey) {
      throw new Error("xAI API key is required");
    }

    this.apiKey = resolvedApiKey;
    this.voice = config.voice || "Ara";
    this.vadThreshold = config.vadThreshold ?? 0.5;
  }

  async connect(callId: string, options?: RealtimeSessionOptions): Promise<void> {
    const session: XaiSession = {
      callId,
      ws: null,
      connected: false,
      reconnectAttempts: 0,
      pendingTranscript: "",
      sessionOptions: options,
    };

    this.sessions.set(callId, session);
    await this.doConnect(session);
  }

  async disconnect(callId: string): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session) return;

    session.connected = false;
    if (session.ws) {
      session.ws.close();
      session.ws = null;
    }

    this.sessions.delete(callId);
  }

  updateSession(callId: string, options: RealtimeSessionOptions): void {
    const session = this.sessions.get(callId);
    if (!session) return;
    session.sessionOptions = options;
    if (session.ws?.readyState === WebSocket.OPEN) {
      const payload = this.buildSessionUpdatePayload(session.sessionOptions);
      if (payload) {
        session.ws.send(JSON.stringify(payload));
      }
    }
  }

  sendAudio(callId: string, audioData: Buffer): void {
    const session = this.sessions.get(callId);
    if (!session?.connected) return;

    if (session.ws?.readyState === WebSocket.OPEN) {
      session.ws.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: audioData.toString("base64"),
        }),
      );
    }
  }

  async sendText(callId: string, text: string): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session?.connected) return;
    if (session.ws?.readyState !== WebSocket.OPEN) return;

    session.ws.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      }),
    );

    session.ws.send(
      JSON.stringify({
        type: "response.create",
      }),
    );
  }

  triggerResponse(callId: string): void {
    const session = this.sessions.get(callId);
    if (!session?.connected) return;
    if (session.ws?.readyState !== WebSocket.OPEN) return;

    session.ws.send(
      JSON.stringify({
        type: "response.create",
      }),
    );
  }

  sendFunctionResult(callId: string, functionCallId: string, result: unknown): void {
    const session = this.sessions.get(callId);
    if (!session?.connected) return;
    if (session.ws?.readyState !== WebSocket.OPEN) return;

    session.ws.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: functionCallId,
          output: JSON.stringify(result),
        },
      }),
    );

    session.ws.send(
      JSON.stringify({
        type: "response.create",
      }),
    );
  }

  onTranscript(callback: (callId: string, transcript: string) => void): void {
    this.onTranscriptCallback = callback;
  }

  onPartialTranscript(
    callback: (callId: string, partial: string) => void,
  ): void {
    this.onPartialTranscriptCallback = callback;
  }

  onAudio(callback: (callId: string, audioData: Buffer) => void): void {
    this.onAudioCallback = callback;
  }

  onError(callback: (callId: string, error: string) => void): void {
    this.onErrorCallback = callback;
  }

  onFunctionCall(
    callback: (callId: string, call: RealtimeFunctionCall) => void,
  ): void {
    this.onFunctionCallCallback = callback;
  }

  hasActiveSession(callId: string): boolean {
    const session = this.sessions.get(callId);
    return session?.connected === true && session.ws?.readyState === WebSocket.OPEN;
  }

  private async doConnect(session: XaiSession): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket("wss://api.x.ai/v1/realtime", {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      session.ws = ws;

      ws.on("open", () => {
        session.connected = true;
        session.reconnectAttempts = 0;

        const updatePayload = this.buildSessionUpdatePayload(session.sessionOptions);
        if (updatePayload) {
          ws.send(JSON.stringify(updatePayload));
        }
        resolve();
      });

      ws.on("message", (data: Buffer) => {
        try {
          const event = JSON.parse(data.toString()) as XaiEvent;
          this.handleEvent(session, event);
        } catch (err) {
          console.error("[xai-realtime] Failed to parse event:", err);
        }
      });

      ws.on("error", (error) => {
        if (!session.connected) {
          reject(error);
        } else {
          this.handleConnectionError(session, error);
        }
      });

      ws.on("close", (code) => {
        session.connected = false;
        if (code !== 1000) {
          this.handleConnectionError(
            session,
            new Error(`WebSocket closed: ${code}`),
          );
        }
      });

      setTimeout(() => {
        if (!session.connected && session.ws === ws) {
          reject(new Error("xAI connection timeout"));
        }
      }, 10000);
    });
  }

  private handleEvent(session: XaiSession, event: XaiEvent): void {
    switch (event.type) {
      case "input_audio_buffer.speech_started":
        session.pendingTranscript = "";
        break;
      case "conversation.item.input_audio_transcription.delta":
        if (event.delta) {
          session.pendingTranscript += event.delta;
          this.onPartialTranscriptCallback?.(session.callId, session.pendingTranscript);
        }
        break;
      case "conversation.item.input_audio_transcription.completed":
        if (event.transcript) {
          this.onTranscriptCallback?.(session.callId, event.transcript);
          session.pendingTranscript = "";
        }
        break;
      case "response.output_audio.delta":
        if (event.delta) {
          const audioData = Buffer.from(event.delta, "base64");
          this.onAudioCallback?.(session.callId, audioData);
        }
        break;
      case "response.function_call_arguments.done": {
        const call: RealtimeFunctionCall = {
          name: event.name,
          arguments: event.arguments,
          callId: event.call_id,
          responseId: event.response_id,
        };
        this.onFunctionCallCallback?.(session.callId, call);
        break;
      }
      case "error":
        this.handleConnectionError(
          session,
          new Error(`xAI error: ${JSON.stringify(event.error)}`),
        );
        break;
    }
  }

  private handleConnectionError(session: XaiSession, error: Error): void {
    if (session.reconnectAttempts >= 5) {
      this.onErrorCallback?.(session.callId, error.message);
      return;
    }

    session.reconnectAttempts++;
    const delay = 1000 * Math.pow(2, session.reconnectAttempts - 1);

    setTimeout(() => {
      if (session.connected) return;
      this.doConnect(session).catch((err) => {
        this.handleConnectionError(
          session,
          new Error(`Reconnect failed: ${err.message}`),
        );
      });
    }, delay);
  }

  private buildSessionUpdatePayload(
    options?: RealtimeSessionOptions,
  ): Record<string, unknown> | null {
    const toolDefs = this.buildToolDefinitions(options?.tools);
    return {
      type: "session.update",
      session: {
        voice: this.voice,
        instructions: options?.instructions ?? "",
        ...(toolDefs ? { tools: toolDefs } : {}),
        turn_detection: {
          type: "server_vad",
          threshold: this.vadThreshold,
          prefix_padding_ms: 300,
          silence_duration_ms: 800,
        },
        audio: {
          input: { format: { type: "audio/pcmu" } },
          output: { format: { type: "audio/pcmu" } },
        },
      },
    };
  }

  private buildToolDefinitions(
    tools?: RealtimeToolDefinition[],
  ): Array<{ type: "function"; function: Record<string, unknown> }> | null {
    if (!tools || tools.length === 0) return null;
    return tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters:
          tool.parameters ?? { type: "object", additionalProperties: false },
      },
    }));
  }
}
