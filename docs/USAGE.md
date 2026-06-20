# Agent Router User Guide

Agent Router is a local Codex plugin that lets Codex discover, run, track, cancel, and continue external coding agents through one routing interface.

Current status: local/personal plugin, not yet published to the public Codex marketplace.

## What It Supports

| Agent | Adapter | Status |
| --- | --- | --- |
| OpenCode | Native ACP stdio | Real E2E passed |
| OpenCode session lifecycle | Native ACP stdio | Real session list, continue, and archive passed |
| Claude Code | CLI fallback | Real E2E passed |
| Cursor Agent | CLI fallback through official `agent` command | Real E2E passed |
| Codex CLI | CLI fallback | Real E2E passed |

Agent Router keeps Codex as the controller. External agents run in a specified worktree and return job status, session ids, changed files, validation notes, failure reasons, agent errors, and log paths.

## Requirements

- Codex Desktop with local plugin support.
- Node.js 18 or newer.
- A git worktree for every write task.
- At least one installed external agent:
  - `opencode`
  - `claude`
  - Cursor Agent `agent`
  - `codex`

External launches are disabled by default. This is intentional.

## Local Install And Refresh

Public beta install from GitHub:

```bash
codex plugin marketplace add peanut996/codex-agent-router
codex plugin add agent-router@codex-agent-router
```

Pinned release install:

```bash
codex plugin marketplace add peanut996/codex-agent-router@v0.6.0
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

Then enable external launches:

```text
Configure Agent Router with launchExternalAgents=true.
```

Run a task only against an absolute worktree path:

```text
Use Cursor Agent through Agent Router to edit /absolute/path/to/worktree.
Append one line to note.txt, then report changed files, validation, risks, job id, session id, and log path.
```

When you are done testing, disable launches again:

```text
Configure Agent Router with launchExternalAgents=false.
```

## Safety Defaults

- `launchExternalAgents=false` by default.
- `worktree` must be an existing absolute path.
- Writable jobs lock a worktree so two agents do not edit it at the same time.
- Child processes inherit the Agent Router environment by default. Set `inheritEnvironment=false` if you want a restricted environment.
- `bypass_permissions` is disabled unless explicitly allowed in config.
- Agent Router does not commit, push, or open pull requests automatically.

## Job And Session Operations

Common user-facing requests:

```text
List Agent Router jobs.
Show job <jobId>.
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

## Validation Commands

No-model validation:

```bash
npm run check
npm run smoke
npm run smoke:sessions
npm run smoke:opencode
npm run smoke:opencode:sessions
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
| `run_coding_agent` records only | Confirm `launchExternalAgents=true`. |
| Worktree is rejected | Use an existing absolute path. |
| Worktree is locked | Check active jobs and cancel or wait for the running writable job. |
| Claude appears stuck | Inspect `job.agentErrors` and `job.logPath`; rate-limit retries can look like a hang. |
| Cursor Agent fails auth | Run `agent status`; if needed, run `agent login`. |
| OpenCode model/provider error | Inspect `availableModels`; for OpenCode ACP, use project-level `opencode.json` for model selection. |
| Need raw evidence | Open `job.logPath`, which is a JSONL event log. |

## Product Boundaries

This plugin does not modify the native Codex sidebar, message avatars, or settings UI. V1 exposes the experience through MCP tools and structured results inside Codex threads.

The plugin is ready for local use and internal validation. Public marketplace publication is still a separate release step.
