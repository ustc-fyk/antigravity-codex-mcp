import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..");
const serverEntry = path.join(repositoryRoot, "src", "index.js");
const useLiveProject =
  process.argv.includes("--live") || process.argv.includes("--execute");

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "agy-mcp-smoke-"));
const temporaryProject = path.join(temporaryRoot, "project");
const temporarySettings = path.join(temporaryRoot, "settings.json");
await mkdir(temporaryProject, { recursive: true });
await writeFile(temporarySettings, "{}\n", "utf8");
await writeFile(path.join(temporaryProject, "message.txt"), "BEFORE\n", "utf8");

const projectRoot = useLiveProject ? repositoryRoot : temporaryProject;
const client = new Client({ name: "antigravity-mcp-smoke", version: "0.3.0" });

try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        AGY_BIN: process.env.AGY_BIN || "agy",
        ...(useLiveProject
          ? {}
          : { ANTIGRAVITY_SETTINGS_PATH: temporarySettings })
      }
    })
  );

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "antigravity_ask",
    "antigravity_continue",
    "antigravity_disable_project",
    "antigravity_enable_project",
    "antigravity_execute",
    "antigravity_get_active_session",
    "antigravity_get_run",
    "antigravity_get_transcript",
    "antigravity_health",
    "antigravity_list_runs",
    "antigravity_list_sessions",
    "antigravity_project_status",
    "antigravity_review",
    "antigravity_start_session",
    "antigravity_sync_conversation"
  ]);

  const health = await client.callTool({
    name: "antigravity_health",
    arguments: {}
  });
  assert.notEqual(health.isError, true);
  assert.match(JSON.stringify(health.content), /1\.1\.\d+/);

  if (!useLiveProject) {
    const initial = await client.callTool({
      name: "antigravity_project_status",
      arguments: { project_root: projectRoot }
    });
    assert.equal(initial.structuredContent.enabled, false);
    assert.equal(initial.structuredContent.initialized, false);

    const enabled = await client.callTool({
      name: "antigravity_enable_project",
      arguments: { project_root: projectRoot }
    });
    assert.notEqual(enabled.isError, true);
    assert.equal(enabled.structuredContent.enabled, true);

    const sessions = await client.callTool({
      name: "antigravity_list_sessions",
      arguments: { project_root: projectRoot, limit: 5 }
    });
    assert.notEqual(sessions.isError, true);
    assert.deepEqual(sessions.structuredContent.sessions, []);

    const disabled = await client.callTool({
      name: "antigravity_disable_project",
      arguments: { project_root: projectRoot }
    });
    assert.notEqual(disabled.isError, true);
    assert.equal(disabled.structuredContent.enabled, false);
  }

  if (process.argv.includes("--live")) {
    const liveResult = await client.callTool(
      {
        name: "antigravity_ask",
        arguments: {
          project_root: projectRoot,
          prompt: "Reply exactly: MCP_ANTIGRAVITY_OK",
          timeout_seconds: 120,
          max_response_chars: 2000
        }
      },
      { timeout: 150_000, maxTotalTimeout: 150_000 }
    );
    assert.notEqual(liveResult.isError, true);
    assert.match(JSON.stringify(liveResult.content), /MCP_ANTIGRAVITY_OK/);
    console.log("Live Antigravity model call passed");
  }

  if (process.argv.includes("--execute")) {
    const executeResult = await client.callTool(
      {
        name: "antigravity_execute",
        arguments: {
          project_root: projectRoot,
          task: "Change test/fixtures/execute-sample/message.txt from BEFORE to exactly AFTER with a trailing newline. Do not change any other file.",
          timeout_seconds: 180,
          max_response_chars: 4000,
          verification: "none"
        }
      },
      { timeout: 210_000, maxTotalTimeout: 210_000 }
    );
    assert.notEqual(executeResult.isError, true);
    assert.match(JSON.stringify(executeResult.content), /message\.txt/);
    assert.match(JSON.stringify(executeResult.content), /modified/);
    console.log("Isolated Antigravity execution passed");
  }

  console.log(`MCP smoke test passed: ${names.join(", ")}`);
} finally {
  await client.close();
  const resolvedTemporary = path.resolve(temporaryRoot);
  const resolvedSystemTemp = path.resolve(tmpdir());
  if (resolvedTemporary.startsWith(`${resolvedSystemTemp}${path.sep}`)) {
    await rm(resolvedTemporary, { recursive: true, force: true });
  }
}
