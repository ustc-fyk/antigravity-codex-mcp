import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import {
  buildSafeChildEnv,
  isPathWithin,
  runAgy,
  sanitizeDiagnostic,
  terminateProcessTree
} from "./agy.js";
import {
  canonicalProjectRoot,
  getProjectRunsRoot,
  recordAgyCall,
  requireEnabledProject
} from "./projects.js";

const RUN_ID_PATTERN = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const MAX_FILES = 20_000;
const MAX_COPY_BYTES = 1024 * 1024 * 1024;
const MAX_VERIFICATION_BYTES = 1024 * 1024;
const MAX_PATCH_OPERATIONS = 50;
const MAX_PATCH_CHARACTERS = 2_000_000;

const PATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    operations: {
      type: "array",
      maxItems: MAX_PATCH_OPERATIONS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          content: { type: "string" }
        },
        required: ["path", "content"]
      }
    }
  },
  required: ["summary", "operations"]
};

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".antigravity-mcp",
  ".codex",
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "venv"
]);

const VERIFICATION_COMMANDS = {
  "npm-test": {
    command: process.platform === "win32" ? "cmd.exe" : "npm",
    args: process.platform === "win32" ? ["/d", "/s", "/c", "npm test"] : ["test"]
  },
  pytest: { command: process.platform === "win32" ? "python" : "python3", args: ["-m", "pytest"] },
  "cargo-test": { command: "cargo", args: ["test"] },
  "go-test": { command: "go", args: ["test", "./..."] },
  "dotnet-test": { command: "dotnet", args: ["test"] }
};

function createRunId() {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

function isSensitiveFileName(name) {
  const lower = name.toLowerCase();
  return (
    lower === ".env" ||
    lower.startsWith(".env.") ||
    lower === "credentials.json" ||
    lower === "id_rsa" ||
    lower === "id_ed25519" ||
    lower.endsWith(".pem") ||
    lower.endsWith(".p12") ||
    lower.endsWith(".pfx")
  );
}

export function shouldCopyRelative(relativePath) {
  if (!relativePath) return true;
  if (process.platform !== "win32" && relativePath.includes("\\")) return false;
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => EXCLUDED_DIRECTORY_NAMES.has(part.toLowerCase()))) {
    return false;
  }
  return !parts.some((part) => isSensitiveFileName(part));
}

async function copyProject(source, destination) {
  await mkdir(destination, { recursive: false });
  const pending = [{ source, destination, relative: "" }];
  let fileCount = 0;
  let totalBytes = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current.source, { withFileTypes: true });
    for (const entry of entries) {
      const relative = path.join(current.relative, entry.name);
      if (!shouldCopyRelative(relative)) continue;
      const sourcePath = path.join(current.source, entry.name);
      const destinationPath = path.join(current.destination, entry.name);
      const info = await lstat(sourcePath);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await mkdir(destinationPath, { recursive: false });
        pending.push({
          source: sourcePath,
          destination: destinationPath,
          relative
        });
        continue;
      }
      if (!info.isFile()) continue;
      fileCount += 1;
      totalBytes += info.size;
      if (fileCount > MAX_FILES || totalBytes > MAX_COPY_BYTES) {
        throw new Error(
          `Project copy exceeds the safety limit (${MAX_FILES} files or 1 GiB)`
        );
      }
      await copyFile(sourcePath, destinationPath);
    }
  }
}

async function hashFile(filePath) {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const input = createReadStream(filePath);
    input.on("error", reject);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function snapshotFiles(root) {
  const snapshot = new Map();
  const pending = [root];
  let fileCount = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      fileCount += 1;
      if (fileCount > MAX_FILES) {
        throw new Error(`Isolated workspace exceeds the ${MAX_FILES} file safety limit`);
      }
      const info = await stat(absolute);
      snapshot.set(path.relative(root, absolute), {
        sha256: await hashFile(absolute),
        size: info.size
      });
    }
  }
  return snapshot;
}

