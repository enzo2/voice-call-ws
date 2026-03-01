import { describe, expect, it, vi } from "vitest";

import type { VoiceCallWsConfig } from "./config.js";
import type { CallManager } from "./manager.js";
import { VoiceCallAgent } from "./voice-agent.js";

function baseConfig(overrides: Partial<VoiceCallWsConfig> = {}): VoiceCallWsConfig {
  return {
    enabled: true,
    fromNumber: "+15550001111",
    toNumber: "+15550002222",
    inboundPolicy: "disabled",
    telephony: { provider: "twilio", twilio: { accountSid: "AC", authToken: "tok" } },
    realtime: { provider: "mock", streamPath: "/voice/webhook" },
    outbound: { notifyHangupDelaySec: 2, maxCallDurationSec: 60 },
    tools: { deny: [] },
    privacy: {
      persistTranscript: false,
      allowTranscriptInStatus: true,
      redactPhoneNumbersInStatus: true,
    },
    voiceAgent: {},
    ...overrides,
  } as any;
}

describe("VoiceCallAgent", () => {
  it("builds a minimal, non-corporate prompt with goal", async () => {
    const agent = new VoiceCallAgent({
      config: baseConfig({ voiceAgent: { ownerName: "Alice", agentName: "Bob" } } as any),
      coreConfig: {},
    });

    const options = await agent.buildSessionOptions({
      callId: "c1",
      provider: "twilio",
      providerCallId: "CA123",
      direction: "outbound",
      state: "active",
      from: "+15550001111",
      to: "+15550002222",
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
      metadata: { mode: "conversation", initialMessage: "Say hi" },
    } as any);

    expect(options.instructions).toContain("helpful voice assistant");
    expect(options.instructions).toContain("GOAL: Say hi");
    expect(options.instructions).toContain("Speak naturally");
  });

  it("exposes end_call tool when manager is provided", async () => {
    const manager = { endCall: vi.fn(async () => ({ success: true })) } as any as CallManager;
    const agent = new VoiceCallAgent({ config: baseConfig(), coreConfig: {}, manager });
    const { tools } = await agent.buildSessionOptions(null);
    const endCall = tools?.find((t) => t.name === "end_call");
    expect(endCall).toBeDefined();
  });
});
