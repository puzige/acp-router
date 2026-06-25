import { spawn, type ChildProcess } from "node:child_process";

import {
  SERVER_NAME,
  SERVER_VERSION,
  ACP_MODE_MAP,
  ACP_STARTUP_DELAY_MS,
  AGENT_ERROR_PATTERNS,
  AGENT_ERROR_KEY_PATTERN
} from "./constants.js";
import {
  safeEnv,
  sleep,
  preview,
  isPlainObject,
  uniqueStrings,
  buildAcpProcessClosedEvent
} from "./utils.js";
import { appendJsonl } from "./storage.js";
import { resolveAcpLaunchTarget, collectWorktreeState } from "./agents.js";
import type { AcpAdapterSpec, EnrichedAgent, WorktreeState } from "./agents.js";

type PermissionProfile = "bypassPermissions" | "acceptEdits" | "plan";

interface AcpLogEvent {
  type: string;
  timestamp: string;
  message: string;
  [key: string]: any;
}

interface AcpClientConstructorArgs {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  permissionProfile?: PermissionProfile;
  onEvent?: (event: AcpLogEvent) => void;
  onProcessStart?: (child: ChildProcess) => void | Promise<void>;
}

interface PendingRequest {
  method: string;
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface AcpJsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: any;
}

interface AcpJsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

interface AcpSessionUpdate {
  sessionUpdate?: string;
  content?: { text?: string };
  title?: string;
  status?: string;
  toolCallId?: string;
  availableCommands?: any[];
}

interface AcpConfigOption {
  id: string | null;
  title: string | null;
  category: string | null;
  type: string | null;
  description: string | null;
  currentValue: string | number | boolean | null;
  options: AcpConfigChoice[];
}

interface AcpConfigChoice {
  value: string;
  label: string;
  description: string | null;
}

interface AcpModelOption {
  configId: string | null;
  value: string;
  label: string;
  description: string | null;
}

interface SessionUpdateEvent {
  type: string;
  timestamp: string;
  message: string;
  params: any;
}

interface InitializeSummary {
  protocolVersion: any;
  agentInfo: any;
  agentCapabilities: {
    loadSession: boolean;
    sessionCapabilities: string[];
  };
  authMethods: { id: any; name: any }[];
}

interface RunAcpStdioJobArgs {
  args: { worktree: string; prompt: string; model?: string | null; collectDiff?: boolean };
  job: {
    jobId: string;
    sessionId: string;
    logPath: string;
    permissionProfile?: PermissionProfile;
    worktreeState: WorktreeState;
  };
  session: { providerSessionId: string | null };
  selectedAgent: EnrichedAgent;
  timeoutSec: number;
  agentEnv?: NodeJS.ProcessEnv;
  controller?: any;
}

interface ProbeAgentModelsArgs {
  selectedAgent: EnrichedAgent;
  worktree?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

interface ProbeAgentModelsResult {
  agentId: string;
  models: AcpModelOption[];
  configOptions: AcpConfigOption[];
}

class AcpStdioClient {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  permissionProfile: PermissionProfile;
  onEvent: (event: AcpLogEvent) => void;
  onProcessStart: ((child: ChildProcess) => void | Promise<void>) | undefined;
  nextId: number;
  pending: Map<number, PendingRequest>;
  stdoutBuffer: string;
  logEvents: AcpLogEvent[];
  child: ChildProcess | null;
  startError: Error | null;

  constructor({ command, args, cwd, timeoutMs, env, permissionProfile, onEvent, onProcessStart }: AcpClientConstructorArgs) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.env = env ?? safeEnv();
    this.permissionProfile = permissionProfile ?? "bypassPermissions";
    this.onEvent = onEvent ?? (() => {});
    this.onProcessStart = onProcessStart;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = "";
    this.logEvents = [];
    this.child = null;
    this.startError = null;
  }

