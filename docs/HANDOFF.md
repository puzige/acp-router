# Agent Router Handoff

Last updated: 2026-06-20, Asia/Shanghai

## Snapshot

- Product name: Agent Router
- Package name: `agent-router` (npm)
- Repo: `https://github.com/peanut996/agent-router`
- Local repo: `/Users/peanut996/Workspace/agent-router-refactor` (worktree on branch `feat/refactor-generic-mcp`)
- Default branch: `master`
- Current version: `0.7.0`
- MCP server name: `agent-router`
- MCP server transport: stdio
- bin entry: `agent-router` via `./bin/agent-router.mjs`
- MCP SDK: `@modelcontextprotocol/sdk` ^1.29.0
- Data directory: `~/.agent-router/`

## Source Inventory

Current checked-in product docs:

- `README.md`: public product overview, quick start, MCP client setup, tools reference, ACP-only mode, supported agents, configuration, data directory, recursion guard, and development instructions.
- `docs/MCP_CLIENT_SETUP.md`: detailed MCP client configuration guide with prerequisites, installation options, client-specific configs, troubleshooting, and environment variables.
- `docs/HANDOFF.md`: this document -- operational status and progress ledger.

Deleted files (no longer relevant after refactor):

- `docs/USAGE.md`: Codex-plugin-specific English usage guide. Replaced by `README.md` and `docs/MCP_CLIENT_SETUP.md`.
- `docs/USAGE.zh-CN.md`: Codex-plugin-specific Chinese usage guide. Replaced by `README.md` and `docs/MCP_CLIENT_SETUP.md`.
- `.codex-plugin/`: Codex plugin manifest and packaging. Removed.
- `skills/`: Codex bundled skill. Removed.
- `.mcp.json`: Codex-specific MCP config. Removed.
- `.agents/`: Codex marketplace entry. Removed.

## Product Boundary

Agent Router is a generic MCP server for routing coding tasks to local ACP agents. It works with any MCP-compatible client (Claude Desktop, Cursor, Windsurf, Codex, etc.) and is no longer tied to Codex as a plugin.

In scope:

- Discover installed local coding agents and their ACP adapter status.
- Read ACP Registry metadata for known adapters, with local caching.
- Configure defaults and safety flags through MCP tools.
- Run external agents against an existing absolute worktree via ACP stdio.
- Track jobs, sessions, event logs, process PID metadata, changed files, and failure reasons.
- List, continue, cancel, archive, and tail jobs/sessions through MCP tools.
- Automatic npx fallback when an ACP executable is not on PATH but the registry has an npx distribution.
- Recursion guard via `AGENT_ROUTER_DEPTH` env var (max depth 3).

Out of scope:

- CLI fallback adapters (removed in v0.7.0; ACP-only mode).
- Automatic adapter installation (install hints are surfaced, but users install tools themselves).
- Automatic commit, push, PR, or conflict resolution.
- Cloud or multi-tenant scheduling.
- Native UI integration for any specific MCP client.

## Implemented MCP Tools

Agent Router exposes 8 MCP tools (consolidated from 11 in v0.6.8):

- `discover_agents` -- discover local coding agents and ACP status
- `manage_config` -- get/set config (action: "get" | "set")
- `run_agent` -- run a coding agent in a worktree (ACP-only, with recursion guard)
- `list_jobs` -- list jobs
- `get_job` -- get job details
- `tail_job_events` -- tail job events
- `cancel_job` -- cancel a job
- `manage_sessions` -- list/continue/archive sessions (action: "list" | "continue" | "archive")

### Tool consolidation mapping (v0.6.8 to v0.7.0)

| v0.6.8 tool | v0.7.0 tool | Notes |
| --- | --- | --- |
| `discover_coding_agents` | `discover_agents` | Renamed |
| `get_coding_agent_dispatcher_config` | `manage_config` (action: "get") | Merged into `manage_config` |
| `configure_coding_agent_dispatcher` | `manage_config` (action: "set") | Merged into `manage_config` |
| `run_coding_agent` | `run_agent` | Renamed; ACP-only |
| `list_coding_agent_jobs` | `list_jobs` | Renamed |
| `get_coding_agent_job` | `get_job` | Renamed |
| `tail_coding_agent_job_events` | `tail_job_events` | Renamed |
| `cancel_coding_agent_job` | `cancel_job` | Renamed |
| `list_coding_agent_sessions` | `manage_sessions` (action: "list") | Merged into `manage_sessions` |
| `continue_coding_agent_session` | `manage_sessions` (action: "continue") | Merged into `manage_sessions` |
| `archive_coding_agent_session` | `manage_sessions` (action: "archive") | Merged into `manage_sessions` |

