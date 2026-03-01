import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { describe, it, expect, vi } from "vitest";

import { VoiceCallWsConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import { TerminalStates } from "./types.js";
import type { TelephonyProvider } from "./providers/base.js";
import type { RealtimeProvider } from "./realtime/base.js";

type SentText = { callId: string; text: string };

function createConfig(storePath: string) {
  return VoiceCallWsConfigSchema.parse({
    enabled: true,
    fromNumber: "+15550001111",
    toNumber: "+15550002222",
    store: storePath,
    inboundPolicy: "disabled",
    telephony: {
      provider: "twilio",
      twilio: {
        accountSid: "AC123",
        authToken: "token",
      },
    },
    realtime: {
      provider: "mock",
    },
  });
}

function createProvider(
  providerCallId: string,
  hangup?: (input: { callId: string; providerCallId: string; reason: string }) => void,
): TelephonyProvider {
  return {
    name: "twilio",
    verifyWebhook: () => ({ ok: true }),
    parseWebhookEvent: () => ({ events: [], statusCode: 200 }),
    initiateCall: async () => ({
      providerCallId,
      status: "initiated",
    }),
    hangupCall: async (input) => {
      hangup?.(input);
    },
  };
}

function createRealtime(sent: SentText[]): RealtimeProvider {
  return {
    name: "mock",
    connect: async () => {},
    disconnect: async () => {},
    sendAudio: () => {},
    sendText: async (callId, text) => {
      sent.push({ callId, text });
    },
    onTranscript: () => {},
    onPartialTranscript: () => {},
    onAudio: () => {},
    onError: () => {},
    onFunctionCall: () => {},
    hasActiveSession: () => true,
  };
}

describe("CallManager", () => {
  it("sends speech through realtime provider and records transcript", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "voice-call-ws-"));
    const storePath = path.join(tmpDir, "store");
    const config = createConfig(storePath);

    const providerCallId = "CA999";
    const provider = createProvider(providerCallId);
    const sent: SentText[] = [];
    const realtime = createRealtime(sent);

    const manager = new CallManager(config, storePath);
    manager.initialize(provider, realtime, "http://localhost");

    const callResult = await manager.initiateCall(config.toNumber || "", undefined, {
      mode: "conversation",
    });
    expect(callResult.success).toBe(true);

    // In conversation mode, initialMessage (if provided) is skipped, so no speak call
    const call = manager.getCall(callResult.callId);
    expect(call?.transcript.length).toBe(0); // No transcript yet

    // Manual speak should still work
    const speakResult = await manager.speak(callResult.callId, "Hello!");
    expect(speakResult.success).toBe(true);
    expect(sent[0]).toEqual({ callId: providerCallId, text: "Hello!" });

    expect(call?.transcript[0]?.speaker).toBe("bot");
    expect(call?.transcript[0]?.text).toBe("Hello!");

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("speaks initial message in notify mode", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "voice-call-ws-notify-"));
    const storePath = path.join(tmpDir, "store");
    const config = createConfig(storePath);

    const providerCallId = "CA888";
    const provider = createProvider(providerCallId);
    const sent: SentText[] = [];
    const realtime = createRealtime(sent);

    const manager = new CallManager(config, storePath);
    manager.initialize(provider, realtime, "http://localhost");

    const message = "This is a notification";
    const callResult = await manager.initiateCall(config.toNumber || "", undefined, {
      mode: "notify",
      message,
    });
    expect(callResult.success).toBe(true);

    // Simulate connection event triggering initial message
    await manager.speakInitialMessage(providerCallId);

    expect(sent.length).toBe(1);
    expect(sent[0]).toEqual({
      callId: providerCallId,
      text: `Repeat the following text exactly, and nothing else: "${message}"`,
    });

    const call = manager.getCall(callResult.callId);
    expect(call?.transcript[0]?.speaker).toBe("bot");
    expect(call?.transcript[0]?.text).toBe(message);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("passes profile option to call metadata", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "voice-call-ws-profile-"));
    const storePath = path.join(tmpDir, "store");
    const config = createConfig(storePath);

    const providerCallId = "CA777";
    const provider = createProvider(providerCallId);
    const realtime = createRealtime([]);

    const manager = new CallManager(config, storePath);
    manager.initialize(provider, realtime, "http://localhost");

    const callResult = await manager.initiateCall(config.toNumber || "", undefined, {
      mode: "conversation",
      profile: "minimal",
    });
    expect(callResult.success).toBe(true);

    const call = manager.getCall(callResult.callId);
    expect(call?.metadata?.profile).toBe("minimal");

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("disconnects realtime when call ends", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "voice-call-ws-end-"));
    const storePath = path.join(tmpDir, "store");
    const config = createConfig(storePath);

    const providerCallId = "CA555";
    const provider = createProvider(providerCallId);
    const realtime = createRealtime([]);
    const disconnect = vi.fn(async () => {});
    realtime.disconnect = disconnect;

    const manager = new CallManager(config, storePath);
    manager.initialize(provider, realtime, "http://localhost");

    const callResult = await manager.initiateCall(config.toNumber || "", undefined, {
      mode: "conversation",
    });
    expect(callResult.success).toBe(true);

    const call = manager.getCall(callResult.callId);
    expect(call).toBeDefined();

    manager.processEvent({
      id: "evt-call-ended",
      type: "call.ended",
      callId: callResult.callId,
      providerCallId,
      timestamp: Date.now(),
      reason: "completed",
      direction: "outbound",
      from: call?.from,
      to: call?.to,
    });

    expect(disconnect).toHaveBeenCalledWith(providerCallId);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves providerCallId for endCall lookups", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "voice-call-ws-map-"));
    const storePath = path.join(tmpDir, "store");
    const config = createConfig(storePath);

    const providerCallId = "CA111";
    const hangup = vi.fn();
    const provider = createProvider(providerCallId, hangup);
    const realtime = createRealtime([]);
    const disconnect = vi.fn(async () => {});
    realtime.disconnect = disconnect;

    const manager = new CallManager(config, storePath);
    manager.initialize(provider, realtime, "http://localhost");

    const callResult = await manager.initiateCall(config.toNumber || "", undefined, {
      mode: "conversation",
    });
    expect(callResult.success).toBe(true);

    const byProvider = manager.getCallByProviderCallId(providerCallId);
    expect(byProvider?.callId).toBe(callResult.callId);

    const endResult = await manager.endCall(providerCallId);
    expect(endResult.success).toBe(true);
    expect(hangup).toHaveBeenCalledWith({
      callId: callResult.callId,
      providerCallId,
      reason: "hangup-bot",
    });
    expect(disconnect).toHaveBeenCalledWith(providerCallId);
    const ended = manager.getCall(callResult.callId);
    expect(ended).toBeDefined();
    expect(TerminalStates.has(ended!.state)).toBe(true);

    await rm(tmpDir, { recursive: true, force: true });
  });

  it("records output transcript as bot transcript", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "voice-call-ws-out-"));
    const storePath = path.join(tmpDir, "store");
    const config = createConfig(storePath);

    const providerCallId = "CA_OUT";
    const provider = createProvider(providerCallId);
    const realtime = createRealtime([]);

    const manager = new CallManager(config, storePath);
    manager.initialize(provider, realtime, "http://localhost");

    const callResult = await manager.initiateCall(config.toNumber || "", undefined, {
      mode: "conversation",
    });
    expect(callResult.success).toBe(true);

    // simulate provider output transcript
    manager.recordAssistantTranscript(callResult.callId, "Hello from the bot");
    const call = manager.getCall(callResult.callId);
    expect(call?.transcript.some((e) => e.speaker === "bot" && e.text.includes("Hello"))).toBe(true);

    await rm(tmpDir, { recursive: true, force: true });
  });
});
