import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..");
const projectRoot = process.argv[2];
if (!projectRoot || !path.isAbsolute(projectRoot)) {
  throw new Error("Pass one absolute project root as the first argument");
}

const client = new Client({ name: "agy-continue-acceptance", version: "0.4.0" });
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [path.join(repositoryRoot, "src", "index.js")],
      cwd: repositoryRoot,
      env: {
        ...process.env,
        AGY_BIN: process.env.AGY_BIN || "agy"
      }
    })
  );

  const before = await client.callTool({
    name: "antigravity_get_active_session",
    arguments: { project_root: projectRoot }
  });
  assert.ok(before.structuredContent.conversationId);

  const continued = await client.callTool(
    {
      name: "antigravity_continue",
      arguments: {
        project_root: projectRoot,
        prompt: "Continue this project conversation and reply exactly: AGY_CONTINUE_OK",
        timeout_seconds: 180,
        max_response_chars: 2000
      }
    },
    { timeout: 210_000, maxTotalTimeout: 210_000 }
  );
  assert.notEqual(continued.isError, true);
  assert.match(JSON.stringify(continued.content), /AGY_CONTINUE_OK/);
  assert.equal(
    continued.structuredContent.conversationId,
    before.structuredContent.conversationId
  );

  console.log(
    JSON.stringify(
      {
        projectRoot,
        conversationId: continued.structuredContent.conversationId,
        response: continued.structuredContent.response
      },
      null,
      2
    )
  );
} finally {
  await client.close();
}
