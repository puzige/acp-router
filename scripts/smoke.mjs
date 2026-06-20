#!/usr/bin/env node

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-router-smoke-"));
const tempHome = path.join(tempRoot, "home");
const tempWorktree = path.join(tempRoot, "worktree");
const tempBin = path.join(tempRoot, "bin");
const tempOldBin = path.join(tempRoot, "old-bin");
const tempPidFile = path.join(tempRoot, "children.pid");
const tempRegistry = path.join(tempRoot, "acp-registry.json");
const tempNpxBin = path.join(tempRoot, "npx-bin");
const tempNpxAcpDir = path.join(tempRoot, "npx-acp");

try {
  await mkdir(tempHome, { recursive: true });
  await mkdir(tempWorktree, { recursive: true });
  await mkdir(tempBin, { recursive: true });
  await mkdir(tempOldBin, { recursive: true });
  await mkdir(tempNpxBin, { recursive: true });
  await mkdir(tempNpxAcpDir, { recursive: true });
  await execFileAsync("git", ["-C", tempWorktree, "init", "-b", "master"]);
  await createFakeOpenCode(tempBin);
  await createFakeClaude(tempOldBin, { version: "fake-claude 0.0.1", fail: true });
  await createFakeClaude(tempBin, { version: "fake-claude 999.0.0" });
  await createFakeAcpAgent(tempBin, {
    executable: "claude-agent-acp",
    version: "fake-claude-agent-acp 999.0.0",
    sessionId: "fake-claude-acp-session",
    message: "Fake Claude ACP completed."
  });
  await createFakeCursorAgent(tempBin);
  await createFakeCodex(tempBin);
  await createFakeAcpAgent(tempBin, {
    executable: "codex-acp",
    version: "fake-codex-acp 999.0.0",
    versionFailureCode: 2,
    sessionId: "fake-codex-acp-session",
    message: "Fake Codex ACP completed."
  });
  await writeFile(tempRegistry, JSON.stringify(createFakeRegistry(), null, 2), "utf8");
  const npxAcpScriptPath = path.join(tempNpxAcpDir, "claude-agent-acp-via-npx");
  await createFakeAcpAgent(tempNpxAcpDir, {
    executable: "claude-agent-acp-via-npx",
    version: "fake-claude-agent-acp-via-npx 0.48.0",
    sessionId: "fake-claude-acp-npx-session",
    message: "Fake Claude ACP via npx completed."
  });
  await createFakeNpxShim(tempNpxBin, npxAcpScriptPath);
  await createFakeOpenCode(tempNpxBin);
  await createFakeClaude(tempNpxBin, { version: "fake-claude 999.0.0" });
  await createFakeCodex(tempNpxBin);
  await createFakeCursorAgent(tempNpxBin);

  const result = await runMcpSmoke(tempHome, tempWorktree, [tempOldBin, tempBin], tempPidFile, tempRegistry);
  const npxResult = await runNpxFallbackSmoke(tempHome, tempWorktree, tempNpxBin, tempRegistry);
  const merged = { ...result, ...npxResult };
  console.log(JSON.stringify(merged, null, 2));

  if (
    result.stderr
    || result.serverVersion !== "0.7.0"
    || result.discoveryCount < 1
    || result.registryStatus !== "fetched"
    || result.codexRegistryId !== "codex-acp"
    || result.claudeRegistryId !== "claude-acp"
    || result.defaultLaunchExternalAgents !== true
    || result.configuredLaunchExternalAgents !== false
    || result.runStatus !== "completed"
    || result.adapterStatus !== "opencode_acp"
    || result.runLaunchExternalAgents !== true
    || result.runInheritEnvironment !== true
    || result.providerSessionId !== "fake-opencode-session"
    || result.tailStatus !== "completed"
    || result.tailEventCount !== 2
    || result.tailFirstEventIndex !== 0
    || result.tailNextEventIndex !== 1
    || result.tailHasMore !== true
    || result.tailLogTailHasText !== true
    || result.tailAfterEventCount !== 1
    || result.tailAfterFirstEventIndex !== 2
    || !result.availableModels?.some((model) => model.value === "opencode-go/glm-5.2")
    || result.failureStatus !== "timed_out"
    || !result.failureReason?.includes("Insufficient balance")
    || !result.agentErrors?.some((error) => error.includes("Rate limit exceeded"))
    || !result.agentErrors?.some((error) => error.includes("system/api_retry"))
    || !result.agentErrors?.some((error) => error.includes("error_status: 429"))
    || !result.agentErrors?.some((error) => error.includes("api_error_status: 429"))
    || !result.agentErrors?.some((error) => error.includes("authentication_failed"))
    || !result.agentErrors?.some((error) => error.includes("Not logged in"))
    || !result.failureAvailableModels?.some((model) => model.value === "opencode-go/glm-5.2")
    || result.claudeDiscoveredVersion !== "fake-claude-agent-acp 999.0.0"
    || result.codexDiscoveredVersion !== "fake-codex 999.0.0"
    || result.codexAcpVersion !== "0.16.0"
    || result.codexHasAcpProbeFailedNote !== false
    || result.claudeStatus !== "completed"
    || result.claudeAdapterStatus !== "claude_acp"
    || result.claudeProviderSessionId !== "fake-claude-acp-session"
    || result.cursorStatus !== "failed"
    || !result.cursorMessage?.includes("no ACP adapter")
    || result.codexStatus !== "completed"
    || result.codexAdapterStatus !== "codex_acp"
    || result.codexProviderSessionId !== "fake-codex-acp-session"
    || result.recordOnlyStatus !== "completed"
    || result.recordOnlyAdapterStatus !== "record_only"
    || result.recordOnlyLaunchExternalAgents !== false
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
    || result.restartFollowupAdapterStatus !== "opencode_acp"
    || npxResult.npxStderr
    || npxResult.npxClaudeStatus !== "available"
    || npxResult.npxClaudeTransport !== "acp_stdio"
    || npxResult.npxClaudeLaunchMode !== "npx"
    || npxResult.npxClaudeInstalledPath !== null
    || !Array.isArray(npxResult.npxClaudeLaunchCommand)
    || npxResult.npxClaudeLaunchCommand?.[0] !== "npx"
    || npxResult.npxClaudeLaunchCommand?.[1] !== "--yes"
    || npxResult.npxClaudeLaunchCommand?.[2] !== "@agentclientprotocol/claude-agent-acp@0.48.0"
    || !npxResult.npxClaudeNotes?.some((note) => note.includes("ACP adapter available via npx"))
    || !npxResult.npxClaudeNotes?.some((note) => note.includes("Install hint"))
    || npxResult.npxClaudeRunStatus !== "completed"
    || npxResult.npxClaudeRunAdapterStatus !== "claude_acp"
    || npxResult.npxClaudeRunProviderSessionId !== "fake-claude-acp-npx-session"
    || npxResult.npxCodexStatus !== "available"
    || npxResult.npxCodexLaunchMode !== "npx"
    || npxResult.npxOpenCodeStatus !== "available"
    || npxResult.npxOpenCodeLaunchMode !== null
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
      if (promptText.includes("Smoke async cancel") || promptText.includes("Smoke orphan recovery")) {
        if (process.env.AGENT_DISPATCHER_SMOKE_PID_FILE) {
          require("node:fs").appendFileSync(process.env.AGENT_DISPATCHER_SMOKE_PID_FILE, String(process.pid) + "\\n");
        }
        setInterval(() => {}, 1000);
        return;
      }
      if (promptText.includes("Trigger failure")) {
        write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-opencode-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Insufficient balance" } } } });
        write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-opencode-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Rate limit exceeded" } } } });
        write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "fake-opencode-session", update: { sessionUpdate: "system/api_retry", error: "rate_limit", error_status: 429, api_error_status: 429, authStatus: "authentication_failed", message: "Not logged in · Please run /login" } } });
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