export function collectChanges(before, after) {
  const changes = [];
  for (const [relativePath, initial] of before) {
    const current = after.get(relativePath);
    if (!current) {
      changes.push({ path: relativePath, status: "deleted", beforeSize: initial.size });
    } else if (current.sha256 !== initial.sha256) {
      changes.push({
        path: relativePath,
        status: "modified",
        beforeSize: initial.size,
        afterSize: current.size
      });
    }
  }
  for (const [relativePath, current] of after) {
    if (!before.has(relativePath)) {
      changes.push({ path: relativePath, status: "added", afterSize: current.size });
    }
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

async function runVerification(kind, cwd, timeoutSeconds) {
  if (!kind || kind === "none") return { kind: "none", status: "not-run" };
  const spec = VERIFICATION_COMMANDS[kind];
  if (!spec) throw new Error(`Unsupported verification kind: ${kind}`);

  return await new Promise((resolve) => {
    const stdout = [];
    const stderr = [];
    let totalBytes = 0;
    let overflow = false;
    let settled = false;
    const child = spawn(spec.command, spec.args, {
      cwd,
      env: buildSafeChildEnv(),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const append = (target, chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_VERIFICATION_BYTES) {
        overflow = true;
        return;
      }
      target.push(chunk);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void terminateProcessTree(child);
      resolve({ kind, status: "timeout", exitCode: null, output: "" });
    }, timeoutSeconds * 1_000);
    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ kind, status: "error", exitCode: null, output: error.message });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = sanitizeDiagnostic(
        `${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`
      ).trim();
      resolve({
        kind,
        status: overflow ? "output-limit" : exitCode === 0 ? "passed" : "failed",
        exitCode,
        output: output.slice(0, 20_000)
      });
    });
  });
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function applyStructuredOperations(isolatedWorkspace, structuredOutput) {
  if (!structuredOutput || typeof structuredOutput !== "object") {
    throw new Error("Antigravity did not return structured file operations");
  }
  const operations = structuredOutput.operations;
  if (!Array.isArray(operations) || operations.length > MAX_PATCH_OPERATIONS) {
    throw new Error(`Antigravity returned an invalid operations list`);
  }

  let totalCharacters = 0;
  const applied = [];
  for (const operation of operations) {
    if (
      !operation ||
      typeof operation.path !== "string" ||
      typeof operation.content !== "string"
    ) {
      throw new Error("Each file operation must contain string path and content fields");
    }
    const relativePath = path.normalize(operation.path.trim());
    if (
      !relativePath ||
      path.isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith(`..${path.sep}`) ||
      !shouldCopyRelative(relativePath)
    ) {
      throw new Error(`Unsafe or excluded file operation path: ${operation.path}`);
    }
    const destination = path.resolve(isolatedWorkspace, relativePath);
    if (!isPathWithin(destination, isolatedWorkspace)) {
      throw new Error(`File operation escapes isolated workspace: ${operation.path}`);
    }
    totalCharacters += operation.content.length;
    if (totalCharacters > MAX_PATCH_CHARACTERS) {
      throw new Error("Antigravity patch exceeds the 2,000,000 character safety limit");
    }
    let existingMode = null;
    try {
      const currentStat = await stat(destination);
      existingMode = currentStat.mode;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, operation.content, "utf8");
    if (existingMode !== null) {
      await chmod(destination, existingMode).catch(() => {});
    }
    applied.push(relativePath);
  }
  return applied;
}

