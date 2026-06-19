#!/usr/bin/env node

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "acp-dispatcher-smoke-"));
const tempHome = path.join(tempRoot, "home");
const tempWorktree = path.join(tempRoot, "worktree");
const tempBin = path.join(tempRoot, "bin");
const tempOldBin = path.join(tempRoot, "old-bin");
const tempPidFile = path.join(tempRoot, "children.pid");

try {
  await mkdir(tempHome, { recursive: true });
  await mkdir(tempWorktree, { recursive: true });
  await mkdir(tempBin, { recursive: true });
  await mkdir(tempOldBin, { recursive: true });
  await execFileAsync("git", ["-C", tempWorktree, "init", "-b", "master"]);
  await createFakeOpenCode(tempBin);
  await createFakeClaude(tempOldBin, { version: "fake-claude 0.0.1", fail: true });
  await createFakeClaude(tempBin, { version: "fake-claude 999.0.0" });
  await createFakeCursorAgent(tempBin);
  await createFakeCodex(tempBin);

  const result = await runMcpSmoke(tempHome, tempWorktree, [tempOldBin, tempBin], tempPidFile);
  console.log(JSON.stringify(result, null, 2));

  if (
    result.stderr
    || result.serverVersion !== "0.5.2"
    || result.discoveryCount < 1
    || result.runStatus !== "completed"
    || result.adapterStatus !== "opencode_acp"
    || result.providerSessionId !== "fake-opencode-session"
    || !result.availableModels?.some((model) => model.value === "opencode-go/glm-5.2")
    || result.failureStatus !== "timed_out"
    || !result.failureReason?.includes("Insufficient balance")
    || !result.agentErrors?.some((error) => error.includes("Rate limit exceeded"))
    || !result.failureAvailableModels?.some((model) => model.value === "opencode-go/glm-5.2")
    || result.claudeDiscoveredVersion !== "fake-claude 999.0.0"
    || result.claudeStatus !== "completed"
    || result.claudeAdapterStatus !== "claude_cli"
    || result.claudeProviderSessionId !== "fake-claude-session"
    || result.cursorStatus !== "completed"
    || result.cursorAdapterStatus !== "cursor_agent_cli"
    || result.cursorProviderSessionId !== "fake-cursor-session"
    || result.codexStatus !== "completed"
    || result.codexAdapterStatus !== "codex_cli"
    || result.codexProviderSessionId !== "fake-codex-session"
    || result.asyncStartStatus !== "running"
    || result.cancelStatus !== "cancelled"
    || result.cancelActiveProcessCancelled !== true
    || result.cancelledJobStatus !== "cancelled"
    || result.cancelledProcessStatus !== "cancelled"
    || result.cancelledProcessKillStatus !== "signal_sent"
    || result.orphanStartStatus !== "running"
    || !Number.isInteger(result.orphanProcessPid)
    || result.orphanStartRecordedProcessPid !== result.orphanProcessPid
    || result.orphanRecoveredStatus !== "orphaned"
    || !result.orphanRecoveredSummary?.includes("orphaned")
    || !result.orphanRecoveredEvents?.includes("orphaned")
    || result.orphanRecoveredSessionStatus !== "orphaned"
    || result.orphanRecoveredProcessKillStatus !== "signal_sent"
    || result.orphanProcessKilled !== true
    || result.restartFollowupStatus !== "completed"
    || result.restartFollowupAdapterStatus !== "claude_cli"
  ) {
    process.exitCode = 1;
  }
} finally {
  await killRecordedPids(tempPidFile);
  await rm(tempRoot, { force: true, recursive: true });
}

