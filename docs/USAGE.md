# Agent Router User Guide

Agent Router is a local Codex plugin that lets Codex discover, run, track, cancel, and continue external coding agents through one routing interface.

In Codex UI, the plugin remains `Agent Router` and the bundled skill appears as `Coding Agent Dispatch`.

Current status: public beta distributed through the GitHub marketplace source.

## What It Supports

| Agent | Adapter | Status |
| --- | --- | --- |
| OpenCode | Native ACP stdio | Real E2E passed |
| OpenCode session lifecycle | Native ACP stdio | Real session list, continue, and archive passed |
| Claude Code | ACP adapter preferred, CLI fallback retained | CLI fallback real E2E passed; ACP adapter path covered by smoke |
| Cursor Agent | CLI fallback through official `agent` command | Real E2E passed |
| Codex CLI | ACP adapter preferred, CLI fallback retained | CLI fallback real E2E passed; ACP adapter path covered by smoke |

Agent Router keeps Codex as the controller. External agents run in a specified worktree and return job status, session ids, changed files, validation notes, failure reasons, agent errors, and log paths.

Discovery also reads ACP Registry metadata by default. Registry data is cached under `~/.codex/agent-router/acp-registry-cache.json` and is used for ids, icons, versions, and install hints only; Agent Router does not auto-install adapters.

## Requirements

- Codex Desktop with local plugin support.
- Node.js 18 or newer.
- A git worktree for every write task.
- At least one installed external agent:
  - `opencode`
  - `claude-agent-acp` for Claude ACP, or `claude` for CLI fallback
  - `codex-acp` for Codex ACP, or `codex` for CLI fallback
  - `claude`
  - Cursor Agent `agent`
  - `codex`

External launches are enabled by default for runnable `run_coding_agent` and `continue_coding_agent_session` calls, but still require an existing absolute worktree.

## Local Install And Refresh

Public beta install from GitHub:

```bash
codex plugin marketplace add peanut996/codex-agent-router
codex plugin add agent-router@codex-agent-router
```

Pinned release install:

```bash
codex plugin marketplace add peanut996/codex-agent-router@v0.6.8
codex plugin add agent-router@codex-agent-router
```

Open a new Codex thread after installing so Codex picks up the bundled skill and MCP server.

The development source is:

```bash
/Users/peanut996/Workspace/codex-agent-router
```

The personal plugin source is:

```bash
/Users/peanut996/plugins/agent-router
```

To refresh the local plugin source from the development repo:

```bash
rsync -a --delete --exclude='.git' \
  /Users/peanut996/Workspace/codex-agent-router/ \
  /Users/peanut996/plugins/agent-router/
```

The personal marketplace entry is named `personal`, so reinstall with:

```bash
codex plugin add agent-router@personal
```

Open a new Codex thread after reinstalling so Codex picks up updated skills and MCP tools.

## First Run In Codex

In a Codex thread, ask:

```text
Discover local coding agents with Agent Router.
```

Run a task only against an absolute worktree path:

```text
Use Cursor Agent through Agent Router to edit /absolute/path/to/worktree.
Append one line to note.txt, then report changed files, validation, risks, job id, session id, and log path.
```

To record without launching an external agent, pass `launchExternalAgents=false` on that one request:

```text
Use Cursor Agent through Agent Router in /absolute/path/to/worktree, but set launchExternalAgents=false for this run.
```

## Safety Defaults

- `launchExternalAgents=true` by default for runnable dispatch tools.
- `worktree` must be an existing absolute path.
- Writable jobs lock a worktree so two agents do not edit it at the same time.
- Child processes inherit the Agent Router environment by default. Pass `inheritEnvironment=false` on a single run or set it in config if you want a restricted environment.
- `bypass_permissions` is disabled unless explicitly allowed in config.
- Agent Router does not commit, push, or open pull requests automatically.

## Job And Session Operations

Common user-facing requests:

```text
List Agent Router jobs.
Show job <jobId>.
Tail new events for job <jobId>.
Cancel job <jobId>.
List external agent sessions.
Continue session <sessionId> with this follow-up prompt: ...
Archive session <sessionId>.
```

Important returned fields:

- `jobId`
- `sessionId`
- `providerSessionId`
- `status`
- `adapterStatus`
- `changedFiles`
- `failureReason`
- `agentErrors`
- `logPath`
- `events`
- `nextEventIndex`
- `hasMore`

For async jobs, poll progress with:

```text
Tail Agent Router job <jobId> events.
```

The returned `events` are zero-indexed. Pass the previous `nextEventIndex` as `afterEventIndex` on the next call to get only new events.

## Validation Commands

No-model validation:

```bash
npm run check
npm run smoke
npm run smoke:sessions
npm run smoke:opencode
npm run smoke:opencode:sessions
npm run smoke:acp:handshake
npm run e2e:restart-recovery
```

Real E2E validation, which may call models and incur cost:

```bash
npm run e2e:opencode -- --opencode-model opencode-go/glm-5.2 --timeout-sec 600 --keep
npm run e2e:sessions:opencode -- --keep
npm run e2e:claude -- --timeout-sec 600 --keep
npm run e2e:cursor -- --timeout-sec 600 --keep
npm run e2e:codex -- --timeout-sec 600 --keep
```

A passing real E2E should include:

- `status: "completed"`
- `changedFiles` containing `note.txt`
- `failureReason: null`
- `agentErrors: []`
- `gitStatus: "M note.txt"`

## Troubleshooting

| Symptom | What To Check |
| --- | --- |
| Agent is not discovered | Run the agent's `--version` command and confirm it is on `PATH`. |
| `run_coding_agent` records only | Confirm the tool call or config did not set `launchExternalAgents=false`. |
| Worktree is rejected | Use an existing absolute path. |
| Worktree is locked | Check active jobs and cancel or wait for the running writable job. |
| Claude appears stuck | Inspect `job.agentErrors` and `job.logPath`; rate-limit retries can look like a hang. |
| Cursor Agent fails auth | Run `agent status`; if needed, run `agent login`. |
| OpenCode model/provider error | Inspect `availableModels`; for OpenCode ACP, use project-level `opencode.json` for model selection. |
| Need progress | Call `tail_coding_agent_job_events` with the job id and latest `afterEventIndex`. |
| Need raw evidence | Open `job.logPath`, which is a JSONL event log. |

## Product Boundaries

This plugin does not modify the native Codex sidebar, message avatars, or settings UI. V1 exposes the experience through MCP tools and structured results inside Codex threads.

The plugin is ready for local use and public beta validation through the GitHub marketplace source.
