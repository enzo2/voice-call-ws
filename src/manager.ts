import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CallMode, VoiceCallWsConfig } from "./config.js";
import type { RealtimeProvider } from "./realtime/base.js";
import type { TelephonyProvider } from "./providers/base.js";
import { resolveUserPath } from "./utils.js";
import {
  CallRecordSchema,
  type CallId,
  type CallRecord,
  type CallState,
  type NormalizedEvent,
  type OutboundCallOptions,
  TerminalStates,
  type TranscriptEntry,
} from "./types.js";

type TranscriptWaiter = {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
};

/**
 * Manages voice calls: state machine, persistence, and provider coordination.
 */
export class CallManager {
  private activeCalls = new Map<CallId, CallRecord>();
  private providerCallIdMap = new Map<string, CallId>(); // providerCallId -> internal callId
  private processedEventIds = new Set<string>();
  private provider: TelephonyProvider | null = null;
  private realtime: RealtimeProvider | null = null;
  private config: VoiceCallWsConfig;
  private storePath: string;
  private webhookUrl: string | null = null;
  private transcriptWaiters = new Map<CallId, TranscriptWaiter>();
  /** Max duration timers to auto-hangup calls after configured timeout */
  private maxDurationTimers = new Map<CallId, NodeJS.Timeout>();

  constructor(config: VoiceCallWsConfig, storePath?: string) {
    this.config = config;
    const rawPath =
      storePath ||
      config.store ||
      path.join(os.homedir(), "clawd", "voice-calls-ws");
    this.storePath = resolveUserPath(rawPath);
  }

  /**
   * Initialize the call manager with providers.
   */
  initialize(
    provider: TelephonyProvider,
    realtime: RealtimeProvider,
    webhookUrl: string,
  ): void {
    this.provider = provider;
    this.realtime = realtime;
    this.webhookUrl = webhookUrl;

    fs.mkdirSync(this.storePath, { recursive: true });
    this.loadActiveCalls();
  }

  /**
   * Get the current telephony provider.
   */
  getProvider(): TelephonyProvider | null {
    return this.provider;
  }

  /**
   * Get the realtime provider.
   */
  getRealtime(): RealtimeProvider | null {
    return this.realtime;
  }

