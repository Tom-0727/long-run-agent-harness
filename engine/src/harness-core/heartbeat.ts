import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { AgentIdentity, AgentPaths, PromptSection } from "./types.js";
import type { Logger } from "./logger.js";
import { appendEvent } from "./events.js";
import { clearUnchangedPending } from "./mailbox.js";
import {
  recordHeartbeat,
  syncCompactState,
  type CompactObservation,
  type Metrics,
  type TurnTokens,
} from "./metrics.js";
import { utcnow } from "./time.js";
import {
  renderDueRemindersSection,
  renderTodayTodosSection,
  runTodoPreHeartbeatHook,
} from "./todo.js";

type HeartbeatPhase = "pre" | "post";

interface HeartbeatExtension {
  name: string;
  command: string[];
  timeoutMs: number;
  manifestFile: string;
}

interface ExtensionRunResult {
  ok: boolean;
  stdout: string;
}

export interface PreHeartbeatInput {
  firstHeartbeat: boolean;
  mailboxStatus: string;
}

export interface PreHeartbeatResult {
  promptSections: PromptSection[];
}

export interface PostHeartbeatInput {
  invokeOk: boolean;
  durationSeconds: number;
  tokens: TurnTokens;
  pendingSnapshot: Record<string, string>;
  observeCompact?: () => CompactObservation | null;
}

export interface PostHeartbeatResult {
  durationSeconds: number;
  metrics: Metrics | null;
}

const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 128 * 1024;
const PAYLOAD_FILE = "heartbeat_extension_payload.json";

export function runPreHeartbeat(
  paths: AgentPaths,
  identity: AgentIdentity,
  input: PreHeartbeatInput,
  log: Logger
): PreHeartbeatResult {
  const promptSections: PromptSection[] = [];

  runTodoPreHeartbeatHook(paths, log);
  addSection(promptSections, "todo.due_reminders", renderDueRemindersSection(paths));
  addSection(promptSections, "todo.today", renderTodayTodosSection(paths));

  const payload = {
    phase: "pre",
    agent_dir: paths.agentDir,
    agent_name: identity.agent_name,
    provider: identity.provider,
    first_heartbeat: input.firstHeartbeat,
    mailbox_status: input.mailboxStatus,
  };

  for (const ext of loadExtensions(paths, "pre", log)) {
    const result = runExtension(paths, "pre", ext, payload, log);
    if (!result.ok) continue;
    const content = result.stdout.trim();
    if (!content) continue;
    addSection(promptSections, `extension.${ext.name}`, content);
    log.info(`pre-heartbeat extension ${ext.name} injected ${content.length} chars`);
  }

  return { promptSections };
}

export function runPostHeartbeat(
  paths: AgentPaths,
  identity: AgentIdentity,
  input: PostHeartbeatInput,
  log: Logger
): PostHeartbeatResult {
  clearUnchangedPending(paths, input.pendingSnapshot);

  const heartbeatTs = utcnow();
  let metrics = input.invokeOk
    ? recordHeartbeat(paths, { durationSeconds: input.durationSeconds, tokens: input.tokens })
    : null;

  if (input.invokeOk && metrics && input.observeCompact) {
    const before = metrics.compact.total_compacts;
    const obs = input.observeCompact();
    if (obs) {
      const synced = syncCompactState(paths, { ...obs, currentHeartbeatTs: heartbeatTs });
      if (synced.compact.total_compacts !== before) {
        appendEvent(paths, "compact_synced", {
          total_compacts: synced.compact.total_compacts,
          last_compact_at: synced.compact.last_compact_at,
          delta: synced.compact.total_compacts - before,
        });
        log.info(
          `compact log sync: total=${synced.compact.total_compacts} (+${synced.compact.total_compacts - before})`
        );
      }
      metrics = synced;
    }
  }

  appendEvent(paths, "heartbeat_end", {
    duration_seconds: input.durationSeconds,
    ok: input.invokeOk,
    heartbeat_count: metrics ? metrics.heartbeat.count : undefined,
    compact_count_since_last: metrics ? metrics.compact.count_since_last : undefined,
    estimated_context_tokens: metrics ? metrics.tokens.estimated_context_tokens : undefined,
  });

  const payload = {
    phase: "post",
    agent_dir: paths.agentDir,
    agent_name: identity.agent_name,
    provider: identity.provider,
    ok: input.invokeOk,
    duration_seconds: input.durationSeconds,
    tokens: input.tokens,
    heartbeat_count: metrics ? metrics.heartbeat.count : null,
    compact_count_since_last: metrics ? metrics.compact.count_since_last : null,
    estimated_context_tokens: metrics ? metrics.tokens.estimated_context_tokens : null,
  };

  for (const ext of loadExtensions(paths, "post", log)) {
    const result = runExtension(paths, "post", ext, payload, log);
    if (result.ok && result.stdout.trim()) {
      log.info(`post-heartbeat extension ${ext.name}: ${oneLine(result.stdout, 200)}`);
    }
  }

  return { durationSeconds: input.durationSeconds, metrics };
}

