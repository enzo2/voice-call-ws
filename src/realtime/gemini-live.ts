import { GoogleGenAI, Modality } from "@google/genai";

import type { GeminiLiveConfig } from "../config.js";
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

type GeminiRealtimeInput = {
  audio?: {
    data: string;
    mimeType?: string;
    mime_type?: string;
  };
  audioStreamEnd?: boolean;
  activityStart?: Record<string, never>;
  activityEnd?: Record<string, never>;
};

type GeminiClientContent = {
  turns:
    | string
    | Array<{ role?: string; parts?: Array<{ text?: string }> }>;
  turnComplete?: boolean;
};

type GeminiToolResponse = {
  functionResponses: Array<{ id: string; name: string; response: unknown }>;
};

type GeminiLiveSession = {
  sendRealtimeInput: (input: GeminiRealtimeInput) => void;
  sendClientContent: (input: GeminiClientContent) => void;
  sendToolResponse: (input: GeminiToolResponse) => void;
  close: () => void;
};

type GeminiTranscription = { text?: string };

type GeminiInlineData = {
  data?: string | Uint8Array;
  mimeType?: string;
  mime_type?: string;
};

type GeminiPart = {
  inlineData?: GeminiInlineData;
  inline_data?: GeminiInlineData;
  text?: string;
};

type GeminiModelTurn = {
  parts?: GeminiPart[];
};

type GeminiServerContent = {
  modelTurn?: GeminiModelTurn;
  model_turn?: GeminiModelTurn;
  interrupted?: boolean;
  inputTranscription?: GeminiTranscription;
  input_transcription?: GeminiTranscription;
  outputTranscription?: GeminiTranscription;
  output_transcription?: GeminiTranscription;
  turnComplete?: boolean;
  turn_complete?: boolean;
};

type GeminiFunctionCall = {
  id?: string;
  name?: string;
  args?: unknown;
  arguments?: string;
};

type GeminiToolCall = {
  functionCalls?: GeminiFunctionCall[];
  function_calls?: GeminiFunctionCall[];
};

type GeminiServerMessage = {
  serverContent?: GeminiServerContent;
  server_content?: GeminiServerContent;
  toolCall?: GeminiToolCall;
  tool_call?: GeminiToolCall;
  inputTranscription?: GeminiTranscription;
  outputTranscription?: GeminiTranscription;
  data?: string | Uint8Array;
  text?: string;
};

interface GeminiSession {
  callId: string;
  session: GeminiLiveSession | null;
  connected: boolean;
  reconnectAttempts: number;
  closing: boolean;
  inputResampler: LibSampleRateInstance | null;
  outputResampler: LibSampleRateInstance | null;
  toolCallNames: Map<string, string>;
  sessionOptions?: RealtimeSessionOptions;
}

const TWILIO_SAMPLE_RATE = 8000;
// Gemini Live expects 16k input PCM and returns 24k output PCM.
const GEMINI_INPUT_SAMPLE_RATE = 16000;
const GEMINI_OUTPUT_SAMPLE_RATE = 24000;

export class GeminiLiveProvider implements RealtimeProvider {
  readonly name = "gemini-live" as const;

  private client: GoogleGenAI;
  private model: string;
  private voice?: string;
  private inputTranscription: boolean;
  private outputTranscription: boolean;
  private sessions = new Map<string, GeminiSession>();

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

  constructor(config: GeminiLiveConfig, apiKey?: string) {
    const resolvedApiKey =
      apiKey ||
      config.apiKey ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY;
    if (!resolvedApiKey) {
      throw new Error("Gemini API key is required");
    }

    this.client = new GoogleGenAI({ apiKey: resolvedApiKey });
    this.model =
      config.model || "gemini-2.5-flash-native-audio-preview-12-2025";
    this.voice = config.voice || undefined;
    this.inputTranscription = config.inputTranscription ?? true;
    this.outputTranscription = config.outputTranscription ?? false;
  }

