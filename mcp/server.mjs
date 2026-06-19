#!/usr/bin/env node

import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { execFile, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const SERVER_NAME = "acp-coding-agent-dispatcher";
const SERVER_VERSION = "0.4.3";
const DATA_DIR = process.env.AGENT_DISPATCHER_DATA_DIR
  ? path.resolve(process.env.AGENT_DISPATCHER_DATA_DIR)
  : path.join(os.homedir(), ".codex", "agent-dispatcher");
const REGISTRY_PATH = path.join(DATA_DIR, "registry.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const LOG_DIR = path.join(DATA_DIR, "logs");
const COMMAND_TIMEOUT_MS = 3000;
const ACP_STARTUP_DELAY_MS = 300;
const execFileAsync = promisify(execFile);

const TOOL_DEFINITIONS = [
  {
    name: "discover_coding_agents",
    description: "Discover local coding agents from safe PATH inspection and dispatcher configuration.",
    inputSchema: {
      type: "object",
      properties: {
        refresh: { type: "boolean", default: false },
        includeNotInstalled: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_coding_agent_dispatcher_config",
    description: "Read dispatcher default agent, per-mode defaults, disabled agents, and safety policy.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "configure_coding_agent_dispatcher",
    description: "Update dispatcher configuration in the local Codex agent-dispatcher config file.",
    inputSchema: {
      type: "object",
      properties: {
        defaultAgent: { type: ["string", "null"] },
        modeDefaults: { type: "object", additionalProperties: { type: "string" } },
        disabledAgents: { type: "array", items: { type: "string" } },
        allowCurrentDirectory: { type: "boolean" },
        launchExternalAgents: { type: "boolean" },
        allowBypassPermissions: { type: "boolean" },
        inheritEnvironment: { type: "boolean" }
      },
      additionalProperties: false
    }
  },
  {
    name: "run_coding_agent",
    description: "Create a tracked coding-agent job and collect safe local registry/log metadata.",
    inputSchema: {
      type: "object",
      required: ["prompt", "worktree"],
      properties: {
        agent: { type: ["string", "null"] },
        worktree: { type: "string" },
        prompt: { type: "string" },
        mode: { type: "string", default: "implementation" },
        async: { type: "boolean", default: true },
        sessionId: { type: ["string", "null"] },
        timeoutSec: { type: "integer", minimum: 1, default: 3600 },
        permissionProfile: {
          type: "string",
          enum: ["plan", "workspace_write", "accept_edits", "bypass_permissions"],
          default: "workspace_write"
        },
        collectDiff: { type: "boolean", default: true },
        metadata: { type: "object", additionalProperties: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "list_coding_agent_jobs",
    description: "List dispatcher jobs from the local registry.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: ["string", "null"] },
        agent: { type: ["string", "null"] },
        worktree: { type: ["string", "null"] },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_coding_agent_job",
    description: "Get a dispatcher job by id.",
    inputSchema: {
      type: "object",
      required: ["jobId"],
      properties: {
        jobId: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "cancel_coding_agent_job",
    description: "Mark a local dispatcher job as cancelled. Future adapters will terminate the backing agent process.",
    inputSchema: {
      type: "object",
      required: ["jobId"],
      properties: {
        jobId: { type: "string" },
        reason: { type: "string" }
      },
      additionalProperties: false
    }
  },
  {
    name: "list_coding_agent_sessions",
    description: "List dispatcher sessions from the local registry.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: ["string", "null"] },
        worktree: { type: ["string", "null"] },
        includeArchived: { type: "boolean", default: false },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 }
      },
      additionalProperties: false
    }
  },
  {
    name: "continue_coding_agent_session",
    description: "Create a new tracked job attached to an existing dispatcher session.",
    inputSchema: {
      type: "object",
      required: ["agent", "sessionId", "prompt", "worktree"],
      properties: {
        agent: { type: "string" },
        sessionId: { type: "string" },
        prompt: { type: "string" },
        worktree: { type: "string" },
        async: { type: "boolean", default: true },
        timeoutSec: { type: "integer", minimum: 1, default: 3600 }
      },
      additionalProperties: false
    }
  },
  {
    name: "archive_coding_agent_session",
    description: "Mark a dispatcher session as archived in the local registry.",
    inputSchema: {
      type: "object",
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" }
      },
      additionalProperties: false
    }
  }
];

const BUILT_IN_AGENTS = [
  {
    id: "opencode",
    displayName: "OpenCode",
    executable: "opencode",
    versionArgs: ["--version"],
    transport: "acp_stdio",
    command: "opencode acp --cwd <worktree>",
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
    command: "agent --print --output-format stream-json --workspace <worktree>",
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
    capabilities: ["file_edit", "shell", "permission_modes", "diff_collection"],
    source: ["path"],
    notes: ["CLI fallback target."]
  },
  {
    id: "codex",
    displayName: "Codex CLI",
    executable: "codex",
    versionArgs: ["--version"],
    transport: "cli",
    command: "codex exec",
    capabilities: ["file_edit", "shell", "diff_collection"],
    source: ["path"],
    notes: ["Use cautiously to avoid recursive control loops; require an isolated worktree."]
  }
];

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  drainBuffer().catch((error) => {
    writeMessage({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32603, message: error.message }
    });
  });
});

async function drainBuffer() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.slice(0, headerEnd);
    const match = /^Content-Length:\s*(\d+)$/im.exec(header);
    if (!match) {
      buffer = "";
      throw new Error("Missing Content-Length header");
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) return;
    const raw = buffer.slice(bodyStart, bodyEnd);
    buffer = buffer.slice(bodyEnd);
    await handleMessage(JSON.parse(raw));
  }
}

