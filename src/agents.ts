import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

import { AGENT_OVERRIDES, COMMAND_TIMEOUT_MS, CONFIG_PATH } from "./constants.js";
import type { AgentOverride } from "./constants.js";
import { safeEnv, isPlainObject, execFileAsync } from "./utils.js";
import {
  readConfig,
  readAcpRegistry,
  writeJson,
  buildRegistryInstallHint,
  extractRegistryNpxPackage,
  extractRegistryNpxArgs,
  buildNpxAcpFallback,
  getRegistryPlatformKey
} from "./storage.js";

interface DispatcherConfig {
  defaultAgent: string | null;
  modeDefaults: Record<string, unknown>;
  disabledAgents: string[];
  allowCurrentDirectory: boolean;
  registryEnabled: boolean;
  registryUrl: string;
  registryCacheTtlSec: number;
  safety: {
    requireAbsoluteWorktree: boolean;
    launchExternalAgents: boolean;
    defaultPermissionProfile: string;
    allowBypassPermissions: boolean;
    inheritEnvironment: boolean;
  };
  updatedAt: string | null;
}

interface ConfigureDispatcherArgs {
  defaultAgent?: string | null;
  modeDefaults?: Record<string, string>;
  disabledAgents?: string[];
  allowCurrentDirectory?: boolean;
  registryEnabled?: boolean;
  registryUrl?: string;
  registryCacheTtlSec?: number;
  launchExternalAgents?: boolean;
  allowBypassPermissions?: boolean;
  defaultPermissionProfile?: string;
  inheritEnvironment?: boolean;
}

interface DiscoverAgentsArgs {
  refresh?: boolean;
  includeNotInstalled?: boolean;
  excludeAgent?: string;
}

interface AcpAdapterSpec {
  executable: string;
  installedPath: string | null;
  version: string | null;
  adapterStatus: string;
  label: string;
  buildArgsKey: string;
  available: boolean;
  launchMode?: string | null;
  launchCommand?: string[] | null;
  baseArgs: string[];
  extraArgs: string[];
}

interface EnrichedAgent {
  id: string;
  displayName: string;
  status: "available" | "not_installed" | "disabled";
  version: string | null;
  installedPath: string | null;
  transport: string;
  command: string;
  acp: AcpAdapterSpec | null;
  source: string[];
  capabilities: string[];
  icon: any;
  notes: string[];
  registry?: any;
  description?: string | null;
}

interface DiscoverAgentsResult {
  agents: EnrichedAgent[];
  recommendedDefaultAgent: { agentId: string; reason: string } | null;
  excludedAgentId: string | null;
  registry: any;
  refreshedAt: string;
}

interface AcpRegistryResult {
  agentsByRouterId: Map<string, any>;
  meta: any;
}

interface ExecutableProbe {
  path: string;
  index: number;
  version: string | null;
  note: string | null;
}

interface SelectExecutableResult {
  installedPath: string | null;
  version: string | null;
  note: string | null;
  candidates: ExecutableProbe[];
  selectionNote: string | null;
}

interface ProbeVersionResult {
  version: string | null;
  note: string | null;
}

interface ChooseAgentResult {
  agentId: string | null;
  reason: string;
}

interface ValidateWorktreeResult {
  ok: boolean;
  reason?: string;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  error?: string;
}

interface WorktreeState {
  isGitRepository: boolean;
  gitRoot?: string;
  currentBranch: string | null;
  preExistingChangedFiles: string[];
  note?: string;
  statusProbeError?: string | null;
}

interface LaunchTarget {
  command: string;
  args: string[];
  processLabel: string;
}

interface LaunchPlan {
  kind: "record_only" | "acp_stdio" | "unsupported";
  runnable: boolean;
  status?: string;
  adapterStatus: string;
  summary: string;
  risks: string[];
}

interface PlanLaunchArgs {
  launchingEnabled: boolean;
  selectedAgent: EnrichedAgent;
}

async function discoverAgents(args: DiscoverAgentsArgs): Promise<DiscoverAgentsResult> {
  const config = await readConfig() as DispatcherConfig;
  const pathEntries = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const acpRegistry = await readAcpRegistry(config as any, { refresh: args.refresh === true });
  const registryAgents = Array.from(acpRegistry.agentsByRouterId.entries());
  const agents = await Promise.all(registryAgents.map(async ([routerId, registryAgent]) => {
    const override = AGENT_OVERRIDES[routerId];
    return probeRegistryAgent(registryAgent, routerId, override, config, pathEntries);
  }));
  const filteredAgents = args.includeNotInstalled === false
    ? agents.filter((agent) => agent.status !== "not_installed")
    : agents;
  const visibleAgents = args.excludeAgent
    ? filteredAgents.filter((agent) => agent.id !== args.excludeAgent)
    : filteredAgents;
  return {
    agents: visibleAgents,
    recommendedDefaultAgent: null,
    excludedAgentId: args.excludeAgent ?? null,
    registry: acpRegistry.meta,
    refreshedAt: new Date().toISOString()
  };
}