  /**
   * Initiate an outbound call.
   */
  async initiateCall(
    to: string,
    sessionKey?: string,
    options?: OutboundCallOptions | string,
  ): Promise<{ callId: CallId; success: boolean; error?: string }> {
    const opts: OutboundCallOptions =
      typeof options === "string" ? { message: options } : (options ?? {});
    const initialMessage = opts.message;
    const mode = opts.mode ?? this.config.outbound.defaultMode;

    if (!this.provider) {
      return { callId: "", success: false, error: "Provider not initialized" };
    }
    if (!this.webhookUrl) {
      return {
        callId: "",
        success: false,
        error: "Webhook URL not configured",
      };
    }

    if (this.activeCalls.size >= this.config.maxConcurrentCalls) {
      return {
        callId: "",
        success: false,
        error: `Maximum concurrent calls (${this.config.maxConcurrentCalls}) reached`,
      };
    }

    const callId = crypto.randomUUID();
    const from = this.config.fromNumber;
    if (!from) {
      return { callId: "", success: false, error: "fromNumber not configured" };
    }

    const callRecord: CallRecord = {
      callId,
      provider: this.provider.name,
      direction: "outbound",
      state: "initiated",
      from,
      to,
      sessionKey,
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
      metadata: {
        ...(initialMessage && { initialMessage }),
        mode,
        ...(opts.profile && { profile: opts.profile }),
      },
    };

    this.activeCalls.set(callId, callRecord);
    this.persistCallRecord(callRecord);

    try {
      const result = await this.provider.initiateCall({
        callId,
        from,
        to,
        webhookUrl: this.webhookUrl,
      });

      callRecord.providerCallId = result.providerCallId;
      this.providerCallIdMap.set(result.providerCallId, callId);
      this.persistCallRecord(callRecord);

      return { callId, success: true };
    } catch (err) {
      callRecord.state = "failed";
      callRecord.endedAt = Date.now();
      callRecord.endReason = "failed";
      this.persistCallRecord(callRecord);
      this.activeCalls.delete(callId);
      if (callRecord.providerCallId) {
        this.providerCallIdMap.delete(callRecord.providerCallId);
      }

      return {
        callId,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Speak to user in an active call.
   */
  async speak(
    callId: CallId,
    text: string,
  ): Promise<{ success: boolean; error?: string }> {
    const call = this.findCall(callId);
    if (!call) {
      return { success: false, error: "Call not found" };
    }
    if (!this.realtime || !call.providerCallId) {
      return { success: false, error: "Realtime session not connected" };
    }
    if (TerminalStates.has(call.state)) {
      return { success: false, error: "Call has ended" };
    }

    try {
      this.transitionState(call, "speaking");
      this.persistCallRecord(call);
      this.addTranscriptEntry(call, "bot", text);

      await this.realtime.sendText(call.providerCallId, text);

      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Speak initial message (if provided) when media stream connects.
   */
  async speakInitialMessage(providerCallId: string): Promise<void> {
    const call = this.getCallByProviderCallId(providerCallId);
    if (!call) {
      console.warn(
        `[voice-call-ws] speakInitialMessage: no call found for ${providerCallId}`,
      );
      return;
    }

    const initialMessage = call.metadata?.initialMessage as string | undefined;
    const mode = (call.metadata?.mode as CallMode) ?? "conversation";

    if (!initialMessage) {
      return;
    }

    // In conversation mode, the "initialMessage" is the System Prompt / Goal
    // and is handled by the agent's system prompt generation.
    
    // In notify mode, we use a direct User command to force the model to speak the notification.

    if (call.metadata) {
      delete call.metadata.initialMessage;
      this.persistCallRecord(call);
    }

    if (mode === "notify") {
      // 1. Log the *intended* message as if the bot said it (for clean transcript)
      this.addTranscriptEntry(call, "bot", initialMessage);
      
      // 2. Send the command to the model as a User message to force generation
      // We assume the provider is connected since we are in speakInitialMessage (called after media connect)
      if (this.realtime) {
        const command = `Repeat the following text exactly, and nothing else: "${initialMessage}"`;
        await this.realtime.sendText(call.providerCallId || call.callId, command);
      }
    } else {
       // Fallback / legacy path? 
       // Actually, conversation mode just returns earlier.
       // So we are done for notify mode here.
    }

    if (mode === "notify") {
      const delaySec = this.config.outbound.notifyHangupDelaySec;
      setTimeout(async () => {
        const currentCall = this.activeCalls.get(call.callId);
        if (currentCall && !TerminalStates.has(currentCall.state)) {
          await this.endCall(call.callId);
        }
      }, delaySec * 1000);
    }
  }

  /**
   * Continue a call by sending a prompt and waiting for the next transcript.
   */
  async continueCall(
    callId: CallId,
    prompt: string,
  ): Promise<{ success: boolean; transcript?: string; error?: string }> {
    const call = this.findCall(callId);
    if (!call) return { success: false, error: "Call not found" };
    if (TerminalStates.has(call.state)) {
      return { success: false, error: "Call has ended" };
    }

    try {
      const speakResult = await this.speak(callId, prompt);
      if (!speakResult.success) {
        return speakResult;
      }

      this.transitionState(call, "listening");
      this.persistCallRecord(call);

      const transcript = await this.waitForFinalTranscript(call.callId);

      return { success: true, transcript };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.clearTranscriptWaiter(call.callId);
    }
  }

  /**
   * End a call.
   */
  async endCall(callId: CallId): Promise<{ success: boolean; error?: string }> {
    const call = this.findCall(callId);
    if (!call) return { success: false, error: "Call not found" };
    if (!this.provider || !call.providerCallId) {
      return { success: false, error: "Call not connected" };
    }

    try {
      await this.provider.hangupCall({
        callId: call.callId,
        providerCallId: call.providerCallId,
        reason: "hangup-bot",
      });
      this.disconnectRealtime(call);
      call.endedAt = Date.now();
      call.endReason = "hangup-bot";
      this.transitionState(call, "hangup-bot");
      this.persistCallRecord(call);
      this.clearMaxDurationTimer(call.callId);
      this.rejectTranscriptWaiter(call.callId, "Call ended: hangup-bot");
      this.activeCalls.delete(call.callId);
      this.providerCallIdMap.delete(call.providerCallId);
      return { success: true };
    } catch (err) {
      this.disconnectRealtime(call);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Process a normalized call event.
   */
  processEvent(event: NormalizedEvent): void {
    if (this.processedEventIds.has(event.id)) return;
    this.processedEventIds.add(event.id);

    let call = this.findCall(event.callId);

    if (!call && event.direction === "inbound" && event.providerCallId) {
      if (!this.shouldAcceptInbound(event.from)) {
        return;
      }
      call = this.createInboundCall({
        providerCallId: event.providerCallId,
        from: event.from || "unknown",
        to: event.to || this.config.fromNumber || "unknown",
      });
      event.callId = call.callId;
    }

    if (!call) {
      if (
        event.type === "call.ended" ||
        (event.type === "call.error" && !event.retryable)
      ) {
        this.disconnectRealtimeById(event.providerCallId ?? event.callId);
      }
      return;
    }

    if (event.providerCallId && call.providerCallId !== event.providerCallId) {
      const previousProviderCallId = call.providerCallId;
      call.providerCallId = event.providerCallId;
      this.providerCallIdMap.set(event.providerCallId, call.callId);
      if (previousProviderCallId) {
        const mapped = this.providerCallIdMap.get(previousProviderCallId);
        if (mapped === call.callId) {
          this.providerCallIdMap.delete(previousProviderCallId);
        }
      }
    }

    call.processedEventIds.push(event.id);

    switch (event.type) {
      case "call.initiated":
        this.transitionState(call, "initiated");
        break;
      case "call.ringing":
        this.transitionState(call, "ringing");
        break;
      case "call.answered":
        call.answeredAt = event.timestamp;
        this.transitionState(call, "answered");
        this.startMaxDurationTimer(call.callId);
        break;
      case "call.active":
        this.transitionState(call, "active");
        break;
      case "call.speaking":
        this.transitionState(call, "speaking");
        break;
      case "call.speech":
        if (event.isFinal) {
          // Filter out empty or very short noise (e.g. "Um", ".") to avoid cluttering the log
          // and triggering downstream logic unnecessarily.
          if (!event.transcript || event.transcript.trim().length < 2) {
            return;
          }
          this.addTranscriptEntry(call, "user", event.transcript);
          this.resolveTranscriptWaiter(call.callId, event.transcript);
        }
        this.transitionState(call, "listening");
        break;
      case "call.ended":
        this.disconnectRealtime(call, event);
        call.endedAt = event.timestamp;
        call.endReason = event.reason;
        this.transitionState(call, event.reason as CallState);
        this.clearMaxDurationTimer(call.callId);
        this.rejectTranscriptWaiter(call.callId, `Call ended: ${event.reason}`);
        this.activeCalls.delete(call.callId);
        if (call.providerCallId) {
          this.providerCallIdMap.delete(call.providerCallId);
        }
        break;
      case "call.error":
        if (!event.retryable) {
          this.disconnectRealtime(call, event);
          call.endedAt = event.timestamp;
          call.endReason = "error";
          this.transitionState(call, "error");
          this.clearMaxDurationTimer(call.callId);
          this.rejectTranscriptWaiter(call.callId, `Call error: ${event.error}`);
          this.activeCalls.delete(call.callId);
          if (call.providerCallId) {
            this.providerCallIdMap.delete(call.providerCallId);
          }
        }
        break;
    }

    this.persistCallRecord(call);
  }

  /**
   * Look up a call by internal callId.
   */
  getCall(callId: CallId): CallRecord | undefined {
    return this.activeCalls.get(callId);
  }

  /**
   * Look up a call by providerCallId.
   */
  getCallByProviderCallId(providerCallId: string): CallRecord | undefined {
    const callId = this.providerCallIdMap.get(providerCallId);
    if (callId) return this.activeCalls.get(callId);
    for (const call of this.activeCalls.values()) {
      if (call.providerCallId === providerCallId) return call;
    }
    return undefined;
  }

  getActiveCalls(): CallRecord[] {
    return Array.from(this.activeCalls.values());
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private findCall(callIdOrProviderCallId: string): CallRecord | undefined {
    const directCall = this.activeCalls.get(callIdOrProviderCallId);
    if (directCall) return directCall;
    return this.getCallByProviderCallId(callIdOrProviderCallId);
  }

  private shouldAcceptInbound(from: string | undefined): boolean {
    const { inboundPolicy: policy, allowFrom } = this.config;

    switch (policy) {
      case "disabled":
        return false;
      case "open":
        return true;
      case "allowlist":
      case "pairing": {
        const normalized = from?.replace(/\D/g, "") || "";
        const allowed = (allowFrom || []).some((num) => {
          const normalizedAllow = num.replace(/\D/g, "");
          return (
            normalized.endsWith(normalizedAllow) ||
            normalizedAllow.endsWith(normalized)
          );
        });
        return allowed;
      }
      default:
        return false;
    }
  }

  private createInboundCall(params: {
    providerCallId: string;
    from: string;
    to: string;
  }): CallRecord {
    const callId = crypto.randomUUID();
    const callRecord: CallRecord = {
      callId,
      providerCallId: params.providerCallId,
      provider: this.provider?.name || "twilio",
      direction: "inbound",
      state: "ringing",
      from: params.from,
      to: params.to,
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
      metadata: {
        initialMessage:
          this.config.inboundGreeting || "Hello! How can I help you today?",
      },
    };

    this.activeCalls.set(callId, callRecord);
    this.providerCallIdMap.set(params.providerCallId, callId);
    this.persistCallRecord(callRecord);
    return callRecord;
  }

  private addTranscriptEntry(
    call: CallRecord,
    speaker: TranscriptEntry["speaker"],
    text: string,
  ): void {
    call.transcript.push({
      timestamp: Date.now(),
      speaker,
      text,
      isFinal: true,
    });
  }

  private transitionState(call: CallRecord, next: CallState): void {
    call.state = next;
  }

  private startMaxDurationTimer(callId: CallId): void {
    this.clearMaxDurationTimer(callId);
    if (!this.config.maxDurationSeconds) return;
    const timer = setTimeout(async () => {
      await this.endCall(callId);
    }, this.config.maxDurationSeconds * 1000);
    this.maxDurationTimers.set(callId, timer);
  }

  private clearMaxDurationTimer(callId: CallId): void {
    const timer = this.maxDurationTimers.get(callId);
    if (timer) {
      clearTimeout(timer);
      this.maxDurationTimers.delete(callId);
    }
  }

  private waitForFinalTranscript(callId: CallId): Promise<string> {
    this.rejectTranscriptWaiter(callId, "Transcript waiter replaced");
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.transcriptWaiters.delete(callId);
        reject(new Error("Timed out waiting for transcript"));
      }, this.config.transcriptTimeoutMs);
      this.transcriptWaiters.set(callId, { resolve, reject, timeout });
    });
  }

  private clearTranscriptWaiter(callId: CallId): void {
    const waiter = this.transcriptWaiters.get(callId);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.transcriptWaiters.delete(callId);
  }

  private rejectTranscriptWaiter(callId: CallId, reason: string): void {
    const waiter = this.transcriptWaiters.get(callId);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.transcriptWaiters.delete(callId);
    waiter.reject(new Error(reason));
  }

  private resolveTranscriptWaiter(callId: CallId, transcript: string): void {
    const waiter = this.transcriptWaiters.get(callId);
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.transcriptWaiters.delete(callId);
    waiter.resolve(transcript);
  }

  private disconnectRealtimeById(callId: string | undefined): void {
    if (!this.realtime || !callId) return;
    this.realtime.disconnect(callId).catch((err) => {
      console.error("[voice-call-ws] Failed to disconnect realtime session:", err);
    });
  }

  private disconnectRealtime(call: CallRecord, event?: NormalizedEvent): void {
    const realtimeCallId =
      event?.providerCallId ?? call.providerCallId ?? call.callId;
    this.disconnectRealtimeById(realtimeCallId);
  }

  private persistCallRecord(call: CallRecord): void {
    const logPath = path.join(this.storePath, "calls.jsonl");
    const line = `${JSON.stringify(call)}\n`;
    fsp.appendFile(logPath, line).catch((err) => {
      console.error("[voice-call-ws] Failed to persist call record:", err);
    });
  }

  private loadActiveCalls(): void {
    const logPath = path.join(this.storePath, "calls.jsonl");
    if (!fs.existsSync(logPath)) {
      return;
    }

    const content = fs.readFileSync(logPath, "utf-8");
    const lines = content.split("\n");

    const callMap = new Map<CallId, CallRecord>();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const call = CallRecordSchema.parse(JSON.parse(line));
        callMap.set(call.callId, call);
      } catch {
        // Skip invalid lines.
      }
    }

    for (const [callId, call] of callMap) {
      if (TerminalStates.has(call.state)) continue;
      this.activeCalls.set(callId, call);
      if (call.providerCallId) {
        this.providerCallIdMap.set(call.providerCallId, callId);
      }
      for (const eventId of call.processedEventIds) {
        this.processedEventIds.add(eventId);
      }
    }
  }
}
