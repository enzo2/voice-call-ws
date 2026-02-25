import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import WebSocket from "ws";
import { describe, it, expect } from "vitest";

import { VoiceCallWsConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import type { TelephonyProvider } from "./providers/base.js";
import { RealtimeBridge } from "./realtime-bridge.js";
import type { RealtimeFunctionCall, RealtimeProvider } from "./realtime/base.js";
import { MockRealtimeProvider } from "./realtime/mock.js";

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

function createProvider(providerCallId: string): TelephonyProvider {
  return {
    name: "twilio",
    verifyWebhook: () => ({ ok: true }),
    parseWebhookEvent: () => ({ events: [], statusCode: 200 }),
    initiateCall: async () => ({
      providerCallId,
      status: "initiated",
    }),
    hangupCall: async () => {},
  };
}

async function listenOnEphemeralPort(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind HTTP server");
  }
  return address.port;
}

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function createDeferred(): Deferred {
  let resolve: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve: resolve! };
}

class DelayedRealtimeProvider implements RealtimeProvider {
  readonly name = "mock" as const;
  private connectGate: Deferred = createDeferred();
  private connected = new Set<string>();
  readonly sendAudioCalls: Array<{ callId: string; audioData: Buffer }> = [];

  async connect(callId: string): Promise<void> {
    await this.connectGate.promise;
    this.connected.add(callId);
  }

  async disconnect(callId: string): Promise<void> {
    this.connected.delete(callId);
  }

  sendAudio(callId: string, audioData: Buffer): void {
    if (!this.connected.has(callId)) return;
    this.sendAudioCalls.push({ callId, audioData });
  }

  async sendText(_callId: string, _text: string): Promise<void> {}

  onTranscript(callback: (callId: string, transcript: string) => void): void {
    void callback;
  }

  onPartialTranscript(
    callback: (callId: string, partial: string) => void,
  ): void {
    void callback;
  }

  onAudio(callback: (callId: string, audioData: Buffer) => void): void {
    void callback;
  }

  onError(callback: (callId: string, error: string) => void): void {
    void callback;
  }

  onFunctionCall(
    callback: (callId: string, call: RealtimeFunctionCall) => void,
  ): void {
    void callback;
  }

  hasActiveSession(callId: string): boolean {
    return this.connected.has(callId);
  }

  releaseConnectGate(): void {
    this.connectGate.resolve();
  }
}

describe("RealtimeBridge", () => {
  it("bridges media stream to transcript and speaks back", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "voice-call-ws-"));
    const storePath = path.join(tmpDir, "store");
    const config = createConfig(storePath);
    const realtime = new MockRealtimeProvider({
      transcriptDelayMs: 10,
      audioDelayMs: 10,
      fixedTranscript: "Hello there",
    });
    const providerCallId = "CA123";
    const provider = createProvider(providerCallId);
    const manager = new CallManager(config, storePath);
    manager.initialize(provider, realtime, "http://localhost");

    const callResult = await manager.initiateCall(config.toNumber || "", undefined, {
      mode: "conversation",
    });
    expect(callResult.success).toBe(true);

    const bridge = new RealtimeBridge({ manager, realtime });
    const server = createServer();
    server.on("upgrade", (req, socket, head) => {
      bridge.handleUpgrade(req, socket, head);
    });

    const port = await listenOnEphemeralPort(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", (err) => reject(err));
    });

    ws.send(
      JSON.stringify({
        event: "start",
        streamSid: "MS123",
        start: {
          streamSid: "MS123",
          accountSid: "AC123",
          callSid: providerCallId,
          tracks: ["inbound"],
          mediaFormat: { encoding: "audio/pcmu", sampleRate: 8000, channels: 1 },
        },
      }),
    );

    ws.send(
      JSON.stringify({
        event: "media",
        streamSid: "MS123",
        media: {
          payload: Buffer.alloc(160, 0xff).toString("base64"),
        },
      }),
    );

    const call = manager.getCall(callResult.callId);
    expect(call).toBeDefined();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Transcript timeout")), 500);
      const interval = setInterval(() => {
        if ((call?.transcript?.length || 0) > 0) {
          clearTimeout(timeout);
          clearInterval(interval);
          resolve();
        }
      }, 10);
    });

    expect(call?.transcript[0]?.speaker).toBe("user");
    expect(call?.transcript[0]?.text).toBe("Hello there");

    const mediaPromise = new Promise<{ event: string; streamSid: string }>((resolve) => {
      ws.on("message", (data) => {
        const parsed = JSON.parse(data.toString()) as { event?: string; streamSid?: string };
        if (parsed.event === "media" && parsed.streamSid === "MS123") {
          resolve(parsed as { event: string; streamSid: string });
        }
      });
    });

    const speakResult = await manager.speak(callResult.callId, "Thanks!");
    expect(speakResult.success).toBe(true);

    const media = await mediaPromise;
    expect(media.event).toBe("media");

    ws.close();
    server.close();
    bridge.closeAll();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("queues media until start finishes", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "voice-call-ws-"));
    const storePath = path.join(tmpDir, "store");
    const config = createConfig(storePath);
    const realtime = new DelayedRealtimeProvider();
    const providerCallId = "CA456";
    const provider = createProvider(providerCallId);
    const manager = new CallManager(config, storePath);
    manager.initialize(provider, realtime, "http://localhost");

    const callResult = await manager.initiateCall(config.toNumber || "", undefined, {
      mode: "conversation",
    });
    expect(callResult.success).toBe(true);

    const bridge = new RealtimeBridge({ manager, realtime });
    const server = createServer();
    server.on("upgrade", (req, socket, head) => {
      bridge.handleUpgrade(req, socket, head);
    });

    const port = await listenOnEphemeralPort(server);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);

    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", (err) => reject(err));
    });

    ws.send(
      JSON.stringify({
        event: "start",
        streamSid: "MS456",
        start: {
          streamSid: "MS456",
          accountSid: "AC123",
          callSid: providerCallId,
          tracks: ["inbound"],
          mediaFormat: { encoding: "audio/pcmu", sampleRate: 8000, channels: 1 },
        },
      }),
    );

    ws.send(
      JSON.stringify({
        event: "media",
        streamSid: "MS456",
        media: {
          payload: Buffer.alloc(160, 0xee).toString("base64"),
        },
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    realtime.releaseConnectGate();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Audio send timeout")), 500);
      const interval = setInterval(() => {
        if (realtime.sendAudioCalls.length > 0) {
          clearTimeout(timeout);
          clearInterval(interval);
          resolve();
        }
      }, 5);
    });

    expect(realtime.sendAudioCalls).toHaveLength(1);
    expect(realtime.sendAudioCalls[0]?.callId).toBe(providerCallId);

    ws.close();
    server.close();
    bridge.closeAll();
    await rm(tmpDir, { recursive: true, force: true });
  });
});
