import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..");
const serverEntry = path.join(repositoryRoot, "src", "index.js");
const projectRoot = process.argv[2];
if (!projectRoot || !path.isAbsolute(projectRoot)) {
  throw new Error("Pass one absolute project root as the first argument");
}

const sourceProbe = path.join(projectRoot, "agy_acceptance.txt");
const client = new Client({ name: "agy-project-acceptance", version: "0.4.0" });

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

  const initial = await client.callTool({
    name: "antigravity_project_status",
    arguments: { project_root: projectRoot }
  });

  const enabled = await client.callTool({
    name: "antigravity_enable_project",
    arguments: { project_root: projectRoot }
  });
  assert.notEqual(enabled.isError, true);
  assert.equal(enabled.structuredContent.enabled, true);

  const conversation = await client.callTool(
    {
      name: "antigravity_ask",
      arguments: {
        project_root: projectRoot,
        prompt: "This is an integration acceptance check. Reply exactly: AGY_TEST1_READY",
        timeout_seconds: 180,
        max_response_chars: 2000
      }
    },
    { timeout: 210_000, maxTotalTimeout: 210_000 }
  );
  assert.notEqual(conversation.isError, true);
  assert.match(JSON.stringify(conversation.content), /AGY_TEST1_READY/);
  const conversationId = conversation.structuredContent.conversationId;
  assert.ok(conversationId);

  const active = await client.callTool({
    name: "antigravity_get_active_session",
    arguments: { project_root: projectRoot }
  });
  assert.equal(active.structuredContent.conversationId, conversationId);

  const execution = await client.callTool(
    {
      name: "antigravity_execute",
      arguments: {
        project_root: projectRoot,
        task: "Create a UTF-8 text file named agy_acceptance.txt whose exact content is AGY_ISOLATED_OK followed by a newline. Do not create or change any other file.",
        timeout_seconds: 240,
        max_response_chars: 4000,
        verification: "none"
      }
    },
    { timeout: 270_000, maxTotalTimeout: 270_000 }
  );
  assert.notEqual(execution.isError, true);
  const runId = execution.structuredContent.runId;
  const isolatedWorkspace = execution.structuredContent.isolatedWorkspace;
  assert.ok(runId && isolatedWorkspace);
  assert.match(
    await readFile(path.join(isolatedWorkspace, "agy_acceptance.txt"), "utf8"),
    /^AGY_ISOLATED_OK\r?\n$/
  );
  await assert.rejects(() => access(sourceProbe));

  const sessions = await client.callTool({
    name: "antigravity_list_sessions",
    arguments: { project_root: projectRoot, limit: 20 }
  });
  assert.ok(sessions.structuredContent.sessions.length >= 2);

  const disabled = await client.callTool({
    name: "antigravity_disable_project",
    arguments: { project_root: projectRoot }
  });
  assert.equal(disabled.structuredContent.enabled, false);

  const reenabled = await client.callTool({
    name: "antigravity_enable_project",
    arguments: { project_root: projectRoot }
  });
  assert.equal(reenabled.structuredContent.enabled, true);
  assert.equal(reenabled.structuredContent.activeConversationId, execution.structuredContent.conversationId);

  console.log(
    JSON.stringify(
      {
        initialEnabled: initial.structuredContent.enabled,
        finalEnabled: reenabled.structuredContent.enabled,
        projectRoot,
        conversationId,
        latestConversationId: execution.structuredContent.conversationId,
        runId,
        isolatedWorkspace,
        sourceUnchanged: true,
        sessionEvents: sessions.structuredContent.sessions.length
      },
      null,
      2
    )
  );
} finally {
  await client.close();
}
