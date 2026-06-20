import { spawn } from "node:child_process";

import {
  SERVER_NAME,
  SERVER_VERSION,
  ACP_MODE_MAP,
  ACP_STARTUP_DELAY_MS,
  AGENT_ERROR_PATTERNS,
  AGENT_ERROR_KEY_PATTERN
} from "./constants.mjs";
import {
  safeEnv,
  sleep,
  preview,
  isPlainObject,
  uniqueStrings,
  buildAcpProcessClosedEvent
} from "./utils.mjs";
import { appendJsonl } from "./storage.mjs";
import { resolveAcpLaunchTarget, collectWorktreeState } from "./agents.mjs";

class AcpStdioClient {
  constructor({ command, args, cwd, timeoutMs, env, permissionProfile, onEvent, onProcessStart }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.env = env ?? safeEnv();
    this.permissionProfile = permissionProfile ?? "bypassPermissions";
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
        const stderrTail = this.logEvents
          .filter((e) => e.type === "acp_stderr")
          .slice(-5)
          .map((e) => e.message)
          .join("\n");
        const error = new Error(
          stderrTail
            ? `ACP request timed out: ${method}. Recent stderr:\n${stderrTail}`
            : `ACP request timed out: ${method} (no stderr output).`
        );
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

  resolvePermissionOutcome(params) {
    switch (this.permissionProfile) {
      case "bypassPermissions":
        return "approved";
      case "acceptEdits": {
        const perms = params?.permissions ?? [];
        const hasNonFilePermission = perms.some((p) => p.type !== "file_edit" && p.type !== "write");
        if (hasNonFilePermission) return "cancelled";
        return "approved";
      }
      case "plan":
        return "cancelled";
      default:
        return "cancelled";
    }
  }

  handleNotification(message) {
    const event = normalizeAcpNotification(message);
    this.onEvent(event);
  }

  handleStderr(chunk) {
    for (const line of chunk.split(/\r?\n/).filter(Boolean)) {
      const event = {
        type: "acp_stderr",
        timestamp: new Date().toISOString(),
        message: preview(line, 500)
      };
      if (typeof this.onEvent === "function") {
        try { this.onEvent(event); } catch {}
      }
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

function diffChangedFiles(beforeState, afterState) {
  const before = new Set(Array.isArray(beforeState?.preExistingChangedFiles) ? beforeState.preExistingChangedFiles : []);
  const after = Array.isArray(afterState?.preExistingChangedFiles) ? afterState.preExistingChangedFiles : [];
  const introduced = after.filter((file) => !before.has(file));
  return introduced.length > 0 ? introduced : after;
}

async function runAcpStdioJob({ args, job, session, selectedAgent, timeoutSec, agentEnv, controller }) {
  const acpSpec = selectedAgent.acp;
  const launchTarget = resolveAcpLaunchTarget(acpSpec, selectedAgent, args.worktree);
  if (!launchTarget) throw new Error(`No ACP adapter is available for ${selectedAgent.id}.`);
  const adapterLabel = acpSpec.label ?? `${selectedAgent.displayName} ACP`;
  const adapterStatus = acpSpec.adapterStatus ?? `${selectedAgent.id}_acp`;
  const permissionProfile = job.permissionProfile ?? "bypassPermissions";
  const events = [];
  const startedAt = Date.now();
  let providerSessionId = session.providerSessionId ?? null;
  let agentConfigOptions = [];
  let availableModels = [];
  let writeChain = Promise.resolve();
  const streamEvent = (event) => {
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
    const targetMode = ACP_MODE_MAP[selectedAgent.id]?.[permissionProfile];
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
        risks: stopReason && stopReason !== "end_turn" ? [`OpenCode stopped with ${stopReason}.`] : []
      }
    };
  } catch (error) {
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
  runAcpStdioJob
};
