---
name: agy-project-assistant
description: Dynamically enable and orchestrate Antigravity CLI (AGY) for the current Codex project only when the user explicitly asks to load or use AGY/Antigravity. Manage exact project read authorization, active conversations, delegation, transcript synchronization, isolated implementation, audit records, and revocation.
---

# AGY Project Assistant

Use the globally available Antigravity MCP as an idle bridge. Never initialize, authorize, or call AGY unless the user explicitly requests AGY or Antigravity in the current request.

## Resolve the project

1. Use the current Codex project root as `project_root`.
2. If the current root is unavailable or ambiguous, ask for the exact directory.
3. Never substitute a parent directory, drive root, user home, or another saved project.

## Enable AGY on explicit request

1. Call `antigravity_project_status` with the exact project root.
2. If disabled, explain that enabling AGY grants read access to that exact project and may send relevant content to the Google model.
3. Treat the explicit request as authorization for that exact read scope, then call `antigravity_enable_project`.
4. If the request only asks to load AGY and no active conversation exists, call `antigravity_start_session`.
5. If the request includes a substantive task, call the appropriate task tool directly; its conversation becomes active.

## Delegate work

- Use `antigravity_ask` for a new analysis conversation.
- Before a follow-up, use `antigravity_sync_conversation` when the user may have interacted through AGY CLI. `antigravity_continue` also synchronizes before and after its model call.
- Use `antigravity_continue` for follow-ups in the active conversation. Inspect `transcriptSync.before.records` for messages added through AGY CLI.
- Use `antigravity_review` for an independent correctness, regression, security, or test-gap review.
- Use `antigravity_execute` for implementation. It may modify only an isolated copy and must never merge automatically.
- Prefer Codex itself for small tasks whose delegation overhead would exceed the work.

After every model call, report the exact `project_root` and `conversation_id`. After implementation, also report `run_id`, isolated workspace path, changed files, and verification status. Verify AGY conclusions independently before applying anything to source.

## Inspect and resume

- Use `antigravity_get_active_session` to recover the active conversation in a new Codex task.
- Use `antigravity_list_sessions` for project delegation history.
- Use `antigravity_sync_conversation` to pull newly added visible AGY CLI messages without calling a model.
- Use `antigravity_get_transcript` when the user asks Codex to read or summarize the visible AGY conversation.
- Use `antigravity_list_runs` and `antigravity_get_run` for isolated implementation audits.
- Tell the user they can inspect a conversation with `agy --conversation=<conversation_id>`.

## Disable AGY

When the user asks to disable, unload, revoke, or stop AGY for the current project, call `antigravity_disable_project`. Preserve local session and run history.

## Safety rules

- Never enable AGY based only on task complexity or convenience.
- Never grant a broader path than the exact current project root.
- Never add AGY write, command, URL, or MCP permissions.
- Never use dangerous auto-approval flags.
- Never apply isolated changes to source without Codex review and appropriate user authorization.
- Never request, expose, reconstruct, or persist AGY private thinking or chain-of-thought. Use only visible messages, final answers, and sanitized tool traces.
- Transcript synchronization is on demand. Avoid concurrent sends from Codex and an interactive AGY CLI in the same conversation.
