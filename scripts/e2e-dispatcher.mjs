#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VALID_AGENTS = new Set(["opencode", "claude", "cursor-agent", "codex"]);

async function main() {
const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printHelp();
  process.exit(0);
}
if (!VALID_AGENTS.has(options.agent)) {
  throw new Error(`Unsupported --agent ${options.agent}. Use one of: ${Array.from(VALID_AGENTS).join(", ")}`);
}

const tempRoot = await mkdtemp(path.join(os.tmpdir(), `agent-router-e2e-${options.agent}-`));
const worktree = path.join(tempRoot, "worktree");
const dispatcherDataDir = path.join(tempRoot, "dispatcher-data");
const expectedLine = options.expectedLine ?? `Agent Router E2E completed by ${options.agent}.`;
const startedAt = Date.now();
let client = null;
let keepArtifacts = options.keep;
let exitCode = 0;

try {
  await prepareWorktree({ worktree, options, expectedLine });
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
    clientInfo: { name: "agent-router-e2e", version: "0.0.0" }
  });
  const configResult = await client.callTool("manage_config", {
    action: "set",
    launchExternalAgents: true
  });
  const discovery = await client.callTool("discover_agents", {
    includeNotInstalled: false
  });
  const prompt = options.prompt ?? buildDefaultPrompt(expectedLine);
  const runOutcome = await waitForRunOutcome({
    client,
    dispatcherDataDir,
    timeoutMs: Math.max(options.timeoutSec * 1000 + 60_000, 120_000),
    args: {
      agent: options.agent,
      worktree,
      prompt,
      async: false,
      timeoutSec: options.timeoutSec,
      permissionProfile: options.permissionProfile,
      collectDiff: true,
      metadata: {
        source: "scripts/e2e-dispatcher.mjs",
        expectedLine
      }
    }
  });
  const runResult = runOutcome.result;
  await client.callTool("manage_config", {
    action: "set",
    launchExternalAgents: false
  });

  const note = await readFile(path.join(worktree, "note.txt"), "utf8");
  const gitStatus = await git(worktree, ["status", "--porcelain=v1"]);
  const passed = runResult.status === "completed"
    && note.includes(expectedLine)
    && Array.isArray(runResult.changedFiles)
    && runResult.changedFiles.includes("note.txt");
  if (!passed) {
    keepArtifacts = true;
    exitCode = 1;
  }

  const summary = {
    passed,
    agent: options.agent,
    serverVersion: initialize.serverInfo?.version ?? null,
    dispatcherDataDir,
    tempRoot,
    worktree,
    keptArtifacts: keepArtifacts,
    configuredLaunchExternalAgents: configResult.config?.safety?.launchExternalAgents ?? null,
    discoveredAgents: (discovery.agents ?? []).map((agent) => ({
      id: agent.id,
      status: agent.status,
      version: agent.version,
      transport: agent.transport
    })),
    job: {
      jobId: runResult.jobId,
      status: runResult.status,
      adapterStatus: runResult.adapterStatus,
      providerSessionId: runResult.providerSessionId,
      stopReason: runResult.stopReason,
      changedFiles: runResult.changedFiles,
      failureReason: runResult.failureReason,
      agentErrors: runResult.agentErrors,
      availableModels: runResult.availableModels,
      logPath: runResult.logPath,
      risks: runResult.risks,
      source: runOutcome.source,
      responseError: runOutcome.error?.message ?? null
    },
    expectedLine,
    note,
    gitStatus: gitStatus.stdout.trim(),
    durationMs: Date.now() - startedAt,
    stderr: client.stderr.trim()
  };
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  keepArtifacts = true;
  exitCode = 1;
  console.log(JSON.stringify({
    passed: false,
    agent: options.agent,
    tempRoot,
    worktree,
    dispatcherDataDir,
    keptArtifacts: true,
    error: error.message,
    durationMs: Date.now() - startedAt,
    stderr: client?.stderr?.trim() ?? ""
  }, null, 2));
} finally {
  if (client) client.stop();
  if (!keepArtifacts) {
    await rm(tempRoot, { force: true, recursive: true });
  }
  process.exitCode = exitCode;
}
}

