import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAgyArgs,
  buildSafeChildEnv,
  isPathWithin,
  parseAgyJson,
  parseAgyStreamJson,
  runVersionCommand,
  sanitizeDiagnostic
} from "../src/agy.js";
import {
  applyStructuredOperations,
  collectChanges,
  executeIsolated,
  listRuns,
  shouldCopyRelative
} from "../src/execution.js";
import { validateExecutionTimeoutBudget } from "../src/server.js";
import {
  appendSessionEvent,
  canonicalProjectRoot,
  disableProject,
  enableProject,
  listSessionEvents,
  projectStatus,
  setActiveConversation
} from "../src/projects.js";
import {
  filterTranscriptRecord,
  getAgyTranscriptPath,
  syncConversationTranscript
} from "../src/transcripts.js";

test("isPathWithin accepts a root and descendants", () => {
  const root = path.resolve(tmpdir(), "antigravity_ws");
  assert.equal(isPathWithin(root, root), true);
  assert.equal(isPathWithin(path.join(root, "src"), root), true);
});

test("isPathWithin rejects sibling prefix tricks", () => {
  const root = path.resolve(tmpdir(), "antigravity_ws");
  assert.equal(isPathWithin(path.resolve(tmpdir(), "antigravity_ws-evil"), root), false);
  assert.equal(isPathWithin(path.resolve(tmpdir()), root), false);
});

