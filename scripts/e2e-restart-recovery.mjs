#!/usr/bin/env node

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keepArtifacts = process.argv.includes("--keep") || process.env.ACP_DISPATCHER_KEEP_RESTART_E2E_ARTIFACTS === "1";
const LONG_RUNNING_MARKER = "RESTART_RECOVERY_LONG_RUNNING";
const FOLLOWUP_LINE = "Restart recovery follow-up completed.";
const SUCCESSFUL_RESTART_KILL_STATUSES = new Set(["signal_sent", "not_found"]);

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-router-restart-recovery-"));
const tempHome = path.join(tempRoot, "home");
const dispatcherDataDir = path.join(tempRoot, "dispatcher-data");
const worktree = path.join(tempRoot, "worktree");
const tempBin = path.join(tempRoot, "bin");
const childPidFile = path.join(tempRoot, "child.pid");
const signalLog = path.join(tempRoot, "signals.jsonl");

let firstClient = null;
let secondClient = null;
let childPid = null;
let retainedArtifacts = keepArtifacts;

async function main() {
  try {
    await prepareTempWorkspace();

    const env = {
      ...process.env,
      HOME: tempHome,
      AGENT_ROUTER_DATA_DIR: dispatcherDataDir,
      ACP_RESTART_CHILD_PID_FILE: childPidFile,
      ACP_RESTART_SIGNAL_LOG: signalLog,
      PATH: `${tempBin}${path.delimiter}${process.env.PATH ?? ""}`
    };

    firstClient = new McpClient({ cwd: repoRoot, env });
    await firstClient.start();
    await initialize(firstClient, "restart-recovery-e2e-first");
    const enabledConfig = await firstClient.callTool("manage_config", {
      action: "set",
      launchExternalAgents: true,
      inheritEnvironment: true
    });
    assert(
      enabledConfig.config?.safety?.launchExternalAgents === true,
      "Expected launchExternalAgents to be enabled.",
      enabledConfig
    );

    const discovery = await firstClient.callTool("discover_agents", {
      includeNotInstalled: false
    });
    const claude = discovery.agents?.find((agent) => agent.id === "claude");
    assert(
      claude?.status === "available" && claude.version === "fake-claude 999.0.0",
      "Expected fake Claude CLI to be discovered from the temporary PATH.",
      discovery
    );

    const asyncJob = await firstClient.callTool("run_agent", {
      agent: "claude",
      worktree,
      prompt: LONG_RUNNING_MARKER,
      async: true,
      timeoutSec: 60,
      permissionProfile: "workspace_write",
      collectDiff: true,
      metadata: {
        source: "scripts/e2e-restart-recovery.mjs",
        phase: "orphan-start"
      }
    }, 5000);
    assert(asyncJob.status === "running", "Expected async job to start in running status.", asyncJob);

    childPid = await waitForRecordedPid(childPidFile, 5000);
    assert(Number.isInteger(childPid), "Expected fake Claude child PID to be recorded.", { childPidFile });

    const runningJob = await waitForJob(firstClient, asyncJob.jobId, (job) => (
      job.status === "running" && job.process?.pid === childPid
    ), 5000);
    assert(
      runningJob.process?.pid === childPid,
      "Expected Agent Router registry to persist the fake Claude child PID.",
      runningJob
    );

    await firstClient.kill("SIGKILL");
    firstClient = null;

    secondClient = new McpClient({ cwd: repoRoot, env });
    await secondClient.start();
    await initialize(secondClient, "restart-recovery-e2e-second");

    const recovered = await secondClient.callTool("get_job", {
      jobId: asyncJob.jobId
    }, 5000);
    const recoveredJob = recovered.job;
    assert(recoveredJob?.status === "orphaned", "Expected restarted server to mark async job orphaned.", recovered);
    assert(
      recoveredJob.process?.pid === childPid,
      "Expected orphaned job to keep the persisted child PID.",
      recoveredJob
    );
    assert(
      SUCCESSFUL_RESTART_KILL_STATUSES.has(recoveredJob.process?.restartKill?.status),
      "Expected restart recovery to record a successful best-effort child kill.",
      recoveredJob.process?.restartKill
    );

    const childExited = await waitForPidExit(childPid, 5000);
    assert(childExited, "Expected persisted child PID to exit after restart recovery.", {
      childPid,
      restartKill: recoveredJob.process?.restartKill
    });

    const sessions = await secondClient.callTool("manage_sessions", {
      action: "list",
      agent: "claude",
      worktree,
      includeArchived: true
    }, 5000);
    const orphanedSession = sessions.sessions?.find((session) => session.sessionId === asyncJob.sessionId);
    assert(orphanedSession?.status === "orphaned", "Expected Agent Router session to be marked orphaned.", sessions);

    const followup = await secondClient.callTool("run_agent", {
      agent: "claude",
      worktree,
      prompt: "Run restart recovery follow-up.",
      async: false,
      timeoutSec: 10,
      permissionProfile: "workspace_write",
      collectDiff: true,
      metadata: {
        source: "scripts/e2e-restart-recovery.mjs",
        phase: "follow-up"
      }
    }, 15_000);
    assert(followup.status === "completed", "Expected follow-up fake Claude job to complete.", followup);
    assert(
      Array.isArray(followup.changedFiles) && followup.changedFiles.includes("note.txt"),
      "Expected follow-up job to report note.txt as changed.",
      followup
    );
    assert(
      typeof followup.summary === "string" && followup.summary.includes("Fake Claude follow-up completed."),
      "Expected follow-up summary to include fake Claude output.",
      followup
    );

    const note = await readFile(path.join(worktree, "note.txt"), "utf8");
    assert(note.includes(FOLLOWUP_LINE), "Expected follow-up fake Claude job to edit note.txt.", { note });

    await secondClient.callTool("manage_config", {
      action: "set",
      launchExternalAgents: false
    }, 5000);

    console.log(JSON.stringify({
      passed: true,
      jobId: asyncJob.jobId,
      sessionId: asyncJob.sessionId,
      childPid,
      orphanStatus: recoveredJob.status,
      restartKill: recoveredJob.process?.restartKill ?? null,
      childExited,
      sessionStatus: orphanedSession.status,
      followup: {
        jobId: followup.jobId,
        status: followup.status,
        changedFiles: followup.changedFiles,
        summary: followup.summary
      },
      signalLog: await readOptionalText(signalLog),
      keptArtifacts: retainedArtifacts ? tempRoot : null
    }, null, 2));
  } catch (error) {
    retainedArtifacts = true;
    console.log(JSON.stringify({
      passed: false,
      error: error.message,
      details: error.details ?? null,
      childPid,
      tempRoot,
      dispatcherDataDir,
      worktree,
      firstServerStderr: firstClient?.stderr.trim() ?? "",
      secondServerStderr: secondClient?.stderr.trim() ?? ""
    }, null, 2));
    process.exitCode = 1;
  } finally {
    if (secondClient) {
      await secondClient.callTool("manage_config", {
        action: "set",
        launchExternalAgents: false
      }, 5000).catch(() => {});
    }
    if (childPid && pidIsAlive(childPid)) {
      try {
        process.kill(childPid, "SIGTERM");
      } catch {
        // Best-effort cleanup only.
      }
      await waitForPidExit(childPid, 1000);
    }
    await firstClient?.stop();
    await secondClient?.stop();
    if (!retainedArtifacts) {
      await rm(tempRoot, { force: true, recursive: true });
    }
  }
}

