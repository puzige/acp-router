#!/usr/bin/env node

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keepArtifacts = process.env.ACP_DISPATCHER_KEEP_SMOKE_ARTIFACTS === "1";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "acp-dispatcher-session-lifecycle-"));
const tempHome = path.join(tempRoot, "home");
const dispatcherDataDir = path.join(tempRoot, "dispatcher-data");
const tempWorktree = path.join(tempRoot, "worktree");
const tempBin = path.join(tempRoot, "bin");
const fakeOpenCodeLog = path.join(tempRoot, "fake-opencode.jsonl");

class McpClient {
  constructor({ cwd, env }) {
    this.cwd = cwd;
    this.env = env;
    this.child = null;
    this.stderr = "";
    this.stdoutBuffer = "";
    this.nextId = 1;
    this.pending = new Map();
  }

  async start() {
    this.child = spawn(process.execPath, ["./mcp/server.mjs"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("exit", (code, signal) => {
      this.rejectAll(new Error(`MCP server exited with code=${code} signal=${signal}`));
    });
    await sleep(50);
  }

  request(method, params = {}, timeoutMs = 5000) {
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

  async callTool(name, args = {}, timeoutMs = 5000) {
    const result = await this.request("tools/call", { name, arguments: args }, timeoutMs);
    const text = result.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;
    if (result.isError) {
      throw new Error(`Tool ${name} failed: ${parsed?.error ?? text ?? "unknown error"}`);
    }
    return parsed;
  }

  write(payload) {
    const body = JSON.stringify(payload);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    while (true) {
      const headerEnd = this.stdoutBuffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.stdoutBuffer.slice(0, headerEnd);
      const match = /^Content-Length:\s*(\d+)$/im.exec(header);
      if (!match) {
        this.rejectAll(new Error(`Malformed MCP response header: ${header}`));
        return;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.stdoutBuffer.length < bodyEnd) return;
      const raw = this.stdoutBuffer.slice(bodyStart, bodyEnd);
      this.stdoutBuffer = this.stdoutBuffer.slice(bodyEnd);
      this.handleMessage(JSON.parse(raw));
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

let client = null;
let passed = false;

try {
  await mkdir(tempHome, { recursive: true });
  await mkdir(dispatcherDataDir, { recursive: true });
  await mkdir(tempWorktree, { recursive: true });
  await mkdir(tempBin, { recursive: true });
  await execFileAsync("git", ["-C", tempWorktree, "init", "-b", "master"]);
  await createFakeOpenCode(tempBin);

  client = new McpClient({
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: tempHome,
      AGENT_DISPATCHER_DATA_DIR: dispatcherDataDir,
      AGENT_DISPATCHER_LIFECYCLE_FAKE_LOG: fakeOpenCodeLog,
      PATH: `${tempBin}${path.delimiter}${process.env.PATH ?? ""}`
    }
  });
  await client.start();

  const initialize = await client.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "session-lifecycle-smoke", version: "0.0.0" }
  });
  const config = await client.callTool("configure_coding_agent_dispatcher", {
    launchExternalAgents: true
  });
  assert(
    config.config?.safety?.launchExternalAgents === true,
    "Expected launchExternalAgents to be enabled.",
    config
  );

  const discovery = await client.callTool("discover_coding_agents", {
    includeNotInstalled: false
  });
  const discoveredOpenCode = discovery.agents?.find((agent) => agent.id === "opencode");
  assert(
    discoveredOpenCode?.status === "available" && discoveredOpenCode.version === "fake-opencode 9999.0.0",
    "Expected fake OpenCode to be discovered and selected ahead of any real binary.",
    discovery
  );

  const initialPrompt = "Lifecycle smoke initial prompt.";
  const firstRun = await client.callTool("run_coding_agent", {
    agent: "opencode",
    worktree: tempWorktree,
    prompt: initialPrompt,
    async: false,
    timeoutSec: 5,
    permissionProfile: "workspace_write",
    metadata: { source: "scripts/session-lifecycle-smoke.mjs", phase: "initial" }
  }, 10_000);
  assertCompletedOpenCodeRun(firstRun, "initial run");

  const firstSession = await findOnlySession(client, {
    worktree: tempWorktree,
    agent: "opencode"
  });
  assertSession(firstSession, {
    expectedSessionId: firstRun.sessionId,
    expectedLastJobId: firstRun.jobId,
    expectedStatus: "idle",
    context: "first session list"
  });

  const followupPrompt = "Lifecycle smoke follow-up prompt.";
  const continuedRun = await client.callTool("continue_coding_agent_session", {
    agent: "opencode",
    sessionId: firstRun.sessionId,
    prompt: followupPrompt,
    worktree: tempWorktree,
    async: false,
    timeoutSec: 5
  }, 10_000);
  assertCompletedOpenCodeRun(continuedRun, "continued run");
  assert(
    continuedRun.sessionId === firstRun.sessionId,
    "Expected continue_coding_agent_session to return the same dispatcher sessionId.",
    { firstRun, continuedRun }
  );
  assert(
    continuedRun.jobId && continuedRun.jobId !== firstRun.jobId,
    "Expected continue_coding_agent_session to create a new job.",
    { firstRun, continuedRun }
  );

  const continuedSession = await findOnlySession(client, {
    worktree: tempWorktree,
    agent: "opencode"
  });
  assertSession(continuedSession, {
    expectedSessionId: firstRun.sessionId,
    expectedLastJobId: continuedRun.jobId,
    expectedStatus: "idle",
    context: "continued session list"
  });

  const archiveResult = await client.callTool("archive_coding_agent_session", {
    sessionId: firstRun.sessionId
  });
  assert(
    archiveResult.sessionId === firstRun.sessionId && archiveResult.status === "archived",
    "Expected archive_coding_agent_session to mark the session archived.",
    archiveResult
  );

  const defaultListAfterArchive = await client.callTool("list_coding_agent_sessions", {
    worktree: tempWorktree,
    agent: "opencode",
    limit: 10
  });
  assert(
    !defaultListAfterArchive.sessions?.some((session) => session.sessionId === firstRun.sessionId),
    "Expected archived session to be hidden from the default session list.",
    defaultListAfterArchive
  );

  const archivedList = await client.callTool("list_coding_agent_sessions", {
    worktree: tempWorktree,
    agent: "opencode",
    includeArchived: true,
    limit: 10
  });
  const archivedSession = archivedList.sessions?.find((session) => session.sessionId === firstRun.sessionId);
  assertSession(archivedSession, {
    expectedSessionId: firstRun.sessionId,
    expectedLastJobId: continuedRun.jobId,
    expectedStatus: "archived",
    context: "archived session list"
  });

  const fakeCalls = await readJsonl(fakeOpenCodeLog);
  assertFakeOpenCodeCalls(fakeCalls, { initialPrompt, followupPrompt });

  passed = true;
  console.log(JSON.stringify({
    passed: true,
    serverVersion: initialize.serverInfo?.version ?? null,
    dispatcherDataDir,
    worktree: tempWorktree,
    keptArtifacts: keepArtifacts,
    session: {
      sessionId: firstRun.sessionId,
      providerSessionId: firstRun.providerSessionId,
      initialJobId: firstRun.jobId,
      continuedJobId: continuedRun.jobId,
      archivedStatus: archivedSession.status
    },
    coverage: {
      configuredLaunchExternalAgents: config.config?.safety?.launchExternalAgents ?? null,
      fakeOpenCodeVersion: discoveredOpenCode.version,
      initialListLastJobId: firstSession.lastJobId,
      continuedListLastJobId: continuedSession.lastJobId,
      defaultListAfterArchiveCount: defaultListAfterArchive.sessions?.length ?? 0,
      includeArchivedCount: archivedList.sessions?.length ?? 0,
      fakeSessionNewCalls: fakeCalls.filter((call) => call.method === "session/new").length,
      fakeSessionResumeCalls: fakeCalls.filter((call) => call.method === "session/resume").length,
      fakePromptCalls: fakeCalls.filter((call) => call.method === "session/prompt").length
    },
    stderr: client.stderr.trim()
  }, null, 2));
} catch (error) {
  process.exitCode = 1;
  console.log(JSON.stringify({
    passed: false,
    error: error.message,
    details: error.details ?? null,
    tempRoot,
    keptArtifacts: keepArtifacts,
    stderr: client?.stderr?.trim() ?? ""
  }, null, 2));
} finally {
  if (client) await client.stop();
  if (!keepArtifacts) {
    await rm(tempRoot, { force: true, recursive: true });
  }
  if (!passed && keepArtifacts) {
    process.stderr.write(`Kept smoke artifacts at ${tempRoot}\n`);
  }
}

async function createFakeOpenCode(binDir) {
  const scriptPath = path.join(binDir, "opencode");
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const logPath = process.env.AGENT_DISPATCHER_LIFECYCLE_FAKE_LOG;
const providerSessionId = "fake-opencode-session";

if (process.argv.includes("--version")) {
  console.log("fake-opencode 9999.0.0");
  process.exit(0);
}

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    handle(message);
  }
});