  async start(): Promise<void> {
    const currentDepth = Number.parseInt(process.env.ACP_ROUTER_DEPTH ?? "0", 10) || 0;
    const childEnv = {
      ...this.env,
      ACP_ROUTER_DEPTH: String(currentDepth + 1)
    };
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: childEnv
    });
    this.child.stdout!.setEncoding("utf8");
    this.child.stderr!.setEncoding("utf8");
    if (typeof this.onProcessStart === "function") {
      await Promise.resolve(this.onProcessStart(this.child)).catch((error: any) => {
        this.logEvents.push({
          type: "process_record_error",
          timestamp: new Date().toISOString(),
          message: `Failed to record ACP process pid: ${error.message}`
        });
      });
    }
    this.child.stdout!.on("data", (chunk: string) => this.handleStdout(chunk));
    this.child.stderr!.on("data", (chunk: string) => this.handleStderr(chunk));
    this.child.on("error", (error: Error) => {
      this.startError = error;
      this.rejectPending(error);
    });
    this.child.on("exit", (code: number | null, signal: NodeJS.Signals | null) => this.rejectPending(new Error(`ACP process exited with code=${code} signal=${signal}`)));
    await sleep(ACP_STARTUP_DELAY_MS);
    if (this.startError) throw this.startError;
  }

  request(method: string, params?: any): Promise<any> {
    const id = this.nextId++;
    const payload: AcpJsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const stderrTail = this.logEvents
          .filter((e) => e.type === "acp_stderr")
          .slice(-5)
          .map((e) => e.message)
          .join("\n");
        const error = new Error(
          stderrTail
            ? `ACP request timed out: ${method}. Recent stderr:\n${stderrTail}`
            : `ACP request timed out: ${method} (no stderr output).`
        ) as Error & { code?: string };
        error.code = "timeout";
        reject(error);
      }, this.timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.write(payload);
    });
  }

  respond(id: number, result: any): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: number, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  write(payload: any): void {
    if (!this.child || !this.child.stdin!.writable) {
      throw new Error("ACP process is not writable.");
    }
    this.child.stdin!.write(`${JSON.stringify(payload)}\n`);
  }

  handleStdout(chunk: string): void {
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

  handleMessageLine(line: string): void {
    let message: any;
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

  handleClientRequest(message: any): void {
    if (message.method === "session/request_permission") {
      const outcome = this.resolvePermissionOutcome(message.params);
      this.logEvents.push({
        type: outcome === "approved" ? "acp_permission_approved" : "acp_permission_cancelled",
        timestamp: new Date().toISOString(),
        message: outcome === "approved"
          ? `Agent Router approved an ACP permission request (${this.permissionProfile}).`
          : "Agent Router cancelled an ACP permission request.",
        params: message.params
      });
      this.respond(message.id, { outcome });
      return;
    }
    this.respondError(message.id, -32601, `Unsupported client method: ${message.method}`);
  }

  resolvePermissionOutcome(params: any): "approved" | "cancelled" {
    switch (this.permissionProfile) {
      case "bypassPermissions":
        return "approved";
      case "acceptEdits": {
        const perms = params?.permissions ?? [];
        const hasNonFilePermission = perms.some((p: any) => p.type !== "file_edit" && p.type !== "write");
        if (hasNonFilePermission) return "cancelled";
        return "approved";
      }
      case "plan":
        return "cancelled";
      default:
        return "cancelled";
    }
  }

  handleNotification(message: any): void {
    const event = normalizeAcpNotification(message);
    this.onEvent(event);
  }

  handleStderr(chunk: string): void {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
      const event: AcpLogEvent = {
        type: "acp_stderr",
        timestamp: new Date().toISOString(),
        message: preview(line, 500)
      };
      if (typeof this.onEvent === "function") {
        try { this.onEvent(event); } catch {}
      }
    }
  }

  drainLogEvents(): AcpLogEvent[] {
    const events = this.logEvents;
    this.logEvents = [];
    return events;
  }

  rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  dispose(): void {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
      const timer = setTimeout(() => {
        if (this.child && !this.child.killed) {
          this.child.kill("SIGKILL");
        }
      }, 1000);
      (timer as NodeJS.Timeout).unref?.();
    }
  }
}