async function configureDispatcher(args: ConfigureDispatcherArgs): Promise<{ config: DispatcherConfig }> {
  const existing = await readConfig() as DispatcherConfig;
  const nextSafety = {
    ...existing.safety,
    launchExternalAgents: typeof args.launchExternalAgents === "boolean"
      ? args.launchExternalAgents
      : existing.safety.launchExternalAgents,
    allowBypassPermissions: typeof args.allowBypassPermissions === "boolean"
      ? args.allowBypassPermissions
      : existing.safety.allowBypassPermissions,
    defaultPermissionProfile: typeof args.defaultPermissionProfile === "string"
      ? args.defaultPermissionProfile
      : existing.safety.defaultPermissionProfile,
    inheritEnvironment: typeof args.inheritEnvironment === "boolean"
      ? args.inheritEnvironment
      : existing.safety.inheritEnvironment
  };
  const next = {
    ...existing,
    defaultAgent: Object.prototype.hasOwnProperty.call(args, "defaultAgent")
      ? (args.defaultAgent ?? null)
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
      ? (args.registryCacheTtlSec as number)
      : existing.registryCacheTtlSec,
    safety: nextSafety,
    updatedAt: new Date().toISOString()
  };
  await writeJson(CONFIG_PATH, next);
  return { config: next };
}

function extractRegistryBinaryInfo(registryAgent: any): { cmd: string; args: string[] } | null {
  const distribution = registryAgent.distribution;
  const binary = distribution?.binary;
  if (!isPlainObject(binary)) return null;
  const platformKey = getRegistryPlatformKey();
  const target = (binary as Record<string, any>)[platformKey] ?? Object.values(binary).find(isPlainObject);
  if (!isPlainObject(target) || typeof target.cmd !== "string") return null;
  const args = Array.isArray(target.args) ? target.args.filter((a: unknown) => typeof a === "string") : [];
  return { cmd: target.cmd, args };
}