async function handleMessage(message) {
  if (!message || typeof message !== "object") return;
  const { id, method, params } = message;

  if (id === undefined) return;

  try {
    if (method === "initialize") {
      return writeResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      });
    }
    if (method === "ping") return writeResult(id, {});
    if (method === "tools/list") return writeResult(id, { tools: TOOL_DEFINITIONS });
    if (method === "tools/call") {
      const result = await callTool(params?.name, params?.arguments ?? {});
      return writeResult(id, asToolResult(result));
    }
    writeError(id, -32601, `Unsupported method: ${method}`);
  } catch (error) {
    writeResult(id, asToolResult({ error: error.message }, true));
  }
}

async function callTool(name, args) {
  switch (name) {
    case "discover_coding_agents":
      return discoverAgents(args);
    case "get_coding_agent_dispatcher_config":
      return { config: await readConfig() };
    case "configure_coding_agent_dispatcher":
      return configureDispatcher(args);
    case "run_coding_agent":
      return createJob(args);
    case "list_coding_agent_jobs":
      return listJobs(args);
    case "get_coding_agent_job":
      return getJob(args);
    case "cancel_coding_agent_job":
      return cancelJob(args);
    case "list_coding_agent_sessions":
      return listSessions(args);
    case "continue_coding_agent_session":
      return continueSession(args);
    case "archive_coding_agent_session":
      return archiveSession(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function discoverAgents(args) {
  const config = await readConfig();
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const agents = await Promise.all(BUILT_IN_AGENTS.map((agent) => probeAgent(agent, config, pathEntries)));
  const filteredAgents = args.includeNotInstalled === false
    ? agents.filter((agent) => agent.status !== "not_installed")
    : agents;
  const recommended = chooseAgent(agents, config, null);
  return {
    agents: filteredAgents,
    recommendedDefaultAgent: recommended.agentId
      ? { agentId: recommended.agentId, reason: recommended.reason }
      : null,
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
    safety: nextSafety,
    updatedAt: new Date().toISOString()
  };
  await writeJson(CONFIG_PATH, next);
  return { config: next };
}

async function createJob(args) {
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
      message: "The dispatcher config does not allow bypass_permissions by default."
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
      message: "Another writable dispatcher job is already active for this worktree."
    };
  }

  const now = new Date().toISOString();
  const jobId = createId("job");
  const sessionId = args.sessionId || createId(`sess_${selected.agentId}`);
  const logPath = path.join(LOG_DIR, `${jobId}.jsonl`);
  const worktreeState = args.collectDiff === false
    ? { skipped: true, reason: "collectDiff disabled" }
    : await collectWorktreeState(args.worktree);
  const launchingEnabled = config.safety.launchExternalAgents === true;
  const agentEnv = safeEnv({ inheritEnvironment: config.safety.inheritEnvironment === true });
  const launchPlan = planLaunch({ launchingEnabled, selectedAgent, async: args.async });
  const adapterStatus = launchPlan.adapterStatus;
  const initialStatus = launchPlan.runnable ? "running" : launchPlan.status;
  const initialSummary = launchPlan.summary;
  const initialRisks = launchPlan.risks;
  const recentEvents = [
    {
      type: "job_created",
      timestamp: now,
      message: "Job recorded in local dispatcher registry."
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
    resultSummary: initialSummary,
    changedFiles: [],
    validation: [],
    risks: initialRisks,
    logPath,
    adapterStatus,
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
    const runResult = launchPlan.kind === "opencode_acp"
      ? await runOpenCodeAcpJob({
        args,
        job,
        session,
        selectedAgent,
        timeoutSec: args.timeoutSec ?? 3600,
        agentEnv
      })
      : await runCliFallbackJob({
        args,
        job,
        session,
        selectedAgent,
        timeoutSec: args.timeoutSec ?? 3600,
        agentEnv
      });
    Object.assign(job, runResult.jobPatch);
    Object.assign(session, runResult.sessionPatch);
    job.recentEvents = [...job.recentEvents, ...runResult.events];
    session.updatedAt = job.endedAt;
    session.lastJobId = jobId;
    registry.sessions[sessionId] = session;
    registry.jobs[jobId] = job;
    await writeRegistry(registry);
    await appendJsonl(logPath, runResult.events.map((event) => ({ ...event, jobId, sessionId, agentId: selected.agentId })));
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
    selectionReason: selected.reason,
    message: `${selected.agentId} job recorded by dispatcher alpha. Use get_coding_agent_job to inspect it.`
  };
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

async function cancelJob(args) {
  const registry = await readRegistry();
  const job = registry.jobs[args.jobId];
  if (!job) return { jobId: args.jobId, status: "not_found" };
  if (!["completed", "failed", "cancelled", "timed_out"].includes(job.status)) {
    job.status = "cancelled";
    job.endedAt = new Date().toISOString();
    job.recentEvents = [
      ...(job.recentEvents ?? []),
      {
        type: "cancelled",
        timestamp: job.endedAt,
        message: args.reason || "Cancelled by dispatcher caller."
      }
    ];
    await writeRegistry(registry);
    await appendJsonl(job.logPath, job.recentEvents.slice(-1).map((event) => ({ ...event, jobId: job.jobId, sessionId: job.sessionId, agentId: job.agentId })));
  }
  return { jobId: job.jobId, status: job.status };
}

async function listSessions(args) {
  const registry = await readRegistry();
  const limit = args.limit ?? 50;
  const sessions = Object.values(registry.sessions)
    .filter((session) => args.includeArchived || session.status !== "archived")
    .filter((session) => !args.agent || session.agentId === args.agent)
    .filter((session) => !args.worktree || session.worktree === args.worktree)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, limit);
  return { sessions };
}

async function continueSession(args) {
  const registry = await readRegistry();
  const session = registry.sessions[args.sessionId];
  if (!session) {
    return {
      sessionId: args.sessionId,
      status: "not_found",
      message: "The V1 scaffold can only continue sessions already recorded in the dispatcher registry."
    };
  }
  return createJob({
    agent: args.agent,
    sessionId: args.sessionId,
    prompt: args.prompt,
    worktree: args.worktree,
    async: args.async,
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
  const defaults = {
    defaultAgent: null,
    modeDefaults: {},
    disabledAgents: [],
    allowCurrentDirectory: false,
    safety: {
      requireAbsoluteWorktree: true,
      launchExternalAgents: false,
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
    safety: {
      ...defaults.safety,
      ...(isPlainObject(stored.safety) ? stored.safety : {})
    }
  };
}

async function readRegistry() {
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

  const probes = await Promise.all(candidates.map(async (candidate) => ({
    path: candidate,
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

async function probeAgent(agent, config, pathEntries) {
  const selection = await selectExecutable(agent, pathEntries);
  const installedPath = selection.installedPath;
  const disabled = config.disabledAgents.includes(agent.id);
  const notes = installedPath ? [`Found at ${installedPath}`] : agent.notes;
  if (selection.selectionNote) notes.push(selection.selectionNote);
  if (selection.note) notes.push(selection.note);
  return {
    id: agent.id,
    displayName: agent.displayName,
    status: disabled ? "disabled" : installedPath ? "available" : "not_installed",
    version: selection.version,
    installedPath,
    transport: agent.transport,
    command: agent.command,
    source: agent.source,
    capabilities: agent.capabilities,
    icon: null,
    notes
  };
}

function compareExecutableProbe(a, b) {
  const versionComparison = compareVersionStrings(b.version, a.version);
  if (versionComparison !== 0) return versionComparison;
  return a.path.localeCompare(b.path);
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
    && ["queued", "starting", "running"].includes(job.status)
  )) ?? null;
}

function planLaunch({ launchingEnabled, selectedAgent, async }) {
  if (!launchingEnabled) {
    return {
      kind: "record_only",
      runnable: false,
      status: "completed",
      adapterStatus: "record_only",
      summary: "Recorded dispatcher job, selected agent, session binding, and current worktree state without launching an external process.",
      risks: ["No external agent process was launched in this alpha build."]
    };
  }
  if (async !== false) {
    return {
      kind: "unsupported",
      runnable: false,
      status: "failed",
      adapterStatus: "async_not_implemented",
      summary: "External launch currently requires async=false.",
      risks: ["External launch was requested, but async job execution is not implemented yet."]
    };
  }
  if (selectedAgent.id === "opencode") {
    return {
      kind: "opencode_acp",
      runnable: true,
      adapterStatus: "starting",
      summary: "Starting OpenCode ACP adapter.",
      risks: []
    };
  }
  const cliSpec = getCliAdapterSpec(selectedAgent.id);
  if (cliSpec) {
    return {
      kind: "cli_fallback",
      runnable: true,
      adapterStatus: "starting",
      summary: `Starting ${selectedAgent.displayName} CLI fallback adapter.`,
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

async function runOpenCodeAcpJob({ args, job, session, selectedAgent, timeoutSec, agentEnv }) {
  const events = [];
  const startedAt = Date.now();
  let providerSessionId = session.providerSessionId ?? null;
  let agentConfigOptions = [];
  let availableModels = [];
  const client = new AcpStdioClient({
    command: selectedAgent.installedPath ?? selectedAgent.executable ?? "opencode",
    args: ["acp", "--cwd", args.worktree, "--print-logs", "--log-level", "ERROR"],
    cwd: args.worktree,
    timeoutMs: timeoutSec * 1000,
    env: agentEnv,
    onEvent: (event) => events.push(event)
  });

  try {
    await client.start();
    const initialize = await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: {
        name: SERVER_NAME,
        title: "ACP Coding Agent Dispatcher",
        version: SERVER_VERSION
      }
    });
    events.push({
      type: "acp_initialize",
      timestamp: new Date().toISOString(),
      message: "OpenCode ACP initialized.",
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
      message: `OpenCode ACP session ready: ${providerSessionId}`,
      providerSessionId
    });
    if (agentConfigOptions.length > 0) {
      events.push({
        type: "acp_config_options",
        timestamp: new Date().toISOString(),
        message: `OpenCode ACP exposed ${agentConfigOptions.length} config option(s), including ${availableModels.length} model option(s).`,
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
          message: `OpenCode ACP prompt completed with stopReason=${stopReason ?? "unknown"}.`,
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
        adapterStatus: "opencode_acp",
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
        resultSummary: agentText || `OpenCode ACP completed with stopReason=${stopReason ?? "unknown"}.`,
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
    const failureReason = buildFailureReason("OpenCode ACP", error, agentErrors);
    return {
      events: [
        ...collectedEvents,
        {
          type: "acp_error",
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
        status: error.code === "timeout" ? "timed_out" : "failed",
        endedAt: failedAt,
        adapterStatus: "opencode_acp",
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
        risks: ["Inspect the job log before re-running the agent."]
      }
    };
  } finally {
    client.dispose();
  }
}

async function runCliFallbackJob({ args, job, session, selectedAgent, timeoutSec, agentEnv }) {
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
    env: agentEnv
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
        "--cwd",
        worktree,
        "--output-format",
        "streaming-json",
        "--permission-mode",
        mapAgentPermissionMode(permissionProfile),
        ...(providerSessionId ? ["--resume", providerSessionId] : []),
        "--single",
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

function mapCodexSandbox(permissionProfile) {
  if (permissionProfile === "plan") return "read-only";
  return "workspace-write";
}

function runCliProcess({ command, args, cwd, timeoutMs, env }) {
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
      resolve({ stdout, stderr, exitCode, signal, timedOut, error: processError });
    });
  });
}

function appendLimited(current, chunk, maxLength) {
  if (current.length >= maxLength) return current;
  const next = `${current}${chunk}`;
  if (next.length <= maxLength) return next;
  return `${next.slice(0, maxLength)}\n[dispatcher truncated captured output]\n`;
}

class AcpStdioClient {
  constructor({ command, args, cwd, timeoutMs, env, onEvent }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.env = env ?? safeEnv();
    this.onEvent = onEvent;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.logEvents = [];
    this.child = null;
    this.startError = null;
  }

  async start() {
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.env
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
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
        message: "Dispatcher cancelled an ACP permission request.",
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
  /rate limit/i,
  /quota/i,
  /unauthorized/i,
  /forbidden/i,
  /permission denied/i,
  /auth(?:entication)? failed/i,
  /failed to authenticate/i,
  /not logged in/i,
  /\berror\b/i
];

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
    candidates.push(...collectStrings(event.payload));
  }
  return uniqueStrings(
    candidates
      .filter((value) => typeof value === "string")
      .map((value) => preview(value.trim().replace(/\s+/g, " "), 500))
      .filter(Boolean)
      .filter((value) => AGENT_ERROR_PATTERNS.some((pattern) => pattern.test(value)))
  ).slice(0, 5);
}

function collectStrings(value, depth = 0) {
  if (depth > 5 || value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item, depth + 1));
  if (typeof value !== "object") return [];
  return Object.values(value).flatMap((item) => collectStrings(item, depth + 1));
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
  const cli = available.find((agent) => agent.transport === "cli");
  if (cli) return { agentId: cli.id, reason: "CLI fallback available" };
  return { agentId: null, reason: "no available agent found" };
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

function asToolResult(payload, isError = false) {
  return {
    isError,
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function writeResult(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function writeError(id, code, message) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function writeMessage(message) {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}