test("buildAgyArgs preserves plan expansion while enforcing sandbox and JSON", () => {
  const args = buildAgyArgs({
    prompt: "inspect",
    conversationId: "0a46654e-c16f-4412-aff3-b5bc06495ddd",
    model: "gemini-3.7-flash-high",
    effort: "high",
    timeoutSeconds: 120,
    sandbox: true,
    mode: "plan",
    outputFormat: "json"
  });
  assert.deepEqual(args.slice(0, 4), ["-p", "inspect", "--output-format", "json"]);
  assert.ok(args.includes("--mode=plan"));
  assert.ok(args.includes("--sandbox"));
  assert.ok(!args.includes("--disable-slash-commands"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.ok(args.includes("--conversation"));
  assert.ok(args.includes("gemini-3.7-flash-high"));
});

test("buildAgyArgs leaves the optional OS sandbox off when not requested", () => {
  const args = buildAgyArgs({ prompt: "inspect", timeoutSeconds: 120, sandbox: false });
  assert.ok(args.includes("--mode=plan"));
  assert.ok(!args.includes("--sandbox"));
});

test("buildAgyArgs can disable slash expansion outside plan mode", () => {
  const args = buildAgyArgs({
    prompt: "edit",
    timeoutSeconds: 120,
    sandbox: false,
    mode: "accept-edits",
    disableSlashCommands: true
  });
  assert.ok(args.includes("--disable-slash-commands"));
});

test("buildSafeChildEnv provides a home directory to AGY on POSIX", () => {
  if (process.platform === "win32") return;
  const childEnv = buildSafeChildEnv();
  assert.equal(childEnv.HOME, process.env.HOME || homedir());
});

test("parseAgyJson accepts a clean envelope", () => {
  const parsed = parseAgyJson(
    '{"conversation_id":"abc","status":"SUCCESS","response":"OK"}\n'
  );
  assert.equal(parsed.status, "SUCCESS");
  assert.equal(parsed.response, "OK");
});

test("parseAgyJson recovers a final JSON line", () => {
  const parsed = parseAgyJson(
    'diagnostic\n{"conversation_id":"abc","status":"SUCCESS","response":"OK"}\n'
  );
  assert.equal(parsed.status, "SUCCESS");
});

test("parseAgyStreamJson returns events and the terminal result", () => {
  const parsed = parseAgyStreamJson(
    [
      '{"event":"init","init":{"cwd":"E:/work"}}',
      '{"event":"step_update","step_update":{"tool_name":"view_file"}}',
      '{"event":"result","result":{"status":"SUCCESS","response":"done"}}'
    ].join("\n")
  );
  assert.equal(parsed.events.length, 3);
  assert.equal(parsed.envelope.response, "done");
});

test("sanitizeDiagnostic redacts account and credential strings", () => {
  const fakeGoogleKey = `AIza${"0".repeat(32)}`;
  const sanitized = sanitizeDiagnostic(
    `signed in as person@example.com Authorization: Bearer abc.def.ghi key=${fakeGoogleKey}`
  );
  assert.ok(!sanitized.includes("person@example.com"));
  assert.ok(!sanitized.includes("abc.def.ghi"));
  assert.ok(!sanitized.includes(fakeGoogleKey));
});

test("version command has a hard timeout", async () => {
  const startedAt = Date.now();
  await assert.rejects(
    () =>
      runVersionCommand(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        100
      ),
    /exceeded 100ms timeout/
  );
  assert.ok(Date.now() - startedAt < 5_000);
});

test("transcript filter keeps visible messages and recursively removes private reasoning", () => {
  const records = filterTranscriptRecord(
    {
      step_index: 4,
      created_at: "2026-08-19T00:00:00Z",
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      content: "visible answer",
      thinking: "SECRET_TOP_LEVEL",
      tool_calls: [
        {
          name: "view_file",
          arguments: { path: "src/index.js", thinking: "SECRET_NESTED" },
          reasoning: "SECRET_REASONING"
        }
      ]
    },
    []
  );
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((record) => record.role), ["assistant", "tool_trace"]);
  const serialized = JSON.stringify(records);
  assert.match(serialized, /visible answer/);
  assert.ok(!serialized.includes("SECRET_TOP_LEVEL"));
  assert.ok(!serialized.includes("SECRET_NESTED"));
  assert.ok(!serialized.includes("SECRET_REASONING"));
  assert.ok(!Object.hasOwn(records[1].toolCalls[0].arguments, "thinking"));
});

test("transcript synchronization mirrors only project-visible dialogue and deduplicates", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "agy-transcript-unit-"));
  const projectRoot = path.join(temporaryRoot, "project");
  const settingsPath = path.join(temporaryRoot, "settings.json");
  const cliDataRoot = path.join(temporaryRoot, "cli-data");
  const conversationId = "0a46654e-c16f-4412-aff3-b5bc06495ddd";
  const previousSettingsPath = process.env.ANTIGRAVITY_SETTINGS_PATH;
  const previousCliDataRoot = process.env.ANTIGRAVITY_CLI_DATA_DIR;
  await mkdir(projectRoot, { recursive: true });
  await writeFile(settingsPath, "{}\n", "utf8");
  process.env.ANTIGRAVITY_SETTINGS_PATH = settingsPath;
  process.env.ANTIGRAVITY_CLI_DATA_DIR = cliDataRoot;

  try {
    await enableProject(projectRoot);
    await writeFile(
      path.join(projectRoot, ".antigravity-mcp", ".gitignore"),
      "runs/\n*.tmp-*\n",
      "utf8"
    );
    await setActiveConversation(projectRoot, conversationId);
    await appendSessionEvent(projectRoot, {
      event: "test",
      conversationId,
      request: "inspect the project"
    });

    const sourcePath = getAgyTranscriptPath(conversationId);
    await mkdir(path.dirname(sourcePath), { recursive: true });
    const sourceRecords = [
      {
        step_index: 0,
        source: "SYSTEM",
        type: "SYSTEM_MESSAGE",
        content: "SECRET_SYSTEM_PROMPT"
      },
      {
        step_index: 1,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        content: "Delegated wrapper: inspect the project"
      },
      {
        step_index: 2,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        content: "visible response",
        thinking: "SECRET_CHAIN_OF_THOUGHT"
      },
      {
        step_index: 3,
        source: "MODEL",
        type: "PLANNER_RESPONSE",
        tool_calls: [
          { name: "view_file", arguments: { path: "README.md", thinking: "SECRET_TOOL" } }
        ]
      },
      {
        step_index: 4,
        source: "SYSTEM",
        type: "CHECKPOINT",
        content: "SECRET_CHECKPOINT"
      },
      {
        step_index: 5,
        source: "USER_EXPLICIT",
        type: "USER_INPUT",
        content: "manual CLI message"
      }
    ];
    await writeFile(
      sourcePath,
      `${sourceRecords.map((record) => JSON.stringify(record)).join("\n")}\n{incomplete`,
      "utf8"
    );

    const first = await syncConversationTranscript({
      projectRoot,
      conversationId,
      includeAll: true
    });
    assert.equal(first.sourceRecordCount, 6);
    assert.equal(first.malformedSourceLines, 1);
    assert.equal(first.visibleRecordCount, 4);
    assert.deepEqual(
      first.records.filter((record) => record.role === "user").map((record) => record.origin),
      ["codex_mcp", "agy_cli"]
    );

    const mirror = await readFile(first.mirrorPath, "utf8");
    const ignore = await readFile(
      path.join(projectRoot, ".antigravity-mcp", ".gitignore"),
      "utf8"
    );
    assert.match(ignore, /^\*$/m);
    for (const secret of [
      "SECRET_SYSTEM_PROMPT",
      "SECRET_CHAIN_OF_THOUGHT",
      "SECRET_TOOL",
      "SECRET_CHECKPOINT"
    ]) {
      assert.ok(!mirror.includes(secret));
    }
    for (const line of mirror.trim().split(/\r?\n/)) {
      const record = JSON.parse(line);
      assert.ok(!Object.hasOwn(record, "thinking"));
    }

    const second = await syncConversationTranscript({ projectRoot, conversationId });
    assert.equal(second.newRecordCount, 0);
    assert.deepEqual(second.records, []);
  } finally {
    if (previousSettingsPath === undefined) delete process.env.ANTIGRAVITY_SETTINGS_PATH;
    else process.env.ANTIGRAVITY_SETTINGS_PATH = previousSettingsPath;
    if (previousCliDataRoot === undefined) delete process.env.ANTIGRAVITY_CLI_DATA_DIR;
    else process.env.ANTIGRAVITY_CLI_DATA_DIR = previousCliDataRoot;
    const resolvedTemporary = path.resolve(temporaryRoot);
    if (resolvedTemporary.startsWith(`${path.resolve(tmpdir())}${path.sep}`)) {
      await rm(resolvedTemporary, { recursive: true, force: true });
    }
  }
});

