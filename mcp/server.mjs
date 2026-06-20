#!/usr/bin/env node

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const SERVER_NAME = "agent-router";
const SERVER_VERSION = "0.7.0";
const DATA_DIR = process.env.AGENT_ROUTER_DATA_DIR
  ? path.resolve(process.env.AGENT_ROUTER_DATA_DIR)
  : path.join(os.homedir(), ".agent-router");
const REGISTRY_PATH = path.join(DATA_DIR, "registry.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const ACP_REGISTRY_CACHE_PATH = path.join(DATA_DIR, "acp-registry-cache.json");
const LOG_DIR = path.join(DATA_DIR, "logs");
const DEFAULT_ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const COMMAND_TIMEOUT_MS = 3000;
const ACP_STARTUP_DELAY_MS = 300;
const execFileAsync = promisify(execFile);
const ACTIVE_RUNS = new Map();
const ACTIVE_JOB_STATUSES = new Set(["queued", "starting", "running"]);
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out", "orphaned"]);
let orphanRecoveryPromise = null;

const MAX_RECURSION_DEPTH = 3;

const BUILT_IN_AGENTS = [
  {
    id: "opencode",
    displayName: "OpenCode",
    executable: "opencode",
    versionArgs: ["--version"],
    transport: "acp_stdio",
    command: "opencode acp --cwd <worktree>",
    acp: {
      executable: "opencode",
      versionArgs: ["--version"],
      adapterStatus: "opencode_acp",
      label: "OpenCode ACP",
      buildArgsKey: "opencode",
      buildArgs: ({ worktree }) => ["acp", "--cwd", worktree, "--print-logs", "--log-level", "ERROR"]
    },
    capabilities: ["session_list", "session_continue", "file_edit", "shell", "diff_collection"],
    source: ["path", "registry"],
    notes: ["Native ACP adapter target for V1."]
  },
  {
    id: "cursor-agent",
    displayName: "Cursor Agent",
    executable: "agent",
    versionArgs: ["--version"],
    transport: "cli",
    command: "agent --print --output-format stream-json --workspace <worktree> --trust <prompt>",
    capabilities: ["file_edit", "shell", "diff_collection"],
    source: ["path"],
    notes: ["CLI fallback target; sessions are dispatcher-managed until an ACP adapter is available."]
  },
  {
    id: "claude",
    displayName: "Claude Code",
    executable: "claude",
    versionArgs: ["--version"],
    transport: "cli",
    command: "claude -p --output-format stream-json",
    acp: {
      executable: "claude-agent-acp",
      versionArgs: ["--version"],
      adapterStatus: "claude_acp",
      label: "Claude Agent ACP",
      buildArgsKey: "claude-agent-acp",
      buildArgs: () => []
    },
    capabilities: ["file_edit", "shell", "permission_modes", "diff_collection"],
    source: ["path"],
    notes: ["ACP adapter preferred when claude-agent-acp is installed; otherwise CLI fallback target."]
  },
  {
    id: "codex",
    displayName: "Codex CLI",
    executable: "codex",
    versionArgs: ["--version"],
    transport: "cli",
    command: "codex exec",
    acp: {
      executable: "codex-acp",
      versionArgs: ["--version"],
      adapterStatus: "codex_acp",
      label: "Codex ACP",
      buildArgsKey: "codex-acp",
      buildArgs: () => []
    },
    capabilities: ["file_edit", "shell", "diff_collection"],
    source: ["path"],
    notes: ["ACP adapter preferred when codex-acp is installed. Use cautiously to avoid recursive control loops; require an isolated worktree."]
  }
];

async function discoverAgents(args) {
  const config = await readConfig();
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const acpRegistry = await readAcpRegistry(config, { refresh: args.refresh === true });
  const agents = await Promise.all(BUILT_IN_AGENTS.map(async (agent) => enrichAgentWithRegistry(
    await probeAgent(agent, config, pathEntries),
    acpRegistry
  )));
  const filteredAgents = args.includeNotInstalled === false
    ? agents.filter((agent) => agent.status !== "not_installed")
    : agents;
  const recommended = chooseAgent(agents, config, null);
  return {
    agents: filteredAgents,
    recommendedDefaultAgent: recommended.agentId
      ? { agentId: recommended.agentId, reason: recommended.reason }
      : null,
    registry: acpRegistry.meta,
    refreshedAt: new Date().toISOString()
  };
}

async function configureDispatcher(args) {
  const existing = await readConfig();
  const nextSafety = {
    ...existing.safety,
    launchExternalAgents: typeof args.launchExternalAgents === "boolean"
      ? args.launchExternalAgents
      : existing.safety.launchExternalAgents,
    allowBypassPermissions: typeof args.allowBypassPermissions === "boolean"
      ? args.allowBypassPermissions
      : existing.safety.allowBypassPermissions,
    inheritEnvironment: typeof args.inheritEnvironment === "boolean"
      ? args.inheritEnvironment
      : existing.safety.inheritEnvironment
  };
  const next = {
    ...existing,
    defaultAgent: Object.prototype.hasOwnProperty.call(args, "defaultAgent")
      ? args.defaultAgent
      : existing.defaultAgent,
    modeDefaults: {
      ...existing.modeDefaults,
      ...(isPlainObject(args.modeDefaults) ? args.modeDefaults : {})
    },
    disabledAgents: Array.isArray(args.disabledAgents)
      ? Array.from(new Set(args.disabledAgents.filter((value) => typeof value === "string" && value.trim())))
      : existing.disabledAgents,
    allowCurrentDirectory: typeof args.allowCurrentDirectory === "boolean"
      ? args.allowCurrentDirectory
      : existing.allowCurrentDirectory,
    registryEnabled: typeof args.registryEnabled === "boolean"
      ? args.registryEnabled
      : existing.registryEnabled,
    registryUrl: typeof args.registryUrl === "string" && args.registryUrl.trim()
      ? args.registryUrl.trim()
      : existing.registryUrl,
    registryCacheTtlSec: Number.isInteger(args.registryCacheTtlSec)
      ? args.registryCacheTtlSec
      : existing.registryCacheTtlSec,
    safety: nextSafety,
    updatedAt: new Date().toISOString()
  };
  await writeJson(CONFIG_PATH, next);
  return { config: next };
}

async function createJob(args) {
  const recursionDepth = Number.parseInt(process.env.AGENT_ROUTER_DEPTH ?? "0", 10) || 0;
  if (recursionDepth >= MAX_RECURSION_DEPTH) {
    return {
      status: "failed",
      error: "recursion_limit",
      message: `Agent Router recursion limit reached (depth=${recursionDepth}). This prevents infinite agent dispatch loops.`
    };
  }

  const worktreeCheck = await validateWorktree(args.worktree);
  if (!worktreeCheck.ok) {
    return {
      status: "failed",
      error: worktreeCheck.reason,
      message: "V1 requires an existing absolute worktree path before dispatching an external agent."
    };
  }

  const config = await readConfig();
  const registry = await readRegistry();
  const mode = args.mode ?? "implementation";
  const permissionProfile = args.permissionProfile ?? config.safety.defaultPermissionProfile;
  if (permissionProfile === "bypass_permissions" && !config.safety.allowBypassPermissions) {
    return {
      status: "failed",
      error: "bypass_permissions_disabled",
      message: "The Agent Router config does not allow bypass_permissions by default."
    };
  }

  const availableAgents = await discoverAgents({ includeNotInstalled: false }).then((value) => value.agents);
  const selected = args.agent
    ? { agentId: args.agent, reason: "agent explicitly requested" }
    : chooseAgent(availableAgents, config, mode);
  if (!selected.agentId) {
    return {
      status: "failed",
      error: "no_available_agent",
      message: "No available agent was configured or discovered. Use discover_coding_agents first."
    };
  }
  const selectedAgent = availableAgents.find((agent) => agent.id === selected.agentId);
  if (!selectedAgent || selectedAgent.status !== "available") {
    return {
      status: "failed",
      error: "agent_unavailable",
      agentId: selected.agentId,
      message: "The requested agent is not currently available. Use discover_coding_agents to inspect status."
    };
  }

  const activeConflict = findActiveWorktreeJob(registry, args.worktree, permissionProfile);
  if (activeConflict) {
    return {
      status: "failed",
      error: "worktree_locked",
      jobId: activeConflict.jobId,
      message: "Another writable Agent Router job is already active for this worktree."
    };
  }

  const now = new Date().toISOString();
  const jobId = createId("job");
  const sessionId = args.sessionId || createId(`sess_${selected.agentId}`);
  const logPath = path.join(LOG_DIR, `${jobId}.jsonl`);
  const worktreeState = args.collectDiff === false
    ? { skipped: true, reason: "collectDiff disabled" }
    : await collectWorktreeState(args.worktree);
  const launchingEnabled = resolveBooleanOverride(args.launchExternalAgents, config.safety.launchExternalAgents);
  const inheritEnvironment = resolveBooleanOverride(args.inheritEnvironment, config.safety.inheritEnvironment);
  const agentEnv = safeEnv({ inheritEnvironment });
  const asyncRequested = args.async !== false;
  if (launchingEnabled && !isAcpRunReady(selectedAgent)) {
    return {
      status: "failed",
      error: "acp_required",
      agentId: selected.agentId,
      message: buildAcpUnavailableError(selectedAgent)
    };
  }
  const launchPlan = planLaunch({ launchingEnabled, selectedAgent });
  const adapterStatus = launchPlan.adapterStatus;
  const initialStatus = launchPlan.runnable ? "running" : launchPlan.status;
  const initialSummary = launchPlan.summary;
  const initialRisks = launchPlan.risks;
  const recentEvents = [
    {
      type: "job_created",
      timestamp: now,
      message: "Job recorded in local Agent Router registry."
    },
    {
      type: adapterStatus,
      timestamp: now,
      message: initialSummary
    }
  ];
  const session = registry.sessions[sessionId] ?? {
    sessionId,
    providerSessionId: null,
    agentId: selected.agentId,
    title: preview(args.prompt, 60),
    status: "idle",
    worktree: args.worktree,
    createdAt: now,
    updatedAt: now,
    lastJobId: null,
    source: "dispatcher_registry",
    canContinue: true
  };

  const job = {
    jobId,
    sessionId,
    agentId: selected.agentId,
    status: initialStatus,
    worktree: args.worktree,
    mode,
    permissionProfile,
    collectDiff: args.collectDiff !== false,
    promptPreview: preview(args.prompt, 160),
    promptHash: await hashText(args.prompt),
    startedAt: now,
    endedAt: initialStatus === "running" ? null : now,
    timeoutSec: args.timeoutSec ?? 3600,
    metadata: isPlainObject(args.metadata) ? args.metadata : {},
    recursionDepth,
    resultSummary: initialSummary,
    changedFiles: [],
    validation: [],
    risks: initialRisks,
    logPath,
    adapterStatus,
    launchExternalAgents: launchingEnabled,
    inheritEnvironment,
    selectionReason: selected.reason,
    worktreeState,
    recentEvents
  };

  session.updatedAt = now;
  session.lastJobId = jobId;
  registry.sessions[sessionId] = session;
  registry.jobs[jobId] = job;
  await writeRegistry(registry);
  await appendJsonl(logPath, recentEvents.map((event) => ({ ...event, jobId, sessionId, agentId: selected.agentId })));

  if (launchPlan.runnable) {
    const runRequest = {
      args,
      job,
      session,
      selectedAgent,
      timeoutSec: args.timeoutSec ?? 3600,
      agentEnv,
      launchKind: launchPlan.kind
    };
    if (asyncRequested) {
      startBackgroundJobRun(runRequest);
    } else {
      await executeAndPersistJobRun(runRequest);
      const updatedRegistry = await readRegistry();
      Object.assign(job, updatedRegistry.jobs[jobId] ?? job);
      Object.assign(session, updatedRegistry.sessions[sessionId] ?? session);
    }
  }

  return {
    jobId,
    sessionId,
    agentId: selected.agentId,
    status: job.status,
    worktree: args.worktree,
    startedAt: now,
    endedAt: job.endedAt,
    summary: job.resultSummary,
    changedFiles: job.changedFiles,
    validation: job.validation,
    risks: job.risks,
    logPath,
    worktreeState: job.worktreeState,
    adapterStatus: job.adapterStatus,
    providerSessionId: session.providerSessionId,
    stopReason: job.stopReason,
    failureReason: job.failureReason ?? null,
    agentErrors: job.agentErrors ?? [],
    availableModels: job.availableModels ?? session.availableModels ?? [],
    agentConfigOptions: job.agentConfigOptions ?? session.agentConfigOptions ?? [],
    launchExternalAgents: job.launchExternalAgents,
    inheritEnvironment: job.inheritEnvironment,
    selectionReason: selected.reason,
    message: `${selected.agentId} job recorded by Agent Router alpha. Use get_coding_agent_job to inspect it.`
  };
}

function startBackgroundJobRun(runRequest) {
  executeAndPersistJobRun(runRequest).catch(async (error) => {
    await markJobRunCrashed(runRequest, error);
  });
}

async function executeAndPersistJobRun({ args, job, session, selectedAgent, timeoutSec, agentEnv, launchKind }) {
  const controller = createRunController(job.jobId);
  ACTIVE_RUNS.set(job.jobId, controller);
  try {
    if (launchKind !== "acp_stdio") {
      throw new Error(`Unsupported launch kind: ${launchKind}. ACP is required and CLI fallback has been removed.`);
    }
    const runResult = await runAcpStdioJob({
      args,
      job,
      session,
      selectedAgent,
      timeoutSec,
      agentEnv,
      controller
    });
    await persistJobRunResult({ job, session, selectedAgent, runResult });
  } finally {
    ACTIVE_RUNS.delete(job.jobId);
  }
}

function createRunController(jobId) {
  return {
    jobId,
    cancelRequested: false,
    cancelReason: null,
    cancelProcess: null,
    processInfo: null,
    async recordProcess(processInfo) {
      const normalized = normalizeProcessInfo(processInfo);
      if (!normalized) return;
      this.processInfo = normalized;
      await recordJobProcess(this.jobId, normalized);
    },
    cancel(reason) {
      this.cancelRequested = true;
      this.cancelReason = reason || "Cancelled by Agent Router caller.";
      if (typeof this.cancelProcess === "function") {
        return Boolean(this.cancelProcess());
      }
      return false;
    }
  };
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

async function persistJobRunResult({ job, session, selectedAgent, runResult }) {
  const registry = await readRegistry();
  const currentJob = registry.jobs[job.jobId] ?? job;
  const currentSession = registry.sessions[session.sessionId] ?? session;
  const jobPatch = currentJob.status === "cancelled" && runResult.jobPatch.status !== "cancelled"
    ? {
      ...runResult.jobPatch,
      status: "cancelled",
      endedAt: currentJob.endedAt ?? runResult.jobPatch.endedAt,
      resultSummary: currentJob.resultSummary ?? "Cancelled by Agent Router caller.",
      risks: currentJob.risks ?? []
    }
    : runResult.jobPatch;
  const processRecord = isPlainObject(currentJob.process) ? { ...currentJob.process } : null;
  Object.assign(currentJob, jobPatch);
  if (processRecord) {
    currentJob.process = {
      ...processRecord,
      status: currentJob.status,
      endedAt: processRecord.endedAt ?? currentJob.endedAt ?? new Date().toISOString()
    };
  }
  Object.assign(currentSession, runResult.sessionPatch);
  currentJob.recentEvents = [...(currentJob.recentEvents ?? []), ...runResult.events];
  currentSession.updatedAt = currentJob.endedAt;
  currentSession.lastJobId = currentJob.jobId;
  registry.jobs[currentJob.jobId] = currentJob;
  registry.sessions[currentSession.sessionId] = currentSession;
  await writeRegistry(registry);
  await appendJsonl(currentJob.logPath, runResult.events.map((event) => ({
    ...event,
    jobId: currentJob.jobId,
    sessionId: currentJob.sessionId,
    agentId: selectedAgent.id
  })));
}

async function markJobRunCrashed(runRequest, error) {
  ACTIVE_RUNS.delete(runRequest.job.jobId);
  const failedAt = new Date().toISOString();
  const message = `Agent Router runner crashed: ${error.message}`;
  const runResult = {
    events: [
      {
        type: "dispatcher_runner_error",
        timestamp: failedAt,
        message,
        errorMessage: error.message
      }
    ],
    sessionPatch: {
      status: "idle",
      canContinue: Boolean(runRequest.session.providerSessionId)
    },
    jobPatch: {
      status: "failed",
      endedAt: failedAt,
      failureReason: message,
      resultSummary: message,
      risks: ["Inspect the job log before re-running the agent."]
    }
  };
  await persistJobRunResult({
    job: runRequest.job,
    session: runRequest.session,
    selectedAgent: runRequest.selectedAgent,
    runResult
  });
}

async function listJobs(args) {
  const registry = await readRegistry();
  const limit = args.limit ?? 50;
  const jobs = Object.values(registry.jobs)
    .filter((job) => !args.status || job.status === args.status)
    .filter((job) => !args.agent || job.agentId === args.agent)
    .filter((job) => !args.worktree || job.worktree === args.worktree)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, limit);
  return { jobs };
}

async function getJob(args) {
  const registry = await readRegistry();
  const job = registry.jobs[args.jobId];
  if (!job) return { jobId: args.jobId, status: "not_found" };
  return { job };
}

async function tailJobEvents(args) {
  const registry = await readRegistry();
  const job = registry.jobs[args.jobId];
  if (!job) {
    return {
      jobId: args.jobId,
      status: "not_found",
      events: [],
      nextEventIndex: null,
      hasMore: false,
      note: "No Agent Router job exists for this jobId."
    };
  }

  const limit = clampInteger(args.limit, 50, 1, 200);
  const afterEventIndex = Number.isInteger(args.afterEventIndex) ? args.afterEventIndex : null;
  const startIndex = afterEventIndex == null ? 0 : afterEventIndex + 1;
  const eventLog = await readJobEventLog(job.logPath);
  const totalEvents = eventLog.events.length;
  const events = eventLog.events.slice(startIndex, startIndex + limit);
  const lastReturned = events.length > 0
    ? events[events.length - 1].eventIndex
    : afterEventIndex;
  const result = {
    jobId: job.jobId,
    status: job.status,
    agentId: job.agentId,
    sessionId: job.sessionId,
    adapterStatus: job.adapterStatus ?? null,
    providerSessionId: registry.sessions[job.sessionId]?.providerSessionId ?? null,
    failureReason: job.failureReason ?? null,
    changedFiles: Array.isArray(job.changedFiles) ? job.changedFiles : [],
    risks: Array.isArray(job.risks) ? job.risks : [],
    startedAt: job.startedAt ?? null,
    endedAt: job.endedAt ?? null,
    logPath: job.logPath ?? null,
    events,
    nextEventIndex: lastReturned,
    hasMore: startIndex + events.length < totalEvents,
    totalEventCount: totalEvents
  };
  if (eventLog.note) result.note = eventLog.note;
  if (eventLog.parseErrors.length > 0) result.parseErrors = eventLog.parseErrors;
  if (args.includeLogTail === true) {
    result.logTail = await readLogTail(job.logPath, clampInteger(args.logTailBytes, 8192, 1, 65536));
  }
  return result;
}

async function cancelJob(args) {
  const registry = await readRegistry();
  const job = registry.jobs[args.jobId];
  if (!job) return { jobId: args.jobId, status: "not_found" };
  let activeProcessCancelled = false;
  let activeProcessInfo = null;
  if (!TERMINAL_JOB_STATUSES.has(job.status)) {
    const activeRun = ACTIVE_RUNS.get(job.jobId);
    if (activeRun) {
      activeProcessInfo = activeRun.processInfo;
      activeProcessCancelled = activeRun.cancel(args.reason || "Cancelled by Agent Router caller.");
    }
    job.status = "cancelled";
    job.endedAt = new Date().toISOString();
    job.resultSummary = args.reason || "Cancelled by Agent Router caller.";
    if (isPlainObject(job.process) || isPlainObject(activeProcessInfo)) {
      job.process = {
        ...(isPlainObject(job.process) ? job.process : {}),
        ...(isPlainObject(activeProcessInfo) ? activeProcessInfo : {}),
        status: "cancelled",
        killSignal: "SIGTERM",
        killRequestedAt: job.endedAt,
        killStatus: activeProcessCancelled ? "signal_sent" : "not_owned_by_current_server"
      };
    }
    job.recentEvents = [
      ...(job.recentEvents ?? []),
      {
        type: "cancelled",
        timestamp: job.endedAt,
        message: args.reason || "Cancelled by Agent Router caller."
      }
    ];
    await writeRegistry(registry);
    await appendJsonl(job.logPath, job.recentEvents.slice(-1).map((event) => ({ ...event, jobId: job.jobId, sessionId: job.sessionId, agentId: job.agentId })));
  }
  return { jobId: job.jobId, status: job.status, activeProcessCancelled };
}

async function listSessions(args) {
  const registry = await readRegistry();
  const config = await readConfig();
  const limit = args.limit ?? 50;
  const localSessions = Object.values(registry.sessions)
    .filter((session) => args.includeArchived || session.status !== "archived")
    .filter((session) => !args.agent || session.agentId === args.agent)
    .filter((session) => !args.worktree || session.worktree === args.worktree)
    .map(compactSessionForList);
  const nativeResult = await maybeListNativeSessions({ args, config, registry });
  const sessions = mergeSessionLists({
    localSessions,
    nativeSessions: nativeResult.sessions,
    limit
  });
  return {
    sessions,
    nativeSessionList: nativeResult.meta
  };
}

function compactSessionForList(session) {
  return {
    sessionId: session.sessionId,
    providerSessionId: session.providerSessionId ?? null,
    agentId: session.agentId,
    title: session.title,
    status: session.status,
    worktree: session.worktree,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastJobId: session.lastJobId,
    source: session.source,
    canContinue: session.canContinue,
    availableModelCount: Array.isArray(session.availableModels) ? session.availableModels.length : 0,
    configOptionCount: Array.isArray(session.agentConfigOptions) ? session.agentConfigOptions.length : 0,
    additionalDirectories: Array.isArray(session.additionalDirectories) ? session.additionalDirectories : [],
    nativeMeta: isPlainObject(session.nativeMeta) ? session.nativeMeta : null
  };
}

async function maybeListNativeSessions({ args, config, registry }) {
  if (config.safety.launchExternalAgents !== true) {
    return { sessions: [], meta: { attempted: false, reason: "launch_external_agents_disabled" } };
  }
  if (args.worktree && !path.isAbsolute(args.worktree)) {
    return { sessions: [], meta: { attempted: false, reason: "worktree_must_be_absolute" } };
  }

  const availableAgents = await discoverAgents({ includeNotInstalled: false }).then((value) => value.agents);
  const acpAgents = availableAgents.filter((agent) => (
    agent.status === "available"
    && agent.acp?.available
    && (!args.agent || agent.id === args.agent)
  ));
  if (acpAgents.length === 0) {
    return { sessions: [], meta: { attempted: false, reason: "no_native_acp_agent_available" } };
  }

  const sessions = [];
  const agents = [];
  for (const agent of acpAgents) {
    try {
      const result = await listAcpNativeSessions({
        selectedAgent: agent,
        worktree: args.worktree ?? null,
        env: safeEnv({ inheritEnvironment: config.safety.inheritEnvironment === true })
      });
      sessions.push(...mapNativeSessions({
        nativeSessions: result.sessions,
        registry,
        args,
        agentId: agent.id
      }));
      agents.push({
        attempted: true,
        agentId: agent.id,
        supported: result.supported,
        sessionCount: result.sessions.length,
        pages: result.pages,
        nextCursor: result.nextCursor ?? null
      });
    } catch (error) {
      agents.push({
        attempted: true,
        agentId: agent.id,
        supported: null,
        error: error.message
      });
    }
  }
  return {
    sessions,
    meta: {
      attempted: true,
      agents
    }
  };
}

async function listAcpNativeSessions({ selectedAgent, worktree, env }) {
  const cwd = worktree ?? process.cwd();
  const launchTarget = resolveAcpLaunchTarget(selectedAgent.acp, selectedAgent, cwd);
  if (!launchTarget) throw new Error(`No ACP adapter is available for ${selectedAgent.id}.`);
  const client = new AcpStdioClient({
    command: launchTarget.command,
    args: launchTarget.args,
    cwd,
    timeoutMs: COMMAND_TIMEOUT_MS,
    env,
    onEvent: () => {}
  });
  try {
    await client.start();
    const initialize = await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: SERVER_NAME,
        title: "Agent Router",
        version: SERVER_VERSION
      }
    });
    const supported = Boolean(initialize?.agentCapabilities?.sessionCapabilities?.list);
    if (!supported) return { supported: false, sessions: [], pages: 0, nextCursor: null };

    const sessions = [];
    let cursor = null;
    let pages = 0;
    do {
      const params = {};
      if (worktree) params.cwd = worktree;
      if (cursor) params.cursor = cursor;
      const page = await client.request("session/list", params);
      if (Array.isArray(page.sessions)) sessions.push(...page.sessions);
      cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
      pages += 1;
    } while (cursor && pages < 10 && sessions.length < 500);
    return { supported: true, sessions, pages, nextCursor: cursor };
  } finally {
    client.dispose();
  }
}

