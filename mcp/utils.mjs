import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { AGENT_ENV_ALLOWLIST } from "./constants.mjs";

const execFileAsync = promisify(execFile);

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

function clampInteger(value, fallback, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, minimum), maximum);
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

function createId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${stamp}_${random}`;
}

function resolveBooleanOverride(value, fallback) {
  return typeof value === "boolean" ? value : fallback === true;
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

function buildAcpProcessClosedEvent(startedAt) {
  return {
    type: "acp_process_closed",
    timestamp: new Date().toISOString(),
    message: `OpenCode ACP adapter finished after ${Date.now() - startedAt}ms.`
  };
}

export {
  execFileAsync,
  sleep,
  safeEnv,
  allowlistedAgentEnv,
  clampInteger,
  preview,
  stripAnsi,
  hashText,
  isPlainObject,
  toToolResult,
  createId,
  resolveBooleanOverride,
  uniqueStrings,
  buildAcpProcessClosedEvent
};
