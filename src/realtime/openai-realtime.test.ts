import { describe, expect, it, vi } from "vitest";

import { OpenAIRealtimeProvider } from "./openai-realtime.js";

function makeProvider() {
  return new OpenAIRealtimeProvider(
    {
      // keep defaults
      model: "gpt-realtime-mini",
      voice: "verse",
      inputTranscription: true,
      outputTranscription: false,
    } as any,
    "test-key",
  );
}

describe("OpenAIRealtimeProvider", () => {
  it("triggerResponse does not commit input buffer before any audio appended", () => {
    const provider: any = makeProvider();

    const sends: any[] = [];
    const ws = { readyState: 1, send: (x: any) => sends.push(x) };

    provider.sessions.set("CALL", {
      callId: "CALL",
      ws,
      connected: true,
      reconnectAttempts: 0,
      closing: false,
      pendingTranscript: "",
      inputResampler: null,
      outputResampler: null,
      sessionOptions: {},
      hasInputAudio: false,
      outputTranscriptByResponseId: new Map(),
      blockedSessionParams: new Set(),
    });

    provider.triggerResponse("CALL");

    const payloads = sends.map((s) => JSON.parse(String(s)));
    expect(payloads.some((p) => p.type === "input_audio_buffer.commit")).toBe(false);
    expect(payloads.some((p) => p.type === "response.create")).toBe(true);
  });

  it("session.update payload does not include output_audio_transcription", () => {
    const provider: any = makeProvider();
    const payload = provider.buildSessionUpdatePayload({ instructions: "hi" }, { blockedSessionParams: new Set() });
    expect(JSON.stringify(payload)).not.toContain("output_audio_transcription");
  });

  it("buffers output transcript deltas and emits only a final assistant transcript", () => {
    const provider: any = makeProvider();

    const onOut = vi.fn();
    provider.onOutputTranscript(onOut);

    const session: any = {
      callId: "CALL",
      ws: null,
      connected: true,
      reconnectAttempts: 0,
      closing: false,
      pendingTranscript: "",
      inputResampler: null,
      outputResampler: null,
      sessionOptions: {},
      hasInputAudio: false,
      outputTranscriptByResponseId: new Map(),
      blockedSessionParams: new Set(),
    };

    provider.handleMessage(session, {
      type: "response.audio_transcript.delta",
      delta: "Hello ",
      response_id: "r1",
    });
    provider.handleMessage(session, {
      type: "response.audio_transcript.delta",
      delta: "world",
      response_id: "r1",
    });

    expect(onOut).toHaveBeenCalledTimes(0);

    provider.handleMessage(session, {
      type: "response.audio_transcript.done",
      transcript: "Hello world",
      response_id: "r1",
    });

    expect(onOut).toHaveBeenCalledTimes(1);
    expect(onOut.mock.calls[0][1]).toBe("Hello world");
  });
});