async function createFakeAcpAgent(binDir, { executable, version, versionFailureCode = 0, sessionId, message }) {
  const scriptPath = path.join(binDir, executable);
  const script = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  if (${JSON.stringify(versionFailureCode)} !== 0) {
    console.error("fake version probe failure");
    process.exit(${JSON.stringify(versionFailureCode)});
  }
  console.log(${JSON.stringify(version)});
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
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      write({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, list: {} } }, agentInfo: { name: ${JSON.stringify(executable)}, version: "0.0.0" }, authMethods: [] } });
    } else if (request.method === "session/new" || request.method === "session/resume") {
      write({ jsonrpc: "2.0", id: request.id, result: { sessionId: ${JSON.stringify(sessionId)}, configOptions: [] } });
    } else if (request.method === "session/list") {
      write({ jsonrpc: "2.0", id: request.id, result: { sessions: [], nextCursor: null } });
    } else if (request.method === "session/prompt") {
      write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: ${JSON.stringify(sessionId)}, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: ${JSON.stringify(message)} } } } });
      write({ jsonrpc: "2.0", id: request.id, result: { stopReason: "end_turn" } });
    } else {
      write({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unsupported fake ACP method" } });
    }
  }
});
function write(response) {
  process.stdout.write(JSON.stringify(response) + "\\n");
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
  console.log("fake-cursor-agent 9999.0.0");
  process.exit(0);
}
if (!process.argv.includes("--print")
  || !process.argv.includes("--output-format")
  || !process.argv.includes("stream-json")
  || !process.argv.includes("--workspace")
  || !process.argv.includes("--trust")) {
  console.error("expected Cursor Agent print-mode arguments");
  process.exit(1);
}
if (process.argv.join(" ").includes("Smoke async cancel") || process.argv.join(" ").includes("Smoke orphan recovery")) {
  if (process.env.AGENT_DISPATCHER_SMOKE_PID_FILE) {
    require("node:fs").appendFileSync(process.env.AGENT_DISPATCHER_SMOKE_PID_FILE, String(process.pid) + "\\n");
  }
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({ type: "message", sessionId: "fake-cursor-session", message: "Fake Cursor Agent completed." }));
}
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

