import fs from "node:fs";
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
import { CodexAppServerClient } from "./app-server-client.js";

function parseArgs(argv: string[]): { agentDir: string } {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--agent-dir" && argv[i + 1]) return { agentDir: argv[i + 1] };
  }
  throw new Error("runtime: missing --agent-dir");
}

function loadThreadId(paths: AgentPaths): string | null {
  if (!fs.existsSync(paths.codexThreadFile)) return null;
  const tid = fs.readFileSync(paths.codexThreadFile, "utf8").trim();
  return tid || null;
}

function saveThreadId(paths: AgentPaths, tid: string): void {
  fs.writeFileSync(paths.codexThreadFile, tid, "utf8");
}

let shuttingDown = false;

async function ensureThread(
  client: CodexAppServerClient,
  paths: AgentPaths,
  log: ReturnType<typeof createLogger>
): Promise<string> {
  const existing = loadThreadId(paths);
  if (existing) {
    await client.resumeThread(existing, {
      sandbox: "workspace-write",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });
    log.info(`resumed thread ${existing}`);
    return existing;
  }
  const tid = await client.startThread({
    cwd: paths.agentDir,
    sandbox: "workspace-write",
    approvalPolicy: "never",
    skipGitRepoCheck: true,
  });
  saveThreadId(paths, tid);
  log.info(`started thread ${tid}`);
  return tid;
}

async function invokeAgent(
  client: CodexAppServerClient,
  threadId: string,
  prompt: string,
  log: ReturnType<typeof createLogger>
): Promise<void> {
  const result = await client.runTurn(
    { threadId, text: prompt },
    {
      onItemCompleted: (n) => {
        const item = n.item as { type?: string; text?: string; command?: string; exit_code?: number; server?: string; tool?: string; message?: string };
        if (item.type === "agentMessage" && typeof item.text === "string") {
          log.info(`agent: ${item.text.slice(0, 200)}`);
        } else if (item.type === "commandExecution") {
          log.info(`cmd: ${String(item.command ?? "").slice(0, 160)} exit=${item.exit_code ?? "?"}`);
        } else if (item.type === "mcpToolCall") {
          log.info(`tool: ${item.server ?? ""}:${item.tool ?? ""}`);
        } else if (item.type === "fileChange") {
          log.info(`file_change`);
        }
      },
    }
  );
  const u = result.usage ?? {};
  log.info(
    `heartbeat ok. tokens in=${u.input_tokens ?? 0} out=${u.output_tokens ?? 0} cached=${u.cached_input_tokens ?? 0}`
  );
}

async function invokeCompact(
  client: CodexAppServerClient,
  threadId: string,
  log: ReturnType<typeof createLogger>
): Promise<boolean> {
  let sawCompactionItem = false;
  await client.compactThread(threadId, {
    onItemCompleted: (n) => {
      const item = n.item as { type?: string };
      if (item.type === "contextCompaction") sawCompactionItem = true;
    },
  });
  log.info(`compact ok (compactionItem=${sawCompactionItem})`);
  return true;
}

async function main(): Promise<void> {
  const { agentDir } = parseArgs(process.argv.slice(2));
  const paths = resolvePaths(agentDir);
  const identity = loadIdentity(paths);
  const log = createLogger(paths, "runtime");

  checkAndWritePid(paths, "runtime");

  const client = new CodexAppServerClient({
    info: (m) => log.info(m),
    warn: (m) => log.warn(m),
    error: (m) => log.error(m),
  });

  process.on("SIGINT", () => {
    log.info("SIGINT received");
    shuttingDown = true;
  });
  process.on("SIGTERM", () => {
    log.info("SIGTERM received");
    shuttingDown = true;
  });

  writeInterval(paths, readInterval(paths, identity.runtime.default_interval_minutes));

  log.info(`starting ${identity.agent_name} on codex runtime (app-server)`);
  await client.start();

  let firstHeartbeat = loadThreadId(paths) === null;

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

      if (!client.isAlive()) {
        log.warn("app-server not alive; restarting");
        await client.start();
      }

      let invokeOk = true;
      let threadId: string | null = null;
      try {
        threadId = await ensureThread(client, paths, log);
        await invokeAgent(client, threadId, decision.prompt!, log);
      } catch (err) {
        invokeOk = false;
        log.error(`invoke error: ${(err as Error).message}`);
      } finally {
        clearUnchangedPending(paths, decision.pendingSnapshot ?? {});
      }
      firstHeartbeat = false;

      if (invokeOk && threadId) {
        const threshold = readCompactInterval(
          paths,
          identity.runtime.default_compact_every_n_heartbeats
        );
        if (threshold > 0) {
          const count = bumpCompactCount(paths);
          if (count >= threshold) {
            log.info(`compact threshold reached (${count}/${threshold}); compacting`);
            try {
              const ok = await invokeCompact(client, threadId, log);
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
    try {
      await client.stop();
    } catch {
      /* ignore */
    }
    cleanupPid(paths, "runtime");
    log.info("runtime stopped");
  }
}

main().catch((err) => {
  console.error(`fatal: ${(err as Error).stack || err}`);
  process.exit(1);
});
