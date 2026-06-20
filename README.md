# Agent Router

Generic MCP server for routing coding tasks to local ACP agents.

[![npm version](https://img.shields.io/npm/v/agent-router.svg)](https://www.npmjs.com/package/agent-router)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org/)

Agent Router discovers locally installed coding agents that speak the [Agent Client Protocol](https://agentclientprotocol.com/) (ACP), routes tasks to them inside isolated git worktrees, and tracks jobs, sessions, and event logs. It works with any MCP-compatible client -- Claude Desktop, Cursor, Windsurf, Codex, and others.

## Quick Start

Run Agent Router directly without installing:

```bash
npx agent-router
```

Or install globally and run:

```bash
npm install -g agent-router
agent-router
```

Add Agent Router to any MCP client by pointing it at the `agent-router` command:

```json
{
  "mcpServers": {
    "agent-router": {
      "command": "npx",
      "args": ["agent-router"]
    }
  }
}
```

See [MCP Client Setup](#mcp-client-setup) below for client-specific configuration examples, or the detailed guide at [docs/MCP_CLIENT_SETUP.md](docs/MCP_CLIENT_SETUP.md).

## MCP Client Setup

Agent Router is a standard stdio MCP server. Any MCP client that supports `command`-based servers can launch it. Below are config examples for common clients.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent location on your platform:

```json
{
  "mcpServers": {
    "agent-router": {
      "command": "npx",
      "args": ["agent-router"]
    }
  }
}
```

Restart Claude Desktop after editing the config file.

### Cursor

Add to `.cursor/mcp.json` in your project root (or user-level config):

```json
{
  "mcpServers": {
    "agent-router": {
      "command": "npx",
      "args": ["agent-router"]
    }
  }
}
```

### Windsurf

Add to your Windsurf MCP server configuration:

```json
{
  "mcpServers": {
    "agent-router": {
      "command": "npx",
      "args": ["agent-router"]
    }
  }
}
```

### Codex

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "agent-router": {
      "command": "npx",
      "args": ["agent-router"]
    }
  }
}
```

### Generic MCP Client

Any client that supports stdio MCP servers can use Agent Router with the following parameters:

| Field | Value |
| --- | --- |
| Command | `npx` |
| Args | `["agent-router"]` |
| Transport | stdio |

If you installed globally, use `"command": "agent-router"` with an empty args array instead.

## Tools

Agent Router exposes 8 MCP tools:

| Tool | Description | Key Params |
| --- | --- | --- |
| `discover_agents` | Discover locally installed coding agents and their ACP adapter status. Returns transport, ACP availability, registry metadata, and install hints. | `refresh` (bool, optional), `includeNotInstalled` (bool, optional) |
| `manage_config` | Get or set Agent Router configuration including default agent, per-mode defaults, disabled agents, and safety policy. | `action` ("get" \| "set"), `defaultAgent`, `disabledAgents`, `launchExternalAgents`, `inheritEnvironment`, `allowBypassPermissions`, `registryEnabled`, `registryUrl`, `registryCacheTtlSec`, `modeDefaults` |
| `run_agent` | Run a coding agent in an isolated worktree. Requires an absolute worktree path. Supports sync and async execution. ACP-only -- CLI fallback is not supported. | `agent` (string, optional), `worktree` (string, required), `prompt` (string, required), `mode`, `async` (bool), `sessionId`, `timeoutSec`, `permissionProfile`, `collectDiff`, `launchExternalAgents`, `inheritEnvironment`, `metadata` |
| `list_jobs` | List Agent Router jobs from the local registry with optional filters. | `status`, `agent`, `worktree`, `limit` |
| `get_job` | Get an Agent Router job by id. | `jobId` (string, required) |
| `tail_job_events` | Return newly recorded job events from the JSONL event log for polling-style progress updates. | `jobId` (string, required), `afterEventIndex`, `limit`, `includeLogTail`, `logTailBytes` |
| `cancel_job` | Cancel a job and terminate an active child process when the current MCP server owns it. | `jobId` (string, required), `reason` (string, optional) |
| `manage_sessions` | List, continue, or archive Agent Router sessions. | `action` ("list" \| "continue" \| "archive"), `sessionId`, `prompt`, `agent`, `worktree`, `async`, `includeArchived`, `limit`, `launchExternalAgents`, `inheritEnvironment`, `timeoutSec` |

## ACP-Only Mode

Agent Router runs agents exclusively through the Agent Client Protocol (ACP). The previous CLI fallback adapters have been removed.

### How it works

1. When you call `run_agent`, Agent Router checks whether the selected agent has an available ACP adapter.
2. If the ACP executable is on `PATH`, it launches directly.
3. If the ACP executable is not on `PATH` but the ACP Registry lists an npx distribution for that agent, Agent Router automatically launches it via `npx --yes <package>`.
4. If no ACP adapter is available at all, the job hard-fails with an `acp_required` error and an install hint telling you how to install the adapter.

### When ACP is not available

| Scenario | Behavior |
| --- | --- |
| ACP executable on `PATH` | Launches directly |
| ACP executable not on `PATH`, registry has npx distribution | Auto-launches via `npx --yes <package>` |
| ACP executable not on `PATH`, no npx distribution | Job fails with `acp_required` error and install hint |
| Agent has no ACP adapter at all (e.g. Cursor Agent) | Job fails with `acp_required` error |

## Supported Agents

| Agent | ACP Support | Launch Method | Notes |
| --- | --- | --- | --- |
| OpenCode | Native ACP stdio | `opencode acp --cwd <worktree>` | Built-in ACP, no extra install needed |
| Claude Code | ACP via `claude-agent-acp` | `claude-agent-acp` or `npx --yes @anthropic-ai/claude-agent-acp` | ACP adapter preferred; npx fallback when not installed |
| Codex CLI | ACP via `codex-acp` | `codex-acp` or `npx --yes codex-acp` | ACP adapter preferred; npx fallback when not installed |
| Cursor Agent | No ACP adapter | Hard-fail | CLI fallback removed; install a Cursor ACP adapter or use a different agent |

## Configuration

Agent Router stores its configuration in `~/.agent-router/config.json`.

### Config fields

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `defaultAgent` | string \| null | `null` | Default agent id to use when none is explicitly requested |
| `modeDefaults` | object | `{}` | Per-mode default agent id mapping (e.g. `{ "planning": "opencode" }`) |
| `disabledAgents` | string[] | `[]` | Agent ids to exclude from automatic selection |
| `allowCurrentDirectory` | boolean | `false` | Allow dispatching agents in the current working directory |
| `registryEnabled` | boolean | `true` | Enable ACP registry lookups for agent discovery |
| `registryUrl` | string | `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` | ACP registry URL override |
| `registryCacheTtlSec` | number | `86400` | ACP registry cache TTL in seconds (24 hours) |
| `safety.launchExternalAgents` | boolean | `true` | Allow launching external agent processes |
| `safety.inheritEnvironment` | boolean | `true` | Inherit parent process environment for child agents |
| `safety.allowBypassPermissions` | boolean | `false` | Allow `bypass_permissions` permission profile |
| `safety.defaultPermissionProfile` | string | `"workspace_write"` | Default permission profile for new jobs |
| `safety.requireAbsoluteWorktree` | boolean | `true` | Require an absolute worktree path |

Read or update config through the `manage_config` tool:

```text
manage_config with action "get"
manage_config with action "set", defaultAgent "opencode"
```

## Data Directory and Paths

Agent Router stores all data under `~/.agent-router/`:

| Path | Description |
| --- | --- |
| `~/.agent-router/config.json` | Configuration file |
| `~/.agent-router/registry.json` | Job and session registry |
| `~/.agent-router/logs/` | Per-job JSONL event logs |
| `~/.agent-router/acp-registry-cache.json` | ACP Registry metadata cache |

Override the data directory by setting the `AGENT_ROUTER_DATA_DIR` environment variable:

```json
{
  "mcpServers": {
    "agent-router": {
      "command": "npx",
      "args": ["agent-router"],
      "env": {
        "AGENT_ROUTER_DATA_DIR": "/custom/path/to/data"
      }
    }
  }
}
```

## Recursion Guard

Agent Router prevents infinite agent dispatch loops using the `AGENT_ROUTER_DEPTH` environment variable.

- Each time Agent Router launches a child agent, it increments `AGENT_ROUTER_DEPTH` by 1 in the child process environment.
- The maximum recursion depth is **3**.
- When `run_agent` is called and `AGENT_ROUTER_DEPTH` is already at or above 3, the job immediately fails with a `recursion_limit` error.

This guards against scenarios where an ACP agent itself calls Agent Router to dispatch another agent, creating a loop. The depth counter propagates through the process tree so nested dispatches are tracked across the entire chain.

## Development

```bash
git clone https://github.com/peanut996/agent-router.git
cd agent-router
npm install
```

### Validation

No-model validation (does not call any external model):

```bash
npm run check
npm run smoke
npm run smoke:sessions
npm run smoke:opencode
npm run smoke:opencode:sessions
npm run smoke:acp:handshake
npm run e2e:restart-recovery
```

Real E2E validation (calls external agents, may incur model cost):

```bash
npm run e2e:opencode -- --opencode-model opencode-go/glm-5.2 --keep
npm run e2e:sessions:opencode -- --keep
npm run e2e:claude -- --timeout-sec 600 --keep
npm run e2e:codex -- --timeout-sec 600 --keep
```

Omit `--keep` to clean successful runs automatically. Failed runs are always kept for inspection.

### Start the server locally

```bash
npm start
```

## License

MIT
