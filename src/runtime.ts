import type { CoreConfig } from "./core-bridge.js";
import type { VoiceCallWsConfig } from "./config.js";
import {
  GeminiLiveConfigSchema,
  OpenAIRealtimeConfigSchema,
  XaiVoiceAgentConfigSchema,
  validateVoiceCallWsConfig,
} from "./config.js";
import { CallManager } from "./manager.js";
import type { TelephonyProvider } from "./providers/base.js";
import { TwilioProvider } from "./providers/twilio.js";
import type { RealtimeProvider } from "./realtime/base.js";
import { MockRealtimeProvider } from "./realtime/mock.js";
import { XaiVoiceAgentProvider } from "./realtime/xai-voice-agent.js";
import { GeminiLiveProvider } from "./realtime/gemini-live.js";
import { OpenAIRealtimeProvider } from "./realtime/openai-realtime.js";
import { RealtimeBridge } from "./realtime-bridge.js";
import { startTunnel, type TunnelResult } from "./tunnel.js";
import { VoiceCallAgent } from "./voice-agent.js";
import {
  cleanupTailscaleExposure,
  setupTailscaleExposure,
  VoiceCallWebhookServer,
} from "./webhook.js";

export type VoiceCallWsRuntime = {
  config: VoiceCallWsConfig;
  provider: TelephonyProvider;
  realtime: RealtimeProvider;
  manager: CallManager;
  webhookServer: VoiceCallWebhookServer;
  webhookUrl: string;
  publicUrl: string | null;
  stop: () => Promise<void>;
};

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug: (message: string) => void;
};

function resolveTelephonyProvider(config: VoiceCallWsConfig): TelephonyProvider {
  return new TwilioProvider(
    {
      accountSid:
        config.telephony.twilio?.accountSid ?? process.env.TWILIO_ACCOUNT_SID,
      authToken:
        config.telephony.twilio?.authToken ?? process.env.TWILIO_AUTH_TOKEN,
    },
    {
      allowNgrokFreeTier: config.tunnel?.allowNgrokFreeTier ?? false,
      publicUrl: config.publicUrl,
      skipVerification: config.skipSignatureVerification,
      streamPath: config.realtime.streamPath,
    },
  );
}

function resolveRealtimeProvider(config: VoiceCallWsConfig): RealtimeProvider {
  if (config.realtime.provider === "mock") {
    return new MockRealtimeProvider();
  }

  if (config.realtime.provider === "gemini-live") {
    const apiKey =
      config.realtime.gemini?.apiKey ??
      process.env.GEMINI_API_KEY ??
      process.env.GOOGLE_API_KEY;
    const geminiConfig = GeminiLiveConfigSchema.parse(config.realtime.gemini ?? {});
    return new GeminiLiveProvider(geminiConfig, apiKey);
  }

  if (config.realtime.provider === "openai-realtime") {
    const apiKey = config.realtime.openai?.apiKey ?? process.env.OPENAI_API_KEY;
    const openaiConfig = OpenAIRealtimeConfigSchema.parse(
      config.realtime.openai ?? {},
    );
    return new OpenAIRealtimeProvider(openaiConfig, apiKey);
  }

  const apiKey = config.realtime.xai?.apiKey ?? process.env.XAI_API_KEY;
  const xaiConfig = XaiVoiceAgentConfigSchema.parse(config.realtime.xai ?? {});
  return new XaiVoiceAgentProvider(xaiConfig, apiKey);
}

export async function createVoiceCallWsRuntime(params: {
  config: VoiceCallWsConfig;
  coreConfig: CoreConfig;
  logger?: Logger;
}): Promise<VoiceCallWsRuntime> {
  const { config, logger, coreConfig } = params;
  const log = logger ?? {
    info: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  if (config.tunnel?.allowNgrokFreeTier) {
    log.warn(
      "[voice-call-ws] WARNING: allowNgrokFreeTier is enabled. This reduces webhook signature verification security and should only be used for development/testing.",
    );
  }


  if (!config.enabled) {
    throw new Error(
      "Voice call WS disabled. Enable the plugin entry in config.",
    );
  }

  const validation = validateVoiceCallWsConfig(config);
  if (!validation.valid) {
    throw new Error(
      `Invalid voice-call-ws config: ${validation.errors.join("; ")}`,
    );
  }

  const provider = resolveTelephonyProvider(config);
  const realtime = resolveRealtimeProvider(config);
  const manager = new CallManager(config);
  const agent = new VoiceCallAgent({ config, coreConfig, logger: log, manager });
  const bridge = new RealtimeBridge({ manager, realtime, agent, logger: log });
  const webhookServer = new VoiceCallWebhookServer(
    config,
    manager,
    provider,
    bridge,
  );

  const localUrl = await webhookServer.start();

  let publicUrl: string | null = config.publicUrl ?? null;
  let tunnelResult: TunnelResult | null = null;

  if (!publicUrl && config.tunnel?.provider && config.tunnel.provider !== "none") {
    try {
      tunnelResult = await startTunnel({
        provider: config.tunnel.provider,
        port: config.serve.port,
        path: config.serve.path,
        ngrokAuthToken:
          config.tunnel.ngrokAuthToken ?? process.env.NGROK_AUTHTOKEN,
        ngrokDomain: config.tunnel.ngrokDomain ?? process.env.NGROK_DOMAIN,
      });
      publicUrl = tunnelResult?.publicUrl ?? null;
    } catch (err) {
      log.error(
        `[voice-call-ws] Tunnel setup failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  if (!publicUrl && config.tailscale?.mode !== "off") {
    publicUrl = await setupTailscaleExposure(config);
  }

  const webhookUrl = publicUrl ?? localUrl;

  if (publicUrl && provider.name === "twilio") {
    (provider as TwilioProvider).setPublicUrl(publicUrl);
  }

  manager.initialize(provider, realtime, webhookUrl);

  const stop = async () => {
    if (tunnelResult) {
      await tunnelResult.stop();
    }
    await cleanupTailscaleExposure(config);
    await webhookServer.stop();
  };

  log.info("[voice-call-ws] Runtime initialized");
  log.info(`[voice-call-ws] Webhook URL: ${webhookUrl}`);
  if (publicUrl) {
    log.info(`[voice-call-ws] Public URL: ${publicUrl}`);
  }

  return {
    config,
    provider,
    realtime,
    manager,
    webhookServer,
    webhookUrl,
    publicUrl,
    stop,
  };
}
