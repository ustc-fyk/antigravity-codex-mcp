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

No software sandbox is a substitute for reviewing permissions and generated changes. Use disposable projects for live integration tests.
