import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const projectRoot = process.argv[2];
if (!projectRoot || !path.isAbsolute(projectRoot)) {
  throw new Error("Usage: node test/transcript-acceptance.js <absolute-project-root>");
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..");
const serverEntry = path.join(repositoryRoot, "src", "index.js");
const client = new Client({ name: "agy-transcript-acceptance", version: "0.4.0" });
const privateKeys = new Set([
  "thinking",
  "thought",
  "thoughts",
  "reasoning",
  "thinkingmetadata",
  "thoughtsignature"
]);

function assertNoPrivateKeys(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoPrivateKeys(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    const normalized = key.replace(/[_-]/g, "").toLowerCase();
    assert.ok(!privateKeys.has(normalized), `private field escaped filtering: ${key}`);
    assertNoPrivateKeys(nested);
  }
}

try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        AGY_BIN: process.env.AGY_BIN || "agy"
      }
    })
  );

  const synced = await client.callTool({
    name: "antigravity_sync_conversation",
    arguments: {
      project_root: projectRoot,
      include_all: true,
      max_records: 1000,
      max_chars: 500000
    }
  });
  assert.notEqual(synced.isError, true);
  assertNoPrivateKeys(synced.structuredContent.records);

  const transcript = await client.callTool({
    name: "antigravity_get_transcript",
    arguments: {
      project_root: projectRoot,
      refresh: false,
      max_records: 1000,
      max_chars: 500000
    }
  });
  assert.notEqual(transcript.isError, true);
  assertNoPrivateKeys(transcript.structuredContent.records);

  const mirrorRaw = await readFile(synced.structuredContent.mirrorPath, "utf8");
  const mirrorRecords = mirrorRaw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assertNoPrivateKeys(mirrorRecords);
  assert.ok(
    mirrorRecords.every((record) =>
      ["user", "assistant", "tool_trace"].includes(record.role)
    )
  );

  const counts = Object.fromEntries(
    ["user", "assistant", "tool_trace"].map((role) => [
      role,
      mirrorRecords.filter((record) => record.role === role).length
    ])
  );
  console.log(
    JSON.stringify({
      ok: true,
      projectRoot: synced.structuredContent.projectRoot,
      conversationId: synced.structuredContent.conversationId,
      sourceRecordCount: synced.structuredContent.sourceRecordCount,
      visibleRecordCount: mirrorRecords.length,
      newRecordCount: synced.structuredContent.newRecordCount,
      counts,
      mirrorPath: synced.structuredContent.mirrorPath
    })
  );
} finally {
  await client.close();
}
