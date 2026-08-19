import { randomUUID } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const PROJECT_DIR = ".antigravity-mcp";
const PROJECT_FILE = "project.json";
const SESSIONS_FILE = "sessions.jsonl";
const STATE_SCHEMA_VERSION = 2;
const MCP_VERSION = "0.3.0";

function normalizeForComparison(value) {
  const normalized = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left, right) {
  return normalizeForComparison(left) === normalizeForComparison(right);
}

function permissionTarget(projectRoot) {
  return projectRoot.replace(/\\/g, "/");
}

export function readRuleFor(projectRoot) {
  return `read_file(${permissionTarget(projectRoot)})`;
}

export function getAntigravitySettingsPath() {
  return (
    process.env.ANTIGRAVITY_SETTINGS_PATH ||
    path.join(homedir(), ".gemini", "antigravity-cli", "settings.json")
  );
}

export function getProjectStateDirectory(projectRoot) {
  return path.join(projectRoot, PROJECT_DIR);
}

export function getProjectRunsRoot(projectRoot) {
  return path.join(getProjectStateDirectory(projectRoot), "runs");
}

export async function ensureProjectIgnoreRules(projectRootInput) {
  const projectRoot = await canonicalProjectRoot(projectRootInput);
  const stateDir = getProjectStateDirectory(projectRoot);
  await mkdir(stateDir, { recursive: true });
  const ignorePath = path.join(stateDir, ".gitignore");
  const ignoreContent = await readFile(ignorePath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  const ignoreLines = ignoreContent.split(/\r?\n/).filter(Boolean);
  let changed = false;
  for (const rule of ["runs/", "transcripts/", "*.tmp-*"]) {
    if (!ignoreLines.includes(rule)) {
      ignoreLines.push(rule);
      changed = true;
    }
  }
  if (changed || !ignoreContent) {
    await writeFile(ignorePath, `${ignoreLines.join("\n")}\n`, "utf8");
  }
  return ignorePath;
}

function projectStatePath(projectRoot) {
  return path.join(getProjectStateDirectory(projectRoot), PROJECT_FILE);
}

function projectSessionsPath(projectRoot) {
  return path.join(getProjectStateDirectory(projectRoot), SESSIONS_FILE);
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function canonicalProjectRoot(input) {
  if (!input || typeof input !== "string") {
    throw new Error("project_root is required");
  }
  const canonical = await realpath(path.resolve(input));
  const info = await stat(canonical);
  if (!info.isDirectory()) throw new Error(`Project root is not a directory: ${canonical}`);

  const broadRoots = [
    path.parse(canonical).root,
    homedir(),
    process.env.SYSTEMROOT,
    process.env.WINDIR,
    process.env.PROGRAMFILES,
    process.env["PROGRAMFILES(X86)"],
    process.env.PROGRAMDATA,
    process.env.LOCALAPPDATA,
    process.env.APPDATA
  ].filter(Boolean);
  if (broadRoots.some((root) => samePath(canonical, root))) {
    throw new Error(`Refusing broad or system project root: ${canonical}`);
  }
  return canonical;
}

async function readJson(filePath, ...fallbackValue) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" && fallbackValue.length > 0) {
      return fallbackValue[0];
    }
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const content = `${JSON.stringify(value, null, 2)}\n`;
  JSON.parse(content);
  await writeFile(temporary, content, "utf8");
  await rename(temporary, filePath);
}