test("isolated copy excludes metadata, dependencies, secrets, and links", () => {
  assert.equal(shouldCopyRelative("src"), true);
  assert.equal(shouldCopyRelative(path.join("src", "index.js")), true);
  assert.equal(shouldCopyRelative(path.join("node_modules", "pkg", "index.js")), false);
  assert.equal(shouldCopyRelative(path.join("packages", "web", "node_modules", "pkg.js")), false);
  assert.equal(shouldCopyRelative(path.join("services", "api", ".venv", "python")), false);
  assert.equal(shouldCopyRelative(path.join("packages", "web", "dist", "bundle.js")), false);
  assert.equal(shouldCopyRelative(path.join(".git", "config")), false);
  assert.equal(shouldCopyRelative(path.join("config", ".env.production")), false);
  assert.equal(shouldCopyRelative(path.join("certs", "client.pem")), false);
});

test("collectChanges reports added, modified, and deleted files", () => {
  const before = new Map([
    ["same.txt", { sha256: "a", size: 1 }],
    ["changed.txt", { sha256: "b", size: 2 }],
    ["deleted.txt", { sha256: "c", size: 3 }]
  ]);
  const after = new Map([
    ["same.txt", { sha256: "a", size: 1 }],
    ["changed.txt", { sha256: "d", size: 4 }],
    ["added.txt", { sha256: "e", size: 5 }]
  ]);
  assert.deepEqual(
    collectChanges(before, after).map(({ path: file, status }) => [file, status]),
    [
      ["added.txt", "added"],
      ["changed.txt", "modified"],
      ["deleted.txt", "deleted"]
    ]
  );
});

test("canonicalProjectRoot rejects a drive root as overly broad", async () => {
  await assert.rejects(
    () => canonicalProjectRoot(path.parse(process.cwd()).root),
    /broad or system/
  );
});