  async connect(callId: string, options?: RealtimeSessionOptions): Promise<void> {
    const session: GeminiSession = {
      callId,
      session: null,
      connected: false,
      reconnectAttempts: 0,
      closing: false,
      inputResampler: null,
      outputResampler: null,
      toolCallNames: new Map(),
      sessionOptions: options,
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
    session.session?.close();
    session.session = null;
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
  }

  sendAudio(callId: string, audioData: Buffer): void {
    const session = this.sessions.get(callId);
    if (!session?.connected || !session.session) return;

    const inputResampler = session.inputResampler;
    if (!inputResampler) return;

    const pcmFloat = muLawToFloat32(audioData);
    const resampled = inputResampler.full(pcmFloat);
    const pcmBuffer = float32ToPcm16Buffer(resampled);

    session.session.sendRealtimeInput({
      audio: {
        data: pcmBuffer.toString("base64"),
        mimeType: `audio/pcm;rate=${GEMINI_INPUT_SAMPLE_RATE}`,
      },
    });
  }

  async sendText(callId: string, text: string): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session?.connected || !session.session) return;

    session.session.sendClientContent({
      turns: text,
      turnComplete: true,
    });
  }

  sendFunctionResult(callId: string, functionCallId: string, result: unknown): void {
    const session = this.sessions.get(callId);
    if (!session?.connected || !session.session) return;

    const functionName = session.toolCallNames.get(functionCallId);
    if (!functionName) {
      this.onErrorCallback?.(
        callId,
        `Gemini function response missing name for call ${functionCallId}`,
      );
      return;
    }

    session.session.sendToolResponse({
      functionResponses: [
        {
          id: functionCallId,
          name: functionName,
          response: result,
        },
      ],
    });
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
    return session?.connected === true && session.session !== null;
  }

  private async doConnect(session: GeminiSession): Promise<void> {
    try {
      const liveSession = (await this.client.live.connect({
        model: this.model,
        config: this.buildSessionConfig(session.sessionOptions),
        callbacks: {
          onmessage: (message: GeminiServerMessage) => {
            this.handleMessage(session, message);
          },
          onerror: (err: { message?: string } | Error) => {
            const message =
              err instanceof Error ? err.message : err.message || "Gemini error";
            this.handleConnectionError(session, new Error(message));
          },
          onclose: (event: { reason?: string }) => {
            session.connected = false;
            if (!session.closing) {
              this.handleConnectionError(
                session,
                new Error(`Gemini connection closed: ${event.reason ?? "unknown"}`),
              );
            }
          },
        },
      })) as GeminiLiveSession;

      session.session = liveSession;
      session.connected = true;
      session.reconnectAttempts = 0;
    } catch (err) {
      this.handleConnectionError(
        session,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }

  private handleMessage(session: GeminiSession, message: GeminiServerMessage): void {
    this.handleToolCalls(session, message);

    const transcript = this.extractInputTranscript(message);

    const outputTranscript = this.extractOutputTranscript(message);
    if (outputTranscript) {
      this.onOutputTranscriptCallback?.(session.callId, outputTranscript);
    }
    if (transcript) {
      this.onTranscriptCallback?.(session.callId, transcript);
      this.onPartialTranscriptCallback?.(session.callId, transcript);
    }

    const audioChunks = this.extractAudioChunks(message);
    if (audioChunks.length > 0) {
      for (const chunk of audioChunks) {
        this.emitAudio(session, chunk);
      }
    }
  }

  private handleToolCalls(session: GeminiSession, message: GeminiServerMessage): void {
    const toolCall = message.toolCall ?? message.tool_call;
    const functionCalls =
      toolCall?.functionCalls ?? toolCall?.function_calls ?? [];

    for (const call of functionCalls) {
      const name =
        typeof call.name === "string" ? call.name.trim() : undefined;
      const id = typeof call.id === "string" ? call.id.trim() : undefined;
      if (!name || !id) continue;

      const args = call.arguments ?? call.args ?? {};
      const argsText =
        typeof args === "string" ? args : JSON.stringify(args ?? {});

      session.toolCallNames.set(id, name);

      const formattedCall: RealtimeFunctionCall = {
        name,
        arguments: argsText,
        callId: id,
      };

      this.onFunctionCallCallback?.(session.callId, formattedCall);
    }
  }

  private extractInputTranscript(message: GeminiServerMessage): string | null {
    const serverContent = message.serverContent ?? message.server_content;
    const transcription =
      serverContent?.inputTranscription ??
      serverContent?.input_transcription ??
      message.inputTranscription;

    const text = transcription?.text?.trim();
    return text ? text : null;
  }

  private extractOutputTranscript(message: GeminiServerMessage): string | null {
    const serverContent = message.serverContent ?? message.server_content;
    const transcription =
      serverContent?.outputTranscription ??
      serverContent?.output_transcription ??
      message.outputTranscription;

    const text = transcription?.text?.trim();
    return text ? text : null;
  }

  private extractAudioChunks(message: GeminiServerMessage): Buffer[] {
    const chunks: Buffer[] = [];
    const serverContent = message.serverContent ?? message.server_content;
    const modelTurn = serverContent?.modelTurn ?? serverContent?.model_turn;
    const parts = modelTurn?.parts ?? [];

    for (const part of parts) {
      const inline = part.inlineData ?? part.inline_data;
      if (!inline?.data) continue;
      if (typeof inline.data === "string") {
        chunks.push(Buffer.from(inline.data, "base64"));
      } else {
        chunks.push(Buffer.from(inline.data));
      }
    }

    if (chunks.length > 0) {
      return chunks;
    }

    if (typeof message.data === "string") {
      chunks.push(Buffer.from(message.data, "base64"));
    } else if (message.data instanceof Uint8Array) {
      chunks.push(Buffer.from(message.data));
    }

    return chunks;
  }

  private emitAudio(session: GeminiSession, pcmChunk: Buffer): void {
    const outputResampler = session.outputResampler;
    if (!outputResampler) return;

    const pcmFloat = pcm16BufferToFloat32(pcmChunk);
    const resampled = outputResampler.full(pcmFloat);
    const encoded = float32ToMuLaw(resampled);

    this.onAudioCallback?.(session.callId, encoded);
  }

  private handleConnectionError(session: GeminiSession, error: Error): void {
    if (session.closing) return;

    if (session.reconnectAttempts >= 5) {
      this.onErrorCallback?.(session.callId, error.message);
      return;
    }

    session.connected = false;
    session.reconnectAttempts++;

    const delay = 1000 * Math.pow(2, session.reconnectAttempts - 1);
    setTimeout(() => {
      if (session.connected || session.closing) return;
      this.doConnect(session).catch((err) => {
        this.handleConnectionError(
          session,
          err instanceof Error ? err : new Error(String(err)),
        );
      });
    }, delay);
  }

  private buildSessionConfig(options?: RealtimeSessionOptions): Record<string, unknown> {
    const config: Record<string, unknown> = {
      responseModalities: [Modality.AUDIO],
    };

    if (options?.instructions) {
      config.systemInstruction = { parts: [{ text: options.instructions }] };
    }

    if (this.voice) {
      config.speechConfig = {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: this.voice } },
      };
    }

    if (this.inputTranscription) {
      config.inputAudioTranscription = {};
    }

    if (this.outputTranscription) {
      config.outputAudioTranscription = {};
    }

    const toolDefs = this.buildToolDeclarations(options?.tools);
    if (toolDefs) {
      config.tools = toolDefs;
    }

    return config;
  }

  private buildToolDeclarations(
    tools?: RealtimeToolDefinition[],
  ): Array<{ functionDeclarations: Array<Record<string, unknown>> }> | null {
    if (!tools || tools.length === 0) return null;

    return [
      {
        functionDeclarations: tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          parameters:
            tool.parameters ?? { type: "object", additionalProperties: false },
        })),
      },
    ];
  }

  private async ensureResamplers(session: GeminiSession): Promise<void> {
    if (session.inputResampler && session.outputResampler) return;

    const [inputResampler, outputResampler] = await Promise.all([
      createResampler(TWILIO_SAMPLE_RATE, GEMINI_INPUT_SAMPLE_RATE),
      createResampler(GEMINI_OUTPUT_SAMPLE_RATE, TWILIO_SAMPLE_RATE),
    ]);

    session.inputResampler?.destroy();
    session.outputResampler?.destroy();
    session.inputResampler = inputResampler;
    session.outputResampler = outputResampler;
  }
}