function mapNativeSessions({ nativeSessions, registry, args, agentId }) {
  const localByProvider = new Map();
  for (const session of Object.values(registry.sessions)) {
    if (isPlainObject(session) && session.providerSessionId) {
      localByProvider.set(session.providerSessionId, session);
    }
  }

  const result = [];
  for (const nativeSession of nativeSessions) {
    if (!isPlainObject(nativeSession) || typeof nativeSession.sessionId !== "string") continue;
    const providerSessionId = nativeSession.sessionId;
    const local = localByProvider.get(providerSessionId);
    if (local) {
      if (!args.includeArchived && local.status === "archived") continue;
      if (args.agent && local.agentId !== args.agent) continue;
      if (args.worktree && (nativeSession.cwd ?? local.worktree) !== args.worktree) continue;
      result.push(compactSessionForList({
        ...local,
        title: nativeSession.title ?? local.title,
        worktree: nativeSession.cwd ?? local.worktree,
        updatedAt: nativeSession.updatedAt ?? local.updatedAt,
        source: local.source === "agent_native" ? "agent_native" : "dispatcher_registry+agent_native",
        canContinue: true,
        additionalDirectories: nativeSession.additionalDirectories,
        nativeMeta: nativeSession._meta
      }));
      continue;
    }
    if (args.agent && args.agent !== agentId) continue;
    if (args.worktree && nativeSession.cwd !== args.worktree) continue;
    result.push(compactSessionForList({
      sessionId: createNativeDispatcherSessionId(agentId, providerSessionId),
      providerSessionId,
      agentId,
      title: nativeSession.title ?? `Native ${agentId} session`,
      status: "idle",
      worktree: nativeSession.cwd ?? null,
      createdAt: nativeSession.updatedAt ?? null,
      updatedAt: nativeSession.updatedAt ?? null,
      lastJobId: null,
      source: "agent_native",
      canContinue: true,
      additionalDirectories: nativeSession.additionalDirectories,
      nativeMeta: nativeSession._meta
    }));
  }
  return result;
}

