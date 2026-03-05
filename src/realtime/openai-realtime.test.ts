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

function makeSession(overrides?: Record<string, unknown>) {
  return {
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
    functionCallArgsByCallId: new Map(),
    emittedFunctionCallIds: new Set(),
    ...(overrides ?? {}),
  };
}

describe("OpenAIRealtimeProvider", () => {
  it("triggerResponse does not commit input buffer before any audio appended", () => {
    const provider: any = makeProvider();

    const sends: any[] = [];
    const ws = { readyState: 1, send: (x: any) => sends.push(x) };

    provider.sessions.set("CALL", makeSession({ ws }));

    provider.triggerResponse("CALL");

    const payloads = sends.map((s) => JSON.parse(String(s)));
    expect(payloads.some((p) => p.type === "input_audio_buffer.commit")).toBe(false);
    expect(payloads.some((p) => p.type === "response.create")).toBe(true);
  });

  it("session.update payload uses docs-native audio shape at 24k PCM", () => {
    const provider: any = makeProvider();
    const payload = provider.buildSessionUpdatePayload(
      { instructions: "hi" },
      { blockedSessionParams: new Set() },
    );
    expect(JSON.stringify(payload)).not.toContain("output_audio_transcription");
    expect(payload).toMatchObject({
      type: "session.update",
      session: {
        type: "realtime",
        instructions: "hi",
        output_modalities: ["audio"],
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            turn_detection: { type: "semantic_vad" },
          },
          output: {
            format: { type: "audio/pcm" },
            voice: "verse",
          },
        },
      },
    });
    expect(JSON.stringify(payload)).not.toContain("input_audio_format");
    expect(JSON.stringify(payload)).not.toContain("output_audio_format");
  });

  it("session.update blocklist removes nested rejected params", () => {
    const provider: any = makeProvider();
    const payload = provider.buildSessionUpdatePayload(
      { instructions: "hi" },
      {
        blockedSessionParams: new Set([
          "session.audio.input.turn_detection",
          "session.audio.output.voice",
        ]),
      },
    );

    expect(payload.session.audio.input.turn_detection).toBeUndefined();
    expect(payload.session.audio.output.voice).toBeUndefined();
  });

  it("buffers output transcript deltas and emits only a final assistant transcript", () => {
    const provider: any = makeProvider();

    const onOut = vi.fn();
    provider.onOutputTranscript(onOut);

    const session: any = makeSession();

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

  it("emits function call from conversation.item.added and conversation.item.done aliases once", () => {
    const provider: any = makeProvider();
    const onFn = vi.fn();
    provider.onFunctionCall(onFn);
    const session: any = makeSession();

    provider.handleMessage(session, {
      type: "conversation.item.added",
      item: {
        type: "function_call",
        name: "lookup",
        call_id: "call_1",
        arguments: "{\"x\":1}",
      },
    });
    provider.handleMessage(session, {
      type: "conversation.item.done",
      item: {
        type: "function_call",
        name: "lookup",
        call_id: "call_1",
        arguments: "{\"x\":1}",
      },
    });

    expect(onFn).toHaveBeenCalledTimes(1);
    expect(onFn.mock.calls[0][1]).toMatchObject({
      name: "lookup",
      callId: "call_1",
      arguments: "{\"x\":1}",
    });
  });

  it("emits function call from response.done output item", () => {
    const provider: any = makeProvider();
    const onFn = vi.fn();
    provider.onFunctionCall(onFn);
    const session: any = makeSession();

    provider.handleMessage(session, {
      type: "response.done",
      response: {
        id: "resp_1",
        output: [
          {
            type: "function_call",
            name: "generate_horoscope",
            call_id: "call_fc",
            arguments: "{\"sign\":\"Aquarius\"}",
          },
        ],
      },
    });

    expect(onFn).toHaveBeenCalledTimes(1);
    expect(onFn.mock.calls[0][1]).toMatchObject({
      name: "generate_horoscope",
      callId: "call_fc",
      arguments: "{\"sign\":\"Aquarius\"}",
      responseId: "resp_1",
    });
  });

  it("reconstructs function call arguments from delta chunks when done payload omits arguments", () => {
    const provider: any = makeProvider();
    const onFn = vi.fn();
    provider.onFunctionCall(onFn);
    const session: any = makeSession();

    provider.handleMessage(session, {
      type: "response.function_call_arguments.delta",
      call_id: "call_delta",
      delta: "{\"city\":",
    });
    provider.handleMessage(session, {
      type: "response.function_call_arguments.delta",
      call_id: "call_delta",
      delta: "\"Paris\"}",
    });
    provider.handleMessage(session, {
      type: "response.function_call_arguments.done",
      name: "lookup_weather",
      call_id: "call_delta",
      response_id: "resp_2",
    });

    expect(onFn).toHaveBeenCalledTimes(1);
    expect(onFn.mock.calls[0][1]).toMatchObject({
      name: "lookup_weather",
      callId: "call_delta",
      arguments: "{\"city\":\"Paris\"}",
      responseId: "resp_2",
    });
  });
});