async function prepareTempWorkspace() {
  await mkdir(tempHome, { recursive: true });
  await mkdir(dispatcherDataDir, { recursive: true });
  await mkdir(worktree, { recursive: true });
  await mkdir(tempBin, { recursive: true });
  await git(worktree, ["init", "-b", "master"]);
  await git(worktree, ["config", "user.email", "agent-router-e2e@example.invalid"]);
  await git(worktree, ["config", "user.name", "Agent Router Restart E2E"]);
  await writeFile(path.join(worktree, "note.txt"), "Restart recovery E2E baseline\n", "utf8");
  await git(worktree, ["add", "."]);
  await git(worktree, ["commit", "-m", "Prepare restart recovery E2E baseline"]);
  await createFakeClaude(tempBin);
}

async function createFakeClaude(binDir) {
  const scriptPath = path.join(binDir, "claude");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log("fake-claude 999.0.0");
  process.exit(0);
}

const prompt = process.argv[process.argv.length - 1] || "";

if (prompt.includes(${JSON.stringify(LONG_RUNNING_MARKER)})) {
  if (process.env.ACP_RESTART_CHILD_PID_FILE) {
    fs.appendFileSync(process.env.ACP_RESTART_CHILD_PID_FILE, String(process.pid) + "\\n");
  }
  process.on("SIGTERM", () => {
    if (process.env.ACP_RESTART_SIGNAL_LOG) {
      fs.appendFileSync(process.env.ACP_RESTART_SIGNAL_LOG, JSON.stringify({
        pid: process.pid,
        signal: "SIGTERM",
        at: new Date().toISOString()
      }) + "\\n");
    }
    process.exit(0);
  });
  setInterval(() => {}, 1000);
} else {
  fs.appendFileSync(path.join(process.cwd(), "note.txt"), ${JSON.stringify(`${FOLLOWUP_LINE}\n`)});
  console.log(JSON.stringify({
    type: "assistant",
    session_id: "fake-claude-followup-session",
    message: {
      content: [{ type: "text", text: "Fake Claude follow-up completed." }]
    },
    stop_reason: "end_turn"
  }));
}
`;
  await writeFile(scriptPath, script, "utf8");
  await chmod(scriptPath, 0o755);
}

async function initialize(client, name) {
  return client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name, version: "0.0.0" }
  }, 5000);
}

async function waitForJob(client, jobId, predicate, timeoutMs) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await client.callTool("get_job", { jobId }, 5000);
    if (predicate(latest.job)) return latest.job;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for job ${jobId}. Latest: ${JSON.stringify(latest)}`);
}

