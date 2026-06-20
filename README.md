# Agent Router

Codex plugin for discovering local coding agents and recording Agent Router jobs through a bundled MCP server.

The plugin display name remains `Agent Router`; its bundled Codex skill is titled `Coding Agent Dispatch` so Codex UI surfaces can distinguish the plugin from the task-dispatch skill.

## Current Status

This repository is an alpha implementation. It can:

- expose Agent Router MCP tools to Codex;
- discover local `opencode`, Cursor Agent `agent`, `claude`, `codex`, and installed ACP adapter commands on `PATH`;
- read ACP Registry metadata with a local cache and attach registry ids, icons, versions, and install hints to discovered agents;
- probe installed agent versions when available;
- persist Agent Router config, sessions, and jobs under `~/.codex/agent-router`;
- write per-job JSONL logs;
- capture current git worktree state for recorded jobs.
- run OpenCode through ACP stdio by default for runnable jobs, with per-call and config overrides to disable external launch.
- prefer installed ACP adapters for Claude Code and Codex CLI, and fall back to CLI adapters when ACP adapters are not installed.
- run Cursor Agent through the official `agent` CLI fallback adapter.
- launch supported adapters synchronously or as background jobs with persisted child process metadata and cancellable in-memory process tracking.
- tail job event logs through `tail_coding_agent_job_events` so Codex can poll near-real-time progress without reading files directly.
- recover jobs orphaned by an MCP server restart, best-effort terminate the recorded child PID, and release stale worktree locks.
- aggregate OpenCode native ACP `session/list` results into `list_coding_agent_sessions` when external launch is enabled.
- surface ACP session config options and available model choices without setting a model by default.
- return ACP adapter failures in `failureReason` and `agentErrors`, including provider-side errors such as balance or rate-limit failures.

Agent Router does not set an ACP model by default. When an ACP agent exposes session `configOptions`, the OpenCode adapter records summarized options and returns model choices in `availableModels`; failures include the same data so Codex can ask the user which model to retry with.

External launch is enabled by default for `run_coding_agent` and `continue_coding_agent_session` when the request uses an existing absolute worktree. Pass `launchExternalAgents=false` on a single tool call, or set it through `configure_coding_agent_dispatcher`, to record a completed `record_only` job instead. Runnable adapters support both `async=false` synchronous execution and `async=true` background execution. `cancel_coding_agent_job` terminates active in-memory child processes for jobs started by the current MCP server process and records kill metadata on the job.

On MCP server restart, Agent Router checks the JSON registry before first config or registry use. Jobs left in `queued`, `starting`, or `running` that are not owned by the current server process are marked `orphaned`; when a child PID was persisted, Agent Router sends `SIGTERM` best-effort before releasing the worktree lock. Sessions move back to `idle` when resumable or `orphaned` otherwise.

External agent processes inherit the Agent Router process environment by default, matching direct terminal usage for tools such as Claude Code. Pass `inheritEnvironment=false` on a single tool call, or set it through `configure_coding_agent_dispatcher`, to restrict child process environment variables to the minimal Agent Router allowlist.

## User Guides

- English: [docs/USAGE.md](docs/USAGE.md)
- 中文: [docs/USAGE.zh-CN.md](docs/USAGE.zh-CN.md)

## Install From GitHub

Agent Router is distributed as a repo marketplace from:

```text
https://github.com/peanut996/codex-agent-router
```

Install the marketplace and then install the plugin:

```bash
codex plugin marketplace add peanut996/codex-agent-router
codex plugin add agent-router@codex-agent-router
```

For a pinned install of the current release:

```bash
codex plugin marketplace add peanut996/codex-agent-router@v0.6.7
codex plugin add agent-router@codex-agent-router
```

Open a new Codex thread after installing so Codex picks up the bundled skill and MCP server.

## Validate

```bash
npm run check
npm run smoke
npm run smoke:sessions
npm run smoke:opencode:sessions
npm run e2e:restart-recovery
```

`npm run smoke` uses fake local `opencode`, `claude-agent-acp`, `claude`, Cursor Agent `agent`, `codex-acp`, and `codex` commands plus a fake ACP Registry payload so it can validate ACP-first routing and CLI fallback adapters without model calls.

