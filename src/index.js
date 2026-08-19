#!/usr/bin/env node

import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createServer } from "./server.js";

serveStdio(createServer);
console.error("antigravity-codex-mcp listening on stdio");
