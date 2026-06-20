#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out", "orphaned"]);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-router-e2e-sessions-"));
  const worktree = path.join(tempRoot, "worktree");
  const dispatcherDataDir = path.join(tempRoot, "dispatcher-data");
  const firstLine = options.firstLine ?? "OpenCode ACP session lifecycle E2E first edit.";
  const secondLine = options.secondLine ?? "OpenCode ACP session lifecycle E2E continued edit.";
  const startedAt = Date.now();
  let client = null;
  let keepArtifacts = options.keep;
  let exitCode = 0;

  try {
    await prepareWorktree({ worktree, options, firstLine, secondLine });
    client = new McpClient({
      cwd: repoRoot,
      env: {
        ...process.env,
        AGENT_ROUTER_DATA_DIR: dispatcherDataDir
      }
    });
    await client.start();

    const initialize = await client.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "dispatcher-session-lifecycle-e2e", version: "0.0.0" }
    });
    const configResult = await client.callTool("manage_config", {
      action: "set",
      launchExternalAgents: true
    });
    const discovery = await client.callTool("discover_agents", {
      includeNotInstalled: false
    });
    const discoveredOpenCode = discovery.agents?.find((agent) => agent.id === "opencode");
    assert(
      discoveredOpenCode?.status === "available",
      "OpenCode must be available before running the session lifecycle E2E.",
      discovery
    );

    const firstStart = await client.callTool("run_agent", {
      agent: "opencode",
      worktree,
      prompt: buildPrompt(firstLine),
      async: true,
      timeoutSec: options.timeoutSec,
      permissionProfile: "workspace_write",
      collectDiff: true,
      metadata: {
        source: "scripts/e2e-session-lifecycle.mjs",
        phase: "initial"
      }
    });
    const firstJob = await waitForJob({
      dispatcherDataDir,
      jobId: firstStart.jobId,
      timeoutMs: options.timeoutSec * 1000 + 120_000
    });
    assertCompletedJob(firstJob, {
      expectedEvent: "acp_session_created",
      context: "initial run"
    });

    const firstSession = await findSession(client, {
      sessionId: firstStart.sessionId,
      worktree,
      includeArchived: true
    });
    assertSession(firstSession, {
      expectedLastJobId: firstJob.jobId,
      expectedStatus: "idle",
      expectedProviderSessionId: firstJob.providerSessionId,
      context: "after initial run"
    });

    const continuedStart = await client.callTool("manage_sessions", {
      action: "continue",
      agent: "opencode",
      sessionId: firstStart.sessionId,
      prompt: buildPrompt(secondLine),
      worktree,
      async: true,
      timeoutSec: options.timeoutSec
    });
    assert(
      continuedStart.sessionId === firstStart.sessionId,
      "manage_sessions (continue) should reuse the Agent Router session id.",
      { firstStart, continuedStart }
    );
    assert(
      continuedStart.jobId && continuedStart.jobId !== firstJob.jobId,
      "manage_sessions (continue) should create a new job.",
      { firstStart, continuedStart }
    );

    const continuedJob = await waitForJob({
      dispatcherDataDir,
      jobId: continuedStart.jobId,
      timeoutMs: options.timeoutSec * 1000 + 120_000
    });
    assertCompletedJob(continuedJob, {
      expectedEvent: "acp_session_resumed",
      context: "continued run"
    });
    assert(
      continuedJob.providerSessionId === firstJob.providerSessionId,
      "Continued run should keep the same provider session id.",
      { firstJob, continuedJob }
    );

    const continuedSession = await findSession(client, {
      sessionId: firstStart.sessionId,
      worktree,
      includeArchived: true
    });
    assertSession(continuedSession, {
      expectedLastJobId: continuedJob.jobId,
      expectedStatus: "idle",
      expectedProviderSessionId: firstJob.providerSessionId,
      context: "after continued run"
    });

    const archiveResult = await client.callTool("manage_sessions", {
      action: "archive",
      sessionId: firstStart.sessionId
    });
    assert(
      archiveResult.sessionId === firstStart.sessionId && archiveResult.status === "archived",
      "manage_sessions (archive) should archive the Agent Router session.",
      archiveResult
    );

    const defaultListAfterArchive = await client.callTool("manage_sessions", {
      action: "list",
      agent: "opencode",
      worktree,
      limit: 20
    });
    assert(
      !defaultListAfterArchive.sessions?.some((session) => session.sessionId === firstStart.sessionId),
      "Archived session should be hidden from the default list.",
      defaultListAfterArchive
    );

    const archivedSession = await findSession(client, {
      sessionId: firstStart.sessionId,
      worktree,
      includeArchived: true
    });
    assertSession(archivedSession, {
      expectedLastJobId: continuedJob.jobId,
      expectedStatus: "archived",
      expectedProviderSessionId: firstJob.providerSessionId,
      context: "after archive"
    });

    const note = await readFile(path.join(worktree, "note.txt"), "utf8");
    assert(note.includes(firstLine), "note.txt should include the first E2E line.", { note, firstLine });
    assert(note.includes(secondLine), "note.txt should include the continued E2E line.", { note, secondLine });
    const gitStatus = await git(worktree, ["status", "--porcelain=v1"]);

    await client.callTool("manage_config", {
      action: "set",
      launchExternalAgents: false
    });

    console.log(JSON.stringify({
      passed: true,
      serverVersion: initialize.serverInfo?.version ?? null,
      tempRoot,
      worktree,
      dispatcherDataDir,
      keptArtifacts: keepArtifacts,
      configuredLaunchExternalAgents: configResult.config?.safety?.launchExternalAgents ?? null,
      discoveredOpenCode: {
        status: discoveredOpenCode.status,
        version: discoveredOpenCode.version,
        transport: discoveredOpenCode.transport
      },
      opencodeModel: options.opencodeModel,
      session: {
        sessionId: firstStart.sessionId,
        providerSessionId: firstJob.providerSessionId,
        initialJobId: firstJob.jobId,
        continuedJobId: continuedJob.jobId,
        archivedStatus: archivedSession.status
      },
      jobs: {
        initial: summarizeJob(firstJob),
        continued: summarizeJob(continuedJob)
      },
      coverage: {
        initialCreatedProviderSession: eventTypes(firstJob).includes("acp_session_created"),
        continuedResumedProviderSession: eventTypes(continuedJob).includes("acp_session_resumed"),
        defaultListAfterArchiveCount: defaultListAfterArchive.sessions?.length ?? 0
      },
      firstLine,
      secondLine,
      note,
      gitStatus: gitStatus.stdout.trim(),
      durationMs: Date.now() - startedAt,
      stderr: client.stderr.trim()
    }, null, 2));
  } catch (error) {
    keepArtifacts = true;
    exitCode = 1;
    console.log(JSON.stringify({
      passed: false,
      tempRoot,
      worktree,
      dispatcherDataDir,
      keptArtifacts: true,
      error: error.message,
      details: error.details ?? null,
      durationMs: Date.now() - startedAt,
      stderr: client?.stderr?.trim() ?? ""
    }, null, 2));
  } finally {
    if (client) await client.stop();
    if (!keepArtifacts) {
      await rm(tempRoot, { force: true, recursive: true });
    }
    process.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const result = {
    timeoutSec: 600,
    keep: false,
    help: false,
    firstLine: null,
    secondLine: null,
    opencodeModel: "opencode-go/glm-5.2",
    opencodeSmallModel: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--keep") result.keep = true;
    else if (arg === "--timeout-sec") result.timeoutSec = Number.parseInt(readValue(argv, ++index, arg), 10);
    else if (arg === "--first-line") result.firstLine = readValue(argv, ++index, arg);
    else if (arg === "--second-line") result.secondLine = readValue(argv, ++index, arg);
    else if (arg === "--opencode-model") result.opencodeModel = readValue(argv, ++index, arg);
    else if (arg === "--opencode-small-model") result.opencodeSmallModel = readValue(argv, ++index, arg);
    else if (arg === "--no-opencode-config") result.opencodeModel = null;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(result.timeoutSec) || result.timeoutSec < 1) {
    throw new Error("--timeout-sec must be a positive integer.");
  }
  return result;
}

