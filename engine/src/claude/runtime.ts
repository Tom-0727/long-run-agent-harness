import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  resolvePaths,
  loadIdentity,
  checkAndWritePid,
  cleanupPid,
  createLogger,
  writeState,
  writeHeartbeat,
  writeInterval,
  readInterval,
  readCompactInterval,
  bumpCompactCount,
  resetCompactCount,
  decidePreInvoke,
  clearUnchangedPending,
  hasAnyPending,
  sleepWithWakeup,
  type AgentIdentity,
  type AgentPaths,
} from "../harness-core/index.js";
import { query, type Options as ClaudeAgentOptions, type AgentDefinition } from "@anthropic-ai/claude-agent-sdk";

function parseArgs(argv: string[]): { agentDir: string } {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--agent-dir" && argv[i + 1]) return { agentDir: argv[i + 1] };
  }
  throw new Error("runtime: missing --agent-dir");
}

function loadSessionId(paths: AgentPaths): string | null {
  if (!fs.existsSync(paths.claudeSessionFile)) return null;
  const sid = fs.readFileSync(paths.claudeSessionFile, "utf8").trim();
  return sid || null;
}

function saveSessionId(paths: AgentPaths, sid: string): void {
  fs.writeFileSync(paths.claudeSessionFile, sid, "utf8");
}

function resolveClaudeExecutable(): string | undefined {
  try {
    const p = execSync("command -v claude", { encoding: "utf8" }).trim();
    if (p && fs.existsSync(p)) return p;
  } catch { /* fall through */ }
  return undefined;
}

function parseAgentFile(filePath: string): AgentDefinition {
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.startsWith("---\n")) {
    throw new Error(`subagent ${filePath}: missing '---' frontmatter opener`);
  }
  const closeIdx = raw.indexOf("\n---\n", 4);
  if (closeIdx === -1) {
    throw new Error(`subagent ${filePath}: missing '---' frontmatter closer`);
  }
  const fmLines = raw.slice(4, closeIdx).split("\n");
  const prompt = raw.slice(closeIdx + 5).trimStart();

  let description: string | undefined;
  let model: string | undefined;
  let tools: string[] | undefined;
  let currentListKey: "tools" | null = null;

  for (const line of fmLines) {
    const listItem = line.match(/^\s+-\s+(.+)$/);
    if (currentListKey && listItem) {
      if (currentListKey === "tools") {
        (tools ??= []).push(listItem[1].trim());
      }
      continue;
    }
    currentListKey = null;
    const scalar = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!scalar) continue;
    const key = scalar[1];
    const value = scalar[2].trim();
    if (value === "") {
      if (key === "tools") currentListKey = "tools";
      continue;
    }
    if (key === "description") description = value;
    else if (key === "model") model = value;
  }

  if (!description) {
    throw new Error(`subagent ${filePath}: frontmatter missing 'description'`);
  }
  if (!prompt) {
    throw new Error(`subagent ${filePath}: body (system prompt) is empty`);
  }
  const def: AgentDefinition = { description, prompt };
  if (tools && tools.length > 0) def.tools = tools;
  if (model) def.model = model;
  return def;
}

function loadProjectAgents(agentDir: string): Record<string, AgentDefinition> {
  const dir = path.join(agentDir, ".claude", "agents");
  if (!fs.existsSync(dir)) return {};
  const out: Record<string, AgentDefinition> = {};
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".md")) continue;
    const name = entry.slice(0, -3);
    out[name] = parseAgentFile(path.join(dir, entry));
  }
  return out;
}

let shuttingDown = false;

async function invokeAgent(
  paths: AgentPaths,
  identity: AgentIdentity,
  prompt: string,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const sessionId = loadSessionId(paths);

  const claudeBin = resolveClaudeExecutable();
  const projectAgents = loadProjectAgents(paths.agentDir);
  const options: ClaudeAgentOptions = {
    cwd: paths.agentDir,
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "WebSearch", "WebFetch", "Agent"],
    maxTurns: identity.runtime.default_max_turns,
    permissionMode: "bypassPermissions",
    agents: projectAgents,
    ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
    ...(sessionId ? { resume: sessionId } : {}),
  };
  log.info(`loaded project subagents: ${Object.keys(projectAgents).sort().join(",") || "(none)"}`);

  log.info(sessionId ? `resuming session ${sessionId}` : "starting new session");

  let newSessionId: string | null = null;

  for await (const message of query({ prompt, options })) {
    const kind = (message as { type?: string }).type;

    if (kind === "assistant") {
      const content = (message as { message?: { content?: unknown[] } }).message?.content ?? [];
      for (const block of content) {
        const b = block as { type?: string; text?: string; name?: string };
        if (b.type === "text" && typeof b.text === "string") {
          log.info(`agent: ${b.text.slice(0, 200)}`);
        } else if (b.type === "tool_use" && typeof b.name === "string") {
          log.info(`tool: ${b.name}`);
        }
      }
    } else if (kind === "result") {
      const r = message as {
        session_id?: string;
        subtype?: string;
        num_turns?: number;
        total_cost_usd?: number;
      };
      if (r.session_id) newSessionId = r.session_id;
      if (r.subtype === "success") {
        log.info(`heartbeat ok. turns=${r.num_turns ?? 0} cost=${(r.total_cost_usd ?? 0).toFixed(4)}`);
      } else {
        log.warn(`heartbeat ended: ${r.subtype}`);
      }
    }
  }

  if (newSessionId) saveSessionId(paths, newSessionId);
}

