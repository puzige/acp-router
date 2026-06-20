#!/usr/bin/env node

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HANDSHAKE_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const ADAPTERS = [
  { id: "claude", executable: "claude-agent-acp", label: "Claude ACP" },
  { id: "codex", executable: "codex-acp", label: "Codex ACP" }
];

async function main() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "acp-adapter-handshake-"));
  const results = [];

  try {
    for (const adapter of ADAPTERS) {
      const worktree = path.join(tempRoot, `${adapter.id}-worktree`);
      await mkdir(worktree, { recursive: true });
      await execFileAsync("git", ["-C", worktree, "init", "-b", "master"]);
      results.push(await handshakeAdapter(adapter, worktree));
    }

    const summary = {
      passed: results.every((result) => result.passed),
      adapters: results
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.passed) process.exitCode = 1;
  } catch (error) {
    process.exitCode = 1;
    console.log(JSON.stringify({
      passed: false,
      error: error.message,
      adapters: results
    }, null, 2));
  } finally {
    await rm(tempRoot, { force: true, recursive: true });
  }
}

async function handshakeAdapter(adapter, worktree) {
  const baseline = await findAdapterProcesses(adapter.executable);
  const baselinePids = new Set(baseline.map((processInfo) => processInfo.pid));
  const client = new AcpClient({
    command: adapter.executable,
    args: [],
    cwd: worktree,
    timeoutMs: HANDSHAKE_TIMEOUT_MS
  });

  let initialize = null;
  let session = null;
  let error = null;

  try {
    await client.start();
    initialize = await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: "agent-router-acp-handshake-smoke",
        title: "Agent Router ACP Handshake Smoke",
        version: "0.6.8"
      }
    });
    session = await client.request("session/new", {
      cwd: worktree,
      mcpServers: []
    });
  } catch (caught) {
    error = caught;
  }

  const cleanup = await client.dispose();
  const leftoverProcesses = await cleanupNewAdapterProcesses(adapter.executable, baselinePids);
  const initialized = initialize?.protocolVersion === 1 || initialize?.protocolVersion === "1";
  const sessionId = typeof session?.sessionId === "string" && session.sessionId ? session.sessionId : null;
  const passed = !error && initialized && Boolean(sessionId) && leftoverProcesses.length === 0;

  return {
    agent: adapter.id,
    executable: adapter.executable,
    passed,
    initialized,
    sessionCreated: Boolean(sessionId),
    sessionId,
    agentInfo: initialize?.agentInfo ?? null,
    cleanup,
    leftoverPids: leftoverProcesses.map((processInfo) => processInfo.pid),
    error: error?.message ?? null,
    stderr: passed ? null : preview(client.stderr.trim(), 800)
  };
}

class AcpClient {
  constructor({ command, args, cwd, timeoutMs }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.stderr = "";
    this.startError = null;
  }

