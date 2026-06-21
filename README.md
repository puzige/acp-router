# ACP Router

Generic MCP server for routing coding tasks to local ACP agents.

[![npm version](https://img.shields.io/npm/v/@peanut996/acp-router.svg)](https://www.npmjs.com/package/@peanut996/acp-router)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-green.svg)](https://nodejs.org/)

ACP Router discovers coding agents from the [ACP Registry](https://agentclientprotocol.com/) (currently 37+ agents) and routes tasks to them inside isolated git worktrees, tracking jobs, sessions, and event logs. It works with any MCP-compatible client -- Claude Desktop, Cursor, Windsurf, Codex, and others.

## Quick Start

Run ACP Router directly without installing:

```bash
npx @peanut996/acp-router
```

Or install globally and run:

```bash
npm install -g @peanut996/acp-router
acp-router
```

Add ACP Router to any MCP client by pointing it at the `acp-router` command:

```json
{
  "mcpServers": {
    "acp-router": {
      "command": "npx",
      "args": ["@peanut996/acp-router"]
    }
  }
}
```

See [MCP Client Setup](#mcp-client-setup) below for client-specific configuration examples, or the detailed guide at [docs/MCP_CLIENT_SETUP.md](docs/MCP_CLIENT_SETUP.md).

## MCP Client Setup

ACP Router is a standard stdio MCP server. Any MCP client that supports `command`-based servers can launch it. Below are config examples for common clients.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent location on your platform:

```json
{
  "mcpServers": {
    "acp-router": {
      "command": "npx",
      "args": ["@peanut996/acp-router"]
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
    "acp-router": {
      "command": "npx",
      "args": ["@peanut996/acp-router"]
    }
  }
}
```

### Windsurf

Add to your Windsurf MCP server configuration:

```json
{
  "mcpServers": {
    "acp-router": {
      "command": "npx",
      "args": ["@peanut996/acp-router"]
    }
  }
}
```

### Codex

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "acp-router": {
      "command": "npx",
      "args": ["@peanut996/acp-router"]
    }
  }
}
```

### Generic MCP Client

Any client that supports stdio MCP servers can use ACP Router with the following parameters:

| Field | Value |
| --- | --- |
| Command | `npx` |
| Args | `["acp-router"]` |
| Transport | stdio |

If you installed globally, use `"command": "acp-router"` with an empty args array instead.

## CLI

ACP Router ships with a command-line interface (`acp-router-cli`) for use outside of an MCP client. Install globally to get the command on your PATH:

```bash
npm install -g @peanut996/acp-router
```

### Commands

| Command | Description |
| --- | --- |
| `acp-router-cli run` | Run a coding agent in a worktree (sync, blocks until done) |
| `acp-router-cli agents` | List discovered agents |
| `acp-router-cli models <agent>` | Probe an agent for available models |
| `acp-router-cli jobs` | List jobs |
| `acp-router-cli job <id>` | Get job details |
| `acp-router-cli tail <id>` | Tail job events |
| `acp-router-cli cancel <id>` | Cancel a running job |
| `acp-router-cli sessions` | List sessions |
| `acp-router-cli config` | Get or set config |

### Examples

```bash
# List available agents
acp-router-cli agents

# Probe models for OpenCode
acp-router-cli models opencode

# Run a job (sync, prints JSON result when done)
acp-router-cli run --worktree /path/to/repo --prompt "Fix the failing tests" --agent opencode

# Run with streaming events to stderr
acp-router-cli run --worktree /path/to/repo --prompt "Refactor utils" --stream

# Run with a specific model and permission profile
acp-router-cli run --worktree /path/to/repo --prompt "Add tests" --model gpt-5 --permission-profile acceptEdits

# Tail events for a running async job
acp-router-cli tail <job-id>

# Cancel a job
acp-router-cli cancel <job-id> --reason "no longer needed"

# Get current config
acp-router-cli config

# Set default agent
acp-router-cli config --set --defaultAgent opencode
```

### `run` options

| Flag | Description | Default |
| --- | --- | --- |
| `--worktree <path>` | Absolute path to worktree (required) | -- |
| `--prompt <text>` | Task prompt (required) | -- |
| `--agent <id>` | Agent id | auto-select |
| `--mode <mode>` | Execution mode | `implementation` |
| `--timeout-sec <n>` | Timeout in seconds | `3600` |
| `--permission-profile <p>` | `plan` / `acceptEdits` / `bypassPermissions` | `bypassPermissions` |
| `--model <id>` | Model id to use (agent-specific) | agent default |
| `--collect-diff <bool>` | Collect git diff | `true` |
| `--session-id <id>` | Continue an existing session | -- |
| `--stream` | Stream events to stderr while running | off |

Run `acp-router-cli <command> --help` for command-specific options.

## Tools

ACP Router exposes 9 MCP tools:

| Tool | Description | Key Params |
| --- | --- | --- |
| `discover_agents` | Discover locally installed coding agents and their ACP adapter status. Returns transport, ACP availability, registry metadata, and install hints. Pass `excludeAgent` with your own agent id to avoid self-dispatch. | `refresh` (bool, optional), `includeNotInstalled` (bool, optional), `excludeAgent` (string, optional -- pass your own agent id to avoid self-dispatch) |
| `get_agent_models` | Probe an ACP agent for its available model list. Starts a temporary ACP session, reads config options, and returns model choices. Use this before `run_agent` to discover valid model ids. | `agent` (string, required), `worktree` (string, optional) |
| `manage_config` | Get or set ACP Router configuration including default agent, per-mode defaults, disabled agents, and safety policy. | `action` ("get" \| "set"), `defaultAgent`, `disabledAgents`, `launchExternalAgents`, `inheritEnvironment`, `allowBypassPermissions`, `defaultPermissionProfile`, `registryEnabled`, `registryUrl`, `registryCacheTtlSec`, `modeDefaults` |
| `run_agent` | Run a coding agent in an isolated worktree. Requires an absolute worktree path. Supports sync and async execution. ACP-only -- CLI fallback is not supported. | `agent` (string, optional), `worktree` (string, required), `prompt` (string, required), `mode`, `async` (bool), `sessionId`, `timeoutSec`, `permissionProfile`, `model`, `collectDiff`, `launchExternalAgents`, `inheritEnvironment`, `metadata` |
| `list_jobs` | List ACP Router jobs from the local registry with optional filters. | `status`, `agent`, `worktree`, `limit` |
| `get_job` | Get an ACP Router job by id. | `jobId` (string, required) |
| `tail_job_events` | Return newly recorded job events from the JSONL event log for polling-style progress updates. Events are streamed in real-time for long-running async jobs. | `jobId` (string, required), `afterEventIndex`, `limit`, `includeLogTail`, `logTailBytes` |
| `cancel_job` | Cancel a job and terminate an active child process when the current MCP server owns it. | `jobId` (string, required), `reason` (string, optional) |
| `manage_sessions` | List, read, continue, or archive ACP Router sessions. `read` loads a session's conversation history. | `action` ("list" \| "read" \| "continue" \| "archive"), `sessionId`, `prompt`, `agent`, `worktree`, `async`, `includeArchived`, `limit`, `launchExternalAgents`, `inheritEnvironment`, `timeoutSec` |

### Permission Profiles

Permission profiles control what the spawned agent is allowed to do. They map to the ACP adapter's mode setting and follow Claude Code naming conventions:

| Profile | Description |
| --- | --- |
| `plan` | Read-only / planning mode. The agent should not modify files. ACP Router also detects `plan_mode_violation` when an agent modifies files despite this profile (guards against upstream ACP adapters that don't enforce read-only). |
| `acceptEdits` | The agent may edit files within the worktree. |
| `bypassPermissions` | The agent bypasses all permission checks (default). |

Set the default profile via `manage_config` (`defaultPermissionProfile`) or override per-job via `run_agent` (`permissionProfile`). `bypassPermissions` can be disabled globally via `safety.allowBypassPermissions`.

### Model Selection

Some ACP agents (e.g. OpenCode) support multiple models. Use `get_agent_models` to discover available model ids before launching a job, then pass the chosen id via `run_agent`'s `model` parameter:

```text
get_agent_models with agent "opencode"
run_agent with agent "opencode", model "gpt-5", worktree "/path", prompt "..."
```

This is useful when an agent's default model is unavailable (e.g. insufficient balance) and you want to switch to an alternative.

## ACP-Only Mode

ACP Router runs agents exclusively through the Agent Client Protocol (ACP). The previous CLI fallback adapters have been removed.

### How it works

1. When you call `run_agent`, ACP Router checks whether the selected agent has an available ACP adapter.
2. If the ACP executable is on `PATH`, it launches directly.
3. If the ACP executable is not on `PATH` but the ACP Registry lists an npx distribution for that agent, ACP Router automatically launches it via `npx --yes <package>`.
4. If no ACP adapter is available at all, the job hard-fails with an `acp_required` error and an install hint telling you how to install the adapter.

### When ACP is not available

| Scenario | Behavior |
| --- | --- |
| ACP executable on `PATH` | Launches directly |
| ACP executable not on `PATH`, registry has npx distribution | Auto-launches via `npx --yes <package>` |
| ACP executable not on `PATH`, no npx distribution | Job fails with `acp_required` error and install hint |

## Supported Agents

### How Agent Discovery Works

ACP Router reads the [ACP Registry](https://agentclientprotocol.com/) to discover all compatible agents (currently 37+). For each agent:

1. **Binary distributions** (e.g. OpenCode, Kimi, Goose, Devin): ACP Router probes your `PATH` for the executable. If found, it launches directly. If not found, the agent is marked `not_installed` and won't appear in `discover_agents` results by default.
2. **npx distributions** (e.g. Gemini CLI, GitHub Copilot, Cline, Auggie, Qwen Code, GLM Agent): ACP Router auto-launches via `npx --yes <package>`. No pre-installation needed -- npx downloads the adapter on first run.
3. **Hybrid distributions** (e.g. Codex CLI, Kilo, siGit): Uses PATH if available, falls back to npx.

Use `discover_agents` to see which agents are available on your machine:

```text
discover_agents
discover_agents with includeNotInstalled true, to see all registry agents including ones not yet installed
```

### Verified Agents

These agents have been tested with ACP Router:

| Agent | Type | Launch Method | Notes |
| --- | --- | --- | --- |
| OpenCode | Binary | `opencode acp --cwd <worktree>` | Native ACP; adds `--cwd` and log flags |
| Cursor Agent | Binary | `agent acp` | Cursor CLI with native ACP; pre-authenticate with `agent login` |
| Claude Code | npx | `claude-agent-acp` or `npx --yes @agentclientprotocol/claude-agent-acp` | Uses Claude Agent SDK; needs ANTHROPIC_API_KEY |
| Codex CLI | Hybrid | `codex-acp` or `npx --yes @zed-industries/codex-acp` | Wraps local Codex CLI; needs codex on PATH |
| Devin | Binary | `devin acp` | Cognition's Devin CLI |

### Other Registry Agents

All 37+ agents in the ACP Registry are supported out of the box. Notable ones include:

| Agent | Type | Notes |
| --- | --- | --- |
| Gemini CLI | npx | Google's CLI; `npx --yes @google/gemini-cli --acp` |
| GitHub Copilot | npx | `npx --yes @github/copilot --acp` |
| Kimi CLI | Binary | Moonshot AI; install from GitHub releases |
| Qwen Code | npx | Alibaba's Qwen coding agent |
| GLM Agent | npx | Zhipu's GLM coding agent |
| Auggie CLI | npx | Augment Code's agent |
| Cline | npx | Popular VS Code agent |
| Factory Droid | npx | Factory's dev agent |
| Goose | Binary | Block's open-source agent |
| Grok Build | npx | xAI's coding agent |
| Junie | Binary | JetBrains' agent |

Run `discover_agents` to see the full list available on your machine.

### Agent Selection

When `run_agent` is called without an explicit `agent` parameter, ACP Router selects one automatically:

1. If `defaultAgent` is configured and available, use it.
2. If `modeDefaults` has an entry for the requested mode, use it.
3. Otherwise, pick the first available agent with `acp_stdio` transport.

Set a default via `manage_config`:

```text
manage_config with action "set", defaultAgent "opencode"
```

## Configuration

ACP Router stores its configuration in `~/.acp-router/config.json`.

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
| `safety.allowBypassPermissions` | boolean | `true` | Allow `bypassPermissions` permission profile |
| `safety.defaultPermissionProfile` | string | `"bypassPermissions"` | Default permission profile for new jobs (`plan` / `acceptEdits` / `bypassPermissions`) |
| `safety.requireAbsoluteWorktree` | boolean | `true` | Require an absolute worktree path |

Read or update config through the `manage_config` tool:

```text
manage_config with action "get"
manage_config with action "set", defaultAgent "opencode"
```

## Data Directory and Paths

ACP Router stores all data under `~/.acp-router/`:

| Path | Description |
| --- | --- |
| `~/.acp-router/config.json` | Configuration file |
| `~/.acp-router/registry.json` | Job and session registry |
| `~/.acp-router/logs/` | Per-job JSONL event logs |
| `~/.acp-router/acp-registry-cache.json` | ACP Registry metadata cache |

Override the data directory by setting the `ACP_ROUTER_DATA_DIR` environment variable:

```json
{
  "mcpServers": {
    "acp-router": {
      "command": "npx",
      "args": ["@peanut996/acp-router"],
      "env": {
        "ACP_ROUTER_DATA_DIR": "/custom/path/to/data"
      }
    }
  }
}
```

## Recursion Guard

ACP Router prevents infinite agent dispatch loops using the `ACP_ROUTER_DEPTH` environment variable.

- Each time ACP Router launches a child agent, it increments `ACP_ROUTER_DEPTH` by 1 in the child process environment.
- The maximum recursion depth is **3**.
- When `run_agent` is called and `ACP_ROUTER_DEPTH` is already at or above 3, the job immediately fails with a `recursion_limit` error.

This guards against scenarios where an ACP agent itself calls ACP Router to dispatch another agent, creating a loop. The depth counter propagates through the process tree so nested dispatches are tracked across the entire chain.

## Plan Mode Violation Detection

When `permissionProfile` is set to `plan`, the agent is expected to operate in read-only mode. However, some upstream ACP adapters do not enforce read-only mode. ACP Router detects this by checking for file changes in the worktree after a `plan` job completes.

If files were modified despite the `plan` profile, the job result includes a `plan_mode_violation` warning listing the changed files. This helps identify adapter bugs and prevents unintended modifications during planning.

## Development

```bash
git clone https://github.com/peanut996/acp-router.git
cd acp-router
pnpm install
```

### Validation

```bash
pnpm run check    # TypeScript typecheck (tsgo --noEmit)
pnpm run build    # Build to dist/
```

### Start the server locally

```bash
pnpm start
```

## License

MIT
