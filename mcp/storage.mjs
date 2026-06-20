import fs from "node:fs/promises";
import path from "node:path";

import {
  REGISTRY_PATH,
  CONFIG_PATH,
  ACP_REGISTRY_CACHE_PATH,
  DEFAULT_ACP_REGISTRY_URL,
  COMMAND_TIMEOUT_MS,
  ACTIVE_JOB_STATUSES,
  TERMINAL_JOB_STATUSES
} from "./constants.mjs";
import { isPlainObject } from "./utils.mjs";
import { ACTIVE_RUNS } from "./jobs.mjs";

let orphanRecoveryPromise = null;

async function readConfig() {
  await ensureOrphanRecovery();
  const defaults = {
    defaultAgent: null,
    modeDefaults: {},
    disabledAgents: [],
    allowCurrentDirectory: false,
    registryEnabled: true,
    registryUrl: DEFAULT_ACP_REGISTRY_URL,
    registryCacheTtlSec: 86400,
    safety: {
      requireAbsoluteWorktree: true,
      launchExternalAgents: true,
      defaultPermissionProfile: "bypassPermissions",
      allowBypassPermissions: true,
      inheritEnvironment: true
    },
    updatedAt: null
  };
  const stored = await readJson(CONFIG_PATH, defaults);
  return {
    ...defaults,
    ...stored,
    modeDefaults: isPlainObject(stored.modeDefaults) ? stored.modeDefaults : defaults.modeDefaults,
    disabledAgents: Array.isArray(stored.disabledAgents) ? stored.disabledAgents : defaults.disabledAgents,
    registryEnabled: typeof stored.registryEnabled === "boolean" ? stored.registryEnabled : defaults.registryEnabled,
    registryUrl: typeof stored.registryUrl === "string" && stored.registryUrl.trim() ? stored.registryUrl : defaults.registryUrl,
    registryCacheTtlSec: Number.isInteger(stored.registryCacheTtlSec) ? stored.registryCacheTtlSec : defaults.registryCacheTtlSec,
    safety: {
      ...defaults.safety,
      ...(isPlainObject(stored.safety) ? stored.safety : {})
    }
  };
}

async function readRegistry() {
  await ensureOrphanRecovery();
  return readJson(REGISTRY_PATH, { jobs: {}, sessions: {} });
}

async function writeRegistry(registry) {
  await writeJson(REGISTRY_PATH, registry);
}

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
}

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function appendJsonl(filePath, entries) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lines = entries.map((entry) => JSON.stringify(entry)).join("\n");
  await fs.appendFile(filePath, `${lines}\n`, "utf8");
}

async function readJobEventLog(logPath) {
  const result = {
    events: [],
    parseErrors: [],
    note: null
  };
  if (typeof logPath !== "string" || !logPath) {
    return {
      ...result,
      note: "This job does not have a logPath recorded yet."
    };
  }
  let raw = "";
  try {
    raw = await fs.readFile(logPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        ...result,
        note: "The job log file does not exist yet."
      };
    }
    return {
      ...result,
      note: `The job log could not be read: ${error.message}`
    };
  }
  const lines = raw.split(/\r?\n/);
  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber].trim();
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      result.events.push({
        ...(isPlainObject(parsed) ? parsed : { payload: parsed }),
        eventIndex: result.events.length
      });
    } catch (error) {
      result.parseErrors.push({
        lineNumber: lineNumber + 1,
        message: error.message
      });
    }
  }
  return result;
}

async function readLogTail(logPath, byteLimit) {
  if (typeof logPath !== "string" || !logPath) {
    return {
      text: "",
      bytes: 0,
      truncated: false,
      note: "This job does not have a logPath recorded yet."
    };
  }
  try {
    const stats = await fs.stat(logPath);
    const bytesToRead = Math.min(stats.size, byteLimit);
    const handle = await fs.open(logPath, "r");
    try {
      const buffer = Buffer.alloc(bytesToRead);
      await handle.read(buffer, 0, bytesToRead, Math.max(0, stats.size - bytesToRead));
      return {
        text: buffer.toString("utf8"),
        bytes: bytesToRead,
        truncated: stats.size > bytesToRead
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        text: "",
        bytes: 0,
        truncated: false,
        note: "The job log file does not exist yet."
      };
    }
    return {
      text: "",
      bytes: 0,
      truncated: false,
      note: `The job log could not be read: ${error.message}`
    };
  }
}