  async start() {
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = appendLimited(this.stderr, chunk, 100_000);
    });
    this.child.on("error", (spawnError) => {
      this.startError = spawnError;
      this.rejectPending(spawnError);
    });
    this.child.on("exit", (code, signal) => {
      this.rejectPending(new Error(`ACP adapter exited with code=${code} signal=${signal}`));
    });
    await sleep(200);
    if (this.startError) throw this.startError;
  }

  request(method, params) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.write(payload);
    });
  }

  write(payload) {
    if (!this.child?.stdin?.writable) throw new Error("ACP adapter stdin is not writable.");
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    while (true) {
      const blankPrefix = /^[\r\n]+/.exec(this.stdoutBuffer);
      if (blankPrefix) {
        this.stdoutBuffer = this.stdoutBuffer.slice(blankPrefix[0].length);
        continue;
      }
      if (/^Content-Length:/i.test(this.stdoutBuffer)) {
        const headerEnd = this.stdoutBuffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const header = this.stdoutBuffer.slice(0, headerEnd);
        const match = /^Content-Length:\s*(\d+)$/im.exec(header);
        if (!match) {
          this.rejectPending(new Error(`Malformed ACP header: ${preview(header, 120)}`));
          this.stdoutBuffer = "";
          return;
        }
        const bodyStart = headerEnd + 4;
        const bodyEnd = bodyStart + Number(match[1]);
        if (this.stdoutBuffer.length < bodyEnd) return;
        const raw = this.stdoutBuffer.slice(bodyStart, bodyEnd);
        this.stdoutBuffer = this.stdoutBuffer.slice(bodyEnd);
        this.handleMessage(raw);
        continue;
      }
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) this.handleMessage(line);
    }
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id") && (message.result || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(`${pending.method} failed: ${message.error.message ?? JSON.stringify(message.error)}`));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && Object.prototype.hasOwnProperty.call(message, "id")) {
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Unsupported client method: ${message.method}` }
      });
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async dispose() {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    if (this.child?.stdin) this.child.stdin.destroy();

    const pid = this.child?.pid ?? null;
    const cleanup = {
      pid,
      processGroup: process.platform === "win32" || !pid ? null : pid,
      termSent: false,
      killSent: false,
      exited: true
    };
    if (!pid) return cleanup;

    cleanup.termSent = signalProcessGroup(pid, "SIGTERM");
    await waitForGroupExit(pid, SHUTDOWN_TIMEOUT_MS);
    if (processGroupIsAlive(pid)) {
      cleanup.killSent = signalProcessGroup(pid, "SIGKILL");
      await waitForGroupExit(pid, SHUTDOWN_TIMEOUT_MS);
    }
    await waitForExit(this.child, 500);
    cleanup.exited = !processGroupIsAlive(pid);
    return cleanup;
  }
}

async function cleanupNewAdapterProcesses(executable, baselinePids) {
  let leftovers = await waitForNewAdapterProcessesGone(executable, baselinePids, 1_000);
  if (leftovers.length === 0) return [];

  for (const processInfo of leftovers) {
    signalProcessInfo(processInfo, "SIGTERM");
  }
  leftovers = await waitForNewAdapterProcessesGone(executable, baselinePids, SHUTDOWN_TIMEOUT_MS);
  if (leftovers.length === 0) return [];

  for (const processInfo of leftovers) {
    signalProcessInfo(processInfo, "SIGKILL");
  }
  return waitForNewAdapterProcessesGone(executable, baselinePids, SHUTDOWN_TIMEOUT_MS);
}

async function waitForNewAdapterProcessesGone(executable, baselinePids, timeoutMs) {
  const startedAt = Date.now();
  let leftovers = [];
  while (Date.now() - startedAt < timeoutMs) {
    leftovers = (await findAdapterProcesses(executable))
      .filter((processInfo) => !baselinePids.has(processInfo.pid));
    if (leftovers.length === 0) return [];
    await sleep(50);
  }
  return leftovers;
}

async function findAdapterProcesses(executable) {
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,pgid=,args="], { maxBuffer: 1_000_000 });
    return stdout
      .split(/\r?\n/)
      .map((line) => parseProcessLine(line, executable))
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseProcessLine(line, executable) {
  const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
  if (!match) return null;
  const pid = Number.parseInt(match[1], 10);
  const pgid = Number.parseInt(match[2], 10);
  const args = match[3];
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return null;
  if (!commandMentionsExecutable(args, executable)) return null;
  return { pid, pgid: Number.isFinite(pgid) ? pgid : null, args };
}

function commandMentionsExecutable(command, executable) {
  const pattern = new RegExp(`(^|[/\\s])${escapeRegExp(executable)}(\\s|$)`);
  return pattern.test(command);
}

function signalProcessInfo(processInfo, signal) {
  if (processInfo.pgid && processInfo.pgid !== process.pid) {
    try {
      process.kill(-processInfo.pgid, signal);
      return true;
    } catch {
      // Fall through to direct PID signalling.
    }
  }
  try {
    process.kill(processInfo.pid, signal);
    return true;
  } catch {
    return false;
  }
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
    return true;
  } catch {
    return false;
  }
}

async function waitForGroupExit(pid, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!processGroupIsAlive(pid)) return true;
    await sleep(50);
  }
  return !processGroupIsAlive(pid);
}

function processGroupIsAlive(pid) {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return error.code !== "ESRCH";
  }
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(timeoutMs)
  ]);
}

function appendLimited(current, chunk, maxLength) {
  if (current.length >= maxLength) return current;
  const next = `${current}${chunk}`;
  if (next.length <= maxLength) return next;
  return `${next.slice(0, maxLength)}\n[truncated]\n`;
}

function preview(value, maxLength) {
  if (!value) return null;
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

await main();
