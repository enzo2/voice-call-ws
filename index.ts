import { Type } from "@sinclair/typebox";

import type { CoreConfig } from "./src/core-bridge.js";
import {
  VoiceCallWsConfigSchema,
  validateVoiceCallWsConfig,
  type VoiceCallWsConfig,
} from "./src/config.js";
import { registerVoiceCallWsCli } from "./src/cli.js";
import { createVoiceCallWsRuntime, type VoiceCallWsRuntime } from "./src/runtime.js";

const ACTIONS = [
  "initiate_call",
  "speak_to_user",
  "end_call",
  "get_status",
] as const;

const MODES = ["notify", "conversation"] as const;

function stringEnum<T extends readonly string[]>(
  values: T,
  options: { description?: string } = {},
) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...options,
  });
}

const VoiceCallWsToolSchema = Type.Object(
  {
    action: stringEnum(ACTIONS, {
      description: `Action to perform: ${ACTIONS.join(", ")}`,
    }),
    callId: Type.Optional(Type.String({ description: "Call ID" })),
    to: Type.Optional(Type.String({ description: "Call target" })),
    message: Type.Optional(Type.String({ description: "Message text or system prompt (depending on mode)" })),
    mode: Type.Optional(stringEnum(MODES)),
    profile: Type.Optional(Type.String({ description: "Tool profile (minimal, messaging, full)" })),
    includeTranscript: Type.Optional(Type.Boolean({ description: "Include call transcript in status (default: false)" })),
  },
  { additionalProperties: false },
);

const voiceCallWsConfigSchema = {
  parse(value: unknown): VoiceCallWsConfig {
    const raw =
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : true;
    return VoiceCallWsConfigSchema.parse({ ...raw, enabled });
  },
};

