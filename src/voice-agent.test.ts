import { describe, expect, it, vi } from "vitest";

import type { VoiceCallWsConfig } from "./config.js";
import type { CallManager } from "./manager.js";
import type { RealtimeFunctionCall } from "./realtime/base.js";
import type { CallRecord } from "./types.js";

const deps = vi.hoisted(() => ({
  resolveAgentDir: () => "/tmp/voice-agent",
  resolveAgentWorkspaceDir: () => "/tmp/voice-agent-workspace",
  resolveAgentIdentity: () => ({ name: "voice" }),
  resolveThinkingDefault: () => "minimal",
  buildAgentSystemPrompt: () => "prompt",
  createClawdbotCodingTools: () => [],
  runEmbeddedPiAgent: async () => ({ payloads: [] }),
  resolveAgentTimeoutMs: () => 1000,
  ensureAgentWorkspace: async () => {},
  resolveStorePath: () => "/tmp/voice-agent-store",
  loadSessionStore: () => ({}),
  saveSessionStore: async () => {},
  resolveSessionFilePath: () => "/tmp/voice-agent-session.json",
  normalizeToolName: (value: string) => value.toLowerCase(),
  expandToolGroups: (list?: string[]) => list ?? [],
  resolveToolProfilePolicy: () => undefined,
  DEFAULT_MODEL: "test",
  DEFAULT_PROVIDER: "test",
}));

vi.mock("./core-bridge.js", () => ({
  loadCoreAgentDeps: vi.fn(async () => deps),
}));

import { VoiceCallAgent } from "./voice-agent.js";

function createCall(callId: string): CallRecord {
  return {
    callId,
    provider: "twilio",
    direction: "outbound",
    state: "active",
    from: "+15550001111",
    to: "+15550002222",
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    metadata: {},
  };
}

function createAgent(manager: CallManager) {
  const config = { tools: {} } as unknown as VoiceCallWsConfig;
  return new VoiceCallAgent({ config, coreConfig: {}, manager });
}

describe("VoiceCallAgent end_call", () => {
  it("uses the current call when tools were cached without a call", async () => {
    const manager = {
      endCall: vi.fn().mockResolvedValue(undefined),
    } as unknown as CallManager;
    const agent = createAgent(manager);

    const warmCall: RealtimeFunctionCall = {
      name: "noop",
      arguments: "{}",
      callId: "tool-noop",
    };
    await agent.executeFunctionCall(null, warmCall);

    const call = createCall("call-1");
    const result = await agent.executeFunctionCall(call, {
      name: "end_call",
      arguments: "{}",
      callId: "tool-end",
    });

    expect(manager.endCall).toHaveBeenCalledWith("call-1");
    expect(result).toEqual({ success: true, status: "call_ended" });
  });

  it("uses the latest call when end_call is reused from cache", async () => {
    const manager = {
      endCall: vi.fn().mockResolvedValue(undefined),
    } as unknown as CallManager;
    const agent = createAgent(manager);

    const firstCall = createCall("call-a");
    await agent.executeFunctionCall(firstCall, {
      name: "end_call",
      arguments: "{}",
      callId: "tool-a",
    });

    const secondCall = createCall("call-b");
    await agent.executeFunctionCall(secondCall, {
      name: "end_call",
      arguments: "{}",
      callId: "tool-b",
    });

    expect(manager.endCall).toHaveBeenNthCalledWith(1, "call-a");
    expect(manager.endCall).toHaveBeenNthCalledWith(2, "call-b");
  });
});