function mergeSessionLists({ localSessions, nativeSessions, limit }) {
  const byId = new Map();
  for (const session of [...localSessions, ...nativeSessions]) {
    if (!session?.sessionId) continue;
    byId.set(session.sessionId, { ...(byId.get(session.sessionId) ?? {}), ...session });
  }
  return Array.from(byId.values())
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, limit);
}

function createNativeDispatcherSessionId(agentId, providerSessionId) {
  return `sess_native_${agentId}_${encodeBase64Url(providerSessionId)}`;
}

function parseNativeDispatcherSessionId(sessionId) {
  const match = /^sess_native_([^_]+)_(.+)$/.exec(String(sessionId ?? ""));
  if (!match) return null;
  const providerSessionId = decodeBase64Url(match[2]);
  if (!providerSessionId) return null;
  return {
    agentId: match[1],
    providerSessionId
  };
}

function encodeBase64Url(value) {
  return Buffer.from(String(value), "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value) {
  try {
    const base64 = String(value).replaceAll("-", "+").replaceAll("_", "/");
    const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

async function continueSession(args) {
  const registry = await readRegistry();
  let session = registry.sessions[args.sessionId];
  if (!session) {
    const nativeRef = parseNativeDispatcherSessionId(args.sessionId);
    if (!nativeRef || nativeRef.agentId !== args.agent) {
      return {
        sessionId: args.sessionId,
        status: "not_found",
        message: "The dispatcher can only continue sessions already recorded in the registry or native ACP sessions returned by list_coding_agent_sessions."
      };
    }
    const now = new Date().toISOString();
    session = {
      sessionId: args.sessionId,
      providerSessionId: nativeRef.providerSessionId,
      agentId: args.agent,
      title: preview(args.prompt, 60),
      status: "idle",
      worktree: args.worktree,
      createdAt: now,
      updatedAt: now,
      lastJobId: null,
      source: "agent_native",
      canContinue: true
    };
    registry.sessions[session.sessionId] = session;
    await writeRegistry(registry);
  }
  return createJob({
    agent: args.agent,
    sessionId: args.sessionId,
    prompt: args.prompt,
    worktree: args.worktree,
    async: args.async,
    launchExternalAgents: args.launchExternalAgents,
    inheritEnvironment: args.inheritEnvironment,
    timeoutSec: args.timeoutSec,
    mode: "implementation",
    permissionProfile: "workspace_write",
    collectDiff: true
  });
}

async function archiveSession(args) {
  const registry = await readRegistry();
  const session = registry.sessions[args.sessionId];
  if (!session) return { sessionId: args.sessionId, status: "not_found" };
  session.status = "archived";
  session.updatedAt = new Date().toISOString();
  await writeRegistry(registry);
  return { sessionId: session.sessionId, status: session.status };
}

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
      defaultPermissionProfile: "workspace_write",
      allowBypassPermissions: false,
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

function resolveBooleanOverride(value, fallback) {
  return typeof value === "boolean" ? value : fallback === true;
}

async function readRegistry() {
  await ensureOrphanRecovery();
  return readJson(REGISTRY_PATH, { jobs: {}, sessions: {} });
}

async function writeRegistry(registry) {
  await writeJson(REGISTRY_PATH, registry);
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

async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return structuredClone(fallback);
    throw error;
  }
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

async function writeJson(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function appendJsonl(filePath, entries) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const lines = entries.map((entry) => JSON.stringify(entry)).join("\n");
  await fs.appendFile(filePath, `${lines}\n`, "utf8");
}

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
}

async function validateWorktree(worktree) {
  if (typeof worktree !== "string" || !worktree.trim()) {
    return { ok: false, reason: "worktree_required" };
  }
  if (!path.isAbsolute(worktree)) {
    return { ok: false, reason: "worktree_must_be_absolute" };
  }
  try {
    const stat = await fs.stat(worktree);
    if (!stat.isDirectory()) return { ok: false, reason: "worktree_must_be_directory" };
    await fs.access(worktree);
    return { ok: true };
  } catch {
    return { ok: false, reason: "worktree_not_accessible" };
  }
}

async function findExecutables(binary, pathEntries) {
  const seen = new Set();
  const candidates = [];
  for (const entry of pathEntries) {
    const candidate = path.join(entry, binary);
    try {
      await fs.access(candidate, fsConstants.X_OK);
      const realPath = await fs.realpath(candidate).catch(() => candidate);
      if (seen.has(realPath)) continue;
      seen.add(realPath);
      candidates.push(candidate);
    } catch {
      continue;
    }
  }
  return candidates;
}

async function selectExecutable(agent, pathEntries) {
  const candidates = await findExecutables(agent.executable, pathEntries);
  if (candidates.length === 0) {
    return {
      installedPath: null,
      version: null,
      note: null,
      candidates: []
    };
  }

  const probes = await Promise.all(candidates.map(async (candidate, index) => ({
    path: candidate,
    index,
    ...(await probeVersion(candidate, agent.versionArgs))
  })));
  const sorted = [...probes].sort(compareExecutableProbe);
  const selected = sorted[0];
  const skipped = sorted.slice(1).map((probe) => probe.version ? `${probe.path} (${probe.version})` : probe.path);
  return {
    installedPath: selected.path,
    version: selected.version,
    note: selected.note,
    candidates: probes,
    selectionNote: skipped.length > 0 ? `Selected ${selected.path}; skipped ${skipped.join(", ")}` : null
  };
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

function enrichAgentWithRegistry(agent, acpRegistry) {
  const registryAgent = acpRegistry.agentsByRouterId.get(agent.id);
  if (!registryAgent) return agent;
  const installHint = buildRegistryInstallHint(registryAgent);
  const registryVersion = typeof registryAgent.version === "string" && registryAgent.version.trim()
    ? registryAgent.version.trim()
    : null;
  const npxPackage = extractRegistryNpxPackage(registryAgent);
  const npxFallback = agent.acp && !agent.acp.available && npxPackage
    ? buildNpxAcpFallback(npxPackage)
    : null;
  const acpVersionFromRegistry = Boolean(agent.acp?.available && !agent.acp.version && registryVersion);
  const notes = acpVersionFromRegistry
    ? agent.notes.filter((note) => !note.startsWith("ACP version probe failed:"))
    : agent.notes;
  const extraNotes = [];
  if (npxFallback) {
    extraNotes.push(`ACP adapter available via npx: ${npxFallback.launchCommand.join(" ")}`);
  }
  if (installHint) {
    extraNotes.push(`Install hint: ${installHint}`);
  }
  const transport = npxFallback ? "acp_stdio" : agent.transport;
  const status = npxFallback && agent.status === "not_installed" ? "available" : agent.status;
  return {
    ...agent,
    version: agent.version ?? (acpVersionFromRegistry || npxFallback ? registryVersion : null),
    displayName: agent.displayName || registryAgent.name,
    description: registryAgent.description ?? null,
    icon: registryAgent.icon ? { kind: "registry_url", value: registryAgent.icon } : agent.icon,
    transport,
    status,
    registry: {
      id: registryAgent.id,
      name: registryAgent.name,
      version: registryVersion,
      repository: registryAgent.repository ?? null,
      license: registryAgent.license ?? null,
      distribution: registryAgent.distribution,
      installHint
    },
    acp: agent.acp ? {
      ...agent.acp,
      available: npxFallback ? true : agent.acp.available,
      installedPath: npxFallback ? null : agent.acp.installedPath,
      launchMode: npxFallback ? "npx" : agent.acp.launchMode ?? null,
      launchCommand: npxFallback ? npxFallback.launchCommand : agent.acp.launchCommand ?? null,
      version: agent.acp.version ?? (agent.acp.available || npxFallback ? registryVersion : null)
    } : null,
    notes: [
      ...notes,
      `Registry: ${registryAgent.name}${registryVersion ? ` ${registryVersion}` : ""}.`,
      ...extraNotes
    ]
  };
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

async function probeAgent(agent, config, pathEntries) {
  const selection = await selectExecutable(agent, pathEntries);
  const installedPath = selection.installedPath;
  const acpSelection = agent.acp ? await selectExecutable({
    executable: agent.acp.executable,
    versionArgs: agent.acp.versionArgs ?? agent.versionArgs
  }, pathEntries) : null;
  const acpInstalledPath = acpSelection?.installedPath ?? null;
  const disabled = config.disabledAgents.includes(agent.id);
  const notes = [];
  if (acpInstalledPath) {
    notes.push(`Found ACP adapter at ${acpInstalledPath}`);
  }
  if (installedPath) {
    notes.push(`Found CLI at ${installedPath}`);
  }
  if (notes.length === 0) notes.push(...agent.notes);
  if (selection.selectionNote) notes.push(selection.selectionNote);
  if (selection.note) notes.push(selection.note);
  if (acpSelection?.selectionNote) notes.push(acpSelection.selectionNote);
  if (acpSelection?.note) notes.push(`ACP version probe failed: ${acpSelection.note.replace(/^Version probe failed: /, "")}`);
  const status = disabled
    ? "disabled"
    : acpInstalledPath || installedPath
      ? "available"
      : "not_installed";
  const transport = acpInstalledPath ? "acp_stdio" : agent.transport;
  return {
    id: agent.id,
    displayName: agent.displayName,
    status,
    version: acpSelection?.version ?? selection.version,
    installedPath,
    transport,
    command: acpInstalledPath ? `${agent.acp.executable} <acp stdio>` : agent.command,
    acp: agent.acp ? {
      executable: agent.acp.executable,
      installedPath: acpInstalledPath,
      version: acpSelection?.version ?? null,
      adapterStatus: agent.acp.adapterStatus,
      label: agent.acp.label,
      buildArgsKey: agent.acp.buildArgsKey ?? agent.acp.executable,
      available: Boolean(acpInstalledPath)
    } : null,
    fallbackTransport: acpInstalledPath && installedPath ? agent.transport : null,
    fallbackCommand: acpInstalledPath && installedPath ? agent.command : null,
    source: agent.source,
    capabilities: agent.capabilities,
    icon: null,
    notes
  };
}

function compareExecutableProbe(a, b) {
  const versionComparison = compareVersionStrings(b.version, a.version);
  if (versionComparison !== 0) return versionComparison;
  return a.index - b.index;
}

function compareVersionStrings(a, b) {
  const parsedA = parseVersionParts(a);
  const parsedB = parseVersionParts(b);
  const length = Math.max(parsedA.length, parsedB.length);
  for (let index = 0; index < length; index += 1) {
    const left = parsedA[index] ?? 0;
    const right = parsedB[index] ?? 0;
    if (left !== right) return left - right;
  }
  return 0;
}

function parseVersionParts(value) {
  const match = String(value ?? "").match(/\d+(?:\.\d+){0,3}/);
  if (!match) return [];
  return match[0].split(".").map((part) => Number.parseInt(part, 10)).filter(Number.isFinite);
}

async function probeVersion(executablePath, versionArgs) {
  try {
    const { stdout, stderr } = await execFileAsync(executablePath, versionArgs, {
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
      env: safeEnv()
    });
    const output = `${stdout}\n${stderr}`.trim();
    return {
      version: output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null,
      note: null
    };
  } catch (error) {
    return {
      version: null,
      note: `Version probe failed: ${error.code ?? error.message}`
    };
  }
}

async function collectWorktreeState(worktree) {
  const gitRoot = await runGit(worktree, ["rev-parse", "--show-toplevel"]);
  if (!gitRoot.ok) {
    return {
      isGitRepository: false,
      currentBranch: null,
      preExistingChangedFiles: [],
      note: "Worktree is not a git repository or git is unavailable."
    };
  }
  const branch = await runGit(worktree, ["branch", "--show-current"]);
  const status = await runGit(worktree, ["status", "--porcelain=v1"]);
  return {
    isGitRepository: true,
    gitRoot: gitRoot.stdout.trim(),
    currentBranch: branch.ok ? branch.stdout.trim() || null : null,
    preExistingChangedFiles: status.ok ? parseGitStatusFiles(status.stdout) : [],
    statusProbeError: status.ok ? null : status.error
  };
}

async function runGit(cwd, args) {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
      env: safeEnv()
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      error: error.message
    };
  }
}

function parseGitStatusFiles(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^.* -> /, ""))
    .filter(Boolean);
}