async function probeRegistryAgent(
  registryAgent: any,
  routerId: string,
  override: AgentOverride | undefined,
  config: DispatcherConfig,
  pathEntries: string[]
): Promise<EnrichedAgent> {
  const binaryInfo = extractRegistryBinaryInfo(registryAgent);
  const npxPackage = extractRegistryNpxPackage(registryAgent);
  const npxArgs = extractRegistryNpxArgs(registryAgent);
  const hasBinary = binaryInfo !== null;
  const hasNpx = npxPackage !== null;
  const registryVersion = typeof registryAgent.version === "string" && registryAgent.version.trim()
    ? registryAgent.version.trim()
    : null;
  const installHint = buildRegistryInstallHint(registryAgent);
  const extraArgs = override?.extraAcpArgs ?? [];

  let mainExecutable: string | null = null;
  let acpExecutable: string | null = null;

  if (hasBinary) {
    mainExecutable = override?.executable ?? path.basename(binaryInfo!.cmd);
    acpExecutable = override?.acpExecutable ?? mainExecutable;
  } else if (hasNpx) {
    if (override?.localCliRequired) {
      mainExecutable = override.localCliRequired;
    }
    if (override?.acpExecutable) {
      acpExecutable = override.acpExecutable;
    }
  }

  const mainSelection = mainExecutable
    ? await selectExecutable({ executable: mainExecutable, versionArgs: ["--version"] }, pathEntries)
    : null;
  const mainInstalledPath = mainSelection?.installedPath ?? null;

  let acpSelection: SelectExecutableResult | null = null;
  if (acpExecutable) {
    if (mainExecutable && acpExecutable === mainExecutable) {
      acpSelection = mainSelection;
    } else {
      acpSelection = await selectExecutable({ executable: acpExecutable, versionArgs: ["--version"] }, pathEntries);
    }
  }
  const acpInstalledPath = acpSelection?.installedPath ?? null;

  let npxFallback: { launchCommand: string[] } | null = null;
  if (hasNpx && !acpInstalledPath) {
    if (override?.localCliRequired) {
      if (mainInstalledPath) {
        npxFallback = buildNpxAcpFallback(npxPackage!, npxArgs);
      }
    } else {
      npxFallback = buildNpxAcpFallback(npxPackage!, npxArgs);
    }
  }

  const disabled = config.disabledAgents.includes(routerId);
  let status: EnrichedAgent["status"];
  let transport: string;

  if (disabled) {
    status = "disabled";
    transport = "acp_stdio";
  } else if (override?.localCliRequired && !mainInstalledPath) {
    status = "not_installed";
    transport = "acp_stdio";
  } else if (acpInstalledPath) {
    status = "available";
    transport = "acp_stdio";
  } else if (npxFallback) {
    status = "available";
    transport = "acp_stdio";
  } else if (mainInstalledPath) {
    status = "available";
    transport = "cli";
  } else {
    status = "not_installed";
    transport = "acp_stdio";
  }

  const notes: string[] = [];
  if (acpInstalledPath) {
    notes.push(`Found ACP adapter at ${acpInstalledPath}`);
  }
  if (mainInstalledPath && mainInstalledPath !== acpInstalledPath) {
    notes.push(`Found CLI at ${mainInstalledPath}`);
  }
  if (mainSelection?.selectionNote) notes.push(mainSelection.selectionNote);
  if (mainSelection?.note) notes.push(mainSelection.note);
  if (acpSelection && acpSelection !== mainSelection) {
    if (acpSelection.selectionNote) notes.push(acpSelection.selectionNote);
    if (acpSelection.note) notes.push(`ACP version probe failed: ${acpSelection.note.replace(/^Version probe failed: /, "")}`);
  }
  if (npxFallback) {
    notes.push(`ACP adapter available via npx: ${npxFallback.launchCommand.join(" ")}`);
  }
  if (installHint) {
    notes.push(`Install hint: ${installHint}`);
  }
  notes.push(`Registry: ${registryAgent.name}${registryVersion ? ` ${registryVersion}` : ""}.`);

  let acp: AcpAdapterSpec | null = null;
  if (acpInstalledPath || npxFallback) {
    const acpExeName = acpExecutable ?? (npxPackage ?? routerId);
    if (acpInstalledPath) {
      const baseArgs = hasBinary ? binaryInfo!.args : npxArgs;
      acp = {
        executable: acpExeName,
        installedPath: acpInstalledPath,
        version: acpSelection?.version ?? registryVersion,
        adapterStatus: `${routerId}_acp`,
        label: `${registryAgent.name} ACP`,
        buildArgsKey: acpExeName,
        available: true,
        launchMode: null,
        launchCommand: null,
        baseArgs,
        extraArgs
      };
    } else {
      acp = {
        executable: acpExeName,
        installedPath: null,
        version: registryVersion,
        adapterStatus: `${routerId}_acp`,
        label: `${registryAgent.name} ACP`,
        buildArgsKey: acpExeName,
        available: true,
        launchMode: "npx",
        launchCommand: npxFallback!.launchCommand,
        baseArgs: [],
        extraArgs
      };
    }
  }

  let command: string;
  if (acpInstalledPath) {
    command = `${acpExecutable} <acp stdio>`;
  } else if (npxFallback) {
    command = npxFallback.launchCommand.join(" ");
  } else if (mainInstalledPath) {
    command = `${mainExecutable} <cli>`;
  } else {
    command = registryAgent.name;
  }

  const source = acpInstalledPath || mainInstalledPath
    ? ["path", "registry"]
    : ["registry"];

  return {
    id: routerId,
    displayName: registryAgent.name,
    status,
    version: acpSelection?.version ?? mainSelection?.version ?? registryVersion ?? null,
    installedPath: mainInstalledPath,
    transport,
    command,
    acp,
    source,
    capabilities: ["file_edit", "shell", "diff_collection"],
    icon: registryAgent.icon ? { kind: "registry_url", value: registryAgent.icon } : null,
    notes,
    description: registryAgent.description ?? null,
    registry: {
      id: registryAgent.id,
      name: registryAgent.name,
      version: registryVersion,
      repository: registryAgent.repository ?? null,
      license: registryAgent.license ?? null,
      distribution: registryAgent.distribution,
      installHint
    }
  };
}

function compareExecutableProbe(a: ExecutableProbe, b: ExecutableProbe): number {
  const versionComparison = compareVersionStrings(b.version, a.version);
  if (versionComparison !== 0) return versionComparison;
  return a.index - b.index;
}

function compareVersionStrings(a: string | null, b: string | null): number {
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

function parseVersionParts(value: string | null): number[] {
  const match = String(value ?? "").match(/\d+(?:\.\d+){0,3}/);
  if (!match) return [];
  return match[0].split(".").map((part) => Number.parseInt(part, 10)).filter(Number.isFinite);
}

async function probeVersion(executablePath: string, versionArgs: string[]): Promise<ProbeVersionResult> {
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
  } catch (error: any) {
    return {
      version: null,
      note: `Version probe failed: ${error.code ?? error.message}`
    };
  }
}