async function ensureOrphanRecovery() {
  if (!orphanRecoveryPromise) {
    orphanRecoveryPromise = recoverOrphanedJobs().catch((error) => {
      orphanRecoveryPromise = null;
      throw error;
    });
  }
  return orphanRecoveryPromise;
}

async function recoverOrphanedJobs() {
  const registry = await readJson(REGISTRY_PATH, { jobs: {}, sessions: {} });
  registry.jobs = isPlainObject(registry.jobs) ? registry.jobs : {};
  registry.sessions = isPlainObject(registry.sessions) ? registry.sessions : {};
  const recoveredAt = new Date().toISOString();
  const logEntries = [];
  let recoveredCount = 0;

  for (const job of Object.values(registry.jobs)) {
    if (!isPlainObject(job)) continue;
    if (!ACTIVE_JOB_STATUSES.has(job.status) || ACTIVE_RUNS.has(job.jobId)) continue;
    const previousStatus = job.status;
    const processKill = bestEffortKillJobProcess(job, recoveredAt);
    const message = processKill?.status === "signal_sent"
      ? "Agent Router marked this job orphaned during MCP server restart recovery and sent SIGTERM to the recorded child process."
      : "Agent Router marked this job orphaned during MCP server restart recovery; the previous runner process is no longer owned by this server.";
    const event = {
      type: "orphaned",
      timestamp: recoveredAt,
      message,
      previousStatus,
      processKill
    };
    job.status = "orphaned";
    job.endedAt = job.endedAt ?? recoveredAt;
    job.orphanedAt = recoveredAt;
    job.failureReason = message;
    job.resultSummary = message;
    if (processKill && isPlainObject(job.process)) {
      job.process = {
        ...job.process,
        status: processKill.status === "signal_sent" ? "kill_requested" : "unowned",
        restartKill: processKill,
        endedAt: job.process.endedAt ?? recoveredAt
      };
    }
    job.risks = [
      processKill?.status === "signal_sent"
        ? "Agent Router sent SIGTERM to the recorded child PID during restart recovery; inspect the worktree if results look unexpected."
        : "The original agent process may have continued after the MCP server exited; inspect the worktree if results look unexpected."
    ];
    job.recentEvents = [...(Array.isArray(job.recentEvents) ? job.recentEvents : []), event];
    updateSessionAfterOrphanedJob(registry, job, recoveredAt);
    if (typeof job.logPath === "string" && job.logPath) {
      logEntries.push({
        logPath: job.logPath,
        event: {
          ...event,
          jobId: job.jobId,
          sessionId: job.sessionId,
          agentId: job.agentId
        }
      });
    }
    recoveredCount += 1;
  }

  if (recoveredCount === 0) {
    return { recoveredCount: 0 };
  }

  await writeJson(REGISTRY_PATH, registry);
  for (const entry of logEntries) {
    await appendJsonl(entry.logPath, [entry.event]);
  }
  return { recoveredCount };
}

function bestEffortKillJobProcess(job, attemptedAt) {
  const pid = normalizePid(job.process?.pid);
  if (!pid) return null;
  const result = {
    pid,
    signal: "SIGTERM",
    attemptedAt,
    status: "unknown"
  };
  try {
    process.kill(pid, "SIGTERM");
    return { ...result, status: "signal_sent" };
  } catch (error) {
    if (error.code === "ESRCH") return { ...result, status: "not_found" };
    if (error.code === "EPERM") return { ...result, status: "permission_denied" };
    return {
      ...result,
      status: "error",
      errorCode: error.code ?? null,
      errorMessage: error.message
    };
  }
}