function findActiveWorktreeJob(registry, worktree, permissionProfile) {
  if (permissionProfile === "plan") return null;
  return Object.values(registry.jobs).find((job) => (
    job.worktree === worktree
    && job.permissionProfile !== "plan"
    && ACTIVE_JOB_STATUSES.has(job.status)
  )) ?? null;
}

function planLaunch({ launchingEnabled, selectedAgent }) {
  if (!launchingEnabled) {
    return {
      kind: "record_only",
      runnable: false,
      status: "completed",
      adapterStatus: "record_only",
      summary: "Recorded Agent Router job, selected agent, session binding, and current worktree state without launching an external process.",
      risks: ["No external agent process was launched in this alpha build."]
    };
  }
  if (selectedAgent.acp?.available && (selectedAgent.acp.installedPath || selectedAgent.acp.launchMode === "npx")) {
    return {
      kind: "acp_stdio",
      runnable: true,
      adapterStatus: "starting",
      summary: `Starting ${selectedAgent.displayName} ACP adapter.`,
      risks: []
    };
  }
  return {
    kind: "unsupported",
    runnable: false,
    status: "failed",
    adapterStatus: "adapter_not_implemented",
    summary: `External launch is not implemented for ${selectedAgent.id}.`,
    risks: ["External launch was requested, but no runnable adapter path was selected."]
  };
}

