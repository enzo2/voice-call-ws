import type { RealtimeProviderName } from "../types.js";

export type RealtimeFunctionCall = {
  name: string;
  arguments: string;
  callId: string;
  responseId?: string;
};

export type RealtimeToolDefinition = {
  name: string;
  description?: string;
  parameters?: unknown;
};

export type RealtimeSessionOptions = {
  instructions?: string;
  tools?: RealtimeToolDefinition[];
};

export interface RealtimeProvider {
  readonly name: RealtimeProviderName;

  connect(callId: string, options?: RealtimeSessionOptions): Promise<void>;
  disconnect(callId: string): Promise<void>;

  updateSession?(callId: string, options: RealtimeSessionOptions): void;

  sendAudio(callId: string, audioData: Buffer): void;
  sendText(callId: string, text: string): Promise<void> | void;
  triggerResponse?(callId: string): Promise<void> | void;

  sendFunctionResult?(
    callId: string,
    functionCallId: string,
    result: unknown,
  ): void;

  onTranscript(callback: (callId: string, transcript: string) => void): void;
  onPartialTranscript(
    callback: (callId: string, partial: string) => void,
  ): void;

  /** Optional: model/output-side transcript (assistant speech) when provider supports it. */
  onOutputTranscript?(callback: (callId: string, transcript: string) => void): void;

  onAudio(callback: (callId: string, audioData: Buffer) => void): void;
  onError(callback: (callId: string, error: string) => void): void;
  onFunctionCall(
    callback: (callId: string, call: RealtimeFunctionCall) => void,
  ): void;

  hasActiveSession(callId: string): boolean;
}