function readValue(argv, index, name) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function printHelp() {
  console.log(`Usage: npm run e2e:sessions:opencode -- [options]

Runs a real OpenCode ACP session lifecycle E2E against a temporary git worktree.
This calls external agent models and may incur cost.

Options:
  --timeout-sec <seconds>       Agent Router job timeout for each run (default: 600)
  --first-line <text>           First exact line that OpenCode must append to note.txt
  --second-line <text>          Continued exact line that OpenCode must append to note.txt
  --opencode-model <model>      Project opencode.json model (default: opencode-go/glm-5.2)
  --opencode-small-model <id>   Optional small_model; defaults to --opencode-model
  --no-opencode-config          Do not write project opencode.json
  --keep                        Keep temp worktree and dispatcher data for inspection
  --help                        Show this help
`);
}

async function prepareWorktree({ worktree, options, firstLine, secondLine }) {
  await mkdir(worktree, { recursive: true });
  await git(worktree, ["init", "-b", "master"]);
  await git(worktree, ["config", "user.email", "agent-router-e2e@example.invalid"]);
  await git(worktree, ["config", "user.name", "Agent Router E2E"]);
  await writeFile(
    path.join(worktree, "note.txt"),
    [
      "Agent Router session lifecycle E2E baseline",
      `First expected line: ${firstLine}`,
      `Second expected line: ${secondLine}`,
      ""
    ].join("\n"),
    "utf8"
  );
  if (options.opencodeModel) {
    await writeFile(
      path.join(worktree, "opencode.json"),
      `${JSON.stringify({
        model: options.opencodeModel,
        small_model: options.opencodeSmallModel ?? options.opencodeModel
      }, null, 2)}\n`,
      "utf8"
    );
  }
  await git(worktree, ["add", "."]);
  await git(worktree, ["commit", "-m", "Prepare Agent Router session lifecycle E2E baseline"]);
}