function isAcpRunReady(selectedAgent) {
  const acp = selectedAgent?.acp;
  if (!acp?.available) return false;
  if (acp.installedPath) return true;
  return acp.launchMode === "npx" && Array.isArray(acp.launchCommand) && acp.launchCommand.length > 0;
}

function buildAcpUnavailableError(selectedAgent) {
  if (selectedAgent.id === "cursor-agent") {
    return "Cursor Agent has no ACP adapter; CLI fallback removed. Install a Cursor ACP adapter or use a different agent.";
  }
  const installHint = selectedAgent.registry?.installHint ?? null;
  const base = `ACP is required for ${selectedAgent.displayName} and CLI fallback has been removed.`;
  if (installHint) {
    return `${base} Install the ACP adapter: ${installHint}`;
  }
  return `${base} Install the ${selectedAgent.displayName} ACP adapter or use a different agent.`;
}

async function runAcpStdioJob({ args, job, session, selectedAgent, timeoutSec, agentEnv, controller }) {
  const acpSpec = selectedAgent.acp;
  const launchTarget = resolveAcpLaunchTarget(acpSpec, selectedAgent, args.worktree);
  if (!launchTarget) throw new Error(`No ACP adapter is available for ${selectedAgent.id}.`);
  const adapterLabel = acpSpec.label ?? `${selectedAgent.displayName} ACP`;
  const adapterStatus = acpSpec.adapterStatus ?? `${selectedAgent.id}_acp`;
  const events = [];
  const startedAt = Date.now();
  let providerSessionId = session.providerSessionId ?? null;
  let agentConfigOptions = [];
  let availableModels = [];
  const client = new AcpStdioClient({
    command: launchTarget.command,
    args: launchTarget.args,
    cwd: args.worktree,
    timeoutMs: timeoutSec * 1000,
    env: agentEnv,
    onEvent: (event) => events.push(event),
    onProcessStart: (child) => controller?.recordProcess({
      pid: child.pid,
      kind: "acp_stdio",
      command: launchTarget.processLabel,
      startedAt: new Date().toISOString()
    })
  });
  if (controller) {
    controller.cancelProcess = () => {
      client.dispose();
      return true;
    };
  }

  try {
    await client.start();
    const initialize = await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: SERVER_NAME,
        title: "Agent Router",
        version: SERVER_VERSION
      }
    });
    events.push({
      type: "acp_initialize",
      timestamp: new Date().toISOString(),
      message: `${adapterLabel} initialized.`,
      result: summarizeInitializeResult(initialize)
    });

    const sessionResult = providerSessionId
      ? await client.request("session/resume", {
        sessionId: providerSessionId,
        cwd: args.worktree,
        mcpServers: []
      })
      : await client.request("session/new", {
        cwd: args.worktree,
        mcpServers: []
      });
    providerSessionId = providerSessionId ?? sessionResult.sessionId;
    agentConfigOptions = summarizeAcpConfigOptions(sessionResult.configOptions);
    availableModels = extractModelOptions(agentConfigOptions);
    events.push({
      type: session.providerSessionId ? "acp_session_resumed" : "acp_session_created",
      timestamp: new Date().toISOString(),
      message: `${adapterLabel} session ready: ${providerSessionId}`,
      providerSessionId
    });
    if (agentConfigOptions.length > 0) {
      events.push({
        type: "acp_config_options",
        timestamp: new Date().toISOString(),
        message: `${adapterLabel} exposed ${agentConfigOptions.length} config option(s), including ${availableModels.length} model option(s).`,
        configOptions: agentConfigOptions,
        availableModels
      });
    }

    const promptResult = await client.request("session/prompt", {
      sessionId: providerSessionId,
      prompt: [
        {
          type: "text",
          text: buildDispatchPrompt(args.prompt)
        }
      ]
    });
    const completedAt = new Date().toISOString();
    const afterState = args.collectDiff === false
      ? { skipped: true, reason: "collectDiff disabled" }
      : await collectWorktreeState(args.worktree);
    const changedFiles = diffChangedFiles(job.worktreeState, afterState);
    const agentText = extractAgentText(events);
    const stopReason = promptResult.stopReason ?? null;
    return {
      events: [
        ...events,
        ...client.drainLogEvents(),
        {
          type: "acp_prompt_completed",
          timestamp: completedAt,
          message: `${adapterLabel} prompt completed with stopReason=${stopReason ?? "unknown"}.`,
          stopReason
        },
        buildAcpProcessClosedEvent(startedAt)
      ],
      sessionPatch: {
        providerSessionId,
        agentConfigOptions,
        availableModels,
        status: "idle",
        canContinue: true
      },
      jobPatch: {
        status: "completed",
        endedAt: completedAt,
        adapterStatus,
        providerSessionId,
        stopReason,
        failureReason: null,
        agentErrors: [],
        agentConfigOptions,
        availableModels,
        changedFiles,
        worktreeState: {
          before: job.worktreeState,
          after: afterState
        },
        resultSummary: agentText || `${adapterLabel} completed with stopReason=${stopReason ?? "unknown"}.`,
        validation: [],
        risks: stopReason && stopReason !== "end_turn" ? [`OpenCode stopped with ${stopReason}.`] : []
      }
    };
  } catch (error) {
    const failedAt = new Date().toISOString();
    const afterState = args.collectDiff === false
      ? { skipped: true, reason: "collectDiff disabled" }
      : await collectWorktreeState(args.worktree);
    const collectedEvents = [...events, ...client.drainLogEvents()];
    const agentErrors = extractAgentErrors(collectedEvents);
    const cancelled = controller?.cancelRequested === true;
    const failureReason = cancelled
      ? (controller.cancelReason || `${adapterLabel} cancelled by Agent Router caller.`)
      : buildFailureReason(adapterLabel, error, agentErrors);
    return {
      events: [
        ...collectedEvents,
        {
          type: cancelled ? "acp_cancelled" : "acp_error",
          timestamp: failedAt,
          message: failureReason,
          errorMessage: error.message,
          agentErrors
        },
        buildAcpProcessClosedEvent(startedAt)
      ],
      sessionPatch: {
        providerSessionId,
        agentConfigOptions,
        availableModels,
        status: "idle",
        canContinue: Boolean(providerSessionId)
      },
      jobPatch: {
        status: cancelled ? "cancelled" : error.code === "timeout" ? "timed_out" : "failed",
        endedAt: failedAt,
        adapterStatus,
        providerSessionId,
        failureReason,
        agentErrors,
        agentConfigOptions,
        availableModels,
        changedFiles: diffChangedFiles(job.worktreeState, afterState),
        worktreeState: {
          before: job.worktreeState,
          after: afterState
        },
        resultSummary: failureReason,
        validation: [],
        risks: cancelled ? [] : ["Inspect the job log before re-running the agent."]
      }
    };
  } finally {
    client.dispose();
  }
}

function getAcpAdapterArgs(selectedAgent, worktree) {
  if (selectedAgent.id === "opencode") {
    return ["acp", "--cwd", worktree, "--print-logs", "--log-level", "ERROR"];
  }
  return [];
}

function resolveAcpLaunchTarget(acpSpec, selectedAgent, worktree) {
  if (!acpSpec?.available) return null;
  if (acpSpec.launchMode === "npx" && Array.isArray(acpSpec.launchCommand) && acpSpec.launchCommand.length > 0) {
    return {
      command: acpSpec.launchCommand[0],
      args: [...acpSpec.launchCommand.slice(1), ...getAcpAdapterArgs(selectedAgent, worktree)],
      processLabel: acpSpec.launchCommand.join(" ")
    };
  }
  if (acpSpec.installedPath) {
    return {
      command: acpSpec.installedPath,
      args: getAcpAdapterArgs(selectedAgent, worktree),
      processLabel: path.basename(acpSpec.installedPath)
    };
  }
  return null;
}

