---
name: coding-agent-dispatch
description: Dispatch independent coding tasks from Codex to local ACP or CLI coding agents through the bundled Agent Router MCP tools.
---

# Coding Agent Dispatch

Use this skill when the user asks Codex to hand off a clearly scoped coding task to another local coding agent, compare agent options, continue an external agent session, or inspect Agent Router jobs.

## When To Use

Use Agent Router when all of these are true:

- The task can be described as a bounded prompt with clear deliverables.
- The work can happen in a dedicated or sibling worktree.
- The outcome can be reviewed by Codex through changed files, a diff summary, and validation output.
- The user expects an external coding agent such as OpenCode, Claude Code, Cursor Agent, Codex CLI, or another ACP-compatible agent to do the implementation work.

Do not use Agent Router for tiny edits, tasks that require the current Codex thread's full context, secrets handling, destructive operations, or work that cannot be isolated to a worktree.

## Tool Flow

1. Call `discover_coding_agents` when you need to see available local agents or choose a default.
2. Call `get_coding_agent_dispatcher_config` before relying on default agent, permission, or worktree policies.
3. Call `run_coding_agent` for a new task. Provide an absolute `worktree`, a concise `prompt`, `mode`, `permissionProfile`, and `async`; pass `launchExternalAgents=false` only when the user wants record-only behavior.
4. Call `tail_coding_agent_job_events` to poll new events for async jobs; pass the previous `nextEventIndex` as `afterEventIndex`.
5. Call `get_coding_agent_job` or `list_coding_agent_jobs` to inspect status.
6. Call `list_coding_agent_sessions` before continuing prior work.
7. Call `continue_coding_agent_session` only when the user wants to add a prompt to a known session.
8. Call `cancel_coding_agent_job`, `configure_coding_agent_dispatcher`, or `archive_coding_agent_session` only after the user confirms the write operation.

## Dispatch Prompt Shape

When calling `run_coding_agent` or `continue_coding_agent_session`, include:

- Goal and acceptance criteria.
- Allowed worktree path and relevant files.
- Constraints from the user and repository instructions.
- Expected final report: changed files, tests or validation, risks, and unresolved questions.

The alpha MCP server exposes safe local registry tools. It discovers installed agents, reads ACP Registry metadata, records jobs and sessions, writes JSONL job logs, tails job events for polling progress, captures current git worktree state, and prefers installed ACP adapters for OpenCode, Claude Code, and Codex CLI before falling back to CLI adapters where available. Runnable dispatch tools default to `launchExternalAgents=true` for existing absolute worktrees; pass `launchExternalAgents=false` on a single call when the user wants record-only behavior.
