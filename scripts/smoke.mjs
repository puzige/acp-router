#!/usr/bin/env node

import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

try {
  await mkdir(tempHome, { recursive: true });
  await mkdir(tempWorktree, { recursive: true });
  await mkdir(tempBin, { recursive: true });
  await execFileAsync("git", ["-C", tempWorktree, "init", "-b", "master"]);
  await createFakeOpenCode(tempBin);

  const result = await runMcpSmoke(tempHome, tempWorktree, tempBin);
  console.log(JSON.stringify(result, null, 2));

  if (
    result.stderr
    || result.serverVersion !== "0.2.1"
    || result.discoveryCount < 1
    || result.runStatus !== "completed"
    || result.adapterStatus !== "opencode_acp"
    || result.providerSessionId !== "fake-opencode-session"
    || result.failureStatus !== "timed_out"
    || !result.failureReason?.includes("Insufficient balance")
    || !result.agentErrors?.some((error) => error.includes("Rate limit exceeded"))
  ) {
    process.exitCode = 1;
  }
} finally {
  await rm(tempRoot, { force: true, recursive: true });
}

async function createFakeOpenCode(binDir) {
  const scriptPath = path.join(binDir, "opencode");
  const script = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("fake-opencode 0.0.0");
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
      write({ jsonrpc: "2.0", id: message.id, result: { sessionId: "fake-opencode-session" } });
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

async function runMcpSmoke(home, worktree, binDir) {
  const { spawn } = await import("node:child_process");
  const child = spawn("node", ["./mcp/server.mjs"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: home, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` }
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

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

  await waitForMessage(() => parseMessages(stdout).find((message) => message.id === 4), 3000);
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
  await waitForMessage(() => parseMessages(stdout).find((message) => message.id === 5), 4000);
  child.kill("SIGTERM");

  const messages = parseMessages(stdout);
  const parsedToolResults = Object.fromEntries(
    messages
      .filter((message) => message.result?.content?.[0]?.text)
      .map((message) => [message.id, JSON.parse(message.result.content[0].text)])
  );
  const init = messages.find((message) => message.id === 1);

  return {
    stderr: stderr.trim(),
    serverVersion: init?.result?.serverInfo?.version,
    discoveryCount: parsedToolResults[3]?.agents?.length ?? 0,
    runStatus: parsedToolResults[4]?.status,
    adapterStatus: parsedToolResults[4]?.adapterStatus,
    providerSessionId: parsedToolResults[4]?.providerSessionId,
    failureStatus: parsedToolResults[5]?.status,
    failureReason: parsedToolResults[5]?.failureReason,
    agentErrors: parsedToolResults[5]?.agentErrors,
    failureProviderSessionId: parsedToolResults[5]?.providerSessionId,
    isGitRepository: parsedToolResults[4]?.worktreeState?.after?.isGitRepository
  };
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