function updateSessionAfterOrphanedJob(registry, job, recoveredAt) {
  const session = registry.sessions[job.sessionId];
  if (!isPlainObject(session)) return;
  const hasCurrentOwnedRun = Object.values(registry.jobs).some((candidate) => (
    isPlainObject(candidate)
    && candidate.sessionId === session.sessionId
    && ACTIVE_JOB_STATUSES.has(candidate.status)
    && ACTIVE_RUNS.has(candidate.jobId)
  ));
  if (hasCurrentOwnedRun) return;
  if (session.lastJobId !== job.jobId && !ACTIVE_JOB_STATUSES.has(session.status)) return;

  const canContinue = Boolean(session.providerSessionId);
  session.status = canContinue ? "idle" : "orphaned";
  session.canContinue = canContinue;
  session.updatedAt = recoveredAt;
}

async function recordJobProcess(jobId, processInfo) {
  const registry = await readRegistry();
  const job = registry.jobs[jobId];
  if (!isPlainObject(job) || TERMINAL_JOB_STATUSES.has(job.status)) return;
  const event = {
    type: "process_started",
    timestamp: processInfo.recordedAt,
    message: `Recorded external agent process pid=${processInfo.pid}.`,
    process: {
      pid: processInfo.pid,
      kind: processInfo.kind,
      command: processInfo.command
    }
  };
  job.process = {
    ...(isPlainObject(job.process) ? job.process : {}),
    ...processInfo
  };
  job.recentEvents = [...(Array.isArray(job.recentEvents) ? job.recentEvents : []), event];
  registry.jobs[job.jobId] = job;
  await writeRegistry(registry);
  await appendJsonl(job.logPath, [{
    ...event,
    jobId: job.jobId,
    sessionId: job.sessionId,
    agentId: job.agentId
  }]);
}

function normalizeProcessInfo(processInfo) {
  if (!isPlainObject(processInfo)) return null;
  const pid = normalizePid(processInfo.pid);
  if (!pid) return null;
  const now = new Date().toISOString();
  return {
    pid,
    kind: typeof processInfo.kind === "string" && processInfo.kind ? processInfo.kind : "external",
    command: typeof processInfo.command === "string" && processInfo.command ? processInfo.command : null,
    startedAt: typeof processInfo.startedAt === "string" ? processInfo.startedAt : now,
    recordedAt: now,
    status: "running"
  };
}

