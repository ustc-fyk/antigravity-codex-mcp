# Contributing

Thanks for helping improve Antigravity Codex MCP.

## Development

Requirements: Node.js 20 or newer. Antigravity CLI is needed only for live integration tests.

```bash
npm ci
npm test
npm run smoke:mcp
```

Before opening a pull request:

1. Keep AGY disabled unless the user explicitly requests it.
2. Preserve exact-project authorization and isolated-write boundaries.
3. Never commit `.antigravity-mcp`, transcript mirrors, settings backups, credentials, or account data.
4. Add tests for behavior or security-boundary changes.
5. Do not weaken transcript filtering for private thinking, system messages, or checkpoints.

Live tests consume Antigravity model quota and may modify AGY project authorization. Run them only against a disposable project:

```bash
npm run smoke:project -- "/absolute/path/to/disposable-project"
```