async function invokeCompact(
  paths: AgentPaths,
  log: ReturnType<typeof createLogger>
): Promise<boolean> {
  const sessionId = loadSessionId(paths);
  if (!sessionId) {
    log.info("compact skipped: no session yet");
    return false;
  }

  const claudeBin = resolveClaudeExecutable();
  const options: ClaudeAgentOptions = {
    cwd: paths.agentDir,
    allowedTools: [],
    maxTurns: 1,
    permissionMode: "bypassPermissions",
    ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
    resume: sessionId,
    includePartialMessages: false,
  };

  log.info(`compact: resuming session ${sessionId}`);

  let boundarySeen = false;
  let newSessionId: string | null = null;
  let ended: "success" | "error" | null = null;

  for await (const message of query({ prompt: "/compact", options })) {
    const kind = (message as { type?: string }).type;
    const subtype = (message as { subtype?: string }).subtype;

    if (kind === "system" && subtype === "compact_boundary") {
      boundarySeen = true;
      log.info("compact: boundary reached");
    } else if (kind === "result") {
      const r = message as { session_id?: string; subtype?: string };
      if (r.session_id) newSessionId = r.session_id;
      ended = r.subtype === "success" ? "success" : "error";
    }
  }

  if (newSessionId) saveSessionId(paths, newSessionId);
  if (boundarySeen && ended === "success") {
    log.info("compact ok");
    return true;
  }
  log.warn(`compact failed: boundary=${boundarySeen} ended=${ended ?? "none"}`);
  return false;
}

async function main(): Promise<void> {
  const { agentDir } = parseArgs(process.argv.slice(2));
  const paths = resolvePaths(agentDir);
  const identity = loadIdentity(paths);
  const log = createLogger(paths, "runtime");

  checkAndWritePid(paths, "runtime");

  process.on("SIGINT", () => {
    log.info("SIGINT received");
    shuttingDown = true;
  });
  process.on("SIGTERM", () => {
    log.info("SIGTERM received");
    shuttingDown = true;
  });

  writeInterval(paths, readInterval(paths, identity.runtime.default_interval_minutes));

  log.info(`starting ${identity.agent_name} on claude runtime`);
  let firstHeartbeat = loadSessionId(paths) === null;

  try {
    while (!shuttingDown) {
      const decision = decidePreInvoke(paths, identity, firstHeartbeat);
      writeHeartbeat(paths);
      writeState(paths, decision.stateUpdate);

      if (decision.action === "skip_long_sleep") {
        log.info(
          `off hours; sleeping ${Math.floor((decision.sleepSeconds ?? 3600) / 60)}m until next window`
        );
        await sleepWithWakeup(paths, decision.sleepSeconds ?? 3600, () => shuttingDown);
        continue;
      }
      if (decision.action === "skip_short_sleep") {
        log.info(`skipping heartbeat (${decision.reason}); sleeping ${decision.sleepMinutes}m`);
        await sleepWithWakeup(paths, (decision.sleepMinutes ?? 20) * 60, () => shuttingDown);
        continue;
      }

      let invokeOk = true;
      try {
        await invokeAgent(paths, identity, decision.prompt!, log);
      } catch (err) {
        invokeOk = false;
        log.error(`invoke error: ${(err as Error).message}`);
      } finally {
        clearUnchangedPending(paths, decision.pendingSnapshot ?? {});
      }
      firstHeartbeat = false;

      if (invokeOk) {
        const threshold = readCompactInterval(
          paths,
          identity.runtime.default_compact_every_n_heartbeats
        );
        if (threshold > 0) {
          const count = bumpCompactCount(paths);
          if (count >= threshold) {
            log.info(`compact threshold reached (${count}/${threshold}); compacting`);
            try {
              const ok = await invokeCompact(paths, log);
              if (ok) resetCompactCount(paths);
            } catch (err) {
              log.error(`compact error: ${(err as Error).message}`);
            }
          }
        }
      }

      if (hasAnyPending(paths)) {
        log.info("more pending messages; continuing immediately");
        continue;
      }

      const interval = readInterval(paths, identity.runtime.default_interval_minutes);
      log.info(`sleeping ${interval}m`);
      await sleepWithWakeup(paths, interval * 60, () => shuttingDown);
    }
  } finally {
    cleanupPid(paths, "runtime");
    log.info("runtime stopped");
  }
}

main().catch((err) => {
  console.error(`fatal: ${(err as Error).stack || err}`);
  process.exit(1);
});
