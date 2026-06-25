import path from "node:path";

import {
  MAX_RECURSION_DEPTH,
  LOG_DIR,
  ACTIVE_JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  SERVER_NAME,
  SERVER_VERSION,
  COMMAND_TIMEOUT_MS
} from "./constants.js";
import {
  safeEnv,
  clampInteger,
  preview,
  hashText,
  isPlainObject,
  createId,
  resolveBooleanOverride
} from "./utils.js";
import {
  readConfig,
  readRegistry,
  writeRegistry,
  readJobEventLog,
  readLogTail,
  recordJobProcess,
  normalizeProcessInfo,
  appendJsonl
} from "./storage.js";
import {
  discoverAgents,
  chooseAgent,
  validateWorktree,
  collectWorktreeState,
  isAcpRunReady,
  buildAcpUnavailableError,
  planLaunch,
  resolveAcpLaunchTarget
} from "./agents.js";
import { AcpStdioClient, runAcpStdioJob } from "./acp-client.js";

interface JobArgs {
  agent?: string | null;
  worktree: string;
  prompt: string;
  mode?: string;
  async?: boolean;
  sessionId?: string | null;
  timeoutSec?: number;
  permissionProfile?: string;
  model?: string;
  collectDiff?: boolean;
  launchExternalAgents?: boolean;
  inheritEnvironment?: boolean;
  metadata?: Record<string, unknown>;
}

interface RunController {
  jobId: string;
  cancelRequested: boolean;
  cancelReason: string | null;
  cancelProcess: (() => boolean) | null;
  processInfo: any | null;
  recordProcess: (info: any) => Promise<void>;
  cancel: (reason?: string) => boolean;
}

interface RunRequest {
  args: JobArgs;
  job: any;
  session: any;
  selectedAgent: any;
  timeoutSec: number;
  agentEnv: Record<string, string | undefined>;
  launchKind: string;
}

interface ListJobsArgs {
  limit?: number;
  status?: string | null;
  agent?: string | null;
  worktree?: string | null;
}

interface GetJobArgs {
  jobId: string;
}

interface TailJobEventsArgs {
  jobId: string;
  afterEventIndex?: number;
  limit?: number;
  includeLogTail?: boolean;
  logTailBytes?: number;
}

interface CancelJobArgs {
  jobId: string;
  reason?: string;
}

interface ListSessionsArgs {
  includeArchived?: boolean;
  agent?: string | null;
  worktree?: string | null;
  limit?: number;
}

interface ContinueSessionArgs {
  agent?: string | null;
  sessionId: string;
  prompt?: string;
  worktree?: string;
  async?: boolean;
  launchExternalAgents?: boolean;
  inheritEnvironment?: boolean;
  timeoutSec?: number;
}

interface ArchiveSessionArgs {
  sessionId: string;
}

const ACTIVE_RUNS = new Map<string, RunController>();

