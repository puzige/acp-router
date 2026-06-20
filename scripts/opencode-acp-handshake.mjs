#!/usr/bin/env node

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-acp-handshake-"));
const tempWorktree = path.join(tempRoot, "worktree");

try {
  await mkdir(tempWorktree, { recursive: true });
  await execFileAsync("git", ["-C", tempWorktree, "init", "-b", "master"]);
  const result = await handshake(tempWorktree);
  console.log(JSON.stringify(result, null, 2));
  if (!result.initialized || !result.sessionId) process.exitCode = 1;
} finally {
  await rm(tempRoot, { force: true, recursive: true });
}

async function handshake(cwd) {
  const child = spawn("opencode", ["acp", "--cwd", cwd, "--print-logs", "--log-level", "ERROR"], {
    stdio: ["pipe", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  await sleep(300);
  send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: "agent-router-smoke",
        title: "Agent Router Smoke",
        version: "0.6.7"
      }
    }
  });
  const initializeMessage = await waitForMessage(() => parseMessages(stdout).find((message) => message.id === 1), 5000);
  send(child, {
    jsonrpc: "2.0",
    id: 2,
    method: "session/new",
    params: { cwd, mcpServers: [] }
  });

  const sessionMessage = await waitForMessage(() => parseMessages(stdout).find((message) => message.id === 2), 5000);
  child.kill("SIGTERM");
  const initialize = initializeMessage?.result;
  const session = sessionMessage?.result;
  return {
    initialized: initialize?.protocolVersion === 1,
    agentInfo: initialize?.agentInfo ?? null,
    sessionId: session?.sessionId ?? null,
    sessionResult: session ?? null,
    sessionError: sessionMessage?.error ?? null,
    stderr: stderr.trim()
  };
}

function parseMessages(stdout) {
  return stdout
    .split(/\r?\n/)
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

async function waitForMessage(findMessage, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const message = findMessage();
    if (message) return message;
    await sleep(50);
  }
  return null;
}

function send(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
