import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type CoreConfig = {
  session?: {
    store?: string;
  };
};

type CoreAgentDeps = {
  resolveAgentDir: (cfg: CoreConfig, agentId: string) => string;
  resolveAgentWorkspaceDir: (cfg: CoreConfig, agentId: string) => string;
  resolveAgentIdentity: (
    cfg: CoreConfig,
    agentId: string,
  ) => { name?: string | null } | null | undefined;
  resolveThinkingDefault: (params: {
    cfg: CoreConfig;
    provider?: string;
    model?: string;
  }) => string;
  buildAgentSystemPrompt: (params: {
    workspaceDir: string;
    defaultThinkLevel?: string;
    reasoningLevel?: string;
    extraSystemPrompt?: string;
    ownerNumbers?: string[];
    reasoningTagHint?: boolean;
    toolNames?: string[];
    toolSummaries?: Record<string, string>;
    modelAliasLines?: string[];
    userTimezone?: string;
    userTime?: string;
    userTimeFormat?: string;
    contextFiles?: unknown[];
    skillsPrompt?: string;
    heartbeatPrompt?: string;
    docsPath?: string;
    workspaceNotes?: string[];
    promptMode?: "full" | "minimal" | "none";
    runtimeInfo?: {
      agentId?: string;
      host?: string;
      os?: string;
      arch?: string;
      node?: string;
      model?: string;
      defaultModel?: string;
      channel?: string;
      capabilities?: string[];
      repoRoot?: string;
    };
    messageToolHints?: string[];
    sandboxInfo?: {
      enabled: boolean;
      workspaceDir?: string;
      workspaceAccess?: "none" | "ro" | "rw";
      agentWorkspaceMount?: string;
      browserControlUrl?: string;
      browserNoVncUrl?: string;
      hostBrowserAllowed?: boolean;
      allowedControlUrls?: string[];
      allowedControlHosts?: string[];
      allowedControlPorts?: number[];
      elevated?: {
        allowed: boolean;
        defaultLevel: "on" | "off" | "ask" | "full";
      };
    };
    reactionGuidance?: {
      level: "minimal" | "extensive";
      channel: string;
    };
  }) => string;
  createClawdbotCodingTools: (options?: {
    messageProvider?: string;
    sessionKey?: string;
    agentDir?: string;
    workspaceDir?: string;
    config?: CoreConfig;
  }) => Array<{
    name: string;
    label?: string;
    description?: string;
    parameters?: unknown;
    execute: (
      toolCallId: string,
      params: unknown,
      signal?: AbortSignal,
      onUpdate?: unknown,
    ) => Promise<unknown> | unknown;
  }>;
  runEmbeddedPiAgent: (params: {
    sessionId: string;
    sessionKey?: string;
    messageProvider?: string;
    sessionFile: string;
    workspaceDir: string;
    config?: CoreConfig;
    prompt: string;
    provider?: string;
    model?: string;
    thinkLevel?: string;
    verboseLevel?: string;
    timeoutMs: number;
    runId: string;
    lane?: string;
    extraSystemPrompt?: string;
    agentDir?: string;
  }) => Promise<{
    payloads?: Array<{ text?: string; isError?: boolean }>;
    meta?: { aborted?: boolean };
  }>;
  resolveAgentTimeoutMs: (opts: { cfg: CoreConfig }) => number;
  ensureAgentWorkspace: (params?: { dir: string }) => Promise<void>;
  resolveStorePath: (store?: string, opts?: { agentId?: string }) => string;
  loadSessionStore: (storePath: string) => Record<string, unknown>;
  saveSessionStore: (
    storePath: string,
    store: Record<string, unknown>,
  ) => Promise<void>;
  resolveSessionFilePath: (
    sessionId: string,
    entry: unknown,
    opts?: { agentId?: string },
  ) => string;
  normalizeToolName: (value: string) => string;
  expandToolGroups: (list?: string[]) => string[];
  resolveToolProfilePolicy: (profile?: string) => { allow?: string[]; deny?: string[] } | undefined;
  DEFAULT_MODEL: string;
  DEFAULT_PROVIDER: string;
};

let coreRootCache: string | null = null;
let coreDepsPromise: Promise<CoreAgentDeps> | null = null;