function buildPrompt(line) {
  return [
    "Edit the file note.txt in the current worktree.",
    `Append exactly this line as a new line: ${line}`,
    "Do not edit any other files.",
    "When finished, briefly report the changed file and whether the edit was made."
  ].join("\n");
}

async function waitForJob({ dispatcherDataDir, jobId, timeoutMs }) {
  const startedAt = Date.now();
  let lastJob = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastJob = await readJobFromRegistry(dispatcherDataDir, jobId);
    if (lastJob && TERMINAL_STATUSES.has(lastJob.status)) return lastJob;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for job ${jobId}. Last status: ${lastJob?.status ?? "unknown"}`);
}

async function readJobFromRegistry(dispatcherDataDir, jobId) {
  try {
    const registry = JSON.parse(await readFile(path.join(dispatcherDataDir, "registry.json"), "utf8"));
    return registry.jobs?.[jobId] ?? null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function findSession(client, { sessionId, worktree, includeArchived }) {
  const result = await client.callTool("manage_sessions", {
    action: "list",
    agent: "opencode",
    worktree,
    includeArchived,
    limit: 50
  });
  return result.sessions?.find((session) => session.sessionId === sessionId) ?? null;
}

function assertCompletedJob(job, { expectedEvent, context }) {
  assert(job?.status === "completed", `Expected ${context} to complete.`, job);
  assert(job.adapterStatus === "opencode_acp", `Expected ${context} to use OpenCode ACP.`, job);
  assert(job.providerSessionId, `Expected ${context} to persist providerSessionId.`, job);
  assert(job.changedFiles?.includes("note.txt"), `Expected ${context} to report note.txt as changed.`, job);
  assert(eventTypes(job).includes(expectedEvent), `Expected ${context} to record ${expectedEvent}.`, job.recentEvents);
}

function assertSession(session, { expectedLastJobId, expectedStatus, expectedProviderSessionId, context }) {
  assert(session, `Expected session to be listed ${context}.`);
  assert(session.agentId === "opencode", `Expected session agent ${context} to be opencode.`, session);
  assert(session.status === expectedStatus, `Expected session status ${context} to be ${expectedStatus}.`, session);
  assert(session.canContinue === true, `Expected session canContinue ${context} to be true.`, session);
  assert(session.lastJobId === expectedLastJobId, `Expected session lastJobId ${context} to match.`, session);
  assert(
    session.providerSessionId === expectedProviderSessionId,
    `Expected session providerSessionId ${context} to match.`,
    session
  );
}

function summarizeJob(job) {
  const types = eventTypes(job);
  return {
    jobId: job.jobId,
    status: job.status,
    adapterStatus: job.adapterStatus,
    providerSessionId: job.providerSessionId,
    stopReason: job.stopReason,
    changedFiles: job.changedFiles,
    failureReason: job.failureReason,
    agentErrors: job.agentErrors,
    availableModelCount: Array.isArray(job.availableModels) ? job.availableModels.length : 0,
    selectedModel: job.agentConfigOptions
      ?.find((option) => option.id === "model" || option.category === "model")
      ?.currentValue ?? null,
    logPath: job.logPath,
    importantEvents: {
      sessionCreated: types.includes("acp_session_created"),
      sessionResumed: types.includes("acp_session_resumed"),
      promptCompleted: types.includes("acp_prompt_completed"),
      processClosed: types.includes("acp_process_closed"),
      usageUpdated: types.includes("acp_usage_update")
    },
    eventCount: types.length,
    eventTail: types.slice(-12),
    process: job.process
  };
}

function eventTypes(job) {
  return (job.recentEvents ?? []).map((event) => event.type);
}

function assert(condition, message, details = null) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

async function git(cwd, args) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: 10_000,
      env: safeEnv()
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    throw new Error(`git ${args.join(" ")} failed: ${error.message}`);
  }
}

class McpClient {
  constructor({ cwd, env }) {
    this.cwd = cwd;
    this.env = env;
    this.child = null;
    this.stderr = "";
    this.stdoutBuffer = Buffer.alloc(0);
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
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code, signal) => {
      this.rejectAll(new Error(`MCP server exited with code=${code} signal=${signal}`));
    });
    await sleep(50);
  }

  request(method, params = {}, timeoutMs = 60_000) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for MCP response to ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.write(payload);
    });
  }

  async callTool(name, args = {}, timeoutMs = 60_000) {
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs);
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
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = this.stdoutBuffer.subarray(0, newlineIndex).toString("utf8").replace(/\r$/, "").trim();
      this.stdoutBuffer = this.stdoutBuffer.subarray(newlineIndex + 1);
      if (!line) continue;
      try {
        this.handleMessage(JSON.parse(line));
      } catch (error) {
        this.rejectAll(new Error(`Malformed MCP response line: ${line}`));
        return;
      }
    }
  }

  handleMessage(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(`${pending.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`));
    } else {
      pending.resolve(message.result);
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async stop() {
    if (!this.child) return;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => this.child.once("exit", resolve)),
        sleep(1000)
      ]);
    }
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

function safeEnv() {
  return {
    ...process.env,
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? os.homedir(),
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8"
  };
}

await main();