async function waitForRecordedPid(pidFile, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pids = await readRecordedPids(pidFile);
    if (pids.length > 0) return pids[pids.length - 1];
    await sleep(50);
  }
  return null;
}

async function readRecordedPids(pidFile) {
  const raw = await readOptionalText(pidFile);
  return raw
    .split(/\r?\n/)
    .map((value) => Number.parseInt(value, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

async function waitForPidExit(pid, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!pidIsAlive(pid)) return true;
    await sleep(50);
  }
  return !pidIsAlive(pid);
}

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true;
  }
}

async function readOptionalText(filePath) {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function git(cwd, args) {
  try {
    await execFileAsync("git", args, {
      cwd,
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? os.homedir(),
        LANG: process.env.LANG ?? "C.UTF-8",
        LC_ALL: process.env.LC_ALL ?? "C.UTF-8"
      }
    });
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed: ${error.message}`);
  }
}

function assert(condition, message, details) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

class McpClient {
  constructor({ cwd, env }) {
    this.cwd = cwd;
    this.env = env;
    this.child = null;
    this.buffer = Buffer.alloc(0);
    this.stderr = "";
    this.nextId = 1;
    this.pending = new Map();
  }

  async start() {
    this.child = spawn(process.execPath, ["./bin/agent-router.mjs"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = appendLimited(this.stderr, chunk, 100_000);
    });
    this.child.on("exit", (code, signal) => {
      const error = new Error(`MCP server exited with code=${code} signal=${signal}`);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
    });
    await sleep(50);
  }

  request(method, params = {}, timeoutMs = 60_000) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write(payload);
    });
  }

  async callTool(name, args = {}, timeoutMs = 60_000) {
    const result = await this.request("tools/call", {
      name,
      arguments: args
    }, timeoutMs);
    const text = result.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;
    if (result.isError) {
      throw new Error(`Tool ${name} failed: ${parsed?.error ?? text ?? "unknown error"}`);
    }
    return parsed;
  }

  write(payload) {
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  handleStdout(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = this.buffer.subarray(0, newlineIndex).toString("utf8").replace(/\r$/, "").trim();
      this.buffer = this.buffer.subarray(newlineIndex + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid MCP line: ${line}`);
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    }
  }

  async kill(signal) {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill(signal);
    await Promise.race([
      new Promise((resolve) => this.child.once("exit", resolve)),
      sleep(1000)
    ]);
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => this.child.once("exit", resolve)),
      sleep(1000)
    ]);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGKILL");
      await Promise.race([
        new Promise((resolve) => this.child.once("exit", resolve)),
        sleep(1000)
      ]);
    }
  }
}

function appendLimited(current, chunk, maxLength) {
  const next = `${current}${chunk}`;
  if (next.length <= maxLength) return next;
  return next.slice(-maxLength);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