function addSection(sections: PromptSection[], source: string, content: string): void {
  const trimmed = content.trim();
  if (trimmed) sections.push({ source, content: trimmed });
}

function loadExtensions(paths: AgentPaths, phase: HeartbeatPhase, log: Logger): HeartbeatExtension[] {
  const dir = phase === "pre" ? paths.heartbeatPreDir : paths.heartbeatPostDir;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir).filter((entry) => entry.endsWith(".json")).sort();
  } catch {
    return [];
  }

  const extensions: HeartbeatExtension[] = [];
  for (const entry of entries) {
    const file = path.join(dir, entry);
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      extensions.push(parseExtension(file, raw, phase));
    } catch (err) {
      const message = (err as Error).message;
      log.warn(`invalid ${phase}-heartbeat extension ${file}: ${message}`);
      appendEvent(paths, "error", {
        phase: `${phase}_heartbeat_hook`,
        manifest: file,
        message,
      });
    }
  }
  return extensions;
}

function parseExtension(file: string, raw: unknown, phase: HeartbeatPhase): HeartbeatExtension {
  if (!isRecord(raw)) throw new Error("manifest must be a JSON object");
  const name = raw.name;
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    throw new Error("name must use letters, digits, dot, underscore, or hyphen");
  }
  const command = raw.command;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part) => typeof part === "string" && part.length > 0)
  ) {
    throw new Error("command must be a non-empty string array");
  }
  if (phase === "pre" && raw.inject_as !== undefined && raw.inject_as !== "prompt_section") {
    throw new Error("pre inject_as must be prompt_section");
  }
  if (phase === "post" && raw.inject_as !== undefined) {
    throw new Error("post extensions must not set inject_as");
  }
  return {
    name,
    command,
    timeoutMs: readTimeout(raw.timeout_ms),
    manifestFile: file,
  };
}

function readTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("timeout_ms must be a number");
  }
  return Math.max(100, Math.min(MAX_TIMEOUT_MS, Math.floor(value)));
}

function runExtension(
  paths: AgentPaths,
  phase: HeartbeatPhase,
  ext: HeartbeatExtension,
  payload: Record<string, unknown>,
  log: Logger
): ExtensionRunResult {
  try {
    const payloadFile = writePayloadFile(paths, payload);
    const result = spawnSync(ext.command[0], ext.command.slice(1), {
      cwd: paths.agentDir,
      encoding: "utf8",
      timeout: ext.timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      env: {
        ...process.env,
        AGENT_DIR: paths.agentDir,
        HEARTBEAT_PHASE: phase,
        HEARTBEAT_EXTENSION_NAME: ext.name,
        HEARTBEAT_PAYLOAD_FILE: payloadFile,
      },
    });

    if (result.status !== 0) {
      const stderr = (result.stderr || "").trim();
      const detail = result.error?.message ?? `exit ${result.status}`;
      recordExtensionError(
        paths,
        phase,
        ext,
        `${detail}${stderr ? `: ${oneLine(stderr, 300)}` : ""}`,
        log
      );
      return { ok: false, stdout: "" };
    }
    return { ok: true, stdout: result.stdout || "" };
  } catch (err) {
    recordExtensionError(paths, phase, ext, (err as Error).message, log);
    return { ok: false, stdout: "" };
  }
}

function writePayloadFile(paths: AgentPaths, payload: Record<string, unknown>): string {
  fs.mkdirSync(paths.runtimeDir, { recursive: true });
  const file = path.join(paths.runtimeDir, PAYLOAD_FILE);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
  return file;
}

function recordExtensionError(
  paths: AgentPaths,
  phase: HeartbeatPhase,
  ext: HeartbeatExtension,
  message: string,
  log: Logger
): void {
  log.warn(`${phase}-heartbeat extension ${ext.name} failed: ${message}`);
  appendEvent(paths, "error", {
    phase: `${phase}_heartbeat_hook`,
    name: ext.name,
    manifest: ext.manifestFile,
    message,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function oneLine(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max);
}