const voiceCallWsPlugin = {
  id: "voice-call-ws",
  name: "Voice Call WS",
  description: "Twilio Media Streams + realtime speech-to-speech providers.",
  configSchema: voiceCallWsConfigSchema,
  register(api) {
    const cfg = voiceCallWsConfigSchema.parse(api.pluginConfig);
    const validation = validateVoiceCallWsConfig(cfg);

    let runtimePromise: Promise<VoiceCallWsRuntime> | null = null;
    let runtime: VoiceCallWsRuntime | null = null;

    const ensureRuntime = async () => {
      if (!cfg.enabled) {
        throw new Error("Voice call WS disabled in plugin config");
      }
      if (!validation.valid) {
        throw new Error(validation.errors.join("; "));
      }
      if (runtime) return runtime;
      if (!runtimePromise) {
        runtimePromise = createVoiceCallWsRuntime({
          config: cfg,
          coreConfig: api.config as CoreConfig,
          logger: api.logger,
        });
      }
      runtime = await runtimePromise;
      return runtime;
    };

    const sendError = (
      respond: (ok: boolean, payload?: unknown) => void,
      err: unknown,
    ) => {
      respond(false, { error: err instanceof Error ? err.message : String(err) });
    };

    api.registerGatewayMethod("voicecallws.initiate", async ({ params, respond }) => {
      try {
        const message =
          typeof params?.message === "string" ? params.message.trim() : "";
        if (!message) {
          respond(false, { error: "message required" });
          return;
        }
        const rt = await ensureRuntime();
        const to =
          typeof params?.to === "string" && params.to.trim()
            ? params.to.trim()
            : rt.config.toNumber;
        if (!to) {
          respond(false, { error: "to required" });
          return;
        }
        const mode =
          params?.mode === "notify" || params?.mode === "conversation"
            ? params.mode
            : undefined;
        const result = await rt.manager.initiateCall(to, undefined, {
          message,
          mode,
        });
        if (!result.success) {
          respond(false, { error: result.error || "initiate failed" });
          return;
        }
        respond(true, { callId: result.callId, initiated: true });
      } catch (err) {
        sendError(respond, err);
      }
    });

    api.registerGatewayMethod("voicecallws.speak", async ({ params, respond }) => {
      try {
        const callId =
          typeof params?.callId === "string" ? params.callId.trim() : "";
        const message =
          typeof params?.message === "string" ? params.message.trim() : "";
        if (!callId || !message) {
          respond(false, { error: "callId and message required" });
          return;
        }
        const rt = await ensureRuntime();
        const result = await rt.manager.speak(callId, message);
        if (!result.success) {
          respond(false, { error: result.error || "speak failed" });
          return;
        }
        respond(true, { success: true });
      } catch (err) {
        sendError(respond, err);
      }
    });

    api.registerGatewayMethod("voicecallws.end", async ({ params, respond }) => {
      try {
        const callId =
          typeof params?.callId === "string" ? params.callId.trim() : "";
        if (!callId) {
          respond(false, { error: "callId required" });
          return;
        }
        const rt = await ensureRuntime();
        const result = await rt.manager.endCall(callId);
        if (!result.success) {
          respond(false, { error: result.error || "end failed" });
          return;
        }
        respond(true, { success: true });
      } catch (err) {
        sendError(respond, err);
      }
    });

    api.registerGatewayMethod("voicecallws.status", async ({ params, respond }) => {
      try {
        const raw =
          typeof params?.callId === "string"
            ? params.callId.trim()
            : typeof params?.sid === "string"
              ? params.sid.trim()
              : "";
        if (!raw) {
          respond(false, { error: "callId required" });
          return;
        }
        const rt = await ensureRuntime();
        const call =
          rt.manager.getCall(raw) || rt.manager.getCallByProviderCallId(raw);
        if (!call) {
          respond(true, { found: false });
          return;
        }
        respond(true, { found: true, call });
      } catch (err) {
        sendError(respond, err);
      }
    });

    api.registerTool({
      name: "voice_call_ws",
      label: "Voice Call WS",
      description:
        "Make voice phone calls over Twilio media streams with realtime speech agents. Calls are performed asynchronously by a conversational subagent. Useful for notifications, real-world interactions with third parties for tasks or queries, or other real-time interactions. The subagent can end the call; there is generally no need to poll status repeatedly.",
      parameters: VoiceCallWsToolSchema,
      async execute(_toolCallId, params) {
        const json = (payload: unknown) => ({
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          details: payload,
        });

        try {
          const rt = await ensureRuntime();

          switch (params.action) {
            case "initiate_call": {
              const message = String(params.message || "").trim();
              if (!message) throw new Error("message required");
              const to =
                typeof params.to === "string" && params.to.trim()
                  ? params.to.trim()
                  : rt.config.toNumber;
              if (!to) throw new Error("to required");
              const result = await rt.manager.initiateCall(to, undefined, {
                message,
                mode:
                  params.mode === "notify" || params.mode === "conversation"
                    ? params.mode
                    : undefined,
                profile: params.profile,
              });
              if (!result.success) {
                throw new Error(result.error || "initiate failed");
              }
              return json({ callId: result.callId, initiated: true });
            }
            case "speak_to_user": {
              const callId = String(params.callId || "").trim();
              const message = String(params.message || "").trim();
              if (!callId || !message) {
                throw new Error("callId and message required");
              }
              const result = await rt.manager.speak(callId, message);
              if (!result.success) {
                throw new Error(result.error || "speak failed");
              }
              return json({ success: true });
            }
            case "end_call": {
              const callId = String(params.callId || "").trim();
              if (!callId) throw new Error("callId required");
              const result = await rt.manager.endCall(callId);
              if (!result.success) {
                throw new Error(result.error || "end failed");
              }
              return json({ success: true });
            }
            case "get_status": {
              const callId = String(params.callId || "").trim();
              if (!callId) throw new Error("callId required");
              const call =
                rt.manager.getCall(callId) ||
                rt.manager.getCallByProviderCallId(callId);

              if (!call) return json({ found: false });

              const { transcript, ...rest } = call;
              const payload = params.includeTranscript
                ? call
                : { ...rest, transcriptSummary: `(${transcript.length} entries hidden)` };

              return json({ found: true, call: payload });
            }
          }
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : String(err) });
        }
      },
    });

    api.registerCli(
      ({ program }) =>
        registerVoiceCallWsCli({
          program,
          config: cfg,
          ensureRuntime,
          logger: api.logger,
        }),
      { commands: ["voicecall-ws"] },
    );
  },
};

export default voiceCallWsPlugin;