function handle(message) {
  const promptText = Array.isArray(message.params?.prompt)
    ? message.params.prompt.map((part) => part.text ?? "").join("\\n")
    : null;
  record({ method: message.method, params: message.params ?? null, promptText });

  if (message.method === "initialize") {
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {}, list: {} }
        },
        agentInfo: { name: "Fake OpenCode", version: "9999.0.0" },
        authMethods: []
      }
    });
    return;
  }

  if (message.method === "session/new") {
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessionId: providerSessionId,
        configOptions: [
          {
            id: "model",
            title: "Model",
            category: "model",
            type: "select",
            options: [
              { value: "fake-opencode/model-a", label: "Fake Model A" },
              { value: "fake-opencode/model-b", label: "Fake Model B" }
            ]
          }
        ]
      }
    });
    return;
  }

  if (message.method === "session/resume") {
    if (message.params?.sessionId !== providerSessionId) {
      write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "Unexpected provider session id" }
      });
      return;
    }
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessionId: providerSessionId,
        configOptions: [
          {
            id: "model",
            title: "Model",
            category: "model",
            type: "select",
            options: [{ value: "fake-opencode/model-a", label: "Fake Model A" }]
          }
        ]
      }
    });
    return;
  }

  if (message.method === "session/prompt") {
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: providerSessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Fake OpenCode completed lifecycle prompt." }
        }
      }
    });
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason: "end_turn" }
    });
    return;
  }

  write({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "Unsupported fake method" }
  });
}