test("dynamic project enable, session persistence, and disable are isolated", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "agy-project-unit-"));
  const projectRoot = path.join(temporaryRoot, "project");
  const secondProjectRoot = path.join(temporaryRoot, "project-2");
  const settingsPath = path.join(temporaryRoot, "settings.json");
  const previousSettingsPath = process.env.ANTIGRAVITY_SETTINGS_PATH;
  await mkdir(projectRoot, { recursive: true });
  await mkdir(secondProjectRoot, { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify({ enableTelemetry: false, customSetting: "preserve-me" }),
    "utf8"
  );
  process.env.ANTIGRAVITY_SETTINGS_PATH = settingsPath;

  try {
    const enabled = await enableProject(projectRoot);
    assert.equal(enabled.enabled, true);
    await enableProject(projectRoot);
    await enableProject(secondProjectRoot);
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(settings.customSetting, "preserve-me");
    assert.equal(settings.permissions.allow.length, 2);
    assert.equal(settings.trustedWorkspaces.length, 2);
    const internalIgnore = await readFile(
      path.join(projectRoot, ".antigravity-mcp", ".gitignore"),
      "utf8"
    );
    assert.match(internalIgnore, /^\*$/m);
    assert.ok(!internalIgnore.includes("sessions.jsonl"));

    const conversationId = "0a46654e-c16f-4412-aff3-b5bc06495ddd";
    await setActiveConversation(projectRoot, conversationId);
    await appendSessionEvent(projectRoot, {
      event: "test",
      conversationId
    });
    const sessions = await listSessionEvents(projectRoot, 10);
    assert.equal(sessions.length, 1);
    assert.equal((await projectStatus(projectRoot)).activeConversationId, conversationId);

    const disabled = await disableProject(projectRoot);
    assert.equal(disabled.enabled, false);
    const after = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(after.permissions.allow.length, 1);
    assert.equal(after.trustedWorkspaces.length, 1);
    assert.equal((await projectStatus(secondProjectRoot)).enabled, true);
  } finally {
    if (previousSettingsPath === undefined) {
      delete process.env.ANTIGRAVITY_SETTINGS_PATH;
    } else {
      process.env.ANTIGRAVITY_SETTINGS_PATH = previousSettingsPath;
    }
    const resolvedTemporary = path.resolve(temporaryRoot);
    if (resolvedTemporary.startsWith(`${path.resolve(tmpdir())}${path.sep}`)) {
      await rm(resolvedTemporary, { recursive: true, force: true });
    }
  }
});

