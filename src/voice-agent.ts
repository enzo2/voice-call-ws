import { loadCoreAgentDeps } from "./core-bridge.js";
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
const DEFAULT_TOOL_PROFILE = "messaging";

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

type ToolPolicy = {
  allow?: string[];
  deny?: string[];
};

export class VoiceCallAgent {
  private depsPromise: ReturnType<typeof loadCoreAgentDeps> | null = null;
  private toolCache: { tools: AgentTool[]; definitions: RealtimeToolDefinition[] } | null =
    null;
  private workspaceDir: string | null = null;

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
          error: `Invalid tool arguments for ${toolName}: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    try {
      return await tool.execute(fnCall.callId, args, undefined, undefined, { call });
    } catch (err) {
      const logger = this.params.logger;
      logger?.error(
        `[voice-call-ws] Tool ${toolName} failed: ${err instanceof Error ? err.message : String(err)}`,
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
    if (callProfile || !this.toolCache) {
      // no-op, just proceed to build
    } else {
       return this.toolCache;
    }

    const deps = await this.getDeps();
    const agentId = DEFAULT_AGENT_ID;
    const agentDir = deps.resolveAgentDir(this.params.coreConfig, agentId);
    const workspaceDir = deps.resolveAgentWorkspaceDir(this.params.coreConfig, agentId);
    this.workspaceDir = workspaceDir;
    const sessionKey = `agent:${agentId}:voice`;

    const rawTools = deps.createClawdbotCodingTools({
      config: this.params.coreConfig,
      sessionKey,
      agentDir,
      workspaceDir,
    }) as AgentTool[];

    const policy = this.resolveToolPolicy(deps, callProfile);
    const tools = this.filterTools(rawTools, policy, deps);

    // Inject end_call tool as a system tool (post-filter)
    // This ensures it doesn't trigger the "allow-only" logic of the filter if the allowlist was empty.
    if (this.params.manager) {
      const manager = this.params.manager;
      const endCallName = "end_call";
      const normalizedEndCall = deps.normalizeToolName(endCallName);
      
      // Check if explicitly denied in the policy
      const expandedDeny = deps.expandToolGroups(policy.deny);
      const isDenied = expandedDeny.some(
        (name) => deps.normalizeToolName(name) === normalizedEndCall
      );

      if (!isDenied) {
        tools.push({
          name: endCallName,
          label: "End Call",
          description: "End the current voice call. Use this when the user says goodbye or asks to hang up. You can also choose to hang up if your conversation is complete.",
          parameters: { type: "object", properties: {} }, // No params needed, callId inferred
          execute: async (_toolCallId, _params, _signal, _onUpdate, context) => {
            const activeCall = context?.call;
            if (!activeCall) return { error: "No active call context" };
            await manager.endCall(activeCall.callId);
            return { success: true, status: "call_ended" };
          },
        });
      }
    }

    const definitions = this.buildToolDefinitions(tools);

    // Cache only if no specific profile override
    if (!callProfile) {
      this.toolCache = { tools, definitions };
    }
    
    return { tools, definitions };
  }

  private async getDeps() {
    if (!this.depsPromise) {
      this.depsPromise = loadCoreAgentDeps();
    }
    return this.depsPromise;
  }

  private resolveToolPolicy(
    deps: Awaited<ReturnType<typeof loadCoreAgentDeps>>, 
    profileOverride?: string | null
  ): ToolPolicy {
    const toolConfig = this.params.config.tools;
    const profile = profileOverride ?? toolConfig?.profile ?? DEFAULT_TOOL_PROFILE;
    const profilePolicy = deps.resolveToolProfilePolicy(profile);

    const allow = [
      ...(profilePolicy?.allow ?? []),
      ...(toolConfig?.allow ?? []),
    ];
    
    const deny = [
      ...(profilePolicy?.deny ?? []),
      ...(toolConfig?.deny ?? []),
    ];

    return {
      allow: allow.length > 0 ? allow : undefined,
      deny: deny.length > 0 ? deny : undefined,
    };
  }

  private filterTools(
    tools: AgentTool[],
    policy: ToolPolicy,
    deps: Awaited<ReturnType<typeof loadCoreAgentDeps>>,
  ): AgentTool[] {
    const expandedAllow = deps.expandToolGroups(policy.allow);
    const expandedDeny = deps.expandToolGroups(policy.deny);
    const allowSet = new Set(expandedAllow.map((name) => deps.normalizeToolName(name)));
    const denySet = new Set(expandedDeny.map((name) => deps.normalizeToolName(name)));

    return tools.filter((tool) => {
      const normalized = deps.normalizeToolName(tool.name);
      if (denySet.has(normalized)) return false;
      if (allowSet.size === 0) return true;
      return allowSet.has(normalized);
    });
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
    const deps = await this.getDeps();
    const agentId = DEFAULT_AGENT_ID;
    const identity = deps.resolveAgentIdentity(this.params.coreConfig, agentId);
    const agentName = identity?.name?.trim() || "assistant";

    const toolSummaries = this.buildToolSummaryMap(tools);
    const basePrompt = deps.buildAgentSystemPrompt({
      workspaceDir: this.workspaceDir ?? process.cwd(),
      promptMode: "minimal",
      toolNames: tools.map((tool) => tool.name),
      toolSummaries,
      runtimeInfo: { agentId, channel: "voice" },
      reasoningTagHint: false,
    });

    const callContext = this.formatCallContext(call);
    
    // In conversation mode, the "initialMessage" is the System Prompt / Goal
    const initialMessage = this.readMetadataString(call, "initialMessage");
    const mode = this.readMetadataString(call, "mode");
    const goalBlock = (mode === "conversation" && initialMessage)
      ? `GOAL: ${initialMessage}\nStart the conversation by introducing yourself or addressing this goal immediately.`
      : "";

    const voiceBlock = [
      `You are ${agentName}, a voice-call agent acting on behalf of the Clawdbot owner.`,
      "You are not Clawdbot itself and do not have broad system or filesystem access.",
      "Only use the tools listed above. If something is out of scope, say so and offer to take a message.",
      "This call may involve third parties. Be polite, concise, and professional.",
      "Never mention internal systems, tool names, or hidden capabilities to the caller.",
      "When given a task, be mission-focused and confirm key details before committing.",
      "Keep responses brief and natural for a phone call (1-2 sentences).",
      "",
      goalBlock,
      "",
      "Call context:",
      ...callContext,
    ]
      .filter(Boolean)
      .join("\n");

    return `${basePrompt}\n\n${voiceBlock}`.trim();
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

  private buildToolSummaryMap(
    tools: RealtimeToolDefinition[],
  ): Record<string, string> {
    const summaries: Record<string, string> = {};
    for (const tool of tools) {
      const summary = tool.description?.trim();
      if (!summary) continue;
      summaries[tool.name.toLowerCase()] = summary;
    }
    return summaries;
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