## Current Capability Progress

| Area | Status | Notes |
| --- | --- | --- |
| MCP server | Done | Migrated from hand-rolled JSON-RPC to `@modelcontextprotocol/sdk`. Stdio transport. |
| Agent discovery | Done | Finds `opencode`, `claude`, `codex`, `cursor-agent`, plus installed ACP adapter commands. |
| ACP Registry metadata | Done | Reads registry metadata, caches it locally, exposes ids/icons/versions/install hints. No auto-install. |
| npx fallback | Done | When ACP executable not on PATH but registry has npx distribution, auto-launches via `npx --yes <package>`. |
| ACP-only mode | Done | CLI fallback removed. Agents without ACP hard-fail with install hint. |
| Recursion guard | Done | `AGENT_ROUTER_DEPTH` env var, max depth 3. Prevents infinite agent dispatch loops. |
| Default config | Done | `launchExternalAgents=true` and `inheritEnvironment=true` by default; per-call overrides available. |
| Run jobs | Done | Sync and async runs supported. Worktree must be existing absolute path. ACP-only. |
| Job tracking | Done | Registry records job/session state, process PID metadata, status, changed files, logs, and errors. |
| Event tailing | Done | `tail_job_events` supports polling with `afterEventIndex`. |
| Cancellation | Done | Active child processes can be cancelled; persisted process metadata records kill attempts. |
| Restart recovery | Done | Orphaned running jobs are marked and recorded child PIDs are best-effort terminated. |
| Session list/continue/archive | Done | All three actions consolidated into `manage_sessions`. |
| Result/failure surfacing | Done | Provider errors returned in `failureReason` and `agentErrors`; model config options surfaced in `availableModels`. |
| Safety | Mostly done | Worktree absolute-path requirement, per-worktree lock, permission profiles, no auto commit/push. More policy polish can be added later. |

## Adapter Status

| Agent | ACP Support | Launch Method | Current validation |
| --- | --- | --- | --- |
| OpenCode | Native ACP stdio | `opencode acp --cwd <worktree>` | Real ACP E2E passed; real no-model handshake and session-list smoke passed. |
| Claude Code | ACP via `claude-agent-acp` | `claude-agent-acp` or `npx --yes @anthropic-ai/claude-agent-acp` | ACP no-model handshake smoke passed in v0.6.8. npx fallback added in v0.7.0. |
| Codex CLI | ACP via `codex-acp` | `codex-acp` or `npx --yes codex-acp` | ACP no-model handshake smoke passed in v0.6.8. npx fallback added in v0.7.0. |
| Cursor Agent | No ACP adapter | Hard-fail | CLI fallback removed in v0.7.0. Job fails with `acp_required` error. |

## Release Timeline

- `v0.6.6`: added `tail_coding_agent_job_events` for near-real-time polling.
- `v0.6.7`: added ACP Registry metadata/cache, ACP-first routing for OpenCode/Claude/Codex, generalized ACP stdio execution and native session-list aggregation.
- `v0.6.8`: added real no-model ACP adapter handshake smoke for `claude-agent-acp` and `codex-acp`, registry version fallback for ACP adapters that do not support version probing, and PATH-priority fixes for equal/unknown versions.
- `v0.7.0`: refactor from Codex-specific plugin to generic MCP server. Repo/package renamed `codex-agent-router` to `agent-router`. Codex plugin packaging removed. MCP server migrated to `@modelcontextprotocol/sdk`. Data directory changed from `~/.codex/agent-router/` to `~/.agent-router/`. Tools consolidated from 11 to 8. ACP-only mode (CLI fallback removed). npx fallback for ACP adapters. Recursion guard via `AGENT_ROUTER_DEPTH`. Hard cut, no backward compatibility with v0.6.x data.

## Latest Validation Evidence

No-model validation listed in `README.md`:

```bash
npm run check
npm run smoke
npm run smoke:sessions
npm run smoke:opencode
npm run smoke:opencode:sessions
npm run smoke:acp:handshake
npm run e2e:restart-recovery
```

Known real E2E acceptance from prior releases:

- OpenCode ACP file-edit E2E passed with model `opencode-go/glm-5.2`.
- OpenCode session lifecycle E2E passed.
- Claude ACP no-model handshake smoke passed (v0.6.8).
- Codex ACP no-model handshake smoke passed (v0.6.8).

Note: real prompt/file-edit E2E for `claude-agent-acp` and `codex-acp` via the new npx fallback path has not yet been run. The npx fallback logic is covered by smoke tests with fake commands.

## Important Runtime Paths

- Config: `~/.agent-router/config.json`
- Job/session registry: `~/.agent-router/registry.json`
- Logs: `~/.agent-router/logs/`
- ACP Registry cache: `~/.agent-router/acp-registry-cache.json`
- Override: set `AGENT_ROUTER_DATA_DIR` env var to use a custom data directory.

## Current Defaults

- `launchExternalAgents=true`
- `inheritEnvironment=true`
- `allowCurrentDirectory=false`
- `requireAbsoluteWorktree=true`
- `defaultPermissionProfile="workspace_write"`
- `allowBypassPermissions=false`
- Registry enabled by default.
- Registry URL: `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`
- Registry cache TTL: 86400 seconds (24 hours).
- Max recursion depth: 3 (`AGENT_ROUTER_DEPTH`).

## Known Gaps

1. npm package `agent-router` is not yet published to npm. The `npx agent-router` command will not work until the package is published. Use a local clone or `npm link` in the meantime.
2. GitHub repo has not been renamed yet. The repo is still `peanut996/codex-agent-router` on GitHub; `package.json` already references `peanut996/agent-router`. The rename needs to happen on GitHub.
3. Dead CLI fallback code still exists in `mcp/server.mjs` (`runCliFallbackJob`, `getCliAdapterSpec`, CLI adapter specs in `BUILT_IN_AGENTS`). The CLI fallback is never called at runtime (ACP-only enforcement blocks it), but the code has not been cleaned up.
4. Real ACP prompt/file-edit E2E for `claude-agent-acp` and `codex-acp` via the npx fallback path has not yet been documented as passed. Smoke tests use fake commands.
5. Native ACP session-list behavior is proven for OpenCode. Other ACP adapters need real session-list/continue acceptance.
6. Registry-driven adapter expansion is still manual. Only known local routes are mapped into Agent Router profiles today.
7. No automatic adapter installation. Registry install hints are surfaced, but users install tools themselves.

## Recommended Next Work

1. Publish `agent-router` to npm so `npx agent-router` works out of the box.

2. Rename the GitHub repo from `peanut996/codex-agent-router` to `peanut996/agent-router` and update any remaining references.

3. Clean up dead CLI fallback code in `mcp/server.mjs`:
   - Remove `runCliFallbackJob` function.
   - Remove `getCliAdapterSpec` and CLI adapter spec builders.
   - Remove `transport: "cli"` and CLI-related fields from `BUILT_IN_AGENTS`.
   - Remove CLI fallback references in `chooseAgent` and `planLaunch`.

4. Run real ACP prompt/file-edit E2E for Claude and Codex via the npx fallback path:
   - Verify `npx --yes @anthropic-ai/claude-agent-acp` launches and completes a file-edit task.
   - Verify `npx --yes codex-acp` launches and completes a file-edit task.
   - Confirm provider session id, changed files, log path, and failure surfacing.

5. In a fresh MCP client session, confirm Agent Router tools are injected:

   ```text
   Use Agent Router. First call discover_agents.
   If you cannot see run_agent or discover_agents, report that tools are not injected.
   ```

6. Run `discover_agents` and check:
   - OpenCode is available through native ACP.
   - Claude has registry id `claude-acp` and uses `claude-agent-acp` if installed, or npx fallback.
   - Codex has registry id `codex-acp` and uses `codex-acp` if installed, or npx fallback.
   - Cursor Agent hard-fails with `acp_required` (no ACP adapter).

7. Start registry expansion work:
   - Add a small registry-id-to-router-profile mapping layer.
   - Keep no-auto-install policy.
   - Prefer ACP transports when executable is installed.
   - Use npx fallback when registry has npx distribution.

## Fresh Session Prompt

Copy this into a new session:

