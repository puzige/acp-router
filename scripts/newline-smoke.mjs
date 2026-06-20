#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agent-router-newline-smoke-"));
const tempHome = path.join(tempRoot, "home");
const state = {
  stdout: "",
  stderr: "",
  child: null
};

try {
  state.child = spawn("node", ["./bin/agent-router.mjs"], {
    cwd: repoRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      HOME: tempHome
    }
  });
  state.child.stdout.on("data", (chunk) => {
    state.stdout += chunk.toString();
  });
  state.child.stderr.on("data", (chunk) => {
    state.stderr += chunk.toString();
  });

  sendLine(state.child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "newline-smoke", version: "0.0.0" }
    }
  });
  sendLine(state.child, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  });

  const init = await waitForMessage(() => parseMessages(state.stdout).find((message) => message.id === 1), 3000);
  const toolsList = await waitForMessage(() => parseMessages(state.stdout).find((message) => message.id === 2), 3000);
  const toolNames = new Set(toolsList?.result?.tools?.map((tool) => tool.name) ?? []);
  const result = {
    stderr: state.stderr.trim(),
    serverVersion: init?.result?.serverInfo?.version,
    toolCount: toolsList?.result?.tools?.length ?? 0,
    usedContentLengthOutput: state.stdout.includes("Content-Length:"),
    hasDiscoverCodingAgents: toolNames.has("discover_agents"),
    hasRunCodingAgent: toolNames.has("run_agent"),
    hasTailJobEvents: toolNames.has("tail_job_events")
  };

  console.log(JSON.stringify(result, null, 2));
  if (
    result.stderr
    || result.serverVersion !== "0.7.0"
    || result.usedContentLengthOutput
    || !result.hasDiscoverCodingAgents
    || !result.hasRunCodingAgent
    || !result.hasTailJobEvents
  ) {
    process.exitCode = 1;
  }
} finally {
  if (state.child) {
    state.child.kill("SIGTERM");
    await waitForExit(state.child, 3000);
  }
  await rm(tempRoot, { force: true, recursive: true });
}

function sendLine(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
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

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]);
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
