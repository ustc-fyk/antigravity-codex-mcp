# Antigravity Codex MCP 中文说明

这是一个受控的 Model Context Protocol 桥接器，让 OpenAI Codex 在用户明确要求时，将部分工作委派给 Google Antigravity CLI。

它默认保持空闲。只有用户明确说“加载 AGY”“使用 Antigravity 协助”等指令后，Codex 才会为当前精确项目启用读取权限、创建或恢复项目会话、同步可见对话，并把实现类修改限制在隔离副本中。

> 本项目是独立的社区项目，与 Google 或 OpenAI 没有隶属或官方背书关系。

[English README](README.md)

## 核心能力

- 明确启用：用户未要求 AGY 时，不授权、不创建会话、不消耗 AGY 模型额度。
- 精确权限：只允许当前项目根目录，拒绝磁盘根、用户目录和系统目录。
- 默认只读：不授予 AGY 写文件、执行命令、访问 URL 或调用其他 MCP 的权限。
- 项目级会话：每个项目独立保存活动 `conversation_id` 和委派记录。
- 对话同步：用户通过 AGY CLI 发送的可见消息，可在下次同步时被 Codex 读取。
- 推理过滤：`thinking`、`reasoning`、系统消息和检查点在写入或返回前被过滤。
- 隔离实现：AGY 生成的文件替换只应用到项目隔离副本，不自动合并到源代码。
- 本地审计：保存运行结果、文件变更、验证输出和已清理的工具事件。

## 环境要求

- Node.js 20 或更高版本
- [Antigravity CLI](https://antigravity.google/docs/cli/)
- [支持 MCP 的 OpenAI Codex](https://developers.openai.com/codex/mcp/)

先登录 Antigravity CLI，并确认以下命令可用：

```powershell
agy --version
agy -p "Reply exactly: AGY_OK" --output-format json
```

如果 `agy` 不在 `PATH` 中，可在 MCP 配置里用 `AGY_BIN` 指定可执行文件的绝对路径。

## 安装

```powershell
git clone https://github.com/ustc-fyk/antigravity-codex-mcp.git
cd antigravity-codex-mcp
npm ci
npm test
```

在 Codex 的 `config.toml` 中添加以下配置，并将示例路径改成实际克隆目录：

```toml
[mcp_servers.antigravity]
command = 'node'
args = ['C:\path\to\antigravity-codex-mcp\src\index.js']
cwd = 'C:\path\to\antigravity-codex-mcp'
enabled = true
required = false
startup_timeout_sec = 20
tool_timeout_sec = 900
default_tools_approval_mode = 'prompt'
enabled_tools = [
  'antigravity_health',
  'antigravity_project_status',
  'antigravity_enable_project',
  'antigravity_disable_project',
  'antigravity_start_session',
  'antigravity_get_active_session',
  'antigravity_list_sessions',
  'antigravity_sync_conversation',
  'antigravity_get_transcript',
  'antigravity_ask',
  'antigravity_continue',
  'antigravity_review',
  'antigravity_execute',
  'antigravity_list_runs',
  'antigravity_get_run',
]

# 仅当 agy 不在 PATH 中时需要：
[mcp_servers.antigravity.env]
AGY_BIN = 'C:\path\to\agy.exe'
```

安装仓库附带的 Codex Skill：

```powershell
$skillRoot = Join-Path $env:USERPROFILE ".codex\skills\agy-project-assistant"
New-Item -ItemType Directory -Force $skillRoot | Out-Null
Copy-Item ".\skills\agy-project-assistant\SKILL.md" $skillRoot
```

修改 MCP 配置或安装 Skill 后，请重启 Codex。

## 使用流程

1. 在 Codex 中打开任意项目目录。
2. 正常工作时 AGY 保持空闲。
3. 明确说：`加载 AGY，帮我审查这个项目。`
4. Codex 只为当前精确项目启用读取权限，并创建或恢复 AGY 会话。
5. Codex 根据任务选择分析、继续对话、独立审查或隔离实现。
6. 说 `禁用当前项目的 AGY`，即可撤销该项目权限，同时保留本地审计记录。

用户可以手动进入同一个会话：

```powershell
agy --conversation=<conversation_id>
```

通过 CLI 发送消息后，可以让 Codex“同步 AGY 对话”。`antigravity_continue` 也会在继续对话前后自动同步。同步属于按需拉取，不是实时推送，因此不建议 Codex 与 AGY CLI 在同一瞬间并发发送消息。

## 15 个 MCP 工具

| 分类 | 工具 |
| --- | --- |
| 健康与生命周期 | `antigravity_health`、`antigravity_project_status`、`antigravity_enable_project`、`antigravity_disable_project` |
| 会话 | `antigravity_start_session`、`antigravity_get_active_session`、`antigravity_list_sessions`、`antigravity_ask`、`antigravity_continue`、`antigravity_review` |
| 可见对话 | `antigravity_sync_conversation`、`antigravity_get_transcript` |
| 隔离实现 | `antigravity_execute`、`antigravity_list_runs`、`antigravity_get_run` |

只有新建、询问、继续、审查和执行工具会调用 AGY 模型。健康检查、状态、历史、运行检查和 transcript 同步不会消耗 AGY 模型轮次。

## 项目本地状态

启用后的项目会生成：

```text
.antigravity-mcp/
├── project.json
├── sessions.jsonl
├── transcripts/
│   └── <conversation-id>.jsonl
└── runs/
    └── <run-id>/
        ├── metadata.json
        ├── events.jsonl
        ├── response.md
        └── workspace/
```

- `project.json`：启用状态和活动会话。
- `sessions.jsonl`：委派调用、状态和 token 用量。
- `transcripts`：用户可见消息、AGY 回复和已清理工具轨迹。
- `runs`：隔离实现副本及审计结果。

该目录默认被 Git 忽略，也不会复制到隔离工作区。不要手动提交，因为其中可能包含私有项目内容或对话。

## 权限与安全边界

启用项目时，只向 Antigravity `trustedWorkspaces` 和 `read_file(...)` 规则添加当前精确根目录；禁用时只删除对应条目。

隔离实现会拒绝：

- 绝对路径和 `..` 路径穿越；
- 文件删除；
- 密钥文件、依赖目录、构建产物、元数据和符号链接；
- 超过 50 个变更文件；
- 超过 2,000,000 个替换字符。

transcript 管线会递归移除内部推理字段，并排除系统消息和检查点，然后才写入项目镜像。漏洞报告方式和安全限制见 [SECURITY.md](SECURITY.md)。

## 开发与测试

```powershell
npm ci
npm test
npm run smoke:mcp
```

以下测试需要已经登录的 AGY CLI，并可能消耗模型额度或修改项目授权：

```powershell
npm run smoke:live
npm run smoke:execute
npm run smoke:project -- "C:\绝对路径\临时项目"
npm run smoke:continue -- "C:\绝对路径\已启用项目"
npm run smoke:transcript -- "C:\绝对路径\已启用项目"
```

`npm test` 完全自包含；`smoke:mcp` 还会检查本机 AGY，其他 smoke 测试应只对可丢弃的测试项目运行。

## 许可证

[MIT](LICENSE)