async function acquireSettingsLock(settingsPath) {
  const lockPath = `${settingsPath}.agy-mcp.lock`;
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      return { handle, lockPath };
    } catch (error) {
      if (error?.code !== "EEXIST" || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function updateAntigravitySettings(mutator) {
  const settingsPath = getAntigravitySettingsPath();
  await mkdir(path.dirname(settingsPath), { recursive: true });
  const lock = await acquireSettingsLock(settingsPath);
  try {
    const settings = await readJson(settingsPath, {});
    const next = mutator(structuredClone(settings));
    if (await pathExists(settingsPath)) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      await copyFile(settingsPath, `${settingsPath}.agy-mcp-backup-${stamp}`);
    }
    await writeJsonAtomic(settingsPath, next);
    return next;
  } finally {
    await lock.handle.close();
    await unlink(lock.lockPath).catch(() => {});
  }
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function addUniquePath(items, candidate) {
  return [...items.filter((item) => !samePath(item, candidate)), candidate];
}

function addUniqueString(items, candidate) {
  const lowered = candidate.toLowerCase();
  return [...items.filter((item) => String(item).toLowerCase() !== lowered), candidate];
}

function removeExactPath(items, candidate) {
  return items.filter((item) => !samePath(item, candidate));
}

function removeExactString(items, candidate) {
  const lowered = candidate.toLowerCase();
  return items.filter((item) => String(item).toLowerCase() !== lowered);
}

export async function readProjectState(projectRootInput) {
  const projectRoot = await canonicalProjectRoot(projectRootInput);
  return await readJson(projectStatePath(projectRoot), null);
}

async function saveProjectState(projectRoot, state) {
  await writeJsonAtomic(projectStatePath(projectRoot), state);
  return state;
}

async function readSettingsStatus(projectRoot) {
  const settings = await readJson(getAntigravitySettingsPath(), {});
  const trusted = ensureArray(settings.trustedWorkspaces).some((item) =>
    samePath(item, projectRoot)
  );
  const rule = readRuleFor(projectRoot);
  const permission = ensureArray(settings.permissions?.allow).some(
    (item) => String(item).toLowerCase() === rule.toLowerCase()
  );
  return { trusted, permission };
}

export async function enableProject(projectRootInput) {
  const projectRoot = await canonicalProjectRoot(projectRootInput);
  const stateDir = getProjectStateDirectory(projectRoot);
  await mkdir(getProjectRunsRoot(projectRoot), { recursive: true });
  if (!(await pathExists(projectSessionsPath(projectRoot)))) {
    await appendFile(projectSessionsPath(projectRoot), "", "utf8");
  }
  await ensureProjectIgnoreRules(projectRoot);

  await updateAntigravitySettings((settings) => {
    settings.trustedWorkspaces = addUniquePath(
      ensureArray(settings.trustedWorkspaces),
      projectRoot
    );
    settings.permissions = settings.permissions || {};
    settings.permissions.allow = addUniqueString(
      ensureArray(settings.permissions.allow),
      readRuleFor(projectRoot)
    );
    return settings;
  });

  const existing = await readJson(projectStatePath(projectRoot), {});
  const now = new Date().toISOString();
  const state = {
    schemaVersion: STATE_SCHEMA_VERSION,
    projectRoot,
    enabled: true,
    activeConversationId: existing.activeConversationId || null,
    initializedAt: existing.initializedAt || now,
    lastUsedAt: existing.lastUsedAt || null,
    mcpVersion: MCP_VERSION
  };
  await saveProjectState(projectRoot, state);
  return await projectStatus(projectRoot);
}

export async function disableProject(projectRootInput) {
  const projectRoot = await canonicalProjectRoot(projectRootInput);
  await updateAntigravitySettings((settings) => {
    settings.trustedWorkspaces = removeExactPath(
      ensureArray(settings.trustedWorkspaces),
      projectRoot
    );
    settings.permissions = settings.permissions || {};
    settings.permissions.allow = removeExactString(
      ensureArray(settings.permissions.allow),
      readRuleFor(projectRoot)
    );
    return settings;
  });

  const existing = await readJson(projectStatePath(projectRoot), {
    schemaVersion: STATE_SCHEMA_VERSION,
    projectRoot,
    initializedAt: null,
    activeConversationId: null
  });
  existing.enabled = false;
  existing.disabledAt = new Date().toISOString();
  await saveProjectState(projectRoot, existing);
  return await projectStatus(projectRoot);
}

export async function projectStatus(projectRootInput) {
  const projectRoot = await canonicalProjectRoot(projectRootInput);
  const state = await readJson(projectStatePath(projectRoot), null);
  const settings = await readSettingsStatus(projectRoot);
  return {
    projectRoot,
    initialized: Boolean(state),
    enabled: Boolean(state?.enabled && settings.trusted && settings.permission),
    stateEnabled: Boolean(state?.enabled),
    trustedWorkspace: settings.trusted,
    readPermission: settings.permission,
    activeConversationId: state?.activeConversationId || null,
    initializedAt: state?.initializedAt || null,
    lastUsedAt: state?.lastUsedAt || null,
    stateDirectory: getProjectStateDirectory(projectRoot)
  };
}

export async function requireEnabledProject(projectRootInput) {
  const status = await projectStatus(projectRootInput);
  if (!status.enabled) {
    throw new Error(
      `AGY is not enabled for ${status.projectRoot}. The user must explicitly request AGY, then call antigravity_enable_project.`
    );
  }
  return status.projectRoot;
}

export async function appendSessionEvent(projectRootInput, event) {
  const projectRoot = await canonicalProjectRoot(projectRootInput);
  await mkdir(getProjectStateDirectory(projectRoot), { recursive: true });
  const record = {
    timestamp: new Date().toISOString(),
    projectRoot,
    ...event
  };
  await appendFile(
    projectSessionsPath(projectRoot),
    `${JSON.stringify(record)}\n`,
    "utf8"
  );
  return record;
}

export async function setActiveConversation(projectRootInput, conversationId) {
  const projectRoot = await requireEnabledProject(projectRootInput);
  const state = await readJson(projectStatePath(projectRoot), null);
  state.activeConversationId = conversationId || null;
  state.lastUsedAt = new Date().toISOString();
  await saveProjectState(projectRoot, state);
  return state;
}

export async function getActiveSession(projectRootInput) {
  const status = await projectStatus(projectRootInput);
  return {
    projectRoot: status.projectRoot,
    enabled: status.enabled,
    conversationId: status.activeConversationId
  };
}

export async function listSessionEvents(projectRootInput, limit = 50) {
  const projectRoot = await canonicalProjectRoot(projectRootInput);
  try {
    const raw = await readFile(projectSessionsPath(projectRoot), "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .slice(-limit);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export async function recordAgyCall(projectRootInput, details) {
  const projectRoot = await requireEnabledProject(projectRootInput);
  const conversationId = details.result?.conversationId || details.conversationId || null;
  if (conversationId) await setActiveConversation(projectRoot, conversationId);
  return await appendSessionEvent(projectRoot, {
    event: details.event || "delegated",
    tool: details.tool,
    conversationId,
    runId: details.runId || null,
    request: String(details.request || "").slice(0, 30_000),
    response: String(details.result?.response || "").slice(0, 4_000),
    status: details.result?.status || null,
    usage: details.result?.usage || null
  });
}