test("project enable recovers a settings lock left by a dead process", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "agy-stale-lock-unit-"));
  const projectRoot = path.join(temporaryRoot, "project");
  const settingsPath = path.join(temporaryRoot, "settings.json");
  const lockPath = `${settingsPath}.agy-mcp.lock`;
  const previousSettingsPath = process.env.ANTIGRAVITY_SETTINGS_PATH;
  await mkdir(projectRoot, { recursive: true });
  await writeFile(settingsPath, "{}\n", "utf8");
  await writeFile(
    lockPath,
    `${JSON.stringify({ pid: 2_147_483_647, createdAt: "2000-01-01T00:00:00Z" })}\n`,
    "utf8"
  );
  process.env.ANTIGRAVITY_SETTINGS_PATH = settingsPath;

  try {
    const enabled = await enableProject(projectRoot);
    assert.equal(enabled.enabled, true);
    await assert.rejects(() => readFile(lockPath, "utf8"), /ENOENT/);
  } finally {
    if (previousSettingsPath === undefined) delete process.env.ANTIGRAVITY_SETTINGS_PATH;
    else process.env.ANTIGRAVITY_SETTINGS_PATH = previousSettingsPath;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("buildSafeChildEnv passes through Linux and standard POSIX environment variables", () => {
  const previousTmpdir = process.env.TMPDIR;
  const previousUser = process.env.USER;
  const previousShell = process.env.SHELL;
  const previousProxy = process.env.ALL_PROXY;
  const previousXdg = process.env.XDG_CONFIG_HOME;
  try {
    process.env.TMPDIR = "/custom/tmp";
    process.env.USER = "testuser";
    process.env.SHELL = "/bin/bash";
    process.env.ALL_PROXY = "socks5://127.0.0.1:1080";
    process.env.XDG_CONFIG_HOME = "/custom/config";
    const childEnv = buildSafeChildEnv();
    assert.equal(childEnv.TMPDIR, "/custom/tmp");
    assert.equal(childEnv.USER, "testuser");
    assert.equal(childEnv.SHELL, "/bin/bash");
    assert.equal(childEnv.ALL_PROXY, "socks5://127.0.0.1:1080");
    assert.equal(childEnv.XDG_CONFIG_HOME, "/custom/config");
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
    if (previousUser === undefined) delete process.env.USER;
    else process.env.USER = previousUser;
    if (previousShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = previousShell;
    if (previousProxy === undefined) delete process.env.ALL_PROXY;
    else process.env.ALL_PROXY = previousProxy;
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousXdg;
  }
});

test("buildSafeChildEnv rejects sensitive opt-in variables without separate approval", () => {
  const previousNames = process.env.ANTIGRAVITY_PASSTHROUGH_ENV;
  const previousApproval = process.env.ANTIGRAVITY_ALLOW_SENSITIVE_ENV_PASSTHROUGH;
  const previousToken = process.env.TEST_PRIVATE_TOKEN;
  process.env.ANTIGRAVITY_PASSTHROUGH_ENV = "TEST_PRIVATE_TOKEN";
  process.env.TEST_PRIVATE_TOKEN = "test-value";
  delete process.env.ANTIGRAVITY_ALLOW_SENSITIVE_ENV_PASSTHROUGH;
  try {
    assert.throws(() => buildSafeChildEnv(), /Refusing sensitive/);
    process.env.ANTIGRAVITY_ALLOW_SENSITIVE_ENV_PASSTHROUGH = "true";
    assert.equal(buildSafeChildEnv().TEST_PRIVATE_TOKEN, "test-value");
  } finally {
    if (previousNames === undefined) delete process.env.ANTIGRAVITY_PASSTHROUGH_ENV;
    else process.env.ANTIGRAVITY_PASSTHROUGH_ENV = previousNames;
    if (previousApproval === undefined) {
      delete process.env.ANTIGRAVITY_ALLOW_SENSITIVE_ENV_PASSTHROUGH;
    } else {
      process.env.ANTIGRAVITY_ALLOW_SENSITIVE_ENV_PASSTHROUGH = previousApproval;
    }
    if (previousToken === undefined) delete process.env.TEST_PRIVATE_TOKEN;
    else process.env.TEST_PRIVATE_TOKEN = previousToken;
  }
});

test("isolated verification requires explicit untrusted-code approval", async () => {
  await assert.rejects(
    () =>
      executeIsolated({
        task: "test",
        projectRoot: path.join(tmpdir(), "not-used"),
        verification: "npm-test"
      }),
    /allow_untrusted_verification=true/
  );
});

test("execution timeout budget stays below the configured MCP tool timeout", () => {
  assert.equal(validateExecutionTimeoutBudget(480, "npm-test", 240), 735);
  assert.throws(
    () => validateExecutionTimeoutBudget(700, "npm-test", 200),
    /must not exceed 840s/
  );
});

test("listRuns remains read-only when a project has no run directory", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "agy-list-runs-unit-"));
  const projectRoot = path.join(temporaryRoot, "project");
  await mkdir(projectRoot, { recursive: true });
  try {
    assert.deepEqual(await listRuns(projectRoot), []);
    await assert.rejects(
      () => stat(path.join(projectRoot, ".antigravity-mcp", "runs")),
      /ENOENT/
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("canonicalProjectRoot rejects POSIX system directories", async () => {
  if (process.platform === "win32") return;
  for (const sysDir of ["/etc", "/usr", "/tmp", "/var"]) {
    await assert.rejects(
      () => canonicalProjectRoot(sysDir),
      /broad or system/
    );
  }
});

test("applyStructuredOperations preserves executable file mode", async () => {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "agy-exec-mode-"));
  try {
    const scriptPath = path.join(temporaryRoot, "script.sh");
    await writeFile(scriptPath, "#!/bin/sh\necho 1\n", { mode: 0o755 });
    const beforeStat = await stat(scriptPath);

    await applyStructuredOperations(temporaryRoot, {
      summary: "update script",
      operations: [
        { path: "script.sh", content: "#!/bin/sh\necho 2\n" }
      ]
    });

    const afterStat = await stat(scriptPath);
    const updatedContent = await readFile(scriptPath, "utf8");
    assert.equal(updatedContent, "#!/bin/sh\necho 2\n");
    if (process.platform !== "win32") {
      assert.equal(afterStat.mode & 0o777, beforeStat.mode & 0o777);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
