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
- run Claude Code, Cursor Agent, and Codex CLI through synchronous CLI fallback adapters.
- surface ACP session config options and available model choices without setting a model by default.
- return ACP adapter failures in `failureReason` and `agentErrors`, including provider-side errors such as balance or rate-limit failures.

The dispatcher does not set an ACP model by default. When an ACP agent exposes session `configOptions`, the OpenCode adapter records summarized options and returns model choices in `availableModels`; failures include the same data so Codex can ask the user which model to retry with.

External launch is disabled by default. `run_coding_agent` records a completed `record_only` job unless `launchExternalAgents` is enabled. Runnable adapters currently require `async=false`; async job execution is still tracked as a later milestone.

External agent processes inherit the dispatcher process environment by default, matching direct terminal usage for tools such as Claude Code. Set `inheritEnvironment=false` through `configure_coding_agent_dispatcher` to restrict child process environment variables to the minimal dispatcher allowlist.

## Validate

```bash
npm run check
npm run smoke
```

`npm run smoke` uses fake local `opencode`, `claude`, `agent`, and `codex` commands so it can validate the ACP and CLI fallback adapters without model calls.

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

The plugin manifest can be validated with the Codex plugin creator helper:

```bash
uv run --with PyYAML python /Users/peanut996/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
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
