import { spawn } from "node:child_process";
import http from "node:http";
import { URL } from "node:url";

import type { VoiceCallWsConfig } from "./config.js";
import type { CallManager } from "./manager.js";
import { RealtimeBridge } from "./realtime-bridge.js";
import type { TelephonyProvider } from "./providers/base.js";
import type { WebhookContext } from "./types.js";

/**
 * HTTP server for receiving voice call webhooks from providers.
 * Supports WebSocket upgrades for media streams.
 */
export class VoiceCallWebhookServer {
  private server: http.Server | null = null;
  private config: VoiceCallWsConfig;
  private manager: CallManager;
  private provider: TelephonyProvider;
  private bridge: RealtimeBridge;

  constructor(
    config: VoiceCallWsConfig,
    manager: CallManager,
    provider: TelephonyProvider,
    bridge: RealtimeBridge,
  ) {
    this.config = config;
    this.manager = manager;
    this.provider = provider;
    this.bridge = bridge;
  }

  /**
   * Start the webhook server.
   */
  async start(): Promise<string> {
    const { port, bind, path: webhookPath } = this.config.serve;
    const streamPath = this.config.realtime.streamPath.startsWith("/")
      ? this.config.realtime.streamPath
      : `/${this.config.realtime.streamPath}`;

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res, webhookPath).catch((err) => {
          console.error("[voice-call-ws] Webhook error:", err);
          res.statusCode = 500;
          res.end("Internal Server Error");
        });
      });

      this.server.on("upgrade", (request, socket, head) => {
        const url = new URL(
          request.url || "/",
          `http://${request.headers.host}`,
        );

        if (url.pathname === streamPath) {
          this.bridge.handleUpgrade(request, socket, head);
        } else {
          socket.destroy();
        }
      });

      this.server.on("error", reject);

      this.server.listen(port, bind, () => {
        const url = `http://${bind}:${port}${webhookPath}`;
        console.log(`[voice-call-ws] Webhook server listening on ${url}`);
        console.log(
          `[voice-call-ws] Media stream WebSocket on ws://${bind}:${port}${streamPath}`,
        );
        resolve(url);
      });
    });
  }

  /**
   * Stop the webhook server.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          this.bridge.closeAll();
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle incoming HTTP request.
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    webhookPath: string,
  ): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    const normalizedPath = url.pathname.replace(/\/+$/, "");
    const normalizedWebhookPath = webhookPath.replace(/\/+$/, "");

    if (normalizedPath !== normalizedWebhookPath) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.end("Method Not Allowed");
      return;
    }

    const body = await this.readBody(req);

    const ctx: WebhookContext = {
      headers: req.headers as Record<string, string | string[] | undefined>,
      rawBody: body,
      url: `http://${req.headers.host}${req.url}`,
      method: "POST",
      query: Object.fromEntries(url.searchParams),
    };

    const verification = this.provider.verifyWebhook(ctx);
    if (!verification.ok) {
      console.warn(
        `[voice-call-ws] Webhook verification failed: ${verification.reason}`,
      );
      res.statusCode = 401;
      res.end("Unauthorized");
      return;
    }

    const result = this.provider.parseWebhookEvent(ctx);

    for (const event of result.events) {
      try {
        this.manager.processEvent(event);
      } catch (err) {
        console.error(
          `[voice-call-ws] Error processing event ${event.type}:`,
          err,
        );
      }
    }

    res.statusCode = result.statusCode || 200;

    if (result.providerResponseHeaders) {
      for (const [key, value] of Object.entries(
        result.providerResponseHeaders,
      )) {
        res.setHeader(key, value);
      }
    }

    res.end(result.providerResponseBody || "OK");
  }

  /**
   * Read request body as string.
   */
    private readBody(req: http.IncomingMessage): Promise<string> {
    const MAX_BYTES = 256 * 1024; // 256KB

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;

      const timer = setTimeout(() => {
        reject(new Error("Request body read timeout"));
      }, 10_000);

      req.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BYTES) {
          clearTimeout(timer);
          reject(new Error("Request body too large"));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString("utf-8"));
      });
      req.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}

/**
 * Resolve the current machine's Tailscale DNS name.
 */
export type TailscaleSelfInfo = {
  dnsName: string | null;
  nodeId: string | null;
};

/**
 * Run a tailscale command with timeout, collecting stdout.
 */
function runTailscaleCommand(
  args: string[],
  timeoutMs = 2500,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const proc = spawn("tailscale", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    proc.stdout.on("data", (data) => {
      stdout += data;
    });

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ code: -1, stdout: "" });
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout });
    });
  });
}

export async function getTailscaleSelfInfo(): Promise<TailscaleSelfInfo | null> {
  const { code, stdout } = await runTailscaleCommand(["status", "--json"]);
  if (code !== 0) return null;

  try {
    const status = JSON.parse(stdout);
    return {
      dnsName: status.Self?.DNSName?.replace(/\.$/, "") || null,
      nodeId: status.Self?.ID || null,
    };
  } catch {
    return null;
  }
}

export async function getTailscaleDnsName(): Promise<string | null> {
  const info = await getTailscaleSelfInfo();
  return info?.dnsName ?? null;
}

export async function setupTailscaleExposureRoute(opts: {
  mode: "serve" | "funnel";
  path: string;
  localUrl: string;
}): Promise<string | null> {
  const dnsName = await getTailscaleDnsName();
  if (!dnsName) {
    console.warn("[voice-call-ws] Could not get Tailscale DNS name");
    return null;
  }

  const { code } = await runTailscaleCommand([
    opts.mode,
    "--bg",
    "--yes",
    "--set-path",
    opts.path,
    opts.localUrl,
  ]);

  if (code === 0) {
    const publicUrl = `https://${dnsName}${opts.path}`;
    console.log(`[voice-call-ws] Tailscale ${opts.mode} active: ${publicUrl}`);
    return publicUrl;
  }

  console.warn(`[voice-call-ws] Tailscale ${opts.mode} failed`);
  return null;
}

export async function cleanupTailscaleExposureRoute(opts: {
  mode: "serve" | "funnel";
  path: string;
}): Promise<void> {
  await runTailscaleCommand([opts.mode, "off", opts.path]);
}

/**
 * Setup Tailscale serve/funnel for the webhook server.
 */
export async function setupTailscaleExposure(
  config: VoiceCallWsConfig,
): Promise<string | null> {
  if (config.tailscale.mode === "off") {
    return null;
  }

  const mode = config.tailscale.mode === "funnel" ? "funnel" : "serve";
  const localUrl = `http://127.0.0.1:${config.serve.port}${config.serve.path}`;
  return setupTailscaleExposureRoute({
    mode,
    path: config.tailscale.path,
    localUrl,
  });
}

export async function cleanupTailscaleExposure(
  config: VoiceCallWsConfig,
): Promise<void> {
  if (config.tailscale.mode === "off") return;

  const mode = config.tailscale.mode === "funnel" ? "funnel" : "serve";
  await cleanupTailscaleExposureRoute({ mode, path: config.tailscale.path });
}