function normalizeAcpNotification(message: any): SessionUpdateEvent {
  if (message.method === "session/update") {
    const update: AcpSessionUpdate = message.params?.update ?? {};
    const event: SessionUpdateEvent = {
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

function describeSessionUpdate(update: AcpSessionUpdate): string {
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

function summarizeInitializeResult(result: any): InitializeSummary {
  return {
    protocolVersion: result.protocolVersion,
    agentInfo: result.agentInfo ?? null,
    agentCapabilities: {
      loadSession: Boolean(result.agentCapabilities?.loadSession),
      sessionCapabilities: Object.keys(result.agentCapabilities?.sessionCapabilities ?? {})
    },
    authMethods: (result.authMethods ?? []).map((method: any) => ({ id: method.id, name: method.name }))
  };
}

function summarizeAcpConfigOptions(configOptions: any): AcpConfigOption[] {
  if (!Array.isArray(configOptions)) return [];
  return configOptions
    .map((option: any) => {
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

function summarizeConfigChoices(choices: any): AcpConfigChoice[] {
  if (!Array.isArray(choices)) return [];
  return choices.map((choice: any): AcpConfigChoice | null => {
    if (typeof choice === "string") return { value: choice, label: choice, description: null };
    if (!isPlainObject(choice)) return null;
    const value = choice.value ?? choice.id ?? choice.name ?? choice.label ?? choice.title;
    const label = choice.label ?? choice.title ?? choice.name ?? choice.value ?? choice.id;
    if (typeof value !== "string" || !value) return null;
    return {
      value,
      label: typeof label === "string" && label ? label : value,
      description: choice.description ? preview(choice.description, 300) : null
    };
  }).filter((choice): choice is AcpConfigChoice => choice !== null);
}

function summarizeConfigValue(value: any): string | number | boolean | null {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return null;
}

function extractModelOptions(configOptions: AcpConfigOption[]): AcpModelOption[] {
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

function buildDispatchPrompt(prompt: string): string {
  return [
    prompt,
    "",
    "When you finish, report:",
    "- changed files",
    "- validation commands and results",
    "- risks or incomplete work"
  ].join("\n");
}

function extractAgentText(events: AcpLogEvent[]): string {
  const chunks = events
    .filter((event) => event.type === "acp_agent_message_chunk")
    .map((event) => event.params?.update?.content?.text)
    .filter(Boolean);
  const text = chunks.join("").trim();
  return text.length > 10000 ? text.slice(0, 10000) + "\n...[truncated]" : text;
}

function extractAgentErrors(events: AcpLogEvent[]): string[] {
  const candidates: any[] = [];
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

function collectDiagnosticStrings(value: any, depth = 0): string[] {
  if (depth > 5 || value == null) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectDiagnosticStrings(item, depth + 1));
  if (typeof value !== "object") return [];
  const values: string[] = [];
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

function buildFailureReason(adapterLabel: string, error: Error & { code?: string }, agentErrors: string[]): string {
  if (agentErrors.length > 0) {
    const suffix = error.code === "timeout" ? " (request timed out after agent error)" : "";
    return `${adapterLabel} failed: ${agentErrors.join("; ")}${suffix}`;
  }
  return `${adapterLabel} failed: ${error.message}`;
}

function diffChangedFiles(beforeState: WorktreeState | null, afterState: WorktreeState | { skipped: boolean; reason: string }): string[] {
  const before = new Set(Array.isArray(beforeState?.preExistingChangedFiles) ? beforeState!.preExistingChangedFiles : []);
  const afterFiles = (afterState as WorktreeState)?.preExistingChangedFiles;
  const after = Array.isArray(afterFiles) ? afterFiles : [];
  const introduced = after.filter((file) => !before.has(file));
  return introduced.length > 0 ? introduced : after;
}

async function runAcpStdioJob({ args, job, session, selectedAgent, timeoutSec, agentEnv, controller }: RunAcpStdioJobArgs): Promise<{
  events: AcpLogEvent[];
  sessionPatch: any;
  jobPatch: any;
}> {
  const acpSpec: AcpAdapterSpec | null = selectedAgent.acp;
  const launchTarget = resolveAcpLaunchTarget(acpSpec, selectedAgent, args.worktree);
  if (!launchTarget) throw new Error(`No ACP adapter is available for ${selectedAgent.id}.`);
  const adapterLabel = acpSpec?.label ?? `${selectedAgent.displayName} ACP`;
  const adapterStatus = acpSpec?.adapterStatus ?? `${selectedAgent.id}_acp`;
  const permissionProfile: PermissionProfile = job.permissionProfile ?? "bypassPermissions";
  const events: AcpLogEvent[] = [];
  const startedAt = Date.now();
  let providerSessionId: string | null = session.providerSessionId ?? null;
  let agentConfigOptions: AcpConfigOption[] = [];
  let availableModels: AcpModelOption[] = [];
  let writeChain: Promise<void> = Promise.resolve();
  const streamEvent = (event: AcpLogEvent): void => {
    events.push(event);
    writeChain = writeChain.then(() => appendJsonl(job.logPath, [{
      ...event,
      jobId: job.jobId,
      sessionId: job.sessionId,
      agentId: selectedAgent.id
    }]).catch(() => {}));
  };
  const client = new AcpStdioClient({
    command: launchTarget.command,
    args: launchTarget.args,
    cwd: args.worktree,
    timeoutMs: timeoutSec * 1000,
    env: agentEnv,
    permissionProfile,
    onEvent: streamEvent,
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
    streamEvent({
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
    streamEvent({
      type: session.providerSessionId ? "acp_session_resumed" : "acp_session_created",
      timestamp: new Date().toISOString(),
      message: `${adapterLabel} session ready: ${providerSessionId}`,
      providerSessionId
    });
    if (agentConfigOptions.length > 0) {
      streamEvent({
        type: "acp_config_options",
        timestamp: new Date().toISOString(),
        message: `${adapterLabel} exposed ${agentConfigOptions.length} config option(s), including ${availableModels.length} model option(s).`,
        configOptions: agentConfigOptions,
        availableModels
      });
    }

    const modeOption = agentConfigOptions.find((o) => o.category === "mode" || o.id === "mode");
    const targetMode = (ACP_MODE_MAP as Record<string, Record<string, string>>)[selectedAgent.id]?.[permissionProfile];
    if (modeOption && targetMode) {
      const modeValueExists = modeOption.options.some((o) => o.value === targetMode);
      if (modeValueExists) {
        const setConfigResult = await client.request("session/set_config_option", {
          sessionId: providerSessionId,
          configId: modeOption.id ?? "mode",
          value: targetMode
        });
        if (Array.isArray(setConfigResult?.configOptions)) {
          agentConfigOptions = summarizeAcpConfigOptions(setConfigResult.configOptions);
          availableModels = extractModelOptions(agentConfigOptions);
        }
        streamEvent({
          type: "acp_mode_set",
          timestamp: new Date().toISOString(),
          message: `Set ${selectedAgent.id} mode to ${targetMode} (permissionProfile=${permissionProfile}).`,
          permissionProfile,
          mode: targetMode
        });
      } else {
        streamEvent({
          type: "acp_mode_set_skipped",
          timestamp: new Date().toISOString(),
          message: `${adapterLabel} mode option does not include value "${targetMode}" for permissionProfile=${permissionProfile}; skipping mode setting.`,
          permissionProfile,
          attemptedMode: targetMode,
          availableModeValues: modeOption.options.map((o) => o.value)
        });
      }
    }

    if (args.model) {
      const modelOption = agentConfigOptions.find((o) => o.category === "model" || /model/i.test(o.id ?? ""));
      if (modelOption) {
        const modelValueExists = modelOption.options.some((o) => o.value === args.model);
        if (modelValueExists) {
          const setModelResult = await client.request("session/set_config_option", {
            sessionId: providerSessionId,
            configId: modelOption.id ?? "model",
            value: args.model
          });
          if (Array.isArray(setModelResult?.configOptions)) {
            agentConfigOptions = summarizeAcpConfigOptions(setModelResult.configOptions);
            availableModels = extractModelOptions(agentConfigOptions);
          }
          streamEvent({
            type: "acp_model_set",
            timestamp: new Date().toISOString(),
            message: `Set ${selectedAgent.id} model to ${args.model}.`,
            model: args.model
          });
        } else {
          streamEvent({
            type: "acp_model_set_skipped",
            timestamp: new Date().toISOString(),
            message: `${adapterLabel} model option does not include value "${args.model}"; skipping model setting.`,
            attemptedModel: args.model,
            availableModelValues: modelOption.options.map((o) => o.value)
          });
        }
      } else {
        streamEvent({
          type: "acp_model_set_skipped",
          timestamp: new Date().toISOString(),
          message: `${adapterLabel} does not expose a model config option; skipping model setting.`,
          attemptedModel: args.model
        });
      }
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
    const stopReason = promptResult.stopReason ?? null;
    for (const logEvent of client.drainLogEvents()) streamEvent(logEvent);
    streamEvent({
      type: "acp_prompt_completed",
      timestamp: completedAt,
      message: `${adapterLabel} prompt completed with stopReason=${stopReason ?? "unknown"}.`,
      stopReason
    });
    streamEvent(buildAcpProcessClosedEvent(startedAt));
    await writeChain;
    const afterState = args.collectDiff === false
      ? { skipped: true, reason: "collectDiff disabled" }
      : await collectWorktreeState(args.worktree);
    const changedFiles = diffChangedFiles(job.worktreeState, afterState);
    const agentText = extractAgentText(events);
    const planViolations = (permissionProfile === "plan" && changedFiles.length > 0)
      ? [`plan_mode_violation: Agent modified ${changedFiles.length} file(s) despite permissionProfile=plan. The ACP adapter did not enforce read-only mode.`]
      : [];
    const planRisks = planViolations.length > 0
      ? planViolations
      : (stopReason && stopReason !== "end_turn" ? [`${adapterLabel} stopped with ${stopReason}.`] : []);
    return {
      events: [...events],
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
        risks: planRisks
      }
    };
  } catch (error: any) {
    const failedAt = new Date().toISOString();
    for (const logEvent of client.drainLogEvents()) streamEvent(logEvent);
    const collectedEvents = [...events];
    const agentErrors = extractAgentErrors(collectedEvents);
    const cancelled = controller?.cancelRequested === true;
    const failureReason = cancelled
      ? (controller.cancelReason || `${adapterLabel} cancelled by Agent Router caller.`)
      : buildFailureReason(adapterLabel, error, agentErrors);
    streamEvent({
      type: cancelled ? "acp_cancelled" : "acp_error",
      timestamp: failedAt,
      message: failureReason,
      errorMessage: error.message,
      agentErrors
    });
    streamEvent(buildAcpProcessClosedEvent(startedAt));
    await writeChain;
    const afterState = args.collectDiff === false
      ? { skipped: true, reason: "collectDiff disabled" }
      : await collectWorktreeState(args.worktree);
    return {
      events: [...events],
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

async function probeAgentModels({ selectedAgent, worktree, env, timeoutMs }: ProbeAgentModelsArgs): Promise<ProbeAgentModelsResult> {
  const cwd = worktree ?? process.cwd();
  const launchTarget = resolveAcpLaunchTarget(selectedAgent.acp, selectedAgent, cwd);
  if (!launchTarget) throw new Error(`No ACP adapter is available for ${selectedAgent.id}.`);
  const client = new AcpStdioClient({
    command: launchTarget.command,
    args: launchTarget.args,
    cwd,
    timeoutMs: timeoutMs ?? 10000,
    env,
    onEvent: () => {}
  });
  try {
    await client.start();
    await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: SERVER_NAME, title: "Agent Router", version: SERVER_VERSION }
    });
    const sessionResult = await client.request("session/new", {
      cwd,
      mcpServers: []
    });
    const configOptions = summarizeAcpConfigOptions(sessionResult.configOptions);
    const models = extractModelOptions(configOptions);
    return {
      agentId: selectedAgent.id,
      models,
      configOptions
    };
  } finally {
    client.dispose();
  }
}

export {
  AcpStdioClient,
  normalizeAcpNotification,
  describeSessionUpdate,
  summarizeInitializeResult,
  summarizeAcpConfigOptions,
  summarizeConfigChoices,
  summarizeConfigValue,
  extractModelOptions,
  buildDispatchPrompt,
  extractAgentText,
  extractAgentErrors,
  collectDiagnosticStrings,
  buildFailureReason,
  diffChangedFiles,
  runAcpStdioJob,
  probeAgentModels
};

export type {
  PermissionProfile,
  AcpLogEvent,
  AcpClientConstructorArgs,
  PendingRequest,
  AcpJsonRpcRequest,
  AcpJsonRpcResponse,
  AcpSessionUpdate,
  AcpConfigOption,
  AcpConfigChoice,
  AcpModelOption,
  SessionUpdateEvent,
  InitializeSummary,
  RunAcpStdioJobArgs,
  ProbeAgentModelsArgs,
  ProbeAgentModelsResult
};
