---
name: acp-coding-agent-dispatcher
description: Dispatch independent coding tasks from Codex to local ACP or CLI coding agents through the bundled dispatcher MCP tools.
---

# ACP Coding Agent Dispatcher

Use this skill when the user asks Codex to hand off a clearly scoped coding task to another local coding agent, compare agent options, continue an external agent session, or inspect dispatcher jobs.

## When To Use

Use the dispatcher when all of these are true:

- The task can be described as a bounded prompt with clear deliverables.
- The work can happen in a dedicated or sibling worktree.
- The outcome can be reviewed by Codex through changed files, a diff summary, and validation output.
- The user expects an external coding agent such as OpenCode, Claude Code, Cursor Agent, Codex CLI, or another ACP-compatible agent to do the implementation work.

Do not use the dispatcher for tiny edits, tasks that require the current Codex thread's full context, secrets handling, destructive operations, or work that cannot be isolated to a worktree.

## Tool Flow

1. Call `discover_coding_agents` when you need to see available local agents or choose a default.
2. Call `get_coding_agent_dispatcher_config` before relying on default agent, permission, or worktree policies.
3. Call `run_coding_agent` for a new task. Provide an absolute `worktree`, a concise `prompt`, `mode`, `permissionProfile`, and `async`.
4. Call `get_coding_agent_job` or `list_coding_agent_jobs` to inspect status.
5. Call `list_coding_agent_sessions` before continuing prior work.
6. Call `continue_coding_agent_session` only when the user wants to add a prompt to a known session.
7. Call `cancel_coding_agent_job`, `configure_coding_agent_dispatcher`, or `archive_coding_agent_session` only after the user confirms the write operation.

## Dispatch Prompt Shape

When calling `run_coding_agent` or `continue_coding_agent_session`, include:

- Goal and acceptance criteria.
- Allowed worktree path and relevant files.
- Constraints from the user and repository instructions.
- Expected final report: changed files, tests or validation, risks, and unresolved questions.

The alpha MCP server exposes safe local registry tools. It discovers installed agents, records jobs and sessions, writes JSONL job logs, and captures current git worktree state. External process launch is intentionally disabled until ACP and CLI adapters are implemented.
