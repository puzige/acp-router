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
- return ACP adapter failures in `failureReason` and `agentErrors`, including provider-side errors such as balance or rate-limit failures.

External launch is disabled by default. `run_coding_agent` records a completed `record_only` job unless `launchExternalAgents` is enabled. The only runnable adapter today is OpenCode ACP, and it currently requires `async=false`.

## Validate

```bash
npm run check
npm run smoke
```

`npm run smoke` uses a fake local `opencode` command so it can validate the ACP adapter without model calls.

To verify that the real OpenCode ACP server can initialize and create a session without sending a model prompt:

```bash
npm run smoke:opencode
```

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