function record(entry) {
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify({
    ...entry,
    argv: process.argv.slice(2)
  }) + "\\n");
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
`;
  await writeFile(scriptPath, script, "utf8");
  await chmod(scriptPath, 0o755);
}

async function findOnlySession(client, args) {
  const result = await client.callTool("list_coding_agent_sessions", {
    ...args,
    limit: 10
  });
  assert(result.sessions?.length === 1, "Expected exactly one visible dispatcher session.", result);
  return result.sessions[0];
}

function assertCompletedOpenCodeRun(result, context) {
  assert(result.status === "completed", `Expected ${context} to complete.`, result);
  assert(result.adapterStatus === "opencode_acp", `Expected ${context} to use the OpenCode ACP adapter.`, result);
  assert(result.sessionId && result.jobId, `Expected ${context} to include sessionId and jobId.`, result);
  assert(
    result.providerSessionId === "fake-opencode-session",
    `Expected ${context} to bind the fake provider session id.`,
    result
  );
  assert(result.worktree === tempWorktree, `Expected ${context} to report the requested worktree.`, result);
}

function assertSession(session, { expectedSessionId, expectedLastJobId, expectedStatus, context }) {
  assert(session, `Expected to find session in ${context}.`, { expectedSessionId, expectedLastJobId });
  assert(session.sessionId === expectedSessionId, `Expected ${context} to return the same sessionId.`, session);
  assert(session.agentId === "opencode", `Expected ${context} to be tied to opencode.`, session);
  assert(session.worktree === tempWorktree, `Expected ${context} to report the requested worktree.`, session);
  assert(session.lastJobId === expectedLastJobId, `Expected ${context} lastJobId to match.`, session);
  assert(session.status === expectedStatus, `Expected ${context} status to be ${expectedStatus}.`, session);
  assert(session.canContinue === true, `Expected ${context} canContinue=true.`, session);
  assert(
    session.providerSessionId === "fake-opencode-session",
    `Expected ${context} providerSessionId to be persisted.`,
    session
  );
}

function assertFakeOpenCodeCalls(calls, { initialPrompt, followupPrompt }) {
  const sessionNewCalls = calls.filter((call) => call.method === "session/new");
  const sessionResumeCalls = calls.filter((call) => call.method === "session/resume");
  const promptCalls = calls.filter((call) => call.method === "session/prompt");
  assert(sessionNewCalls.length === 1, "Expected fake OpenCode to create exactly one provider session.", calls);
  assert(sessionResumeCalls.length === 1, "Expected fake OpenCode to resume exactly one provider session.", calls);
  assert(
    sessionResumeCalls[0]?.params?.sessionId === "fake-opencode-session",
    "Expected fake OpenCode resume to use the providerSessionId from the first run.",
    sessionResumeCalls
  );
  assert(promptCalls.length === 2, "Expected fake OpenCode to receive exactly two prompts.", calls);
  assert(promptCalls[0]?.promptText?.includes(initialPrompt), "Expected initial prompt to reach fake OpenCode.", promptCalls);
  assert(promptCalls[1]?.promptText?.includes(followupPrompt), "Expected follow-up prompt to reach fake OpenCode.", promptCalls);
}

async function readJsonl(filePath) {
  const raw = await readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function assert(condition, message, details = null) {
  if (condition) return;
  const error = new Error(message);
  error.details = details;
  throw error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