`npm run smoke:sessions` uses fake OpenCode ACP to validate session list, continue, provider session resume, and archive behavior without model calls.

`npm run e2e:restart-recovery` uses a fake PATH-visible `claude` CLI to validate async PID persistence, MCP restart orphan recovery, best-effort child termination, and post-recovery worktree lock release without model calls.

To verify that the real OpenCode ACP server can initialize and create a session without sending a model prompt:

```bash
npm run smoke:opencode
```

`npm run smoke:opencode:sessions` verifies real OpenCode ACP `session/list` through Agent Router without sending a prompt or creating a model turn.

## Real E2E

Real E2E scripts call external agents and may incur model cost. They create a temporary git worktree, isolate Agent Router registry/config/logs with `AGENT_ROUTER_DATA_DIR`, and ask the selected agent to append one line to `note.txt`.

```bash
npm run e2e:opencode -- --opencode-model opencode-go/glm-5.2 --keep
npm run e2e:sessions:opencode -- --keep
npm run e2e:claude -- --timeout-sec 600 --keep
npm run e2e:cursor -- --timeout-sec 600 --keep
npm run e2e:codex -- --timeout-sec 600 --keep
```

Omit `--keep` to clean successful runs automatically. Failed runs are always kept for inspection.

`npm run e2e:sessions:opencode` runs two real OpenCode ACP jobs against the same Agent Router session, defaults the temporary project to `opencode-go/glm-5.2`, verifies provider session resume through the `acp_session_resumed` event, then archives the session.

### Adapter Acceptance Matrix

Last manual acceptance sweep: 2026-06-20.

| Agent | Adapter | Real E2E command | Result | Evidence |
| --- | --- | --- | --- | --- |
| OpenCode | Native ACP stdio | `npm run e2e:opencode -- --opencode-model opencode-go/glm-5.2 --keep` | Passed | `status=completed`, provider session created, `note.txt` changed |
| OpenCode session lifecycle | Native ACP stdio | `npm run e2e:sessions:opencode -- --keep` | Passed | initial + continued jobs reused the same provider session and archive worked |
| Claude Code | ACP preferred, CLI fallback retained | `npm run e2e:claude -- --timeout-sec 600 --keep` | CLI fallback passed | `status=completed`, `adapterStatus=claude_cli`, `note.txt` changed; ACP adapter path covered by smoke |
| Cursor Agent | CLI fallback | `npm run e2e:cursor -- --timeout-sec 600 --keep` | Passed | `status=completed`, `adapterStatus=cursor_agent_cli`, provider session `e496274e-a32d-416e-9fc1-fc4e6d9319a5`, `note.txt` changed |
| Codex CLI | ACP preferred, CLI fallback retained | `npm run e2e:codex -- --timeout-sec 600 --keep` | CLI fallback passed | `status=completed`, `adapterStatus=codex_cli`, `note.txt` changed; ACP adapter path covered by smoke |

For a passing real E2E, the JSON output should include `status: "completed"`, a non-empty `providerSessionId` when the provider exposes one, `changedFiles` containing `note.txt`, `failureReason: null`, `agentErrors: []`, and `gitStatus: "M note.txt"`.

If an adapter fails, inspect `job.failureReason`, `job.agentErrors`, and `job.logPath` first. Agent Router surfaces provider-side errors such as `rate_limit`, `authentication_failed`, insufficient balance, and local transport failures in those fields.

The plugin manifest can be checked locally with:

```bash
node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(".codex-plugin/plugin.json","utf8")); for (const k of ["name","version","interface","mcpServers"]) if (!p[k]) throw new Error(`missing ${k}`);'
```

## MCP Tools

- `discover_coding_agents`
- `get_coding_agent_dispatcher_config`
- `configure_coding_agent_dispatcher`
- `run_coding_agent`
- `list_coding_agent_jobs`
- `get_coding_agent_job`
- `tail_coding_agent_job_events`
- `cancel_coding_agent_job`
- `list_coding_agent_sessions`
- `continue_coding_agent_session`
- `archive_coding_agent_session`

## Local Plugin Source

The personal Codex marketplace entry points at:

```text
~/plugins/agent-router
```

This Git repository is the development source. Sync changes into the personal plugin source before reinstalling or testing inside a fresh Codex thread.
