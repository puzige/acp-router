# MCP Client Setup Guide

This guide covers how to configure Agent Router with various MCP clients, troubleshoot common issues, and use environment variables to customize behavior.

## Prerequisites

- **Node.js >= 18** -- check with `node --version`
- **npm** -- comes bundled with Node.js
- At least one ACP-capable coding agent installed (see [Supported Agents](../README.md#supported-agents))

## Installation Options

### Option 1: npx (recommended)

No installation required. `npx` downloads and runs Agent Router on demand:

```bash
npx agent-router
```

This is the simplest option and ensures you always run the latest published version. All client config examples below use `npx`.

### Option 2: Global npm install

Install once, then run the `agent-router` command directly:

```bash
npm install -g agent-router
agent-router
```

When using a global install, client configs can use `"command": "agent-router"` with an empty args array instead of `npx`.

### Option 3: Clone from source

For development or running unreleased changes:

```bash
git clone https://github.com/peanut996/agent-router.git
cd agent-router
npm install
npm start
```

For client configs pointing at a local clone, use the full path to the bin entry:

```json
{
  "mcpServers": {
    "agent-router": {
      "command": "node",
      "args": ["/path/to/agent-router/bin/agent-router.mjs"]
    }
  }
}
```

## Client-Specific Configuration

### Claude Desktop

**Config file location:**

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

**Config:**

```json
{
  "mcpServers": {
    "agent-router": {
      "command": "npx",
      "args": ["agent-router"]
    }
  }
}
```

After saving the file, fully quit and restart Claude Desktop. The Agent Router tools will appear in the tool list.

If you installed Agent Router globally, use this instead:

```json
{
  "mcpServers": {
    "agent-router": {
      "command": "agent-router"
    }
  }
}
```

### Cursor

**Config file location:** `.cursor/mcp.json` in your project root, or the user-level Cursor settings.

**Config:**

```json
{
  "mcpServers": {
    "agent-router": {
      "command": "npx",
      "args": ["agent-router"]
    }
  }
}
```

Reload the Cursor window after saving (Command+Shift+P > "Reload Window" on macOS).

### Windsurf

**Config file location:** Windsurf MCP server settings (via UI or config file, depending on version).

**Config:**

```json
{
  "mcpServers": {
    "agent-router": {
      "command": "npx",
      "args": ["agent-router"]
    }
  }
}
```

Restart Windsurf after saving the config.

### Codex

**Config file location:** `.mcp.json` in your project root.

**Config:**

```json
{
  "mcpServers": {
    "agent-router": {
      "command": "npx",
      "args": ["agent-router"]
    }
  }
}
```

Codex picks up the MCP server from the project-level `.mcp.json` on the next session.

### Generic MCP Client

Any client that supports stdio MCP servers can launch Agent Router. The server communicates over stdin/stdout using the Model Context Protocol.

| Parameter | Value |
| --- | --- |
| Command | `npx` |
| Args | `["agent-router"]` |
| Transport | stdio |
| Server name | `agent-router` |
| Server version | `0.7.0` |

If your client requires a full command string instead of a JSON config:

```bash
npx agent-router
```

## Environment Variables

Agent Router supports two environment variables. Set them in the `env` field of your MCP client config:

### AGENT_ROUTER_DATA_DIR

Overrides the data directory location. Defaults to `~/.agent-router/`.

```json
{
  "mcpServers": {
    "agent-router": {
      "command": "npx",
      "args": ["agent-router"],
      "env": {
        "AGENT_ROUTER_DATA_DIR": "/path/to/custom/data/dir"
      }
    }
  }
}
```

Use this when you want to isolate Agent Router data per project, run tests, or store data on a different volume.

### AGENT_ROUTER_DEPTH

Tracks the current recursion depth for the agent dispatch loop. Agent Router sets this automatically when launching child agents -- you normally do not need to set it manually.

The maximum allowed depth is **3**. If you need to change the starting depth for testing or nested dispatch scenarios, set it in the env config:

```json
{
  "mcpServers": {
    "agent-router": {
      "command": "npx",
      "args": ["agent-router"],
      "env": {
        "AGENT_ROUTER_DEPTH": "0"
      }
    }
  }
}
```

## Verifying the Setup

After configuring your MCP client, verify that Agent Router is working:

1. **Check tool injection** -- Ask your MCP client to list available tools. You should see 8 tools: `discover_agents`, `manage_config`, `run_agent`, `list_jobs`, `get_job`, `tail_job_events`, `cancel_job`, `manage_sessions`.

2. **Run discovery** -- Ask the client to call `discover_agents`:

   ```text
   Discover local coding agents with Agent Router.
   ```

   The response should list all agents found on your system with their ACP status.

3. **Run a test job** -- Create a temporary git worktree and dispatch a simple task:

   ```text
   Use Agent Router to run opencode in /path/to/worktree.
   Append one line to note.txt, then report the job id, session id, and changed files.
   ```

## Troubleshooting

### Server not starting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Client reports "server failed to start" | Node.js not found or version < 18 | Install Node.js >= 18 and ensure it is on PATH |
| Client reports "command not found: npx" | npm not installed or not on PATH | Install Node.js which includes npm |
| Server starts but immediately exits | `agent-router` package not found | Run `npx agent-router` manually in a terminal to trigger the initial download |
| Permission denied on data directory | `~/.agent-router/` not writable | Check directory permissions or set `AGENT_ROUTER_DATA_DIR` to a writable path |

### Tools not appearing

| Symptom | Cause | Fix |
| --- | --- | --- |
| No Agent Router tools in the client | Config file not loaded | Restart the client after editing the config; verify the JSON is valid |
| Only some tools appear | Client filters tools by name or capability | Check the client's tool filtering settings |
| Tools appear but calls fail | Server process crashed or hung | Check the client's MCP server logs for stderr output |

### ACP not found

| Symptom | Cause | Fix |
| --- | --- | --- |
| `run_agent` fails with `acp_required` | Selected agent has no ACP adapter on PATH and no npx distribution | Install the ACP adapter (see the install hint in the error message) |
| `run_agent` fails with `acp_required` for Cursor Agent | Cursor Agent has no ACP adapter at all | Use a different agent (opencode, claude, or codex) |
| Agent discovered but ACP status is "not available" | ACP executable not on PATH | Install the ACP adapter or rely on npx fallback |
| npx fallback is slow | First `npx` run downloads the package | Subsequent runs use the npm cache and are faster |
| `discover_agents` shows no agents | No coding agents installed | Install at least one supported agent (opencode, claude, codex) |

### Debugging tips

- Run Agent Router standalone to see stderr output:

  ```bash
  npx agent-router
  ```

  The server reads JSON-RPC messages from stdin and writes responses to stdout. Any errors or diagnostics go to stderr.

- Check the data directory for state:

  ```bash
  ls -la ~/.agent-router/
  cat ~/.agent-router/config.json
  cat ~/.agent-router/registry.json
  ```

- Inspect job logs for failure details:

  ```bash
  cat ~/.agent-router/logs/<jobId>.jsonl
  ```

- Use `AGENT_ROUTER_DATA_DIR` to isolate a test run from your real data:

  ```bash
  AGENT_ROUTER_DATA_DIR=/tmp/agent-router-test npx agent-router
  ```