function findPackageRoot(startDir: string, name: string): string | null {
  let dir = startDir;
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    try {
      if (fs.existsSync(pkgPath)) {
        const raw = fs.readFileSync(pkgPath, "utf8");
        const pkg = JSON.parse(raw) as { name?: string };
        if (pkg.name === name) return dir;
      }
    } catch {
      // ignore parse errors and keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolveClawdbotRoot(): string {
  if (coreRootCache) return coreRootCache;
  const override = process.env.CLAWDBOT_ROOT?.trim();
  if (override) {
    coreRootCache = override;
    return override;
  }

  const candidates = new Set<string>();
  if (process.argv[1]) {
    candidates.add(path.dirname(process.argv[1]));
  }
  candidates.add(process.cwd());
  try {
    const urlPath = fileURLToPath(import.meta.url);
    candidates.add(path.dirname(urlPath));
  } catch {
    // ignore
  }

  for (const start of candidates) {
    const found = findPackageRoot(start, "clawdbot");
    if (found) {
      coreRootCache = found;
      return found;
    }
  }

  throw new Error(
    "Unable to resolve Clawdbot root. Set CLAWDBOT_ROOT to the package root.",
  );
}

async function importCoreModule<T>(relativePath: string): Promise<T> {
  const root = resolveClawdbotRoot();
  const distPath = path.join(root, "dist", relativePath);
  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Missing core module at ${distPath}. Run \`pnpm build\` or install the official package.`,
    );
  }
  return (await import(pathToFileURL(distPath).href)) as T;
}

export async function loadCoreAgentDeps(): Promise<CoreAgentDeps> {
  if (coreDepsPromise) return coreDepsPromise;

  coreDepsPromise = (async () => {
    const [
      agentScope,
      defaults,
      identity,
      modelSelection,
      systemPrompt,
      piTools,
      piEmbedded,
      toolPolicy,
      timeout,
      workspace,
      sessions,
    ] = await Promise.all([
      importCoreModule<{
        resolveAgentDir: CoreAgentDeps["resolveAgentDir"];
        resolveAgentWorkspaceDir: CoreAgentDeps["resolveAgentWorkspaceDir"];
      }>("agents/agent-scope.js"),
      importCoreModule<{
        DEFAULT_MODEL: string;
        DEFAULT_PROVIDER: string;
      }>("agents/defaults.js"),
      importCoreModule<{
        resolveAgentIdentity: CoreAgentDeps["resolveAgentIdentity"];
      }>("agents/identity.js"),
      importCoreModule<{
        resolveThinkingDefault: CoreAgentDeps["resolveThinkingDefault"];
      }>("agents/model-selection.js"),
      importCoreModule<{
        buildAgentSystemPrompt: CoreAgentDeps["buildAgentSystemPrompt"];
      }>("agents/system-prompt.js"),
      importCoreModule<{
        createClawdbotCodingTools: CoreAgentDeps["createClawdbotCodingTools"];
      }>("agents/pi-tools.js"),
      importCoreModule<{
        runEmbeddedPiAgent: CoreAgentDeps["runEmbeddedPiAgent"];
      }>("agents/pi-embedded.js"),
      importCoreModule<{
        normalizeToolName: CoreAgentDeps["normalizeToolName"];
        expandToolGroups: CoreAgentDeps["expandToolGroups"];
        resolveToolProfilePolicy: CoreAgentDeps["resolveToolProfilePolicy"];
      }>("agents/tool-policy.js"),
      importCoreModule<{
        resolveAgentTimeoutMs: CoreAgentDeps["resolveAgentTimeoutMs"];
      }>("agents/timeout.js"),
      importCoreModule<{
        ensureAgentWorkspace: CoreAgentDeps["ensureAgentWorkspace"];
      }>("agents/workspace.js"),
      importCoreModule<{
        resolveStorePath: CoreAgentDeps["resolveStorePath"];
        loadSessionStore: CoreAgentDeps["loadSessionStore"];
        saveSessionStore: CoreAgentDeps["saveSessionStore"];
        resolveSessionFilePath: CoreAgentDeps["resolveSessionFilePath"];
      }>("config/sessions.js"),
    ]);

    return {
      resolveAgentDir: agentScope.resolveAgentDir,
      resolveAgentWorkspaceDir: agentScope.resolveAgentWorkspaceDir,
      resolveAgentIdentity: identity.resolveAgentIdentity,
      resolveThinkingDefault: modelSelection.resolveThinkingDefault,
      buildAgentSystemPrompt: systemPrompt.buildAgentSystemPrompt,
      runEmbeddedPiAgent: piEmbedded.runEmbeddedPiAgent,
      resolveAgentTimeoutMs: timeout.resolveAgentTimeoutMs,
      ensureAgentWorkspace: workspace.ensureAgentWorkspace,
      resolveStorePath: sessions.resolveStorePath,
      loadSessionStore: sessions.loadSessionStore,
      saveSessionStore: sessions.saveSessionStore,
      resolveSessionFilePath: sessions.resolveSessionFilePath,
      createClawdbotCodingTools: piTools.createClawdbotCodingTools,
      normalizeToolName: toolPolicy.normalizeToolName,
      expandToolGroups: toolPolicy.expandToolGroups,
      resolveToolProfilePolicy: toolPolicy.resolveToolProfilePolicy,
      DEFAULT_MODEL: defaults.DEFAULT_MODEL,
      DEFAULT_PROVIDER: defaults.DEFAULT_PROVIDER,
    };
  })();

  return coreDepsPromise;
}