async function createFakeOpenCode(binDir) {
  const scriptPath = path.join(binDir, "opencode");
  const script = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("fake-opencode 999.0.0");
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
    if (message.method === "initialize") {
      write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, list: {} } }, agentInfo: { name: "Fake OpenCode", version: "0.0.0" }, authMethods: [] } });
    } else if (message.method === "session/new" || message.method === "session/resume") {
      write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "fake-opencode-session", configOptions: [{ id: "model", title: "Model", category: "model", type: "select", options: [{ value: "opencode-go/glm-5.2", label: "GLM-5.2" }, { value: "opencode-go/kimi-k2", label: "Kimi K2" }] }] } });
    } else if (message.method === "session/prompt") {
      const promptText = (message.params.prompt ?? []).map((part) => part.text ?? "").join("\\n");
      if (promptText.includes("Trigger failure")) {
        write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-opencode-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Insufficient balance" } } } });
        write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-opencode-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Rate limit exceeded" } } } });
        return;
      }
      write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-opencode-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Fake OpenCode completed." } } } });
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
    } else {
      write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported fake method" } });
    }
  }
});
function write(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
`;
  await writeFile(scriptPath, script, "utf8");
  await chmod(scriptPath, 0o755);
}

async function createFakeClaude(binDir, { version, fail = false }) {
  const scriptPath = path.join(binDir, "claude");
  const script = `#!/usr/bin/env node
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log(${JSON.stringify(version)});
  process.exit(0);
}
if (${JSON.stringify(fail)}) {
  console.error("old fake Claude should not be selected");
  process.exit(1);
}
if (process.env.AGENT_DISPATCHER_SMOKE_INHERITED !== "yes") {
  console.error("expected inherited environment");
  process.exit(1);
}
if (process.argv.join(" ").includes("Smoke async cancel") || process.argv.join(" ").includes("Smoke orphan recovery")) {
  if (process.env.AGENT_DISPATCHER_SMOKE_PID_FILE) {
    require("node:fs").appendFileSync(process.env.AGENT_DISPATCHER_SMOKE_PID_FILE, String(process.pid) + "\\n");
  }
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({ type: "assistant", session_id: "fake-claude-session", message: { content: [{ type: "text", text: "Fake Claude completed." }] } }));
}
`;
  await writeFile(scriptPath, script, "utf8");
  await chmod(scriptPath, 0o755);
}

async function createFakeCursorAgent(binDir) {
  const scriptPath = path.join(binDir, "agent");
  const script = `#!/usr/bin/env node
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  console.log("fake-agent 999.0.0");
  process.exit(0);
}
console.log(JSON.stringify({ type: "message", sessionId: "fake-cursor-session", message: "Fake Cursor Agent completed." }));
`;
  await writeFile(scriptPath, script, "utf8");
  await chmod(scriptPath, 0o755);
}

async function createFakeCodex(binDir) {
  const scriptPath = path.join(binDir, "codex");
  const script = `#!/usr/bin/env node
