import WebSocket from "ws";

import type { OpenAIRealtimeConfig } from "../config.js";
import type { LibSampleRateInstance } from "./audio-conversion.js";
import type {
  RealtimeFunctionCall,
  RealtimeProvider,
  RealtimeSessionOptions,
  RealtimeToolDefinition,
} from "./base.js";
import {
  createResampler,
  float32ToMuLaw,
  float32ToPcm16Buffer,
  muLawToFloat32,
  pcm16BufferToFloat32,
} from "./audio-conversion.js";

type OpenAIEvent = {
  type?: string;
  item?: {
    id?: string;
    type?: string;
    role?: string;
    name?: string;
    call_id?: string;
    arguments?: string | Record<string, unknown>;
    content?: Array<{
      type?: string;
      text?: string;
      transcript?: string;
      audio?: string;
    }>;
  };
  content?: Array<{ type?: string; text?: string; transcript?: string }>;
  transcript?: string;
  delta?: string;
  audio?: string;
  error?: unknown;
  name?: string;
  arguments?: string;
  call_id?: string;
  response_id?: string;
};

interface OpenAISession {
  callId: string;
  ws: WebSocket | null;
  connected: boolean;
  reconnectAttempts: number;
  closing: boolean;
  reconnectTimer?: NodeJS.Timeout;
  pendingTranscript: string;
  inputResampler: LibSampleRateInstance | null;
  outputResampler: LibSampleRateInstance | null;
  sessionOptions?: RealtimeSessionOptions;
  hasInputAudio: boolean;
  // Buffer assistant transcript deltas so we don't persist word fragments.
  outputTranscriptByResponseId: Map<string, string>;
  // If the server rejects a session.update parameter, keep a blocklist.
  blockedSessionParams: Set<string>;
}

const TWILIO_SAMPLE_RATE = 8000;
const OPENAI_INPUT_SAMPLE_RATE = 16000;
const OPENAI_OUTPUT_SAMPLE_RATE = 24000;
const DEFAULT_MODEL = "gpt-realtime-mini";

export class OpenAIRealtimeProvider implements RealtimeProvider {
  readonly name = "openai-realtime" as const;

  private apiKey: string;
  private model: string;
  private voice: string;
  private inputTranscription: boolean;
  private outputTranscription: boolean;
  private sessions = new Map<string, OpenAISession>();

  private onTranscriptCallback:
    | ((callId: string, transcript: string) => void)
    | null = null;
  private onPartialTranscriptCallback:
    | ((callId: string, partial: string) => void)
    | null = null;
  private onAudioCallback: ((callId: string, audioData: Buffer) => void) | null =
    null;
  private onOutputTranscriptCallback: ((callId: string, transcript: string) => void) | null =
    null;
  private onErrorCallback: ((callId: string, error: string) => void) | null =
    null;
  private onFunctionCallCallback:
    | ((callId: string, call: RealtimeFunctionCall) => void)
    | null = null;

  constructor(config: OpenAIRealtimeConfig, apiKey?: string) {
    const resolvedApiKey =
      apiKey || config.apiKey || process.env.OPENAI_API_KEY;
    if (!resolvedApiKey) {
      throw new Error("OpenAI API key is required");
    }

    this.apiKey = resolvedApiKey;
    this.model = config.model || DEFAULT_MODEL;
    this.voice = config.voice || "verse";
    this.inputTranscription = config.inputTranscription ?? true;
    this.outputTranscription = config.outputTranscription ?? true;
  }

  async connect(callId: string, options?: RealtimeSessionOptions): Promise<void> {
    const session: OpenAISession = {
      callId,
      ws: null,
      connected: false,
      reconnectAttempts: 0,
      closing: false,
      pendingTranscript: "",
      inputResampler: null,
      outputResampler: null,
      sessionOptions: options,
      hasInputAudio: false,
      outputTranscriptByResponseId: new Map(),
      blockedSessionParams: new Set(),
    };

    this.sessions.set(callId, session);
    await this.ensureResamplers(session);
    await this.doConnect(session);
  }

