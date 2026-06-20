#!/usr/bin/env node

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-acp-session-list-"));
  const dispatcherDataDir = path.join(tempRoot, "dispatcher-data");
  const tempWorktree = path.join(tempRoot, "worktree");
  let client = null;
  let keepArtifacts = false;

  try {
    await mkdir(dispatcherDataDir, { recursive: true });
    await mkdir(tempWorktree, { recursive: true });
    await execFileAsync("git", ["-C", tempWorktree, "init", "-b", "master"]);
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
      clientInfo: { name: "opencode-acp-session-list-smoke", version: "0.0.0" }
    });
    await client.callTool("manage_config", {
      action: "set",
      launchExternalAgents: true
    });
    const listResult = await client.callTool("manage_sessions", {
      action: "list",
      agent: "opencode",
      worktree: tempWorktree,
      includeArchived: true,
      limit: 20
    }, 20_000);
    await client.callTool("manage_config", {
      action: "set",
      launchExternalAgents: false
    });

    const opencodeNative = listResult.nativeSessionList?.agents?.find((agent) => agent.agentId === "opencode");
    const passed = listResult.nativeSessionList?.attempted === true
      && opencodeNative?.supported === true
      && Array.isArray(listResult.sessions);
    if (!passed) {
      keepArtifacts = true;
      process.exitCode = 1;
    }
    console.log(JSON.stringify({
      passed,
      serverVersion: initialize.serverInfo?.version ?? null,
      dispatcherDataDir,
      worktree: tempWorktree,
      keptArtifacts: keepArtifacts,
      nativeSessionList: listResult.nativeSessionList,
      sessionCount: listResult.sessions?.length ?? 0,
      sessions: (listResult.sessions ?? []).slice(0, 5),
      stderr: client.stderr.trim()
    }, null, 2));
  } catch (error) {
    keepArtifacts = true;
    process.exitCode = 1;
    console.log(JSON.stringify({
      passed: false,
      error: error.message,
      dispatcherDataDir,
      worktree: tempWorktree,
      keptArtifacts: true,
      stderr: client?.stderr?.trim() ?? ""
    }, null, 2));
  } finally {
    if (client) await client.stop();
    if (!keepArtifacts) await rm(tempRoot, { force: true, recursive: true });
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

await main();
