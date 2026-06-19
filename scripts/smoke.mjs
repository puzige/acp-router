#!/usr/bin/env node

import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

try {
  await mkdir(tempHome, { recursive: true });
  await mkdir(tempWorktree, { recursive: true });
  await execFileAsync("git", ["-C", tempWorktree, "init", "-b", "master"]);

  const result = await runMcpSmoke(tempHome, tempWorktree);
  console.log(JSON.stringify(result, null, 2));

  if (result.stderr || result.serverVersion !== "0.1.1" || result.discoveryCount < 1 || result.runStatus !== "completed") {
    process.exitCode = 1;
  }
} finally {
  await rm(tempRoot, { force: true, recursive: true });
}

async function runMcpSmoke(home, worktree) {
  const { spawn } = await import("node:child_process");
  const child = spawn("node", ["./mcp/server.mjs"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: home }
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
      name: "discover_coding_agents",
      arguments: { includeNotInstalled: true }
    }
  });
  send(child, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "run_coding_agent",
      arguments: {
        agent: "codex",
        worktree,
        prompt: "Smoke test only",
        async: false,
        permissionProfile: "workspace_write"
      }
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 3000));
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
    discoveryCount: parsedToolResults[2]?.agents?.length ?? 0,
    runStatus: parsedToolResults[3]?.status,
    adapterStatus: parsedToolResults[3]?.adapterStatus,
    isGitRepository: parsedToolResults[3]?.worktreeState?.isGitRepository
  };
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
