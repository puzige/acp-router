import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import { BUILT_IN_AGENTS, COMMAND_TIMEOUT_MS, CONFIG_PATH } from "./constants.mjs";
import { safeEnv, isPlainObject, execFileAsync } from "./utils.mjs";
import {
  readConfig,
  readAcpRegistry,
  writeJson,
  buildRegistryInstallHint,
  extractRegistryNpxPackage,
  buildNpxAcpFallback
} from "./storage.mjs";

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

function getAcpAdapterArgs(selectedAgent, worktree) {
  if (selectedAgent.id === "opencode") {
    return ["acp", "--cwd", worktree, "--print-logs", "--log-level", "INFO"];
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

export {
  discoverAgents,
  configureDispatcher,
  enrichAgentWithRegistry,
  probeAgent,
  compareExecutableProbe,
  compareVersionStrings,
  parseVersionParts,
  probeVersion,
  findExecutables,
  selectExecutable,
  chooseAgent,
  validateWorktree,
  collectWorktreeState,
  runGit,
  parseGitStatusFiles,
  getAcpAdapterArgs,
  resolveAcpLaunchTarget,
  isAcpRunReady,
  buildAcpUnavailableError,
  planLaunch
};