async function createFakeNpxShim(binDir, acpScriptPath) {
  const scriptPath = path.join(binDir, "npx");
  const script = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
const packageIndex = args.findIndex((a) => !a.startsWith("-"));
if (packageIndex === -1) {
  process.stderr.write("fake npx: no package specified\\n");
  process.exit(1);
}
const child = spawn(${JSON.stringify(acpScriptPath)}, [], {
  stdio: "inherit",
  env: process.env
});
child.on("exit", (code, signal) => process.exit(code ?? 1));
child.on("error", (err) => {
  process.stderr.write("fake npx: " + err.message + "\\n");
  process.exit(1);
});
`;
  await writeFile(scriptPath, script, "utf8");
  await chmod(scriptPath, 0o755);
}

function createFakeRegistry() {
  return {
    version: "1.0.0",
    agents: [
      {
        id: "claude-acp",
        name: "Claude Agent",
        version: "0.48.0",
        description: "ACP wrapper for Anthropic's Claude",
        repository: "https://github.com/agentclientprotocol/claude-agent-acp",
        license: "proprietary",
        distribution: {
          npx: { package: "@agentclientprotocol/claude-agent-acp@0.48.0" }
        },
        icon: "https://cdn.agentclientprotocol.com/registry/v1/latest/claude-acp.svg"
      },
      {
        id: "codex-acp",
        name: "Codex CLI",
        version: "0.16.0",
        description: "ACP adapter for OpenAI's coding assistant",
        repository: "https://github.com/zed-industries/codex-acp",
        license: "Apache-2.0",
        distribution: {
          npx: { package: "@zed-industries/codex-acp@0.16.0" }
        }
      }
    ],
    extensions: []
  };
}

async function runMcpSmoke(home, worktree, binDirs, pidFile, registryPath) {
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
    id: 20,
    method: "tools/call",
    params: {
      name: "manage_config",
      arguments: { action: "get" }
    }
  });
  await waitForMessage(() => parseMessages(first.stdout).find((message) => message.id === 20), 3000);
  send(child, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "manage_config",
      arguments: {
        action: "set",
        launchExternalAgents: false,
        registryUrl: registryPath,
        registryCacheTtlSec: 0
      }
    }
  });
  await waitForMessage(() => parseMessages(first.stdout).find((message) => message.id === 2), 3000);
  send(child, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "discover_agents",
      arguments: { includeNotInstalled: true }
    }
  });
  send(child, {
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "run_agent",
      arguments: {
        agent: "opencode",
        worktree,
        prompt: "Smoke test only",
        async: false,
        launchExternalAgents: true,
        permissionProfile: "workspace_write"
      }
    }
  });

  const runMessage = await waitForMessage(() => parseMessages(first.stdout).find((message) => message.id === 4), 10_000);
  const runResult = parseToolResult(runMessage);
  send(child, {
    jsonrpc: "2.0",
    id: 41,
    method: "tools/call",
    params: {
      name: "tail_job_events",
      arguments: {
        jobId: runResult?.jobId,
        limit: 2,
        includeLogTail: true,
        logTailBytes: 512
      }
    }
  });
  await waitForMessage(() => parseMessages(first.stdout).find((message) => message.id === 41), 3000);
  send(child, {
    jsonrpc: "2.0",
    id: 42,
    method: "tools/call",
    params: {
      name: "tail_job_events",
      arguments: {
        jobId: runResult?.jobId,
        afterEventIndex: 1,
        limit: 1
      }
    }
  });
  await waitForMessage(() => parseMessages(first.stdout).find((message) => message.id === 42), 3000);
  send(child, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: {
      name: "run_agent",
      arguments: {
        agent: "opencode",
        worktree,
        prompt: "Trigger failure: insufficient balance",
        async: false,
        launchExternalAgents: true,
        timeoutSec: 1,
        permissionProfile: "workspace_write"
      }
    }
  });
  await waitForMessage(() => parseMessages(first.stdout).find((message) => message.id === 5), 8000);
  send(child, {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: {
      name: "run_agent",
      arguments: {
        agent: "claude",
        worktree,
        prompt: "Smoke test Claude ACP",
        async: false,
        launchExternalAgents: true,
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
      name: "run_agent",
      arguments: {
        agent: "cursor-agent",
        worktree,
        prompt: "Smoke test Cursor Agent CLI",
        async: false,
        launchExternalAgents: true,
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
      name: "run_agent",
      arguments: {
        agent: "codex",
        worktree,
        prompt: "Smoke test Codex CLI",
        async: false,
        launchExternalAgents: true,
        permissionProfile: "workspace_write"
      }
    }
  });
  await waitForMessage(() => parseMessages(first.stdout).find((message) => message.id === 8), 10_000);
  send(child, {
    jsonrpc: "2.0",
    id: 90,
    method: "tools/call",
    params: {
      name: "run_agent",
      arguments: {
        agent: "cursor-agent",
        worktree,
        prompt: "Smoke record-only override",
        async: false,
        launchExternalAgents: false,
        permissionProfile: "workspace_write"
      }
    }
  });
  await waitForMessage(() => parseMessages(first.stdout).find((message) => message.id === 90), 3000);
  send(child, {
    jsonrpc: "2.0",
    id: 9,
    method: "tools/call",
    params: {
      name: "run_agent",
      arguments: {
        agent: "opencode",
        worktree,
        prompt: "Smoke async cancel",
        async: true,
        launchExternalAgents: true,
        timeoutSec: 30,
        permissionProfile: "workspace_write"
      }
    }
  });
  const asyncStart = await waitForMessage(() => parseMessages(first.stdout).find((message) => message.id === 9), 10_000);
  const asyncStartResult = parseToolResult(asyncStart);
  send(child, {
    jsonrpc: "2.0",
    id: 10,
    method: "tools/call",
    params: {
      name: "cancel_job",
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
      name: "get_job",
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
      name: "run_agent",
      arguments: {
        agent: "opencode",
        worktree,
        prompt: "Smoke orphan recovery",
        async: true,
        launchExternalAgents: true,
        timeoutSec: 30,
        permissionProfile: "workspace_write"
      }
    }
  });
  const orphanStart = await waitForMessage(() => parseMessages(first.stdout).find((message) => message.id === 12), 10_000);
  const orphanStartResult = parseToolResult(orphanStart);
  const orphanProcessPid = await waitForRecordedPid(pidFile, pidCountBeforeOrphan, 3000);
  send(child, {
    jsonrpc: "2.0",
    id: 13,
    method: "tools/call",
    params: {
      name: "get_job",
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
      name: "get_job",
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
      name: "manage_sessions",
      arguments: {
        action: "list",
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
      name: "run_agent",
      arguments: {
        agent: "opencode",
        worktree,
        prompt: "Smoke restart recovery followup",
        async: false,
        launchExternalAgents: true,
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
    registryStatus: parsedToolResults[3]?.registry?.status,
    codexRegistryId: parsedToolResults[3]?.agents?.find((agent) => agent.id === "codex")?.registry?.id,
    claudeRegistryId: parsedToolResults[3]?.agents?.find((agent) => agent.id === "claude")?.registry?.id,
    defaultLaunchExternalAgents: parsedToolResults[20]?.config?.safety?.launchExternalAgents,
    configuredLaunchExternalAgents: parsedToolResults[2]?.config?.safety?.launchExternalAgents,
    claudeDiscoveredVersion: parsedToolResults[3]?.agents?.find((agent) => agent.id === "claude")?.version,
    runStatus: parsedToolResults[4]?.status,
    adapterStatus: parsedToolResults[4]?.adapterStatus,
    runLaunchExternalAgents: parsedToolResults[4]?.launchExternalAgents,
    runInheritEnvironment: parsedToolResults[4]?.inheritEnvironment,
    providerSessionId: parsedToolResults[4]?.providerSessionId,
    tailStatus: parsedToolResults[41]?.status,
    tailEventCount: parsedToolResults[41]?.events?.length,
    tailFirstEventIndex: parsedToolResults[41]?.events?.[0]?.eventIndex,
    tailNextEventIndex: parsedToolResults[41]?.nextEventIndex,
    tailHasMore: parsedToolResults[41]?.hasMore,
    tailLogTailHasText: typeof parsedToolResults[41]?.logTail?.text === "string"
      && parsedToolResults[41].logTail.text.length > 0,
    tailAfterEventCount: parsedToolResults[42]?.events?.length,
    tailAfterFirstEventIndex: parsedToolResults[42]?.events?.[0]?.eventIndex,
    availableModels: parsedToolResults[4]?.availableModels,
    codexDiscoveredVersion: parsedToolResults[3]?.agents?.find((agent) => agent.id === "codex")?.version,
    codexAcpVersion: parsedToolResults[3]?.agents?.find((agent) => agent.id === "codex")?.acp?.version,
    codexHasAcpProbeFailedNote: parsedToolResults[3]?.agents?.find((agent) => agent.id === "codex")?.notes
      ?.some((note) => note.includes("ACP version probe failed")),
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
    claudeFailureReason: parsedToolResults[6]?.failureReason,
    claudeMessage: parsedToolResults[6]?.message,
    cursorStatus: parsedToolResults[7]?.status,
    cursorAdapterStatus: parsedToolResults[7]?.adapterStatus,
    cursorProviderSessionId: parsedToolResults[7]?.providerSessionId,
    cursorFailureReason: parsedToolResults[7]?.failureReason,
    cursorAgentErrors: parsedToolResults[7]?.agentErrors,
    cursorMessage: parsedToolResults[7]?.message,
    codexStatus: parsedToolResults[8]?.status,
    codexAdapterStatus: parsedToolResults[8]?.adapterStatus,
    codexProviderSessionId: parsedToolResults[8]?.providerSessionId,
    codexFailureReason: parsedToolResults[8]?.failureReason,
    codexMessage: parsedToolResults[8]?.message,
    recordOnlyStatus: parsedToolResults[90]?.status,
    recordOnlyAdapterStatus: parsedToolResults[90]?.adapterStatus,
    recordOnlyLaunchExternalAgents: parsedToolResults[90]?.launchExternalAgents,
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

async function runNpxFallbackSmoke(home, worktree, npxBin, registryPath) {
  const { spawn } = await import("node:child_process");
  const npxDataDir = path.join(home, "npx-data");
  await mkdir(npxDataDir, { recursive: true });
  await writeFile(path.join(npxDataDir, "config.json"), JSON.stringify({
    defaultAgent: null,
    modeDefaults: {},
    disabledAgents: [],
    allowCurrentDirectory: false,
    registryEnabled: true,
    registryUrl: registryPath,
    registryCacheTtlSec: 0,
    safety: {
      launchExternalAgents: true,
      allowBypassPermissions: false,
      inheritEnvironment: true,
      defaultPermissionProfile: "workspace_write"
    },
    updatedAt: new Date().toISOString()
  }), "utf8");

  const nodeBinDir = path.dirname(process.execPath);
  const minimalPath = [npxBin, nodeBinDir, "/usr/bin", "/bin"].join(path.delimiter);
  const state = {
    stdout: "",
    stderr: "",
    child: spawn("node", ["./bin/agent-router.mjs"], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HOME: home,
        AGENT_ROUTER_DATA_DIR: npxDataDir,
        PATH: minimalPath,
        AGENT_DISPATCHER_SMOKE_INHERITED: "yes"
      }
    })
  };
  state.child.stdout.on("data", (chunk) => {
    state.stdout += chunk.toString();
  });
  state.child.stderr.on("data", (chunk) => {
    state.stderr += chunk.toString();
  });

  send(state.child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-npx", version: "0.0.0" }
    }
  });
  send(state.child, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "discover_agents",
      arguments: { includeNotInstalled: true }
    }
  });
  await waitForMessage(() => parseMessages(state.stdout).find((message) => message.id === 2), 5000);
  send(state.child, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "run_agent",
      arguments: {
        agent: "claude",
        worktree,
        prompt: "Smoke npx fallback",
        async: false,
        launchExternalAgents: true,
        permissionProfile: "workspace_write"
      }
    }
  });
  await waitForMessage(() => parseMessages(state.stdout).find((message) => message.id === 3), 15_000);
  state.child.kill("SIGTERM");
  await waitForExit(state.child, 3000);

  const messages = parseMessages(state.stdout);
  const parsed = Object.fromEntries(
    messages
      .filter((message) => message.result?.content?.[0]?.text)
      .map((message) => [message.id, JSON.parse(message.result.content[0].text)])
  );
  const claudeAgent = parsed[2]?.agents?.find((agent) => agent.id === "claude");
  const codexAgent = parsed[2]?.agents?.find((agent) => agent.id === "codex");
  const opencodeAgent = parsed[2]?.agents?.find((agent) => agent.id === "opencode");

  return {
    npxStderr: state.stderr.trim(),
    npxClaudeStatus: claudeAgent?.status,
    npxClaudeTransport: claudeAgent?.transport,
    npxClaudeLaunchMode: claudeAgent?.acp?.launchMode,
    npxClaudeInstalledPath: claudeAgent?.acp?.installedPath,
    npxClaudeLaunchCommand: claudeAgent?.acp?.launchCommand,
    npxClaudeNotes: claudeAgent?.notes,
    npxClaudeRunStatus: parsed[3]?.status,
    npxClaudeRunAdapterStatus: parsed[3]?.adapterStatus,
    npxClaudeRunProviderSessionId: parsed[3]?.providerSessionId,
    npxCodexStatus: codexAgent?.status,
    npxCodexLaunchMode: codexAgent?.acp?.launchMode,
    npxOpenCodeStatus: opencodeAgent?.status,
    npxOpenCodeLaunchMode: opencodeAgent?.acp?.launchMode ?? null
  };
}

function startMcpServer({ home, binDirs, pidFile, spawn }) {
  const state = {
    stdout: "",
    stderr: "",
    child: spawn("node", ["./bin/agent-router.mjs"], {
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
  child.stdin.write(`${JSON.stringify(message)}\n`);
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
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