```text
Continue Agent Router development.

Repo: /Users/peanut996/Workspace/agent-router-refactor
Branch: feat/refactor-generic-mcp
GitHub: https://github.com/peanut996/agent-router
Current version: 0.7.0
npm package: agent-router (not yet published)

Do these first:
1. git -C /Users/peanut996/Workspace/agent-router-refactor status
2. Confirm branch is feat/refactor-generic-mcp.
3. Use Agent Router. First call discover_agents.
4. If you cannot see discover_agents or run_agent, report that tools are not injected.

Current product state:
- Generic MCP server, works with any MCP client (Claude Desktop, Cursor, Windsurf, Codex, etc.).
- MCP server built on @modelcontextprotocol/sdk.
- Data directory: ~/.agent-router/
- ACP-only mode. CLI fallback removed.
- npx fallback when ACP executable not on PATH but registry has npx distribution.
- Recursion guard: AGENT_ROUTER_DEPTH, max depth 3.
- 8 tools: discover_agents, manage_config, run_agent, list_jobs, get_job, tail_job_events, cancel_job, manage_sessions.
- OpenCode: native ACP.
- Claude: ACP via claude-agent-acp or npx fallback.
- Codex: ACP via codex-acp or npx fallback.
- Cursor Agent: hard-fail (no ACP adapter).
- ACP Registry metadata/cache integrated.

Next priorities:
- Publish agent-router to npm.
- Rename GitHub repo from codex-agent-router to agent-router.
- Clean up dead CLI fallback code in mcp/server.mjs.
- Run real ACP prompt/file-edit E2E for Claude and Codex via npx fallback.
```

## Refactor Notes (v0.6.8 to v0.7.0)

### What changed

1. **Repo/package rename**: `codex-agent-router` renamed to `agent-router`. `package.json` name, repository URL, bin entry, and description all updated.

2. **Codex plugin packaging removed**: `.codex-plugin/`, `skills/`, `.mcp.json`, `.agents/` directories deleted. Agent Router is no longer a Codex plugin; it is a standalone npm package and MCP server.

3. **MCP server migration**: Migrated from hand-rolled JSON-RPC handling to `@modelcontextprotocol/sdk` (`McpServer` + `StdioServerTransport`). Tool registration uses `server.tool()` with Zod schemas. This provides proper MCP protocol compliance and automatic schema generation.

4. **Data directory changed**: `~/.codex/agent-router/` changed to `~/.agent-router/`. Hard cut, no backward compatibility. Existing v0.6.x users need to reconfigure. Override available via `AGENT_ROUTER_DATA_DIR` env var.

5. **Tools consolidated from 11 to 8**:
   - Config get/set merged into `manage_config` with `action` param.
   - Session list/continue/archive merged into `manage_sessions` with `action` param.
   - All tool names shortened (removed `coding_agent` infix).

6. **ACP-only mode**: CLI fallback adapters removed. `run_agent` only supports ACP stdio transport. Agents without an available ACP adapter hard-fail with `acp_required` error and an install hint. `executeAndPersistJobRun` throws on non-`acp_stdio` launch kinds.

7. **npx fallback**: When an ACP executable is not on PATH but the ACP Registry lists an npx distribution for that agent, Agent Router automatically launches the adapter via `npx --yes <package>`. The agent's `acp.launchMode` is set to `"npx"` and `acp.launchCommand` contains the npx command. `isAcpRunReady` and `resolveAcpLaunchTarget` both handle the npx case.

8. **Recursion guard**: `AGENT_ROUTER_DEPTH` env var tracks dispatch depth. `createJob` checks depth at the start and fails with `recursion_limit` if >= 3. `AcpStdioClient.start` increments the depth in the child process environment. This prevents infinite loops when an ACP agent itself calls Agent Router.

9. **bin entry**: `agent-router` command via `./bin/agent-router.mjs`, which imports and calls `startMcpServer()` from `mcp/server.mjs`.

10. **Version**: Bumped to `0.7.0`.

### What was removed

- Codex plugin manifest (`.codex-plugin/plugin.json`).
- Codex bundled skill (`skills/agent-router/SKILL.md`).
- Codex marketplace entry (`.agents/plugins/marketplace.json`).
- Codex-specific MCP config (`.mcp.json`).
- Codex plugin install instructions from README.
- English and Chinese usage guides (`docs/USAGE.md`, `docs/USAGE.zh-CN.md`).
- CLI fallback as a runtime path (code still present but unreachable).

### What was not changed

- ACP stdio client implementation (`AcpStdioClient`).
- ACP Registry metadata reading and caching.
- Job/session registry persistence and orphan recovery.
- Worktree validation and locking.
- Permission profiles and safety defaults.
- Smoke and E2E test scripts (still present, may need updates for new tool names).