async function findExecutables(binary: string, pathEntries: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const candidates: string[] = [];
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

async function selectExecutable(
  agent: { executable: string; versionArgs?: string[] },
  pathEntries: string[]
): Promise<SelectExecutableResult> {
  const candidates = await findExecutables(agent.executable, pathEntries);
  if (candidates.length === 0) {
    return {
      installedPath: null,
      version: null,
      note: null,
      candidates: [],
      selectionNote: null
    };
  }

  const probes = await Promise.all(candidates.map(async (candidate, index) => ({
    path: candidate,
    index,
    ...(await probeVersion(candidate, agent.versionArgs ?? []))
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

function chooseAgent(agents: EnrichedAgent[], config: DispatcherConfig, mode: string | null): ChooseAgentResult {
  const disabled = new Set(config.disabledAgents ?? []);
  const available = agents.filter((agent) => agent.status === "available" && !disabled.has(agent.id));
  const explicit = config.defaultAgent && available.find((agent) => agent.id === config.defaultAgent);
  if (explicit) return { agentId: explicit.id, reason: "configured default agent" };
  const modeDefault = mode ? config.modeDefaults?.[mode] : undefined;
  const modeAgent = typeof modeDefault === "string" && modeDefault
    ? available.find((agent) => agent.id === modeDefault)
    : undefined;
  if (modeAgent) return { agentId: modeAgent.id, reason: `configured default for ${mode}` };
  const acp = available.find((agent) => agent.transport === "acp_stdio");
  if (acp) return { agentId: acp.id, reason: "native ACP available" };
  return { agentId: null, reason: "no available ACP agent found; CLI fallback removed" };
}

async function validateWorktree(worktree: string): Promise<ValidateWorktreeResult> {
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

async function collectWorktreeState(worktree: string): Promise<WorktreeState> {
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

async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout: COMMAND_TIMEOUT_MS,
      windowsHide: true,
      env: safeEnv()
    });
    return { ok: true, stdout, stderr };
  } catch (error: any) {
    return {
      ok: false,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      error: error.message
    };
  }
}

function parseGitStatusFiles(stdout: string): string[] {
  const files = stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^.* -> /, ""))
    .filter(Boolean);
  return files.length > 500 ? [...files.slice(0, 500), `... and ${files.length - 500} more`] : files;
}

function resolveExtraArgs(extraArgs: string[], worktree: string): string[] {
  return extraArgs.map((arg) => arg === "<worktree>" ? worktree : arg);
}

function getAcpAdapterArgs(acpSpec: AcpAdapterSpec, worktree: string): string[] {
  const extra = resolveExtraArgs(acpSpec.extraArgs, worktree);
  if (acpSpec.launchMode === "npx") return extra;
  return [...acpSpec.baseArgs, ...extra];
}

function resolveAcpLaunchTarget(acpSpec: AcpAdapterSpec | null, selectedAgent: EnrichedAgent, worktree: string): LaunchTarget | null {
  if (!acpSpec?.available) return null;
  const adapterArgs = getAcpAdapterArgs(acpSpec, worktree);
  if (acpSpec.launchMode === "npx" && Array.isArray(acpSpec.launchCommand) && acpSpec.launchCommand.length > 0) {
    return {
      command: acpSpec.launchCommand[0],
      args: [...acpSpec.launchCommand.slice(1), ...adapterArgs],
      processLabel: acpSpec.launchCommand.join(" ")
    };
  }
  if (acpSpec.installedPath) {
    return {
      command: acpSpec.installedPath,
      args: adapterArgs,
      processLabel: path.basename(acpSpec.installedPath)
    };
  }
  return null;
}

function isAcpRunReady(selectedAgent: EnrichedAgent): boolean {
  const acp = selectedAgent?.acp;
  if (!acp?.available) return false;
  if (acp.installedPath) return true;
  return acp.launchMode === "npx" && Array.isArray(acp.launchCommand) && acp.launchCommand.length > 0;
}

function buildAcpUnavailableError(selectedAgent: EnrichedAgent): string {
  const installHint = selectedAgent.registry?.installHint ?? null;
  const base = `ACP is required for ${selectedAgent.displayName} and CLI fallback has been removed.`;
  if (installHint) {
    return `${base} Install the ACP adapter: ${installHint}`;
  }
  return `${base} Install the ${selectedAgent.displayName} ACP adapter or use a different agent.`;
}

function planLaunch({ launchingEnabled, selectedAgent }: PlanLaunchArgs): LaunchPlan {
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
  probeRegistryAgent,
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

export type {
  DispatcherConfig,
  ConfigureDispatcherArgs,
  DiscoverAgentsArgs,
  DiscoverAgentsResult,
  AcpAdapterSpec,
  EnrichedAgent,
  AcpRegistryResult,
  ExecutableProbe,
  SelectExecutableResult,
  ProbeVersionResult,
  ChooseAgentResult,
  ValidateWorktreeResult,
  GitResult,
  WorktreeState,
  LaunchTarget,
  LaunchPlan,
  PlanLaunchArgs
};