if (process.argv.includes("--version") || process.argv.includes("-V")) {
  console.log("fake-codex 999.0.0");
  process.exit(0);
}
console.log(JSON.stringify({ type: "agent_message", session_id: "fake-codex-session", message: "Fake Codex completed." }));
`;
  await writeFile(scriptPath, script, "utf8");
  await chmod(scriptPath, 0o755);
}

async function runMcpSmoke(home, worktree, binDirs, pidFile) {
  const { spawn } = await import("node:child_process");
  const first = startMcpServer({ home, binDirs, pidFile, spawn });
  const { child } = first;

  send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0.0.0" }
    }
  });
  send(child, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "configure_coding_agent_dispatcher",
      arguments: {
        launchExternalAgents: true
      }
    }
  });
  send(child, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "discover_coding_agents",
      arguments: { includeNotInstalled: true }
    }
  });
  send(child, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "run_coding_agent",
      arguments: {
        agent: "opencode",
        worktree,
        prompt: "Smoke test only",
        async: false,
        permissionProfile: "workspace_write"
      }
    }
  });

  await waitForMessage(() => parseMessages(first.stdout).find((message) => message.id === 4), 3000);
  send(child, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "run_coding_agent",
      arguments: {
        agent: "opencode",
        worktree,
        prompt: "Trigger failure: insufficient balance",
        async: false,
        timeoutSec: 1,
        permissionProfile: "workspace_write"
      }
    }
  });
  await waitForMessage(() => parseMessages(first.stdout).find((message) => message.id === 5), 4000);
  send(child, {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "run_coding_agent",
      arguments: {
        agent: "claude",
        worktree,
        prompt: "Smoke test Claude CLI",
        async: false,
        permissionProfile: "workspace_write"
      }
    }
  });
  await waitForMessage(() => parseMessages(first.stdout).find((message) => message.id === 6), 10_000);
  send(child, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: {
      name: "run_coding_agent",
      arguments: {
        agent: "cursor-agent",
        worktree,
        prompt: "Smoke test Cursor Agent CLI",
        async: false,
        permissionProfile: "workspace_write"
      }
    }
  });
  await waitForMessage(() => parseMessages(first.stdout).find((message) => message.id === 7), 10_000);
  send(child, {
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: {
      name: "run_coding_agent",
      arguments: {
        agent: "codex",
        worktree,
        prompt: "Smoke test Codex CLI",
        async: false,
        permissionProfile: "workspace_write"
      }
    }
  });
  await waitForMessage(() => parseMessages(first.stdout).find((message) => message.id === 8), 10_000);
  send(child, {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "run_coding_agent",
      arguments: {
        agent: "claude",
        worktree,
        prompt: "Smoke async cancel",
        async: true,
        timeoutSec: 30,
        permissionProfile: "workspace_write"
      }
    }
  });
  const asyncStart = await waitForMessage(() => parseMessages(first.stdout).find((message) => message.id === 9), 3000);
  const asyncStartResult = parseToolResult(asyncStart);
  send(child, {
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: {
      name: "cancel_coding_agent_job",
      arguments: {
        jobId: asyncStartResult?.jobId,
        reason: "Smoke cancel"
      }
    }
  });
  await waitForMessage(() => parseMessages(first.stdout).find((message) => message.id === 10), 3000);
  send(child, {
    jsonrpc: "2.0",
    id: 11,
    method: "tools/call",
    params: {
      name: "get_coding_agent_job",
      arguments: {
        jobId: asyncStartResult?.jobId
      }
    }
  });
  await waitForMessage(() => parseMessages(first.stdout).find((message) => message.id === 11), 3000);
  const pidCountBeforeOrphan = (await readRecordedPids(pidFile)).length;
  send(child, {
    jsonrpc: "2.0",
    id: 12,
    method: "tools/call",
    params: {
      name: "run_coding_agent",
      arguments: {
        agent: "claude",
        worktree,
        prompt: "Smoke orphan recovery",
        async: true,
        timeoutSec: 30,
        permissionProfile: "workspace_write"
      }
    }
  });
  const orphanStart = await waitForMessage(() => parseMessages(first.stdout).find((message) => message.id === 12), 3000);
  const orphanStartResult = parseToolResult(orphanStart);
  const orphanProcessPid = await waitForRecordedPid(pidFile, pidCountBeforeOrphan, 3000);
  send(child, {
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: {
      name: "get_coding_agent_job",
      arguments: {
        jobId: orphanStartResult?.jobId
      }
    }
  });
  await waitForMessage(() => parseMessages(first.stdout).find((message) => message.id === 13), 3000);
  child.kill("SIGKILL");
  await waitForExit(child, 3000);

  const second = startMcpServer({ home, binDirs, pidFile, spawn });
  send(second.child, {
    jsonrpc: "2.0",
    id: 101,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-restart", version: "0.0.0" }
    }
  });
  send(second.child, {
    jsonrpc: "2.0",
    id: 102,
    method: "tools/call",
    params: {
      name: "get_coding_agent_job",
      arguments: {
        jobId: orphanStartResult?.jobId
      }
    }
  });
  await waitForMessage(() => parseMessages(second.stdout).find((message) => message.id === 102), 3000);
  const orphanProcessKilled = orphanProcessPid
    ? await waitForPidExit(orphanProcessPid, 3000)
    : false;
  send(second.child, {
    jsonrpc: "2.0",
    id: 103,
    method: "tools/call",
    params: {
      name: "list_coding_agent_sessions",
      arguments: {
        worktree,
        includeArchived: true
      }
    }
  });
  await waitForMessage(() => parseMessages(second.stdout).find((message) => message.id === 103), 3000);
  send(second.child, {
    jsonrpc: "2.0",
    id: 104,
    method: "tools/call",
    params: {
      name: "run_coding_agent",
      arguments: {
        agent: "claude",
        worktree,
        prompt: "Smoke restart recovery followup",
        async: false,
        permissionProfile: "workspace_write"
      }
    }
  });
  await waitForMessage(() => parseMessages(second.stdout).find((message) => message.id === 104), 10_000);
  second.child.kill("SIGTERM");
  await waitForExit(second.child, 3000);

  const messages = parseMessages(first.stdout);
  const restartMessages = parseMessages(second.stdout);
  const parsedToolResults = Object.fromEntries(
    messages
      .filter((message) => message.result?.content?.[0]?.text)
      .map((message) => [message.id, JSON.parse(message.result.content[0].text)])
  );
  const parsedRestartToolResults = Object.fromEntries(
    restartMessages
      .filter((message) => message.result?.content?.[0]?.text)
      .map((message) => [message.id, JSON.parse(message.result.content[0].text)])
  );
  const init = messages.find((message) => message.id === 1);

  return {
    stderr: `${first.stderr}${second.stderr}`.trim(),
    serverVersion: init?.result?.serverInfo?.version,
    discoveryCount: parsedToolResults[3]?.agents?.length ?? 0,
    claudeDiscoveredVersion: parsedToolResults[3]?.agents?.find((agent) => agent.id === "claude")?.version,
    runStatus: parsedToolResults[4]?.status,
    adapterStatus: parsedToolResults[4]?.adapterStatus,
    providerSessionId: parsedToolResults[4]?.providerSessionId,
    availableModels: parsedToolResults[4]?.availableModels,
    failureStatus: parsedToolResults[5]?.status,
    failureError: parsedToolResults[5]?.error,
    failureMessage: parsedToolResults[5]?.message,
    failureReason: parsedToolResults[5]?.failureReason,
    agentErrors: parsedToolResults[5]?.agentErrors,
    failureProviderSessionId: parsedToolResults[5]?.providerSessionId,
    failureAvailableModels: parsedToolResults[5]?.availableModels,
    claudeStatus: parsedToolResults[6]?.status,
    claudeAdapterStatus: parsedToolResults[6]?.adapterStatus,
    claudeProviderSessionId: parsedToolResults[6]?.providerSessionId,
    cursorStatus: parsedToolResults[7]?.status,
    cursorAdapterStatus: parsedToolResults[7]?.adapterStatus,
    cursorProviderSessionId: parsedToolResults[7]?.providerSessionId,
    codexStatus: parsedToolResults[8]?.status,
    codexAdapterStatus: parsedToolResults[8]?.adapterStatus,
    codexProviderSessionId: parsedToolResults[8]?.providerSessionId,
    asyncStartStatus: parsedToolResults[9]?.status,
    asyncStartJobId: parsedToolResults[9]?.jobId,
    cancelStatus: parsedToolResults[10]?.status,
    cancelActiveProcessCancelled: parsedToolResults[10]?.activeProcessCancelled,
    cancelledJobStatus: parsedToolResults[11]?.job?.status,
    cancelledProcessStatus: parsedToolResults[11]?.job?.process?.status,
    cancelledProcessKillStatus: parsedToolResults[11]?.job?.process?.killStatus,
    orphanStartStatus: parsedToolResults[12]?.status,
    orphanStartJobId: parsedToolResults[12]?.jobId,
    orphanProcessPid,
    orphanStartRecordedProcessPid: parsedToolResults[13]?.job?.process?.pid,
    orphanRecoveredStatus: parsedRestartToolResults[102]?.job?.status,
    orphanRecoveredSummary: parsedRestartToolResults[102]?.job?.resultSummary,
    orphanRecoveredEvents: parsedRestartToolResults[102]?.job?.recentEvents?.map((event) => event.type),
    orphanRecoveredProcessKillStatus: parsedRestartToolResults[102]?.job?.process?.restartKill?.status,
    orphanProcessKilled,
    orphanRecoveredSessionStatus: parsedRestartToolResults[103]?.sessions
      ?.find((session) => session.lastJobId === parsedToolResults[12]?.jobId)?.status,
    restartFollowupStatus: parsedRestartToolResults[104]?.status,
    restartFollowupAdapterStatus: parsedRestartToolResults[104]?.adapterStatus,
    isGitRepository: parsedToolResults[4]?.worktreeState?.after?.isGitRepository
  };
}

function startMcpServer({ home, binDirs, pidFile, spawn }) {
  const state = {
    stdout: "",
    stderr: "",
    child: spawn("node", ["./mcp/server.mjs"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDirs.join(path.delimiter)}${path.delimiter}${process.env.PATH ?? ""}`,
        AGENT_DISPATCHER_SMOKE_INHERITED: "yes",
        AGENT_DISPATCHER_SMOKE_PID_FILE: pidFile
      }
    })
  };
  state.child.stdout.on("data", (chunk) => {
    state.stdout += chunk.toString();
  });
  state.child.stderr.on("data", (chunk) => {
    state.stderr += chunk.toString();
  });
  return state;
}

async function waitForMessage(getMessage, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const message = getMessage();
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

function send(child, message) {
  const body = JSON.stringify(message);
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

async function readRecordedPids(pidFile) {
  let raw = "";
  try {
    raw = await readFile(pidFile, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return raw
    .split(/\r?\n/)
    .map((value) => Number.parseInt(value, 10))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

async function waitForRecordedPid(pidFile, previousCount, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const pids = await readRecordedPids(pidFile);
    if (pids.length > previousCount) return pids[previousCount];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

async function waitForPidExit(pid, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!pidIsAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
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

async function killRecordedPids(pidFile) {
  for (const pid of await readRecordedPids(pidFile)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      continue;
    }
  }
}

function parseToolResult(message) {
  if (!message?.result?.content?.[0]?.text) return null;
  return JSON.parse(message.result.content[0].text);
}

function parseMessages(output) {
  return output
    .split("Content-Length:")
    .filter(Boolean)
    .map((part) => {
      const bodyStart = part.indexOf("\r\n\r\n");
      if (bodyStart === -1) return null;
      try {
        return JSON.parse(part.slice(bodyStart + 4));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
