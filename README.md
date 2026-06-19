# ACP Coding Agent Dispatcher

Codex plugin for discovering local coding agents and recording dispatcher jobs through a bundled MCP server.

## Current Status

This repository is an alpha implementation. It can:

- expose dispatcher MCP tools to Codex;
- discover local `opencode`, `agent`, `claude`, and `codex` commands on `PATH`;
- probe installed agent versions when available;
- persist dispatcher config, sessions, and jobs under `~/.codex/agent-dispatcher`;
- write per-job JSONL logs;
- capture current git worktree state for recorded jobs.
- run OpenCode through ACP stdio when external launch is explicitly enabled.
- run Claude Code, Cursor Agent, and Codex CLI through CLI fallback adapters.
- launch supported adapters synchronously or as background jobs with persisted child process metadata and cancellable in-memory process tracking.
- recover jobs orphaned by an MCP server restart, best-effort terminate the recorded child PID, and release stale worktree locks.
- surface ACP session config options and available model choices without setting a model by default.
- return ACP adapter failures in `failureReason` and `agentErrors`, including provider-side errors such as balance or rate-limit failures.

The dispatcher does not set an ACP model by default. When an ACP agent exposes session `configOptions`, the OpenCode adapter records summarized options and returns model choices in `availableModels`; failures include the same data so Codex can ask the user which model to retry with.

External launch is disabled by default. `run_coding_agent` records a completed `record_only` job unless `launchExternalAgents` is enabled. Runnable adapters support both `async=false` synchronous execution and `async=true` background execution. `cancel_coding_agent_job` terminates active in-memory child processes for jobs started by the current MCP server process and records kill metadata on the job.

On MCP server restart, the dispatcher checks the JSON registry before first config or registry use. Jobs left in `queued`, `starting`, or `running` that are not owned by the current server process are marked `orphaned`; when a child PID was persisted, the dispatcher sends `SIGTERM` best-effort before releasing the worktree lock. Sessions move back to `idle` when resumable or `orphaned` otherwise.

External agent processes inherit the dispatcher process environment by default, matching direct terminal usage for tools such as Claude Code. Set `inheritEnvironment=false` through `configure_coding_agent_dispatcher` to restrict child process environment variables to the minimal dispatcher allowlist.

## Validate

```bash
npm run check
npm run smoke
npm run smoke:sessions
```

`npm run smoke` uses fake local `opencode`, `claude`, `agent`, and `codex` commands so it can validate the ACP and CLI fallback adapters without model calls.

`npm run smoke:sessions` uses fake OpenCode ACP to validate session list, continue, provider session resume, and archive behavior without model calls.

To verify that the real OpenCode ACP server can initialize and create a session without sending a model prompt:

```bash
npm run smoke:opencode
```

## Real E2E

Real E2E scripts call external agents and may incur model cost. They create a temporary git worktree, isolate dispatcher registry/config/logs with `AGENT_DISPATCHER_DATA_DIR`, and ask the selected agent to append one line to `note.txt`.

```bash
npm run e2e:opencode -- --opencode-model opencode-go/glm-5.2 --keep
npm run e2e:claude -- --timeout-sec 600 --keep
npm run e2e:cursor -- --timeout-sec 600 --keep
npm run e2e:codex -- --timeout-sec 600 --keep
```

Omit `--keep` to clean successful runs automatically. Failed runs are always kept for inspection.

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
- `cancel_coding_agent_job`
- `list_coding_agent_sessions`
- `continue_coding_agent_session`
- `archive_coding_agent_session`

## Local Plugin Source

The personal Codex marketplace entry points at:

```text
~/plugins/acp-coding-agent-dispatcher
```

This Git repository is the development source. Sync changes into the personal plugin source before reinstalling or testing inside a fresh Codex thread.