  async disconnect(callId: string): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session) return;

    session.closing = true;
    session.connected = false;
    if (session.reconnectTimer) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = undefined;
    }

    try {
      session.ws?.close();
    } catch {
      // ignore
    }
    session.ws = null;

    session.inputResampler?.destroy();
    session.outputResampler?.destroy();
    session.inputResampler = null;
    session.outputResampler = null;

    this.sessions.delete(callId);
  }

  updateSession(callId: string, options: RealtimeSessionOptions): void {
    const session = this.sessions.get(callId);
    if (!session) return;
    session.sessionOptions = options;

    if (session.ws?.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify(this.buildSessionUpdatePayload(options, session)));
    }
  }

  sendAudio(callId: string, audioData: Buffer): void {
    const session = this.sessions.get(callId);
    if (!session?.connected || session.ws?.readyState !== WebSocket.OPEN) return;
    if (!session.inputResampler) return;

    const pcmFloat = muLawToFloat32(audioData);
    const resampled = session.inputResampler.full(pcmFloat);
    const pcmBuffer = float32ToPcm16Buffer(resampled);

    session.hasInputAudio = true;

    session.ws.send(
      JSON.stringify({
        type: "input_audio_buffer.append",
        audio: pcmBuffer.toString("base64"),
      }),
    );
  }

  async sendText(callId: string, text: string): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session?.connected || session.ws?.readyState !== WebSocket.OPEN) return;

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

    session.ws.send(JSON.stringify({ type: "response.create" }));
  }

  triggerResponse(callId: string): void {
    const session = this.sessions.get(callId);
    if (!session?.connected || session.ws?.readyState !== WebSocket.OPEN) return;

    // If we haven't appended any audio yet, committing causes:
    // input_audio_buffer_commit_empty. For "assistant speaks first" use-cases,
    // just create a response.
    if (session.hasInputAudio) {
      session.ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }
    session.ws.send(JSON.stringify({ type: "response.create" }));
  }

  sendFunctionResult(callId: string, functionCallId: string, result: unknown): void {
    const session = this.sessions.get(callId);
    if (!session?.connected || session.ws?.readyState !== WebSocket.OPEN) return;

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

    session.ws.send(JSON.stringify({ type: "response.create" }));
  }

  onTranscript(callback: (callId: string, transcript: string) => void): void {
    this.onTranscriptCallback = callback;
  }

  onPartialTranscript(
    callback: (callId: string, partial: string) => void,
  ): void {
    this.onPartialTranscriptCallback = callback;
  }

  onOutputTranscript(callback: (callId: string, transcript: string) => void): void {
    this.onOutputTranscriptCallback = callback;
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

  private async doConnect(session: OpenAISession): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(this.model)}`,
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "OpenAI-Beta": "realtime=v1",
          },
        },
      );

      session.ws = ws;

      const timeout = setTimeout(() => {
        if (!session.connected && session.ws === ws) {
          reject(new Error("OpenAI Realtime connection timeout"));
        }
      }, 10000);

      ws.on("open", () => {
        clearTimeout(timeout);
        session.connected = true;
        session.reconnectAttempts = 0;
        if (session.reconnectTimer) {
          clearTimeout(session.reconnectTimer);
          session.reconnectTimer = undefined;
        }

        ws.send(
          JSON.stringify(this.buildSessionUpdatePayload(session.sessionOptions, session)),
        );
        resolve();
      });

      ws.on("message", (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString()) as OpenAIEvent;
          this.handleMessage(session, message);
        } catch (err) {
          this.onErrorCallback?.(
            session.callId,
            `[openai-realtime] Failed to parse server event: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      });

      ws.on("error", (error) => {
        clearTimeout(timeout);
        if (!session.connected) {
          reject(error);
          return;
        }
        this.handleConnectionError(session, error);
      });

      ws.on("close", (code) => {
        clearTimeout(timeout);
        session.connected = false;
        if (!session.closing && code !== 1000) {
          this.handleConnectionError(
            session,
            new Error(`OpenAI Realtime WebSocket closed: ${code}`),
          );
        }
      });
    });
  }

  private handleMessage(session: OpenAISession, message: OpenAIEvent): void {
    switch (message.type) {
      case "input_audio_buffer.speech_started":
        session.pendingTranscript = "";
        break;
      case "input_audio_buffer.speech_ended":
      case "input_audio_buffer.speech_stopped":
        break;
      case "conversation.item.input_audio_transcription.delta":
        if (message.delta) {
          session.pendingTranscript += message.delta;
          this.onPartialTranscriptCallback?.(session.callId, session.pendingTranscript);
        }
        break;
      case "conversation.item.input_audio_transcription.completed": {
        const transcript = this.readTranscript(message.transcript);
        if (transcript) {
          this.onTranscriptCallback?.(session.callId, transcript);
          session.pendingTranscript = "";
        }
        break;
      }
      case "conversation.item.created":
        this.handleConversationItemCreated(session, message);
        break;
      case "response.output_audio.delta":
      case "response.audio.delta":
      case "audio.audio":
        this.handleAudioChunk(session, message);
        break;
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta": {
        // Buffer assistant transcript deltas; do not emit partials as final transcript entries.
        const delta = this.readTranscript(message.delta);
        if (delta) {
          const responseId = (message.response_id ?? "").trim();
          const key = responseId || "__no_response_id__";
          const prev = session.outputTranscriptByResponseId.get(key) ?? "";
          session.outputTranscriptByResponseId.set(key, prev + delta);
        }
        break;
      }
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done": {
        const responseId = (message.response_id ?? "").trim();
        const key = responseId || "__no_response_id__";
        const buffered = session.outputTranscriptByResponseId.get(key) ?? "";
        session.outputTranscriptByResponseId.delete(key);

        const transcript = this.readTranscript(message.transcript) ?? this.readTranscript(buffered);
        if (transcript) {
          this.onOutputTranscriptCallback?.(session.callId, transcript);
        }
        break;
      }
      case "response.function_call_arguments.done":
        this.handleFunctionCallDone(session, message);
        break;
      case "error": {
        // Attempt to auto-recover from session.update "unknown_parameter" errors
        // by blocklisting the rejected param and resending a minimal session.update.
        const errObj = message.error ?? "unknown error";
        const errJson = typeof errObj === "object" ? JSON.stringify(errObj) : String(errObj);

        // Try to parse shape: { code, message, param, type }
        let code: string | undefined;
        let param: string | undefined;
        try {
          const parsed = typeof errObj === "object" ? (errObj as any) : JSON.parse(String(errObj));
          code = typeof parsed?.code === "string" ? parsed.code : undefined;
          param = typeof parsed?.param === "string" ? parsed.param : undefined;
        } catch {
          // ignore
        }

        if (code === "unknown_parameter" && param && param.startsWith("session.")) {
          session.blockedSessionParams.add(param);
          // Best-effort re-send updated session without the rejected field.
          try {
            session.ws?.send(
              JSON.stringify(this.buildSessionUpdatePayload(session.sessionOptions, session)),
            );
            return;
          } catch {
            // fall through
          }
        }

        this.onErrorCallback?.(session.callId, `[openai-realtime] ${errJson}`);
        break;
      }
      default:
        break;
    }
  }

  private handleConversationItemCreated(
    session: OpenAISession,
    message: OpenAIEvent,
  ): void {
    const item = message.item;
    if (!item) return;

    if (item.type === "function_call") {
      const name = item.name?.trim();
      const callId = (item.call_id || item.id || "").trim();
      if (!name || !callId) return;

      const args =
        typeof item.arguments === "string"
          ? item.arguments
          : JSON.stringify(item.arguments ?? {});

      this.onFunctionCallCallback?.(session.callId, {
        name,
        arguments: args,
        callId,
      });
      return;
    }

    if (item.type === "message") {
      const text = this.extractTextFromContent(item.content ?? message.content ?? []);
      if (!text) return;
      if (item.role === "assistant") {
        this.onOutputTranscriptCallback?.(session.callId, text);
        return;
      }
      this.onTranscriptCallback?.(session.callId, text);
      this.onPartialTranscriptCallback?.(session.callId, text);
    }
  }

  private handleFunctionCallDone(session: OpenAISession, message: OpenAIEvent): void {
    const name = message.name?.trim();
    const callId = message.call_id?.trim();
    if (!name || !callId) return;

    this.onFunctionCallCallback?.(session.callId, {
      name,
      arguments: message.arguments ?? "{}",
      callId,
      responseId: message.response_id,
    });
  }

  private handleAudioChunk(session: OpenAISession, message: OpenAIEvent): void {
    const outputResampler = session.outputResampler;
    if (!outputResampler) return;

    const base64Audio = this.extractAudioChunk(message);
    if (!base64Audio) return;

    const pcm24k = Buffer.from(base64Audio, "base64");
    const pcmFloat = pcm16BufferToFloat32(pcm24k);
    const resampled = outputResampler.full(pcmFloat);
    const mulaw = float32ToMuLaw(resampled);

    this.onAudioCallback?.(session.callId, mulaw);
  }

  private extractAudioChunk(message: OpenAIEvent): string | null {
    if (typeof message.delta === "string" && message.delta.length > 0) {
      return message.delta;
    }
    if (typeof message.audio === "string" && message.audio.length > 0) {
      return message.audio;
    }
    const contentAudio = message.content?.find(
      (entry) => entry.type === "audio" && typeof (entry as { audio?: unknown }).audio === "string",
    ) as { audio?: string } | undefined;
    if (contentAudio?.audio) {
      return contentAudio.audio;
    }
    return null;
  }

  private extractTextFromContent(
    content: Array<{ type?: string; text?: string; transcript?: string; audio?: string }>,
  ): string | null {
    const parts: string[] = [];
    for (const entry of content) {
      const text = this.readTranscript(entry.transcript ?? entry.text);
      if (text) {
        parts.push(text);
      }
    }
    if (parts.length === 0) return null;
    return parts.join(" ").trim();
  }

  private readTranscript(value: string | undefined): string | null {
    if (!value) return null;
    const text = value.trim();
    return text ? text : null;
  }

  private handleConnectionError(session: OpenAISession, error: Error): void {
    if (session.closing) return;
    if (session.reconnectTimer) return;

    if (session.reconnectAttempts >= 5) {
      this.onErrorCallback?.(session.callId, error.message);
      return;
    }

    session.connected = false;
    session.reconnectAttempts++;

    const delay = 1000 * Math.pow(2, session.reconnectAttempts - 1);
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = undefined;
      if (session.connected || session.closing) return;

      this.doConnect(session).catch((err) => {
        this.handleConnectionError(
          session,
          err instanceof Error ? err : new Error(String(err)),
        );
      });
    }, delay);
  }

  private buildSessionUpdatePayload(
    options?: RealtimeSessionOptions,
    sessionState?: Pick<OpenAISession, "blockedSessionParams">,
  ): Record<string, unknown> {
    // Keep session.update minimal and compatible.
    const session: Record<string, unknown> = {
      voice: this.voice,
      instructions: options?.instructions ?? "",
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      turn_detection: { type: "server_vad" },
    };

    if (this.inputTranscription) {
      session.input_audio_transcription = { model: "gpt-4o-mini-transcribe" };
    }

    // NOTE: OpenAI Realtime session.update currently rejects `session.output_audio_transcription`.
    // Output transcripts still arrive via `response.*_transcript.*` events when available.

    const tools = this.buildToolDefinitions(options?.tools);
    if (tools) {
      session.tools = tools;
    }

    // Apply blocklist of rejected params (defensive hardening).
    if (sessionState?.blockedSessionParams?.size) {
      for (const blocked of sessionState.blockedSessionParams) {
        const key = blocked.replace(/^session\./, "");
        delete (session as any)[key];
      }
    }

    return { type: "session.update", session };
  }

  private buildToolDefinitions(
    tools?: RealtimeToolDefinition[],
  ): Array<Record<string, unknown>> | null {
    if (!tools || tools.length === 0) return null;

    return tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description ?? "",
      parameters:
        tool.parameters ?? { type: "object", additionalProperties: false },
    }));
  }

  private async ensureResamplers(session: OpenAISession): Promise<void> {
    if (session.inputResampler && session.outputResampler) return;

    const [inputResampler, outputResampler] = await Promise.all([
      createResampler(TWILIO_SAMPLE_RATE, OPENAI_INPUT_SAMPLE_RATE),
      createResampler(OPENAI_OUTPUT_SAMPLE_RATE, TWILIO_SAMPLE_RATE),
    ]);

    session.inputResampler?.destroy();
    session.outputResampler?.destroy();
    session.inputResampler = inputResampler;
    session.outputResampler = outputResampler;
  }
}