async function createJob(args: JobArgs): Promise<any> {
  // Built-in prompt to prevent subagents from spawning further subagents
  if (args.prompt && !args.prompt.includes("不允许派发的subagent 继续开subagent")) {
    args.prompt += "\n\nIMPORTANT INSTRUCTION: 不允许派发的subagent 继续开subagent";
  }

  const recursionDepth = Number.parseInt(process.env.ACP_ROUTER_DEPTH ?? "0", 10) || 0;
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
  if (permissionProfile === "bypassPermissions" && !config.safety.allowBypassPermissions) {
    return {
      status: "failed",
      error: "bypassPermissions_disabled",
      message: "The Agent Router config does not allow bypassPermissions by default."
    };
  }

  const availableAgents = await discoverAgents({ includeNotInstalled: false }).then((value) => value.agents);
  const selected = args.agent
    ? { agentId: args.agent, reason: "agent explicitly requested" }
    : chooseAgent(availableAgents, config as any, mode);
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

  const job: any = {
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
    const runRequest: RunRequest = {
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

function startBackgroundJobRun(runRequest: RunRequest): void {
  executeAndPersistJobRun(runRequest).catch(async (error) => {
    await markJobRunCrashed(runRequest, error);
  });
}

async function executeAndPersistJobRun({ args, job, session, selectedAgent, timeoutSec, agentEnv, launchKind }: RunRequest): Promise<void> {
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

function createRunController(jobId: string): RunController {
  return {
    jobId,
    cancelRequested: false,
    cancelReason: null,
    cancelProcess: null,
    processInfo: null,
    async recordProcess(processInfo: any) {
      const normalized = normalizeProcessInfo(processInfo);
      if (!normalized) return;
      this.processInfo = normalized;
      await recordJobProcess(this.jobId, normalized);
    },
    cancel(reason?: string) {
      this.cancelRequested = true;
      this.cancelReason = reason || "Cancelled by Agent Router caller.";
      if (typeof this.cancelProcess === "function") {
        return Boolean(this.cancelProcess());
      }
      return false;
    }
  };
}

async function persistJobRunResult({ job, session, selectedAgent, runResult }: {
  job: any;
  session: any;
  selectedAgent: any;
  runResult: any;
}): Promise<void> {
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
  currentJob.recentEvents = [...(currentJob.recentEvents ?? []), ...runResult.events].slice(-5);
  (currentSession as any).updatedAt = currentJob.endedAt;
  (currentSession as any).lastJobId = currentJob.jobId;
  registry.jobs[currentJob.jobId] = currentJob;
  registry.sessions[currentSession.sessionId] = currentSession;
  await writeRegistry(registry);
}

async function markJobRunCrashed(runRequest: RunRequest, error: Error): Promise<void> {
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

async function listJobs(args: ListJobsArgs): Promise<{ jobs: any[] }> {
  const registry = await readRegistry();
  const limit = args.limit ?? 50;
  const jobs = Object.values(registry.jobs)
    .filter((job) => !args.status || job.status === args.status)
    .filter((job) => !args.agent || job.agentId === args.agent)
    .filter((job) => !args.worktree || job.worktree === args.worktree)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, limit)
    .map((job) => {
      const { recentEvents, availableModels, agentConfigOptions, process, validation, ...lightweight } = job;
      return lightweight;
    });
  return { jobs };
}

async function getJob(args: GetJobArgs): Promise<any> {
  const registry = await readRegistry();
  const job = registry.jobs[args.jobId];
  if (!job) return { jobId: args.jobId, status: "not_found" };
  const { recentEvents, availableModels, agentConfigOptions, process, validation, ...lightweight } = job;
  return { job: lightweight };
}

async function tailJobEvents(args: TailJobEventsArgs): Promise<any> {
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

  const limit = clampInteger(args.limit, 5, 1, 200);
  const afterEventIndex = Number.isInteger(args.afterEventIndex) ? args.afterEventIndex : null;
  
  const eventLog = await readJobEventLog(job.logPath);
  const filteredEvents = eventLog.events.filter((e) => !["acp_agent_message_chunk", "acp_tool_call_chunk", "acp_llm_token", "model_completion_chunk"].includes(String(e.type)));
  
  const actualStartIndex = afterEventIndex == null 
    ? 0 
    : filteredEvents.findIndex(e => (e.eventIndex ?? 0) > afterEventIndex);
  
  const startIndex = actualStartIndex === -1 && afterEventIndex != null ? filteredEvents.length : actualStartIndex;

  const totalEvents = eventLog.events.length;
  const events = filteredEvents.slice(startIndex, startIndex + limit);
  const lastReturned = events.length > 0
    ? events[events.length - 1].eventIndex
    : afterEventIndex;
  const result: any = {
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
    hasMore: startIndex + events.length < filteredEvents.length,
    totalEventCount: totalEvents
  };
  if (eventLog.note) result.note = eventLog.note;
  if (eventLog.parseErrors.length > 0) result.parseErrors = eventLog.parseErrors;
  // Log tail is forcefully disabled to avoid token bloat
  return result;
}

async function cancelJob(args: CancelJobArgs): Promise<any> {
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
    ].slice(-5);
    await writeRegistry(registry);
    await appendJsonl(job.logPath ?? "", job.recentEvents.slice(-1).map((event) => ({ ...event, jobId: job.jobId, sessionId: job.sessionId, agentId: job.agentId })));
  }
  return { jobId: job.jobId, status: job.status, activeProcessCancelled };
}

async function listSessions(args: ListSessionsArgs): Promise<any> {
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

function compactSessionForList(session: any): any {
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

async function maybeListNativeSessions({ args, config, registry }: {
  args: ListSessionsArgs;
  config: any;
  registry: any;
}): Promise<{ sessions: any[]; meta: any }> {
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

  const sessions: any[] = [];
  const agents: any[] = [];
  const results = await Promise.allSettled(acpAgents.map((agent) => listAcpNativeSessions({
    selectedAgent: agent,
    worktree: args.worktree ?? null,
    env: safeEnv({ inheritEnvironment: config.safety.inheritEnvironment === true })
  }).then((result) => ({ agent, result }))));
  for (const settled of results) {
    if (settled.status === "fulfilled") {
      const { agent, result } = settled.value;
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
    } else {
      const agent = acpAgents[results.indexOf(settled)];
      agents.push({
        attempted: true,
        agentId: agent.id,
        supported: null,
        error: settled.reason?.message ?? String(settled.reason)
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

async function listAcpNativeSessions({ selectedAgent, worktree, env }: {
  selectedAgent: any;
  worktree: string | null;
  env: Record<string, string | undefined>;
}): Promise<{ supported: boolean; sessions: any[]; pages: number; nextCursor: string | null }> {
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

    const sessions: any[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const params: any = {};
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

async function readAcpSession({ selectedAgent, providerSessionId, worktree, env }: {
  selectedAgent: any;
  providerSessionId: string;
  worktree: string | null;
  env: Record<string, string | undefined>;
}): Promise<{ supported: boolean; events: any[]; sessionInfo: any }> {
  const cwd = worktree ?? process.cwd();
  const launchTarget = resolveAcpLaunchTarget(selectedAgent.acp, selectedAgent, cwd);
  if (!launchTarget) throw new Error(`No ACP adapter is available for ${selectedAgent.id}.`);
  const events: any[] = [];
  const client = new AcpStdioClient({
    command: launchTarget.command,
    args: launchTarget.args,
    cwd,
    timeoutMs: 30000,
    env,
    onEvent: (event: any) => {
      events.push(event);
    }
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
    const supported = Boolean(initialize?.agentCapabilities?.loadSession);
    if (!supported) return { supported: false, events: [], sessionInfo: null };

    const result = await client.request("session/load", {
      sessionId: providerSessionId,
      cwd,
      mcpServers: []
    });
    return {
      supported: true,
      events,
      sessionInfo: {
        sessionId: providerSessionId,
        replayedEvents: events.length,
        loadResult: result
      }
    };
  } finally {
    client.dispose();
  }
}

async function readSession(args: { sessionId: string; agent?: string; worktree?: string }): Promise<any> {
  const registry = await readRegistry();
  const config = await readConfig();

  const localSession = registry.sessions[args.sessionId];
  const isNative = args.sessionId.startsWith("sess_native_");
  let agentId: string | null = null;
  let providerSessionId: string | null = null;
  let worktree: string | null = args.worktree ?? null;

  if (localSession) {
    agentId = typeof localSession.agentId === "string" ? localSession.agentId : null;
    providerSessionId = typeof localSession.providerSessionId === "string" ? localSession.providerSessionId : args.sessionId;
    worktree = worktree ?? (typeof localSession.worktree === "string" ? localSession.worktree : null);
  } else if (isNative) {
    const parsed = parseNativeDispatcherSessionId(args.sessionId);
    if (parsed) {
      agentId = parsed.agentId;
      providerSessionId = parsed.providerSessionId;
    }
  }

  if (args.agent) agentId = args.agent;
  if (!agentId) {
    return { error: "agent_not_found", message: "Could not determine agent for session." };
  }

  const { agents } = await discoverAgents({ includeNotInstalled: false });
  const selectedAgent = agents.find((a: any) => a.id === agentId);
  if (!selectedAgent) {
    return { error: "agent_not_found", agentId, message: `Agent ${agentId} not found.` };
  }
  if (!selectedAgent.acp?.available) {
    return { error: "acp_not_available", agentId };
  }

  const env = safeEnv({ inheritEnvironment: config.safety.inheritEnvironment === true });
  try {
    const result = await readAcpSession({
      selectedAgent,
      providerSessionId: providerSessionId ?? args.sessionId,
      worktree,
      env
    });
    return {
      sessionId: args.sessionId,
      agentId,
      providerSessionId,
      worktree,
      ...result
    };
  } catch (error) {
    return {
      sessionId: args.sessionId,
      agentId,
      providerSessionId,
      error: "read_failed",
      message: (error as Error).message
    };
  }
}

function mapNativeSessions({ nativeSessions, registry, args, agentId }: {
  nativeSessions: any[];
  registry: any;
  args: ListSessionsArgs;
  agentId: string;
}): any[] {
  const localByProvider = new Map<string, any>();
  for (const session of Object.values(registry.sessions)) {
    if (isPlainObject(session) && session.providerSessionId) {
      localByProvider.set(session.providerSessionId, session);
    }
  }

  const result: any[] = [];
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

function mergeSessionLists({ localSessions, nativeSessions, limit }: {
  localSessions: any[];
  nativeSessions: any[];
  limit: number;
}): any[] {
  const byId = new Map<string, any>();
  for (const session of [...localSessions, ...nativeSessions]) {
    if (!session?.sessionId) continue;
    byId.set(session.sessionId, { ...(byId.get(session.sessionId) ?? {}), ...session });
  }
  return Array.from(byId.values())
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, limit);
}

function createNativeDispatcherSessionId(agentId: string, providerSessionId: string): string {
  return `sess_native_${agentId}_${encodeBase64Url(providerSessionId)}`;
}

function parseNativeDispatcherSessionId(sessionId: string): { agentId: string; providerSessionId: string } | null {
  const match = /^sess_native_([^_]+)_(.+)$/.exec(String(sessionId ?? ""));
  if (!match) return null;
  const providerSessionId = decodeBase64Url(match[2]);
  if (!providerSessionId) return null;
  return {
    agentId: match[1],
    providerSessionId
  };
}

function encodeBase64Url(value: string): string {
  return Buffer.from(String(value), "utf8")
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): string | null {
  try {
    const base64 = String(value).replaceAll("-", "+").replaceAll("_", "/");
    const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
    return Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }
}

async function continueSession(args: ContinueSessionArgs): Promise<any> {
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
      lastJobId: undefined,
      source: "agent_native",
      canContinue: true
    } as any;
    registry.sessions[session.sessionId] = session;
    await writeRegistry(registry);
  }
  return createJob({
    agent: args.agent,
    sessionId: args.sessionId,
    prompt: args.prompt ?? "",
    worktree: args.worktree ?? "",
    async: args.async,
    launchExternalAgents: args.launchExternalAgents,
    inheritEnvironment: args.inheritEnvironment,
    timeoutSec: args.timeoutSec,
    mode: "implementation",
    permissionProfile: "bypassPermissions",
    collectDiff: true
  });
}

async function archiveSession(args: ArchiveSessionArgs): Promise<any> {
  const registry = await readRegistry();
  const session = registry.sessions[args.sessionId];
  if (!session) return { sessionId: args.sessionId, status: "not_found" };
  session.status = "archived";
  session.updatedAt = new Date().toISOString();
  await writeRegistry(registry);
  return { sessionId: session.sessionId, status: session.status };
}

function findActiveWorktreeJob(registry: any, worktree: string, permissionProfile: string): any | null {
  if (permissionProfile === "plan") return null;
  return (Object.values(registry.jobs) as any[]).find((job) => (
    job.worktree === worktree
    && job.permissionProfile !== "plan"
    && ACTIVE_JOB_STATUSES.has(job.status)
  )) ?? null;
}

export {
  ACTIVE_RUNS,
  createJob,
  startBackgroundJobRun,
  executeAndPersistJobRun,
  createRunController,
  persistJobRunResult,
  markJobRunCrashed,
  listJobs,
  getJob,
  tailJobEvents,
  cancelJob,
  listSessions,
  compactSessionForList,
  maybeListNativeSessions,
  listAcpNativeSessions,
  mapNativeSessions,
  mergeSessionLists,
  createNativeDispatcherSessionId,
  parseNativeDispatcherSessionId,
  encodeBase64Url,
  decodeBase64Url,
  continueSession,
  archiveSession,
  readSession,
  findActiveWorktreeJob
};
