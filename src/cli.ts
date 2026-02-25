import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Command } from "commander";

import type { VoiceCallWsConfig } from "./config.js";
import type { VoiceCallWsRuntime } from "./runtime.js";
import { resolveUserPath } from "./utils.js";
import {
  cleanupTailscaleExposureRoute,
  getTailscaleSelfInfo,
  setupTailscaleExposureRoute,
} from "./webhook.js";

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

function resolveMode(input: string): "off" | "serve" | "funnel" {
  const raw = input.trim().toLowerCase();
  if (raw === "serve" || raw === "off") return raw;
  return "funnel";
}

function resolveDefaultStorePath(config: VoiceCallWsConfig): string {
  const base =
    config.store?.trim() || path.join(os.homedir(), "clawd", "voice-calls-ws");
  return path.join(resolveUserPath(base), "calls.jsonl");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function registerVoiceCallWsCli(params: {
  program: Command;
  config: VoiceCallWsConfig;
  ensureRuntime: () => Promise<VoiceCallWsRuntime>;
  logger: Logger;
}) {
  const { program, config, ensureRuntime, logger } = params;
  const root = program
    .command("voicecall-ws")
    .description("Voice call WebSocket utilities")
    .addHelpText(
      "after",
      () => `\nDocs: https://docs.clawd.bot/plugins/voice-call-ws\n`,
    );

  root
    .command("call")
    .description("Initiate an outbound voice call")
    .requiredOption(
      "-m, --message <text>",
      "Message to speak when call connects",
    )
    .option(
      "-t, --to <phone>",
      "Phone number to call (E.164 format, uses config toNumber if not set)",
    )
    .option(
      "--mode <mode>",
      "Call mode: notify (hangup after message) or conversation (stay open)",
      "conversation",
    )
    .option(
      "--profile <profile>",
      "Tool profile: minimal, messaging, full",
    )
    .action(
      async (options: { message: string; to?: string; mode?: string; profile?: string }) => {
        const rt = await ensureRuntime();
        const to = options.to ?? rt.config.toNumber;
        if (!to) {
          throw new Error("Missing --to and no toNumber configured");
        }
        const result = await rt.manager.initiateCall(to, undefined, {
          message: options.message,
          mode:
            options.mode === "notify" || options.mode === "conversation"
              ? options.mode
              : undefined,
          profile: options.profile,
        });
        if (!result.success) {
          throw new Error(result.error || "Call initiation failed");
        }
        logger.info(`Call initiated: ${result.callId}`);
      },
    );

  root
    .command("speak")
    .description("Send a message to the realtime provider to speak")
    .requiredOption("--call-id <id>", "Call ID")
    .requiredOption("-m, --message <text>", "Message to speak")
    .action(async (options: { callId: string; message: string }) => {
      const rt = await ensureRuntime();
      const result = await rt.manager.speak(options.callId, options.message);
      if (!result.success) {
        throw new Error(result.error || "Speak failed");
      }
      logger.info("Message sent");
    });

  root
    .command("end")
    .description("End an active call")
    .requiredOption("--call-id <id>", "Call ID")
    .action(async (options: { callId: string }) => {
      const rt = await ensureRuntime();
      const result = await rt.manager.endCall(options.callId);
      if (!result.success) {
        throw new Error(result.error || "End failed");
      }
      logger.info("Call ended");
    });

  root
    .command("status")
    .description("Get call status")
    .requiredOption("--call-id <id>", "Call ID or provider SID")
    .action(async (options: { callId: string }) => {
      const rt = await ensureRuntime();
      const call =
        rt.manager.getCall(options.callId) ||
        rt.manager.getCallByProviderCallId(options.callId);
      if (!call) {
        logger.info("Call not found");
        return;
      }
      logger.info(JSON.stringify(call, null, 2));
    });

  root
    .command("tail")
    .description("Tail call logs (JSONL)")
    .option("-f, --file <path>", "Log file path override")
    .action(async (options: { file?: string }) => {
      const logPath = options.file || resolveDefaultStorePath(config);
      if (!fs.existsSync(logPath)) {
        logger.warn(`Log file not found: ${logPath}`);
        return;
      }

      let lastSize = fs.statSync(logPath).size;
      logger.info(`Tailing ${logPath}`);

      for (;;) {
        const stats = fs.statSync(logPath);
        if (stats.size > lastSize) {
          const stream = fs.createReadStream(logPath, {
            start: lastSize,
            end: stats.size,
            encoding: "utf-8",
          });
          stream.on("data", (chunk) => {
            process.stdout.write(chunk);
          });
          lastSize = stats.size;
        }
        await sleep(500);
      }
    });

  root
    .command("expose")
    .description("Expose webhook via Tailscale serve or funnel")
    .option("--mode <mode>", "Mode: off | serve | funnel", "serve")
    .action(async (options: { mode: string }) => {
      const mode = resolveMode(options.mode);
      const localUrl = `http://127.0.0.1:${config.serve.port}${config.serve.path}`;
      const path = config.serve.path;

      if (mode === "off") {
        await cleanupTailscaleExposureRoute({ mode: "serve", path });
        await cleanupTailscaleExposureRoute({ mode: "funnel", path });
        logger.info("Tailscale exposure disabled");
        return;
      }

      const result = await setupTailscaleExposureRoute({
        mode,
        path,
        localUrl,
      });
      if (!result) {
        logger.error("Failed to set up Tailscale exposure");
        return;
      }
      const info = await getTailscaleSelfInfo();
      logger.info(`Tailscale ${mode} enabled: ${result}`);
      if (info?.dnsName) {
        logger.info(`Device: ${info.dnsName}`);
      }
    });
}