async function runCliFallbackJob({ args, job, session, selectedAgent, timeoutSec, agentEnv, controller }) {
  const spec = getCliAdapterSpec(selectedAgent.id);
  if (!spec) throw new Error(`No CLI adapter is registered for ${selectedAgent.id}.`);
  const startedAt = Date.now();
  const prompt = buildDispatchPrompt(args.prompt);
  const providerSessionId = session.providerSessionId ?? null;
  const command = selectedAgent.installedPath ?? selectedAgent.executable;
  const commandArgs = spec.buildArgs({
    prompt,
    worktree: args.worktree,
    permissionProfile: job.permissionProfile,
    providerSessionId
  });
  const startedEvent = {
    type: "cli_started",
    timestamp: new Date().toISOString(),
    message: `Started ${spec.label} CLI fallback adapter.`,
    command: [path.basename(command), ...commandArgs.map((part) => part === prompt ? "<prompt>" : part)]
  };
  const result = await runCliProcess({
    command,
    args: commandArgs,
    cwd: args.worktree,
    timeoutMs: timeoutSec * 1000,
    env: agentEnv,
    controller
  });
  const endedAt = new Date().toISOString();
  const stdoutEvents = parseCliStream(result.stdout, "stdout");
  const stderrEvents = parseCliStream(result.stderr, "stderr");
  const events = [
    startedEvent,
    ...stdoutEvents,
    ...stderrEvents,
    buildCliProcessClosedEvent(spec.label, startedAt, result)
  ];
  const afterState = args.collectDiff === false
    ? { skipped: true, reason: "collectDiff disabled" }
    : await collectWorktreeState(args.worktree);
  const changedFiles = diffChangedFiles(job.worktreeState, afterState);
  const nextProviderSessionId = providerSessionId ?? findCliSessionId(events);
  const stopReason = findCliStopReason(events);
  const agentErrors = extractAgentErrors(events);
  const semanticFailure = stopReason && !["end_turn", "completed", "complete", "finished", "success"].includes(stopReason.toLowerCase());

  if (result.exitCode === 0 && !result.timedOut && !result.error && !semanticFailure) {
    const agentText = extractCliText(events);
    return {
      events,
      sessionPatch: {
        providerSessionId: nextProviderSessionId,
        status: "idle",
        canContinue: true
      },
      jobPatch: {
        status: "completed",
        endedAt,
        adapterStatus: spec.adapterStatus,
        providerSessionId: nextProviderSessionId,
        stopReason,
        failureReason: null,
        agentErrors,
        changedFiles,
        worktreeState: {
          before: job.worktreeState,
          after: afterState
        },
        resultSummary: agentText || `${spec.label} CLI completed.`,
        validation: [],
        risks: agentErrors.length > 0 ? ["Agent reported warnings; inspect the job log if results look incomplete."] : []
      }
    };
  }

  if (result.cancelled) {
    const cancelReason = controller?.cancelReason || `${spec.label} CLI cancelled by Agent Router caller.`;
    return {
      events: [
        ...events,
        {
          type: "cli_cancelled",
          timestamp: endedAt,
          message: cancelReason
        }
      ],
      sessionPatch: {
        providerSessionId: nextProviderSessionId,
        status: "idle",
        canContinue: Boolean(nextProviderSessionId)
      },
      jobPatch: {
        status: "cancelled",
        endedAt,
        adapterStatus: spec.adapterStatus,
        providerSessionId: nextProviderSessionId,
        stopReason,
        failureReason: null,
        agentErrors: [],
        changedFiles,
        worktreeState: {
          before: job.worktreeState,
          after: afterState
        },
        resultSummary: cancelReason,
        validation: [],
        risks: []
      }
    };
  }

  const failure = result.error ?? new Error(result.timedOut
    ? `${spec.label} CLI timed out after ${timeoutSec}s.`
    : semanticFailure
      ? `${spec.label} CLI stopped before completing: ${stopReason}.`
      : `${spec.label} CLI exited with code ${result.exitCode}.`);
  if (result.timedOut) failure.code = "timeout";
  const failureReason = buildFailureReason(`${spec.label} CLI`, failure, agentErrors);
  return {
    events: [
      ...events,
      {
        type: "cli_error",
        timestamp: endedAt,
        message: failureReason,
        errorMessage: failure.message,
        agentErrors
      }
    ],
    sessionPatch: {
      providerSessionId: nextProviderSessionId,
      status: "idle",
      canContinue: true
    },
    jobPatch: {
      status: result.timedOut ? "timed_out" : "failed",
      endedAt,
      adapterStatus: spec.adapterStatus,
      providerSessionId: nextProviderSessionId,
      stopReason,
      failureReason,
      agentErrors,
      changedFiles,
      worktreeState: {
        before: job.worktreeState,
        after: afterState
      },
      resultSummary: failureReason,
      validation: [],
      risks: ["Inspect the job log before re-running the agent."]
    }
  };
}

function getCliAdapterSpec(agentId) {
  const specs = {
    "cursor-agent": {
      label: "Cursor Agent",
      adapterStatus: "cursor_agent_cli",
      buildArgs: ({ prompt, worktree, permissionProfile, providerSessionId }) => [
        "--print",
        "--output-format",
        "stream-json",
        "--workspace",
        worktree,
        "--trust",
        ...mapCursorAgentPermissionArgs(permissionProfile),
        ...(providerSessionId ? ["--resume", providerSessionId] : []),
        prompt
      ]
    },
    claude: {
      label: "Claude Code",
      adapterStatus: "claude_cli",
      buildArgs: ({ prompt, permissionProfile, providerSessionId }) => [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        mapAgentPermissionMode(permissionProfile),
        ...(providerSessionId ? ["--resume", providerSessionId] : []),
        prompt
      ]
    },
    codex: {
      label: "Codex",
      adapterStatus: "codex_cli",
      buildArgs: ({ prompt, worktree, permissionProfile, providerSessionId }) => {
        if (providerSessionId) {
          return [
            "exec",
            "resume",
            "--json",
            ...(permissionProfile === "bypass_permissions" ? ["--dangerously-bypass-approvals-and-sandbox"] : []),
            providerSessionId,
            prompt
          ];
        }
        return [
          "exec",
          "--json",
          "--cd",
          worktree,
          ...(permissionProfile === "bypass_permissions"
            ? ["--dangerously-bypass-approvals-and-sandbox"]
            : ["--sandbox", mapCodexSandbox(permissionProfile)]),
          prompt
        ];
      }
    }
  };
  return specs[agentId] ?? null;
}

function mapAgentPermissionMode(permissionProfile) {
  if (permissionProfile === "plan") return "plan";
  if (permissionProfile === "bypass_permissions") return "bypassPermissions";
  return "acceptEdits";
}

function mapCursorAgentPermissionArgs(permissionProfile) {
  if (permissionProfile === "plan") return ["--mode", "plan"];
  if (permissionProfile === "bypass_permissions") return ["--force", "--sandbox", "disabled"];
  if (permissionProfile === "accept_edits") return ["--force"];
  return [];
}

function mapCodexSandbox(permissionProfile) {
  if (permissionProfile === "plan") return "read-only";
  return "workspace-write";
}

function runCliProcess({ command, args, cwd, timeoutMs, env, controller }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: env ?? safeEnv()
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let processError = null;
    let settled = false;
    if (controller && typeof controller.recordProcess === "function") {
      controller.recordProcess({
        pid: child.pid,
        kind: "cli",
        command: path.basename(command),
        startedAt: new Date().toISOString()
      }).catch(() => {});
    }
    if (controller) {
      controller.cancelProcess = () => {
        if (!settled && !child.killed) {
          child.kill("SIGTERM");
          return true;
        }
        return false;
      };
      if (controller.cancelRequested) controller.cancelProcess();
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk, 200_000);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk, 200_000);
    });
    child.on("error", (error) => {
      processError = error;
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, signal, timedOut, cancelled: controller?.cancelRequested === true, error: processError });
    });
  });
}

function appendLimited(current, chunk, maxLength) {
  if (current.length >= maxLength) return current;
  const next = `${current}${chunk}`;
  if (next.length <= maxLength) return next;
  return `${next.slice(0, maxLength)}\n[Agent Router truncated captured output]\n`;
}

class AcpStdioClient {
  constructor({ command, args, cwd, timeoutMs, env, onEvent, onProcessStart }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.env = env ?? safeEnv();
    this.onEvent = onEvent;
    this.onProcessStart = onProcessStart;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.logEvents = [];
    this.child = null;
    this.startError = null;
  }

  async start() {
    const currentDepth = Number.parseInt(process.env.AGENT_ROUTER_DEPTH ?? "0", 10) || 0;
    const childEnv = {
      ...this.env,
      AGENT_ROUTER_DEPTH: String(currentDepth + 1)
    };
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    if (typeof this.onProcessStart === "function") {
      await Promise.resolve(this.onProcessStart(this.child)).catch((error) => {
        this.logEvents.push({
          type: "process_record_error",
          timestamp: new Date().toISOString(),
          message: `Failed to record ACP process pid: ${error.message}`
        });
      });
    }
    this.child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.child.stderr.on("data", (chunk) => this.handleStderr(chunk));
    this.child.on("error", (error) => {
      this.startError = error;
      this.rejectPending(error);
    });
    this.child.on("exit", (code, signal) => this.rejectPending(new Error(`ACP process exited with code=${code} signal=${signal}`)));
    await sleep(ACP_STARTUP_DELAY_MS);
    if (this.startError) throw this.startError;
  }

