import type {
  RealtimeFunctionCall,
  RealtimeProvider,
  RealtimeSessionOptions,
} from "./base.js";

type MockOptions = {
  transcriptDelayMs?: number;
  audioDelayMs?: number;
  fixedTranscript?: string;
};

interface MockSession {
  callId: string;
  connected: boolean;
}

export class MockRealtimeProvider implements RealtimeProvider {
  readonly name = "mock" as const;

  private sessions = new Map<string, MockSession>();
  private onTranscriptCallback:
    | ((callId: string, transcript: string) => void)
    | null = null;
  private onPartialTranscriptCallback:
    | ((callId: string, partial: string) => void)
    | null = null;
  private onOutputTranscriptCallback:
    | ((callId: string, transcript: string) => void)
    | null = null;
  private onAudioCallback: ((callId: string, audioData: Buffer) => void) | null =
    null;
  private onErrorCallback: ((callId: string, error: string) => void) | null =
    null;
  private onFunctionCallCallback:
    | ((callId: string, call: RealtimeFunctionCall) => void)
    | null = null;

  private transcriptDelayMs: number;
  private audioDelayMs: number;
  private fixedTranscript?: string;

  constructor(options: MockOptions = {}) {
    this.transcriptDelayMs = options.transcriptDelayMs ?? 50;
    this.audioDelayMs = options.audioDelayMs ?? 100;
    this.fixedTranscript = options.fixedTranscript;
  }

  async connect(callId: string, _options?: RealtimeSessionOptions): Promise<void> {
    this.sessions.set(callId, { callId, connected: true });
  }

  async disconnect(callId: string): Promise<void> {
    this.sessions.delete(callId);
  }

  sendAudio(callId: string, _audioData: Buffer): void {
    const session = this.sessions.get(callId);
    if (!session?.connected) return;

    const transcript = this.fixedTranscript || "Hello, how can I help you?";
    this.onPartialTranscriptCallback?.(callId, transcript);

    setTimeout(() => {
      this.onTranscriptCallback?.(callId, transcript);
    }, this.transcriptDelayMs);
  }

  async sendText(callId: string, text: string): Promise<void> {
    const session = this.sessions.get(callId);
    if (!session?.connected) return;

    setTimeout(() => {
      this.onOutputTranscriptCallback?.(callId, text);
      const audioData = Buffer.alloc(160, 0xff);
      this.onAudioCallback?.(callId, audioData);
    }, this.audioDelayMs);
  }

  triggerResponse(callId: string): void {
    const session = this.sessions.get(callId);
    if (!session?.connected) return;

    // Simulate audio generation triggered by system prompt/tools
    setTimeout(() => {
      this.onOutputTranscriptCallback?.(
        callId,
        this.fixedTranscript ?? "(mock response)",
      );
      const audioData = Buffer.alloc(160, 0xff);
      this.onAudioCallback?.(callId, audioData);
    }, this.audioDelayMs);
  }


  triggerAudio(callId: string, audioData: Buffer): void {
    const session = this.sessions.get(callId);
    if (!session?.connected) return;
    this.onAudioCallback?.(callId, audioData);
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
    return this.sessions.get(callId)?.connected ?? false;
  }

  simulateFunctionCall(callId: string, call: RealtimeFunctionCall): void {
    this.onFunctionCallCallback?.(callId, call);
  }
}
