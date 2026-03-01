import type { VoiceCallWsConfig } from "./config.js";
import type { CoreConfig } from "./core-bridge.js";
import type { CallRecord } from "./types.js";
import type { CallManager } from "./manager.js";
import type {
  RealtimeFunctionCall,
  RealtimeSessionOptions,
  RealtimeToolDefinition,
} from "./realtime/base.js";

const DEFAULT_AGENT_ID = "voice";

type AgentTool = {
  name: string;
  label?: string;
  description?: string;
  parameters?: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
    onUpdate?: unknown,
    context?: { call: CallRecord | null },
  ) => Promise<unknown> | unknown;
};

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
};

export class VoiceCallAgent {
  private toolCache: { tools: AgentTool[]; definitions: RealtimeToolDefinition[] } | null =
    null;

  constructor(
    private params: {
      config: VoiceCallWsConfig;
      coreConfig: CoreConfig;
      logger?: Logger;
      manager?: CallManager;
    },
  ) {}

  async buildSessionOptions(call: CallRecord | null): Promise<RealtimeSessionOptions> {
    const { definitions } = await this.getTooling(call);
    const instructions = await this.buildSystemPrompt(call, definitions);
    return { instructions, tools: definitions };
  }

  async executeFunctionCall(
    call: CallRecord | null,
    fnCall: RealtimeFunctionCall,
  ): Promise<unknown> {
    const toolName = fnCall.name;
    const { tools } = await this.getTooling(call);
    const tool = tools.find((entry) => entry.name === toolName);
    if (!tool) {
      return { error: `Unknown tool: ${toolName}` };
    }

    const argsText = fnCall.arguments?.trim() ?? "";
    let args: unknown = {};
    if (argsText) {
      try {
        args = JSON.parse(argsText);
      } catch (err) {
        return {
          error: `Invalid tool arguments for ${toolName}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        };
      }
    }

    try {
      return await tool.execute(fnCall.callId, args, undefined, undefined, { call });
    } catch (err) {
      this.params.logger?.error(
        `[voice-call-ws] Tool ${toolName} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { error: `Tool ${toolName} failed` };
    }
  }

  private async getTooling(call: CallRecord | null): Promise<{
    tools: AgentTool[];
    definitions: RealtimeToolDefinition[];
  }> {
    // If profile changed, invalidate cache (simplified: always rebuild if call profile set)
    const callProfile = this.readMetadataString(call, "profile");
    if (!callProfile && this.toolCache) {
      return this.toolCache;
    }

    const tools: AgentTool[] = [];

    // Only include tools that are implemented locally by this plugin.
    // Keep this publishable (avoid depending on OpenClaw internal dist module layout).
    const deny = new Set(
      (this.params.config.tools?.deny ?? []).map((t) => t.trim().toLowerCase()),
    );

    if (this.params.manager && !deny.has("end_call")) {
      const manager = this.params.manager;
      tools.push({
        name: "end_call",
        label: "End Call",
        description:
          "End the current voice call. Use this when the caller says goodbye or asks to hang up.",
        parameters: { type: "object", properties: {} },
        execute: async (_toolCallId, _params, _signal, _onUpdate, context) => {
          const activeCall = context?.call;
          if (!activeCall) return { error: "No active call context" };
          await manager.endCall(activeCall.callId);
          return { success: true, status: "call_ended" };
        },
      });
    }

    const definitions = this.buildToolDefinitions(tools);

    if (!callProfile) {
      this.toolCache = { tools, definitions };
    }

    return { tools, definitions };
  }

  private buildToolDefinitions(tools: AgentTool[]): RealtimeToolDefinition[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.label ?? "",
      parameters: tool.parameters,
    }));
  }

  private async buildSystemPrompt(
    call: CallRecord | null,
    tools: RealtimeToolDefinition[],
  ): Promise<string> {
    const configuredAgentName = this.params.config.voiceAgent?.agentName?.trim() ?? "";
    const configuredOwnerName = this.params.config.voiceAgent?.ownerName?.trim() ?? "";

    const agentName = configuredAgentName || "assistant";

    const callContext = this.formatCallContext(call);

    const initialMessage = this.readMetadataString(call, "initialMessage");
    const mode = this.readMetadataString(call, "mode");
    const goalBlock =
      mode === "conversation" && initialMessage
        ? `GOAL: ${initialMessage}
Start the conversation by introducing yourself or addressing this goal immediately.`
        : "";

    const toolList = tools.length
      ? [
          "Available tools:",
          ...tools.map((t) => `- ${t.name}: ${t.description ?? ""}`.trim()),
          "",
        ]
      : [];

    const identityLine = configuredOwnerName
      ? `You are ${agentName}, a helpful voice assistant for ${configuredOwnerName}.`
      : `You are ${agentName}, a helpful voice assistant for the owner.`;

    return [
      identityLine,
      "Speak naturally (not corporate) and keep responses brief (1-2 sentences).",
      "If the caller asks you to hang up, end the call immediately.",
      "Don’t mention internal file paths, configuration details, or implementation details.",
      "",
      ...toolList,
      goalBlock,
      "",
      "Call context:",
      ...callContext,
    ]
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  private formatCallContext(call: CallRecord | null): string[] {
    if (!call) {
      return ["- (call context unavailable)"];
    }

    const initialMessage = this.readMetadataString(call, "initialMessage");
    const mode = this.readMetadataString(call, "mode");

    return [
      `- Direction: ${call.direction || "unknown"}`,
      `- From: ${call.from || "unknown"}`,
      `- To: ${call.to || "unknown"}`,
      call.provider ? `- Provider: ${call.provider}` : "",
      mode ? `- Mode: ${mode}` : "",
      initialMessage ? `- Initial instruction: ${initialMessage}` : "",
    ].filter(Boolean);
  }

  private readMetadataString(call: CallRecord | null, key: string): string | null {
    if (!call) return null;
    const value = call.metadata?.[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    }
    return null;
  }
}