  request(method, params) {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`ACP request timed out: ${method}`);
        error.code = "timeout";
        reject(error);
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.write(payload);
    });
  }

  respond(id, result) {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id, code, message) {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  write(payload) {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error("ACP process is not writable.");
    }
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      this.handleMessageLine(line);
    }
  }

  handleMessageLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.logEvents.push({
        type: "acp_stdout_parse_error",
        timestamp: new Date().toISOString(),
        message: preview(line, 300)
      });
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
      this.handleClientRequest(message);
      return;
    }
    if (message.method) {
      this.handleNotification(message);
    }
  }

  handleClientRequest(message) {
    if (message.method === "session/request_permission") {
      this.logEvents.push({
        type: "acp_permission_cancelled",
        timestamp: new Date().toISOString(),
        message: "Agent Router cancelled an ACP permission request.",
        params: message.params
      });
      this.respond(message.id, { outcome: "cancelled" });
      return;
    }
    this.respondError(message.id, -32601, `Unsupported client method: ${message.method}`);
  }

  handleNotification(message) {
    const event = normalizeAcpNotification(message);
    this.onEvent(event);
  }

  handleStderr(chunk) {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
      this.logEvents.push({
        type: "acp_stderr",
        timestamp: new Date().toISOString(),
        message: preview(line, 500)
      });
    }
  }

  drainLogEvents() {
    const events = this.logEvents;
    this.logEvents = [];
    return events;
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  dispose() {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }
}

function normalizeAcpNotification(message) {
  if (message.method === "session/update") {
    const update = message.params?.update ?? {};
    const event = {
      type: `acp_${update.sessionUpdate ?? "session_update"}`,
      timestamp: new Date().toISOString(),
      message: describeSessionUpdate(update),
      params: message.params
    };
    return event;
  }
  return {
    type: `acp_${message.method.replaceAll("/", "_")}`,
    timestamp: new Date().toISOString(),
    message: message.method,
    params: message.params
  };
}

function describeSessionUpdate(update) {
  if (update.sessionUpdate === "agent_message_chunk") {
    return preview(update.content?.text ?? "", 300);
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    return preview(update.title ?? update.status ?? update.toolCallId ?? "tool call update", 300);
  }
  if (update.sessionUpdate === "plan") {
    return "Agent plan update.";
  }
  if (update.sessionUpdate === "available_commands_update") {
    return `Available commands updated: ${(update.availableCommands ?? []).length}`;
  }
  return update.sessionUpdate ?? "session update";
}

function summarizeInitializeResult(result) {
  return {
    protocolVersion: result.protocolVersion,
    agentInfo: result.agentInfo ?? null,
    agentCapabilities: {
      loadSession: Boolean(result.agentCapabilities?.loadSession),
      sessionCapabilities: Object.keys(result.agentCapabilities?.sessionCapabilities ?? {})
    },
    authMethods: (result.authMethods ?? []).map((method) => ({ id: method.id, name: method.name }))
  };
}

function summarizeAcpConfigOptions(configOptions) {
  if (!Array.isArray(configOptions)) return [];
  return configOptions
    .map((option) => {
      const id = option.id ?? option.configId ?? null;
      const title = option.title ?? option.name ?? option.label ?? id;
      const category = option.category ?? null;
      const description = option.description ? preview(option.description, 300) : null;
      const choices = summarizeConfigChoices(option.options ?? option.values ?? option.choices);
      return {
        id,
        title,
        category,
        type: option.type ?? option.input?.type ?? (choices.length > 0 ? "select" : null),
        description,
        currentValue: summarizeConfigValue(option.value ?? option.currentValue ?? option.defaultValue),
        options: choices
      };
    })
    .filter((option) => option.id || option.category || option.options.length > 0);
}

function summarizeConfigChoices(choices) {
  if (!Array.isArray(choices)) return [];
  return choices.map((choice) => {
    if (typeof choice === "string") return { value: choice, label: choice };
    if (!isPlainObject(choice)) return null;
    const value = choice.value ?? choice.id ?? choice.name ?? choice.label ?? choice.title;
    const label = choice.label ?? choice.title ?? choice.name ?? choice.value ?? choice.id;
    if (typeof value !== "string" || !value) return null;
    return {
      value,
      label: typeof label === "string" && label ? label : value,
      description: choice.description ? preview(choice.description, 300) : null
    };
  }).filter(Boolean);
}

function summarizeConfigValue(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return null;
}

function extractModelOptions(configOptions) {
  return configOptions
    .filter((option) => (
      option.category === "model"
      || /model/i.test(option.id ?? "")
      || /model/i.test(option.title ?? "")
    ))
    .flatMap((option) => option.options.map((choice) => ({
      configId: option.id,
      value: choice.value,
      label: choice.label,
      description: choice.description
    })));
}

function buildDispatchPrompt(prompt) {
  return [
    prompt,
    "",
    "When you finish, report:",
    "- changed files",
    "- validation commands and results",
    "- risks or incomplete work"
  ].join("\n");
}

function extractAgentText(events) {
  const chunks = events
    .filter((event) => event.type === "acp_agent_message_chunk")
    .map((event) => event.params?.update?.content?.text)
    .filter(Boolean);
  return chunks.join("").trim();
}

function parseCliStream(output, stream) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        const payload = JSON.parse(line);
        return {
          type: `cli_${stream}_json`,
          timestamp: new Date().toISOString(),
          stream,
          message: preview(readableTextFromValue(payload) || payload.type || payload.event || "JSON output", 500),
          payload
        };
      } catch {
        return {
          type: `cli_${stream}`,
          timestamp: new Date().toISOString(),
          stream,
          message: preview(line, 500)
        };
      }
    });
}

function extractCliText(events) {
  const chunks = [];
  for (const event of events) {
    if (event.stream === "stderr") continue;
    if (event.payload) {
      const text = readableTextFromValue(event.payload);
      if (text) chunks.push(text);
    } else if (event.type === "cli_stdout" && event.message) {
      chunks.push(event.message);
    }
  }
  return uniqueStrings(chunks.map((chunk) => preview(chunk, 2000))).join("\n").trim();
}

function readableTextFromValue(value) {
  return collectReadableText(value)
    .map((text) => text.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function collectReadableText(value, depth = 0) {
  if (depth > 6 || value == null) return [];
  if (typeof value === "string") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectReadableText(item, depth + 1));
  }
  if (typeof value !== "object") return [];
  const chunks = [];
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && /^(text|content|message|summary|result|response|output|delta|final_answer)$/i.test(key)) {
      chunks.push(child);
    } else {
      chunks.push(...collectReadableText(child, depth + 1));
    }
  }
  return chunks;
}

function findCliSessionId(events) {
  for (const event of events) {
    const value = findSessionIdInValue(event.payload);
    if (value) return value;
  }
  return null;
}

function findCliStopReason(events) {
  for (const event of events) {
    const value = findStopReasonInValue(event.payload);
    if (value) return value;
  }
  return null;
}

