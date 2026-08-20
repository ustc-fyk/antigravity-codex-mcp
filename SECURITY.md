# Security Policy

## Supported version

Security fixes target the latest release.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose credentials, private transcripts, arbitrary files, or command execution. Use GitHub's private vulnerability reporting feature when it is enabled for the repository.

Please include the affected version, platform, reproduction steps, impact, and any suggested mitigation. Remove credentials, account identifiers, transcript content, and private project files from reports.

## Security boundaries

The bridge is designed to:

- authorize only an exact project root;
- grant AGY read access by default;
- keep generated implementation changes in an isolated copy;
- reject broad/system roots, unsafe file operations, secrets, and path traversal;
- exclude private thinking, system messages, and checkpoints from synchronized transcripts.
- ignore every file under project-local `.antigravity-mcp` state by default;
- terminate full AGY/verification process trees on timeout and recover locks left by dead processes;
- require explicit risk acceptance before running verification against AGY-influenced code;
- reject sensitive extra environment-variable names unless a separate high-risk override is enabled.

## Residual risks

The bridge does not itself provide a universal OS sandbox. AGY CLI sandbox support is optional and platform-dependent. Verification commands execute project code in a disposable workspace under the current OS user; they can still access resources available to that user unless an external OS sandbox is applied. Keep verification disabled for untrusted repositories, or run the bridge inside a disposable VM/container with restricted credentials and network access.

Project content can contain prompt injection. Read-only AGY permissions, structured output validation, path fencing, and isolated writes reduce impact but cannot make model output trusted. Review generated changes before applying them.

Transcript synchronization currently depends on AGY CLI's local transcript layout. An incompatible AGY upgrade may temporarily break synchronization without affecting the underlying AGY conversation.