export async function executeIsolated({
  task,
  projectRoot,
  model,
  effort,
  timeoutSeconds = 600,
  maxResponseChars = 12000,
  verification = "none",
  verificationTimeoutSeconds = 300,
  allowUntrustedVerification = false
}) {
  if (verification !== "none" && !allowUntrustedVerification) {
    throw new Error(
      "Verification executes AGY-influenced project code. Set allow_untrusted_verification=true only after the user explicitly accepts that risk."
    );
  }
  const source = await requireEnabledProject(projectRoot);
  const runsRoot = getProjectRunsRoot(source);
  await mkdir(runsRoot, { recursive: true });
  const runId = createRunId();
  const runDirectory = path.join(runsRoot, runId);
  const isolatedWorkspace = path.join(runDirectory, "workspace");
  await mkdir(runDirectory, { recursive: false });

  const startedAt = new Date().toISOString();
  await copyProject(source, isolatedWorkspace);
  const before = await snapshotFiles(isolatedWorkspace);
  await writeJson(path.join(runDirectory, "metadata.json"), {
    runId,
    status: "running",
    startedAt,
    source,
    isolatedWorkspace,
    task,
    verification
  });

  const delegatedPrompt = [
    "You are a delegated implementation planner. Inspect the project read-only and produce exact replacement contents for every file that must be changed or created.",
    `The project root is exactly: ${source}`,
    "Every operation path must be relative to that project root. Never include absolute paths, parent traversal, secret files, dependency directories, build outputs, or deletions.",
    "Return only the structured result required by the provided JSON schema. Each operation must contain the complete final UTF-8 text content of that file; omit unchanged files.",
    `Task:\n${task}`
  ].join("\n\n");

  let agyResult;
  try {
    agyResult = await runAgy({
      prompt: delegatedPrompt,
      workingDirectory: source,
      model,
      effort,
      timeoutSeconds,
      maxResponseChars,
      mode: "plan",
      outputFormat: "stream-json",
      sandbox: false,
      jsonSchema: PATCH_SCHEMA,
      allowedRoots: [source]
    });
  } catch (error) {
    agyResult = {
      ok: false,
      status: "ERROR",
      response: "",
      error: error instanceof Error ? error.message : String(error),
      warnings: [],
      events: []
    };
  }

  let appliedOperations = [];
  if (agyResult.ok) {
    try {
      appliedOperations = await applyStructuredOperations(
        isolatedWorkspace,
        agyResult.structuredOutput
      );
    } catch (error) {
      agyResult.ok = false;
      agyResult.status = "ERROR";
      agyResult.error = error instanceof Error ? error.message : String(error);
    }
  }

  const after = await snapshotFiles(isolatedWorkspace);
  const changes = collectChanges(before, after);
  const verificationResult = await runVerification(
    verification,
    isolatedWorkspace,
    verificationTimeoutSeconds
  );
  const completedAt = new Date().toISOString();

  const eventLines = (agyResult.events || []).map((event) =>
    sanitizeDiagnostic(JSON.stringify(event))
  );
  await writeFile(
    path.join(runDirectory, "events.jsonl"),
    eventLines.length ? `${eventLines.join("\n")}\n` : "",
    "utf8"
  );
  await writeFile(
    path.join(runDirectory, "response.md"),
    `${agyResult.response || ""}\n`,
    "utf8"
  );

  const metadata = {
    runId,
    status: agyResult.ok ? "completed" : "failed",
    startedAt,
    completedAt,
    source,
    isolatedWorkspace,
    task,
    conversationId: agyResult.conversationId || null,
    agyStatus: agyResult.status,
    response:
      agyResult.structuredOutput?.summary || agyResult.response || "",
    responseTruncated: agyResult.responseTruncated || false,
    durationSeconds: agyResult.durationSeconds ?? null,
    usage: agyResult.usage ?? null,
    error: agyResult.error || null,
    warnings: agyResult.warnings || [],
    appliedOperations,
    changes,
    verification: verificationResult,
    auditLog: path.join(runDirectory, "events.jsonl"),
    responseFile: path.join(runDirectory, "response.md")
  };
  await writeJson(path.join(runDirectory, "metadata.json"), metadata);
  await recordAgyCall(source, {
    event: "implementation",
    tool: "antigravity_execute",
    request: task,
    runId,
    result: {
      ...agyResult,
      response: metadata.response
    }
  });
  return metadata;
}

function validateRunId(runId) {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("Invalid run_id");
}

export async function listRuns(projectRootInput, limit = 20) {
  const projectRoot = await canonicalProjectRoot(projectRootInput);
  const runsRoot = getProjectRunsRoot(projectRoot);
  let entries;
  try {
    entries = await readdir(runsRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_ID_PATTERN.test(entry.name)) continue;
    try {
      const metadata = JSON.parse(
        await readFile(path.join(runsRoot, entry.name, "metadata.json"), "utf8")
      );
      runs.push({
        runId: metadata.runId,
        status: metadata.status,
        startedAt: metadata.startedAt,
        completedAt: metadata.completedAt || null,
        task: metadata.task,
        changedFiles: metadata.changes?.length ?? 0,
        verification: metadata.verification?.status || "not-run"
      });
    } catch {
      // Ignore incomplete or externally modified run directories.
    }
  }
  return runs
    .sort((left, right) => String(right.startedAt).localeCompare(String(left.startedAt)))
    .slice(0, limit);
}

export async function getRun(
  projectRootInput,
  runId,
  includeEvents = false,
  maxEvents = 100
) {
  const projectRoot = await canonicalProjectRoot(projectRootInput);
  validateRunId(runId);
  const runDirectory = path.join(getProjectRunsRoot(projectRoot), runId);
  const metadata = JSON.parse(
    await readFile(path.join(runDirectory, "metadata.json"), "utf8")
  );
  if (!includeEvents) return metadata;

  const rawEvents = await readFile(path.join(runDirectory, "events.jsonl"), "utf8");
  const lines = rawEvents.split(/\r?\n/).filter(Boolean);
  return {
    ...metadata,
    eventCount: lines.length,
    events: lines.slice(-maxEvents).map((line) => JSON.parse(line))
  };
}