function findSessionIdInValue(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSessionIdInValue(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (
      typeof child === "string"
      && /^(sessionId|session_id|conversationId|conversation_id|threadId|thread_id)$/i.test(key)
    ) {
      return child;
    }
    const found = findSessionIdInValue(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function findStopReasonInValue(value, depth = 0) {
  if (depth > 6 || value == null) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStopReasonInValue(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && /^(stopReason|stop_reason|finishReason|finish_reason)$/i.test(key)) {
      return child;
    }
    const found = findStopReasonInValue(child, depth + 1);
    if (found) return found;
  }
  return null;
}

const AGENT_ERROR_PATTERNS = [
  /insufficient balance/i,
  /rate[_ -]?limit/i,
  /rate limit/i,
  /quota/i,
  /unauthorized/i,
  /forbidden/i,
  /permission denied/i,
  /auth(?:entication)?[_ -]?failed/i,
  /auth(?:entication)? failed/i,
  /failed to authenticate/i,
  /not logged in/i,
  /api[_/-]?retry/i,
  /api[_-]?error[_-]?status/i,
  /error[_-]?status/i,
  /\berror\b/i
];

const AGENT_ERROR_KEY_PATTERN = /(?:api[_-]?error[_-]?status|error[_-]?status|error|fail|auth|login|rate|quota|retry|reason|code)/i;

function extractAgentErrors(events) {
  const candidates = [];
  for (const event of events) {
    candidates.push(event.message);
    candidates.push(event.errorMessage);
    candidates.push(event.params?.update?.content?.text);
    candidates.push(event.params?.update?.error?.message);
    candidates.push(event.params?.update?.message);
    candidates.push(event.params?.error?.message);
    candidates.push(event.result?.error?.message);
    candidates.push(event.payload?.error?.message);
    candidates.push(...collectDiagnosticStrings(event.params));
    candidates.push(...collectDiagnosticStrings(event.payload));
  }
  return uniqueStrings(
    candidates
      .filter((value) => typeof value === "string")
      .map((value) => preview(value.trim().replace(/\s+/g, " "), 500))
      .filter(Boolean)
      .filter((value) => AGENT_ERROR_PATTERNS.some((pattern) => pattern.test(value)))
  ).slice(0, 10);
}

function collectDiagnosticStrings(value, depth = 0) {
  if (depth > 5 || value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectDiagnosticStrings(item, depth + 1));
  if (typeof value !== "object") return [];
  const values = [];
  for (const [key, child] of Object.entries(value)) {
    if (
      AGENT_ERROR_KEY_PATTERN.test(key)
      && (typeof child === "string" || typeof child === "number" || typeof child === "boolean")
    ) {
      values.push(`${key}: ${child}`);
    }
    values.push(...collectDiagnosticStrings(child, depth + 1));
  }
  return values;
}

function buildFailureReason(adapterLabel, error, agentErrors) {
  if (agentErrors.length > 0) {
    const suffix = error.code === "timeout" ? " (request timed out after agent error)" : "";
    return `${adapterLabel} failed: ${agentErrors.join("; ")}${suffix}`;
  }
  return `${adapterLabel} failed: ${error.message}`;
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function diffChangedFiles(beforeState, afterState) {
  const before = new Set(Array.isArray(beforeState?.preExistingChangedFiles) ? beforeState.preExistingChangedFiles : []);
  const after = Array.isArray(afterState?.preExistingChangedFiles) ? afterState.preExistingChangedFiles : [];
  const introduced = after.filter((file) => !before.has(file));
  return introduced.length > 0 ? introduced : after;
}

function buildAcpProcessClosedEvent(startedAt) {
  return {
    type: "acp_process_closed",
    timestamp: new Date().toISOString(),
    message: `OpenCode ACP adapter finished after ${Date.now() - startedAt}ms.`
  };
}

function buildCliProcessClosedEvent(label, startedAt, result) {
  return {
    type: "cli_process_closed",
    timestamp: new Date().toISOString(),
    message: `${label} CLI adapter finished after ${Date.now() - startedAt}ms with exitCode=${result.exitCode ?? "unknown"} signal=${result.signal ?? "none"}.`,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeEnv({ inheritEnvironment = true } = {}) {
  const env = inheritEnvironment ? { ...process.env } : {};
  return {
    ...env,
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? os.homedir(),
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    ...allowlistedAgentEnv()
  };
}

function allowlistedAgentEnv() {
  const env = {};
  for (const key of AGENT_ENV_ALLOWLIST) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

const AGENT_ENV_ALLOWLIST = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR"
];

function chooseAgent(agents, config, mode) {
  const disabled = new Set(config.disabledAgents ?? []);
  const available = agents.filter((agent) => agent.status === "available" && !disabled.has(agent.id));
  const explicit = config.defaultAgent && available.find((agent) => agent.id === config.defaultAgent);
  if (explicit) return { agentId: explicit.id, reason: "configured default agent" };
  const modeDefault = mode && config.modeDefaults?.[mode];
  const modeAgent = modeDefault && available.find((agent) => agent.id === modeDefault);
  if (modeAgent) return { agentId: modeAgent.id, reason: `configured default for ${mode}` };
  const acp = available.find((agent) => agent.transport === "acp_stdio");
  if (acp) return { agentId: acp.id, reason: "native ACP available" };
  return { agentId: null, reason: "no available ACP agent found; CLI fallback removed" };
}

function createId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}_${random}`;
}

function preview(value, maxLength) {
  const text = stripAnsi(String(value ?? "")).replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text;
}

function stripAnsi(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

async function hashText(text) {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(String(text)).digest("hex");
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toToolResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

async function startMcpServer() {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.tool(
    "discover_agents",
    "Discover locally installed coding agents and their ACP adapter status. Returns transport, ACP availability, registry metadata, and install hints.",
    {
      refresh: z.boolean().optional().describe("Force refresh the ACP registry cache"),
      includeNotInstalled: z.boolean().optional().describe("Include agents that are not currently installed")
    },
    async (args) => toToolResult(await discoverAgents({
      refresh: args.refresh === true,
      includeNotInstalled: args.includeNotInstalled !== false
    }))
  );

  server.tool(
    "manage_config",
    "Get or set Agent Router configuration including default agent, per-mode defaults, disabled agents, and safety policy.",
    {
      action: z.enum(["get", "set"]).describe("Get or set config"),
      defaultAgent: z.string().nullable().optional().describe("Default agent id to use when none is explicitly requested"),
      disabledAgents: z.array(z.string()).optional().describe("Agent ids to exclude from automatic selection"),
      allowCurrentDirectory: z.boolean().optional().describe("Allow dispatching agents in the current working directory"),
      registryEnabled: z.boolean().optional().describe("Enable ACP registry lookups for agent discovery"),
      registryUrl: z.string().optional().describe("ACP registry URL override"),
      registryCacheTtlSec: z.number().optional().describe("ACP registry cache TTL in seconds"),
      launchExternalAgents: z.boolean().optional().describe("Allow launching external agent processes"),
      allowBypassPermissions: z.boolean().optional().describe("Allow bypass_permissions permission profile"),
      inheritEnvironment: z.boolean().optional().describe("Inherit parent process environment for child agents"),
      modeDefaults: z.record(z.string(), z.unknown()).optional().describe("Per-mode default agent id mapping")
    },
    async (args) => {
      if (args.action === "get") {
        return toToolResult({ config: await readConfig() });
      }
      return toToolResult(await configureDispatcher(args));
    }
  );

  server.tool(
    "run_agent",
    "Run a coding agent in an isolated worktree. Requires an absolute worktree path. Supports sync and async execution. ACP-only — CLI fallback is not supported.",
    {
      agent: z.string().nullable().optional().describe("Agent id to run; omit for automatic selection"),
      worktree: z.string().describe("Absolute path to the worktree directory"),
      prompt: z.string().describe("Task prompt to send to the agent"),
      mode: z.string().optional().describe("Execution mode (e.g. implementation, planning)"),
      async: z.boolean().optional().describe("Return immediately and run the job in the background"),
      sessionId: z.string().nullable().optional().describe("Existing session id to continue"),
      timeoutSec: z.number().optional().describe("Job timeout in seconds"),
      permissionProfile: z.enum(["plan", "workspace_write", "accept_edits", "bypass_permissions"]).optional().describe("Permission profile for the agent"),
      collectDiff: z.boolean().optional().describe("Collect git diff before and after the run"),
      launchExternalAgents: z.boolean().optional().describe("Override config for launching external agents"),
      inheritEnvironment: z.boolean().optional().describe("Override config for inheriting parent environment"),
      metadata: z.record(z.string(), z.unknown()).optional().describe("Arbitrary metadata to attach to the job")
    },
    async (args) => toToolResult(await createJob(args))
  );

  server.tool(
    "list_jobs",
    "List Agent Router jobs from the local registry with optional filters.",
    {
      status: z.string().nullable().optional().describe("Filter by job status"),
      agent: z.string().nullable().optional().describe("Filter by agent id"),
      worktree: z.string().nullable().optional().describe("Filter by worktree path"),
      limit: z.number().optional().describe("Maximum number of jobs to return")
    },
    async (args) => toToolResult(await listJobs(args))
  );

  server.tool(
    "get_job",
    "Get an Agent Router job by id.",
    {
      jobId: z.string().describe("Job id to look up")
    },
    async (args) => toToolResult(await getJob(args))
  );

  server.tool(
    "tail_job_events",
    "Return newly recorded Agent Router job events from the JSONL event log for polling-style progress updates.",
    {
      jobId: z.string().describe("Job id to tail events for"),
      afterEventIndex: z.number().optional().describe("Return events after this index"),
      limit: z.number().optional().describe("Maximum number of events to return"),
      includeLogTail: z.boolean().optional().describe("Include a tail of the raw log file"),
      logTailBytes: z.number().optional().describe("Number of bytes to include in the log tail")
    },
    async (args) => toToolResult(await tailJobEvents(args))
  );

  server.tool(
    "cancel_job",
    "Cancel an Agent Router job and terminate an active child process when the current MCP server owns it.",
    {
      jobId: z.string().describe("Job id to cancel"),
      reason: z.string().optional().describe("Reason for cancellation")
    },
    async (args) => toToolResult(await cancelJob(args))
  );

  server.tool(
    "manage_sessions",
    "List, continue, or archive Agent Router sessions. Use action='list' to enumerate sessions, action='continue' to resume a session with a new prompt, or action='archive' to mark a session as archived.",
    {
      action: z.enum(["list", "continue", "archive"]).describe("Session action to perform"),
      includeArchived: z.boolean().optional().describe("Include archived sessions in list results"),
      agent: z.string().optional().describe("Filter by agent id (list) or specify agent for continue"),
      worktree: z.string().optional().describe("Filter by worktree path (list) or specify worktree for continue"),
      limit: z.number().optional().describe("Maximum number of sessions to return (list)"),
      sessionId: z.string().optional().describe("Session id to continue or archive"),
      prompt: z.string().optional().describe("Prompt to send when continuing a session"),
      async: z.boolean().optional().describe("Return immediately and run the job in the background (continue)"),
      launchExternalAgents: z.boolean().optional().describe("Override config for launching external agents (continue)"),
      inheritEnvironment: z.boolean().optional().describe("Override config for inheriting parent environment (continue)"),
      timeoutSec: z.number().optional().describe("Job timeout in seconds (continue)")
    },
    async (args) => {
      if (args.action === "list") {
        return toToolResult(await listSessions({
          includeArchived: args.includeArchived,
          agent: args.agent,
          worktree: args.worktree,
          limit: args.limit
        }));
      }
      if (args.action === "continue") {
        if (!args.sessionId) {
          return toToolResult({
            sessionId: null,
            status: "failed",
            error: "missing_session_id",
            message: "sessionId is required when action is 'continue'."
          });
        }
        return toToolResult(await continueSession({
          agent: args.agent,
          sessionId: args.sessionId,
          prompt: args.prompt,
          worktree: args.worktree,
          async: args.async,
          launchExternalAgents: args.launchExternalAgents,
          inheritEnvironment: args.inheritEnvironment,
          timeoutSec: args.timeoutSec
        }));
      }
      if (args.action === "archive") {
        if (!args.sessionId) {
          return toToolResult({
            sessionId: null,
            status: "failed",
            error: "missing_session_id",
            message: "sessionId is required when action is 'archive'."
          });
        }
        return toToolResult(await archiveSession({ sessionId: args.sessionId }));
      }
      return toToolResult({
        status: "failed",
        error: "invalid_action",
        message: `Unknown session action: ${args.action}`
      });
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    try {
      await server.close();
    } catch {
      // Ignore errors during shutdown
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export { startMcpServer };
