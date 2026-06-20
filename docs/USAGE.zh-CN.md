# Agent Router 使用手册

Agent Router 是一个本地 Codex 插件，用来让 Codex 通过统一的 routing interface 发现、运行、跟踪、取消和继续外部 Coding Agent。

当前状态：本地/个人插件，尚未发布到公开 Codex marketplace。

## 当前支持能力

| Agent | Adapter | 状态 |
| --- | --- | --- |
| OpenCode | Native ACP stdio | 真实 E2E 已通过 |
| OpenCode session lifecycle | Native ACP stdio | 真实 session list、continue、archive 已通过 |
| Claude Code | CLI fallback | 真实 E2E 已通过 |
| Cursor Agent | 通过官方 `agent` 命令的 CLI fallback | 真实 E2E 已通过 |
| Codex CLI | CLI fallback | 真实 E2E 已通过 |

Codex 仍然是主控。外部 agent 在指定 worktree 中执行任务，Agent Router 会返回 job 状态、session id、修改文件、验证信息、失败原因、agent 错误和日志路径。

## 使用前要求

- Codex Desktop 支持本地插件。
- Node.js 18 或更高版本。
- 写入型任务必须指定一个 git worktree。
- 至少安装一个外部 agent：
  - `opencode`
  - `claude`
  - Cursor Agent `agent`
  - `codex`

外部 agent 启动默认是关闭的，这是安全设计。

## 本地安装和刷新

从 GitHub 公开 beta 安装：

```bash
codex plugin marketplace add peanut996/codex-agent-router
codex plugin add agent-router@codex-agent-router
```

固定当前 release 安装：

```bash
codex plugin marketplace add peanut996/codex-agent-router@v0.6.0
codex plugin add agent-router@codex-agent-router
```

安装后请新开一个 Codex thread，这样 Codex 才会加载新的 skill 和 MCP server。

开发源码路径：

```bash
/Users/peanut996/Workspace/codex-agent-router
```

个人插件源路径：

```bash
/Users/peanut996/plugins/agent-router
```

从开发仓库同步到个人插件源：

```bash
rsync -a --delete --exclude='.git' \
  /Users/peanut996/Workspace/codex-agent-router/ \
  /Users/peanut996/plugins/agent-router/
```

个人 marketplace 名称是 `personal`，重装命令：

```bash
codex plugin add agent-router@personal
```

重装后请新开一个 Codex thread，这样 Codex 才会加载新的 skill 和 MCP tools。

## 在 Codex 里第一次使用

先让 Codex 发现本机 agent：

```text
使用 Agent Router 发现本机可用的 coding agent。
```

然后打开外部 agent 启动开关：

```text
把 Agent Router 配置为 launchExternalAgents=true。
```

运行任务时必须给绝对 worktree 路径：

```text
使用 Cursor Agent 通过 Agent Router 在 /absolute/path/to/worktree 中执行任务。
请给 note.txt 追加一行，完成后报告 changed files、validation、risks、job id、session id 和 log path。
```

测试结束后建议关闭外部启动：

```text
把 Agent Router 配置为 launchExternalAgents=false。
```

## 安全默认值

- 默认 `launchExternalAgents=false`。
- `worktree` 必须是已存在的绝对路径。
- 写入型 job 会锁定 worktree，避免多个 agent 同时修改同一目录。
- 子进程默认继承 Agent Router 环境变量；如果要限制环境，设置 `inheritEnvironment=false`。
- 默认不允许 `bypass_permissions`，除非显式配置开启。
- Agent Router 不会自动 commit、push 或创建 PR。

## Job 和 Session 操作

常见用户请求：

```text
列出 Agent Router jobs。
查看 job <jobId>。
取消 job <jobId>。
列出外部 agent sessions。
继续 session <sessionId>，追加这个 prompt：...
归档 session <sessionId>。
```

重要返回字段：

- `jobId`
- `sessionId`
- `providerSessionId`
- `status`
- `adapterStatus`
- `changedFiles`
- `failureReason`
- `agentErrors`
- `logPath`

## 验证命令

不调用模型的验证：

```bash
npm run check
npm run smoke
npm run smoke:sessions
npm run smoke:opencode
npm run smoke:opencode:sessions
npm run e2e:restart-recovery
```

真实 E2E 验证，可能调用模型并产生费用：

```bash
npm run e2e:opencode -- --opencode-model opencode-go/glm-5.2 --timeout-sec 600 --keep
npm run e2e:sessions:opencode -- --keep
npm run e2e:claude -- --timeout-sec 600 --keep
npm run e2e:cursor -- --timeout-sec 600 --keep
npm run e2e:codex -- --timeout-sec 600 --keep
```

真实 E2E 通过时通常会看到：

- `status: "completed"`
- `changedFiles` 包含 `note.txt`
- `failureReason: null`
- `agentErrors: []`
- `gitStatus: "M note.txt"`

## 排错

| 现象 | 优先检查 |
| --- | --- |
| agent 没被发现 | 先运行该 agent 的 `--version`，确认它在 `PATH` 上。 |
| `run_coding_agent` 只是记录 job，没有真实启动 | 确认 `launchExternalAgents=true`。 |
| worktree 被拒绝 | 使用已存在的绝对路径。 |
| worktree 被锁 | 查看 active jobs，等待当前写入 job 结束或取消它。 |
| Claude 看起来卡住 | 查看 `job.agentErrors` 和 `job.logPath`；rate-limit 重试可能看起来像卡住。 |
| Cursor Agent 认证失败 | 运行 `agent status`；必要时运行 `agent login`。 |
| OpenCode 模型或 provider 报错 | 查看 `availableModels`；OpenCode ACP 的模型选择用项目级 `opencode.json`。 |
| 需要原始证据 | 打开 `job.logPath`，它是 JSONL 事件日志。 |

## 产品边界

这个插件不会修改 Codex 原生 sidebar、消息头像或设置页 UI。V1 的体验通过 MCP tools 和 Codex thread 里的结构化结果提供。

插件已经可以本地使用和内部验收。发布到公开 marketplace 仍然是后续独立发布步骤。