function parseArgs(argv) {
  const result = {
    agent: "opencode",
    timeoutSec: 300,
    permissionProfile: "workspace_write",
    keep: false,
    help: false,
    prompt: null,
    expectedLine: null,
    opencodeModel: null,
    opencodeSmallModel: null
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--keep") result.keep = true;
    else if (arg === "--agent") result.agent = readValue(argv, ++index, arg);
    else if (arg === "--timeout-sec") result.timeoutSec = Number.parseInt(readValue(argv, ++index, arg), 10);
    else if (arg === "--permission-profile") result.permissionProfile = readValue(argv, ++index, arg);
    else if (arg === "--prompt") result.prompt = readValue(argv, ++index, arg);
    else if (arg === "--expected-line") result.expectedLine = readValue(argv, ++index, arg);
    else if (arg === "--opencode-model") result.opencodeModel = readValue(argv, ++index, arg);
    else if (arg === "--opencode-small-model") result.opencodeSmallModel = readValue(argv, ++index, arg);
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

async function waitForRunOutcome({ client, dispatcherDataDir, args, timeoutMs }) {
  const pollState = { done: false };
  const mcpPromise = client
    .callTool("run_agent", args, timeoutMs)
    .then((result) => ({ source: "mcp_response", result }))
    .catch((error) => ({ source: "mcp_error", error }));
  const registryPromise = waitForLatestTerminalJob({ dispatcherDataDir, timeoutMs, pollState })
    .then((result) => ({ source: "dispatcher_registry", result }))
    .catch((error) => ({ source: "registry_error", error }));

  const first = await Promise.race([mcpPromise, registryPromise]);
  if (first.source === "mcp_error") {
    const fallback = await registryPromise;
    pollState.done = true;
    if (fallback.source === "dispatcher_registry") {
      return { ...fallback, error: first.error };
    }
    throw first.error;
  }
  pollState.done = true;
  if (first.source === "registry_error") throw first.error;
  return first;
}

async function waitForLatestTerminalJob({ dispatcherDataDir, timeoutMs, pollState }) {
  const startedAt = Date.now();
  let lastJob = null;
  while (!pollState.done && Date.now() - startedAt < timeoutMs) {
    const job = await readLatestJob(dispatcherDataDir);
    if (job) {
      lastJob = job;
      if (["completed", "failed", "cancelled", "timed_out", "orphaned"].includes(job.status)) {
        return mapJobToRunResult(job);
      }
    }
    await sleep(1000);
  }
  throw new Error(`No terminal Agent Router job found before timeout. Last status: ${lastJob?.status ?? "none"}`);
}

async function readLatestJob(dispatcherDataDir) {
  try {
    const registry = JSON.parse(await readFile(path.join(dispatcherDataDir, "registry.json"), "utf8"));
    return Object.values(registry.jobs ?? {})
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0] ?? null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function mapJobToRunResult(job) {
  return {
    jobId: job.jobId,
    sessionId: job.sessionId,
    agentId: job.agentId,
    status: job.status,
    worktree: job.worktree,
    endedAt: job.endedAt,
    summary: job.resultSummary,
    changedFiles: job.changedFiles ?? [],
    validation: job.validation ?? [],
    risks: job.risks ?? [],
    logPath: job.logPath,
    worktreeState: job.worktreeState,
    adapterStatus: job.adapterStatus,
    providerSessionId: job.providerSessionId,
    stopReason: job.stopReason,
    failureReason: job.failureReason ?? null,
    agentErrors: job.agentErrors ?? [],
    availableModels: job.availableModels ?? []
  };
}

function printHelp() {
  console.log(`Usage: npm run e2e -- [options]

Runs a real dispatcher E2E against a temporary git worktree.
This may call external agent models and incur cost.

Options:
  --agent <id>                  opencode, claude, cursor-agent, or codex (default: opencode)
  --timeout-sec <seconds>       Agent Router job timeout (default: 300)
  --permission-profile <name>   plan, workspace_write, accept_edits, or bypass_permissions (default: workspace_write)
  --expected-line <text>        Line that the agent must add to note.txt
  --prompt <text>               Override the default prompt
  --opencode-model <model>      Write project opencode.json with this model before running
  --opencode-small-model <id>   Optional small_model for opencode.json; defaults to --opencode-model
  --keep                        Keep temp worktree and dispatcher data for inspection
  --help                        Show this help

Examples:
  npm run e2e:opencode -- --opencode-model opencode-go/glm-5.2 --keep
  npm run e2e:claude -- --timeout-sec 600 --keep
`);
}

async function prepareWorktree({ worktree, options, expectedLine }) {
  await mkdir(worktree, { recursive: true });
  await git(worktree, ["init", "-b", "master"]);
  await git(worktree, ["config", "user.email", "agent-router-e2e@example.invalid"]);
  await git(worktree, ["config", "user.name", "Agent Router E2E"]);
  await writeFile(
    path.join(worktree, "note.txt"),
    [
      "Agent Router E2E baseline",
      `Expected line: ${expectedLine}`,
      ""
    ].join("\n"),
    "utf8"
  );
  if (options.agent === "opencode" && options.opencodeModel) {
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
  await git(worktree, ["commit", "-m", "Prepare Agent Router E2E baseline"]);
}

function buildDefaultPrompt(expectedLine) {
  return [
    "Edit the file note.txt in the current worktree.",
    `Append exactly this line as a new line: ${expectedLine}`,
    "Do not edit any other files.",
    "When finished, briefly report the changed file and whether the edit was made."
  ].join("\n");
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
    this.buffer = Buffer.alloc(0);
    this.stderr = "";
    this.nextId = 1;
    this.pending = new Map();
  }

  async start() {
    this.child = spawn("node", ["./bin/agent-router.mjs"], {
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
  }

  request(method, params, timeoutMs = 60_000) {
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

  async callTool(name, args, timeoutMs) {
    const result = await this.request("tools/call", {
      name,
      arguments: args
    }, timeoutMs);
    const text = result.content?.[0]?.text;
    if (!text) return result;
    return JSON.parse(text);
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

  stop() {
    if (this.child && !this.child.killed) this.child.kill("SIGTERM");
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
