import os from "node:os";
import path from "node:path";

export type PermissionProfile = "plan" | "acceptEdits" | "bypassPermissions";

export interface AgentOverride {
  executable?: string;
  localCliRequired?: string;
  extraAcpArgs?: string[];
  acpExecutable?: string;
}

export type AcpModeMap = Record<string, Record<PermissionProfile, string>>;

const SERVER_NAME = "acp-router";
const SERVER_VERSION = "0.10.1";
const DATA_DIR = process.env.ACP_ROUTER_DATA_DIR
  ? path.resolve(process.env.ACP_ROUTER_DATA_DIR)
  : path.join(os.homedir(), ".acp-router");
const REGISTRY_PATH = path.join(DATA_DIR, "registry.json");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const ACP_REGISTRY_CACHE_PATH = path.join(DATA_DIR, "acp-registry-cache.json");
const LOG_DIR = path.join(DATA_DIR, "logs");
const DEFAULT_ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const COMMAND_TIMEOUT_MS = 3000;
const ACP_STARTUP_DELAY_MS = 300;
const ACTIVE_JOB_STATUSES = new Set(["queued", "starting", "running"]);
const TERMINAL_JOB_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out", "orphaned"]);

const MAX_RECURSION_DEPTH = 3;

const ACP_MODE_MAP: AcpModeMap = {
  claude: {
    plan: "plan",
    acceptEdits: "acceptEdits",
    bypassPermissions: "bypassPermissions"
  },
  codex: {
    plan: "read-only",
    acceptEdits: "auto",
    bypassPermissions: "full-access"
  },
  opencode: {
    plan: "plan",
    acceptEdits: "build",
    bypassPermissions: "build"
  },
  "cursor-agent": {
    plan: "plan",
    acceptEdits: "agentic",
    bypassPermissions: "agentic"
  },
  devin: {
    plan: "plan",
    acceptEdits: "acceptEdits",
    bypassPermissions: "bypassPermissions"
  }
};

const AGENT_OVERRIDES: Record<string, AgentOverride> = {
  "cursor-agent": { executable: "agent" },
  codex: { localCliRequired: "codex", acpExecutable: "codex-acp" },
  claude: { acpExecutable: "claude-agent-acp" },
  opencode: { extraAcpArgs: ["--cwd", "<worktree>", "--print-logs", "--log-level", "INFO"] }
};

const AGENT_ENV_ALLOWLIST: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CURSOR_API_KEY",
  "DEVIN_API_KEY",
  "OPENAI_API_KEY"
];

const AGENT_ERROR_PATTERNS: readonly RegExp[] = [
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

export {
  SERVER_NAME,
  SERVER_VERSION,
  DATA_DIR,
  REGISTRY_PATH,
  CONFIG_PATH,
  ACP_REGISTRY_CACHE_PATH,
  LOG_DIR,
  DEFAULT_ACP_REGISTRY_URL,
  COMMAND_TIMEOUT_MS,
  ACP_STARTUP_DELAY_MS,
  ACTIVE_JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  MAX_RECURSION_DEPTH,
  ACP_MODE_MAP,
  AGENT_OVERRIDES,
  AGENT_ENV_ALLOWLIST,
  AGENT_ERROR_PATTERNS,
  AGENT_ERROR_KEY_PATTERN
};