function normalizePid(value) {
  const pid = Number.parseInt(value, 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return pid;
}

async function readAcpRegistryCache() {
  try {
    return await readJson(ACP_REGISTRY_CACHE_PATH, null);
  } catch {
    return null;
  }
}

async function fetchAcpRegistry(registryUrl) {
  if (registryUrl.startsWith("file://")) {
    return JSON.parse(await fs.readFile(new URL(registryUrl), "utf8"));
  }
  if (path.isAbsolute(registryUrl)) {
    return JSON.parse(await fs.readFile(registryUrl, "utf8"));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), COMMAND_TIMEOUT_MS);
  try {
    const response = await fetch(registryUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`Registry fetch failed with HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function readAcpRegistry(config, { refresh = false } = {}) {
  const disabledMeta = {
    enabled: false,
    sourceUrl: config.registryUrl,
    status: "disabled",
    agentCount: 0
  };
  if (config.registryEnabled !== true) {
    return { agentsByRouterId: new Map(), meta: disabledMeta };
  }

  const now = Date.now();
  const cache = await readAcpRegistryCache();
  const ttlMs = Math.max(0, config.registryCacheTtlSec ?? 86400) * 1000;
  const cacheFresh = cache
    && cache.sourceUrl === config.registryUrl
    && Array.isArray(cache.agents)
    && !refresh
    && ttlMs > 0
    && now - Date.parse(cache.fetchedAt ?? 0) < ttlMs;
  if (cacheFresh) {
    return buildAcpRegistryResult(cache.agents, {
      enabled: true,
      status: "cached",
      sourceUrl: cache.sourceUrl,
      fetchedAt: cache.fetchedAt,
      registryVersion: cache.registryVersion ?? null,
      agentCount: cache.agents.length,
      lastError: cache.lastError ?? null
    });
  }

  try {
    const registry = await fetchAcpRegistry(config.registryUrl);
    const agents = normalizeRegistryAgents(registry);
    const fetchedAt = new Date().toISOString();
    const nextCache = {
      schemaVersion: 1,
      sourceUrl: config.registryUrl,
      fetchedAt,
      registryVersion: registry.version ?? null,
      agentCount: agents.length,
      agents,
      lastError: null
    };
    await writeJson(ACP_REGISTRY_CACHE_PATH, nextCache);
    return buildAcpRegistryResult(agents, {
      enabled: true,
      status: "fetched",
      sourceUrl: config.registryUrl,
      fetchedAt,
      registryVersion: registry.version ?? null,
      agentCount: agents.length,
      lastError: null
    });
  } catch (error) {
    if (cache?.agents?.length) {
      return buildAcpRegistryResult(cache.agents, {
        enabled: true,
        status: "stale",
        sourceUrl: cache.sourceUrl,
        fetchedAt: cache.fetchedAt,
        registryVersion: cache.registryVersion ?? null,
        agentCount: cache.agents.length,
        lastError: error.message
      });
    }
    return {
      agentsByRouterId: new Map(),
      meta: {
        enabled: true,
        status: "unavailable",
        sourceUrl: config.registryUrl,
        agentCount: 0,
        lastError: error.message
      }
    };
  }
}

function normalizeRegistryAgents(registry) {
  if (!isPlainObject(registry) || !Array.isArray(registry.agents)) {
    throw new Error("ACP registry payload must contain an agents array.");
  }
  return registry.agents.filter((agent) => (
    isPlainObject(agent)
    && typeof agent.id === "string"
    && typeof agent.name === "string"
    && isPlainObject(agent.distribution)
  ));
}

function buildAcpRegistryResult(registryAgents, meta) {
  const agentsByRouterId = new Map();
  for (const registryAgent of registryAgents) {
    const routerId = mapRegistryAgentToRouterId(registryAgent.id);
    if (!routerId) continue;
    agentsByRouterId.set(routerId, registryAgent);
  }
  return { agentsByRouterId, meta };
}

function mapRegistryAgentToRouterId(registryId) {
  const mapping = {
    "claude-acp": "claude",
    "codex-acp": "codex",
    opencode: "opencode"
  };
  return mapping[registryId] ?? null;
}

function extractRegistryNpxPackage(registryAgent) {
  const npxPackage = registryAgent.distribution?.npx?.package;
  return typeof npxPackage === "string" && npxPackage ? npxPackage : null;
}

function buildNpxAcpFallback(npxPackage) {
  return {
    launchCommand: ["npx", "--yes", npxPackage]
  };
}

function buildRegistryInstallHint(registryAgent) {
  const distribution = registryAgent.distribution;
  const npxPackage = distribution?.npx?.package;
  if (typeof npxPackage === "string" && npxPackage) {
    return `npm install -g ${npxPackage}`;
  }
  const binary = distribution?.binary;
  if (isPlainObject(binary)) {
    const platformKey = getRegistryPlatformKey();
    const target = binary[platformKey] ?? Object.values(binary).find(isPlainObject);
    if (target?.archive) return `Install ${registryAgent.name} from ${target.archive}`;
  }
  return null;
}

function getRegistryPlatformKey() {
  const osName = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch;
  return `${osName}-${arch}`;
}

export {
  readConfig,
  readRegistry,
  writeRegistry,
  readJson,
  writeJson,
  appendJsonl,
  readJobEventLog,
  readLogTail,
  ensureOrphanRecovery,
  recoverOrphanedJobs,
  bestEffortKillJobProcess,
  updateSessionAfterOrphanedJob,
  recordJobProcess,
  normalizeProcessInfo,
  normalizePid,
  readAcpRegistryCache,
  fetchAcpRegistry,
  readAcpRegistry,
  normalizeRegistryAgents,
  buildAcpRegistryResult,
  mapRegistryAgentToRouterId,
  extractRegistryNpxPackage,
  buildNpxAcpFallback,
  buildRegistryInstallHint,
  getRegistryPlatformKey
};
