# Antigravity Codex MCP

A controlled Model Context Protocol bridge that lets OpenAI Codex delegate work to Google Antigravity CLI on demand.

The bridge stays idle until a user explicitly asks Codex to use AGY. It then authorizes only the exact current project, keeps a project-scoped conversation, synchronizes user-visible dialogue, and confines generated implementation changes to an isolated copy.

> This is an independent community project. It is not affiliated with or endorsed by Google or OpenAI.

[中文说明](readme_zh.md)

## Highlights

- Explicit opt-in: Codex cannot enable or call AGY unless the user asks for it.
- Exact project scope: broad roots and system directories are rejected.
- Read-only delegation by default: no AGY write, command, URL, or MCP permission is granted.
- Project conversations: active conversation IDs and delegation history survive new Codex tasks.
- Visible transcript sync: messages entered through AGY CLI become available to Codex on the next sync.
- Private-reasoning filter: thinking/reasoning fields, system messages, and checkpoints are excluded before persistence or MCP return.
- Isolated implementation: validated full-file replacements are applied only to a disposable project copy.
- Auditable runs: responses, changed-file manifests, verification output, and sanitized tool events are retained locally.

## Requirements

- Node.js 20 or newer
- [Antigravity CLI](https://antigravity.google/docs/cli/)
- [OpenAI Codex with MCP support](https://developers.openai.com/codex/mcp/)

Authenticate Antigravity CLI and verify that `agy` is available:

```bash
agy --version
agy -p "Reply exactly: AGY_OK" --output-format json
```

If `agy` is not on `PATH`, set `AGY_BIN` to its executable path in the MCP configuration.

## Installation

```bash
git clone https://github.com/ustc-fyk/antigravity-codex-mcp.git
cd antigravity-codex-mcp
npm ci
npm test
```

Add the server to your Codex `config.toml`. Replace the example paths with the absolute clone path on your machine:

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

# Optional when agy is not available on PATH:
[mcp_servers.antigravity.env]
AGY_BIN = 'C:\path\to\agy.exe'
```

On macOS or Linux, use the corresponding absolute POSIX paths and normally omit `AGY_BIN` when `agy` is on `PATH`.

Install the included Codex Skill so Codex follows the opt-in workflow:

```powershell
$skillRoot = Join-Path $env:USERPROFILE ".codex\skills\agy-project-assistant"
New-Item -ItemType Directory -Force $skillRoot | Out-Null
Copy-Item ".\skills\agy-project-assistant\SKILL.md" $skillRoot
```

Restart Codex after changing MCP configuration or installing the Skill.

## Usage

1. Open any project directory in Codex.
2. Work normally; the AGY bridge remains idle.
3. Explicitly ask: `Load AGY and review this project.`
4. Codex enables read access for that exact project and starts or reuses its AGY conversation.
5. Codex delegates analysis, review, continuation, or isolated implementation as appropriate.
6. Ask `Disable AGY for this project` to revoke the exact project permission while preserving local audit history.

To inspect or participate in the same conversation directly:

```bash
agy --conversation=<conversation_id>
```

After sending messages through AGY CLI, ask Codex to `sync the AGY conversation`. `antigravity_continue` also synchronizes before and after every follow-up. Synchronization is on demand, not a live push channel, so avoid simultaneous sends from Codex and AGY CLI.

## MCP tools

| Area | Tools |
| --- | --- |
| Health and lifecycle | `antigravity_health`, `antigravity_project_status`, `antigravity_enable_project`, `antigravity_disable_project` |
| Conversations | `antigravity_start_session`, `antigravity_get_active_session`, `antigravity_list_sessions`, `antigravity_ask`, `antigravity_continue`, `antigravity_review` |
| Visible transcripts | `antigravity_sync_conversation`, `antigravity_get_transcript` |
| Isolated implementation | `antigravity_execute`, `antigravity_list_runs`, `antigravity_get_run` |

Model calls occur only through the start, ask, continue, review, and execute tools. Health, status, history, run inspection, and transcript synchronization do not consume an AGY model turn.

## Project-local state

Each enabled project receives an ignored local state directory:

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

- `project.json` records opt-in state and the active conversation.
- `sessions.jsonl` records delegated calls and token usage.
- `transcripts` contains only visible user/assistant records and sanitized tool traces.
- `runs` contains isolated implementation workspaces and audit results.

This directory is excluded from the source copy and ignored by Git. Do not commit it manually because it may contain private project or conversation data.

## Safety model

Project enablement atomically adds only the exact root to Antigravity `trustedWorkspaces` and `read_file(...)` allow rules. Disablement removes only those exact entries.

Isolated implementation rejects:

- absolute paths and parent traversal;
- file deletion;
- secret files, dependencies, build output, metadata, and symbolic links;
- more than 50 changed files;
- more than 2,000,000 replacement characters.

The transcript pipeline recursively removes private reasoning fields and excludes system/checkpoint records before writing the project mirror. See [SECURITY.md](SECURITY.md) for reporting guidance and limitations.

## Development

```bash
npm ci
npm test
npm run smoke:mcp
```

Live checks require an authenticated AGY CLI and consume model quota:

```bash
npm run smoke:live
npm run smoke:execute
npm run smoke:project -- "/absolute/path/to/disposable-project"
npm run smoke:continue -- "/absolute/path/to/enabled-project"
npm run smoke:transcript -- "/absolute/path/to/enabled-project"
```

`npm test` is self-contained. `smoke:mcp` also checks the local AGY binary, while the remaining smoke tests may change project authorization or consume quota.

## License

[MIT](LICENSE)
