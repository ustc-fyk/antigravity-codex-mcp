import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  ensureProjectIgnoreRules,
  getActiveSession,
  getProjectStateDirectory,
  listSessionEvents,
  requireEnabledProject
} from "./projects.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRIVATE_FIELD_NAMES = new Set([
  "thinking",
  "thought",
  "thoughts",
  "reasoning",
  "thinkingmetadata",
  "thoughtsignature"
]);
const EXCLUDED_RECORD_TYPES = new Set([
  "SYSTEM_MESSAGE",
  "CHECKPOINT",
  "THINKING",
  "REASONING"
]);

function normalizePrivateFieldName(name) {
  return String(name).replace(/[_-]/g, "").toLowerCase();
}

function stripPrivateFields(value) {
  if (Array.isArray(value)) return value.map(stripPrivateFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !PRIVATE_FIELD_NAMES.has(normalizePrivateFieldName(key)))
      .map(([key, nested]) => [key, stripPrivateFields(nested)])
  );
}

function stableRecordId(record) {
  return createHash("sha256")
    .update(JSON.stringify(record))
    .digest("hex")
    .slice(0, 24);
}

function normalizeBase(record) {
  return {
    stepIndex: Number.isInteger(record.step_index) ? record.step_index : null,
    createdAt:
      typeof record.created_at === "string" || typeof record.created_at === "number"
        ? record.created_at
        : null,
    type: typeof record.type === "string" ? record.type : null,
    status: typeof record.status === "string" ? record.status : null
  };
}

function withId(record) {
  return { id: stableRecordId(record), ...record };
}

export function filterTranscriptRecord(record, codexRequests = []) {
  if (!record || typeof record !== "object") return [];
  const source = String(record.source || "").toUpperCase();
  const type = String(record.type || "").toUpperCase();
  const content = typeof record.content === "string" ? record.content : "";
  const base = normalizeBase(record);
  const visible = [];

  if (source === "USER_EXPLICIT" && type === "USER_INPUT" && content) {
    const origin = codexRequests.some(
      (request) => typeof request === "string" && request && content.includes(request)
    )
      ? "codex_mcp"
      : "agy_cli";
    visible.push(withId({ ...base, role: "user", origin, content }));
  }

  if (source === "MODEL" && content && !EXCLUDED_RECORD_TYPES.has(type)) {
    visible.push(
      withId({ ...base, role: "assistant", origin: "antigravity", content })
    );
  }

  if (
    source === "MODEL" &&
    !EXCLUDED_RECORD_TYPES.has(type) &&
    Array.isArray(record.tool_calls) &&
    record.tool_calls.length
  ) {
    visible.push(
      withId({
        ...base,
        role: "tool_trace",
        origin: "antigravity_tool",
        toolCalls: stripPrivateFields(record.tool_calls)
      })
    );
  }

  return visible;
}

export function getAgyTranscriptPath(conversationId) {
  if (!UUID_PATTERN.test(String(conversationId || ""))) {
    throw new Error("conversation_id must be a UUID");
  }
  const cliDataRoot =
    process.env.ANTIGRAVITY_CLI_DATA_DIR ||
    path.join(homedir(), ".gemini", "antigravity-cli");
  return path.join(
    cliDataRoot,
    "brain",
    conversationId,
    ".system_generated",
    "logs",
    "transcript.jsonl"
  );
}

export function getProjectTranscriptPath(projectRoot, conversationId) {
  if (!UUID_PATTERN.test(String(conversationId || ""))) {
    throw new Error("conversation_id must be a UUID");
  }
  return path.join(
    getProjectStateDirectory(projectRoot),
    "transcripts",
    `${conversationId}.jsonl`
  );
}

async function readJsonLines(filePath, { missingIsEmpty = false } = {}) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (missingIsEmpty && error?.code === "ENOENT") return { records: [], malformed: 0 };
    if (error?.code === "ENOENT") {
      throw new Error(`Antigravity transcript not found: ${filePath}`);
    }
    throw error;
  }

  const records = [];
  let malformed = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
}

async function verifyConversationOwnership(projectRoot, conversationId) {
  const active = await getActiveSession(projectRoot);
  if (active.conversationId === conversationId) return;
  const events = await listSessionEvents(projectRoot, 100_000);
  if (events.some((event) => event.conversationId === conversationId)) return;
  throw new Error(
    `Conversation ${conversationId} is not registered to project ${projectRoot}`
  );
}

async function resolveConversation(projectRoot, conversationId) {
  const active = await getActiveSession(projectRoot);
  const selected = conversationId || active.conversationId;
  if (!selected) {
    throw new Error("No active AGY conversation; start a session or provide conversation_id");
  }
  if (!UUID_PATTERN.test(selected)) throw new Error("conversation_id must be a UUID");
  await verifyConversationOwnership(projectRoot, selected);
  return selected;
}

async function writeJsonLinesAtomic(filePath, records) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  const content = records.length
    ? `${records.map((record) => JSON.stringify(record)).join("\n")}\n`
    : "";
  await writeFile(temporary, content, "utf8");
  await rename(temporary, filePath);
}

function boundRecords(records, maxRecords, maxChars) {
  const selected = records.slice(-maxRecords);
  const output = [];
  let used = 0;
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const record = selected[index];
    const serialized = JSON.stringify(record);
    if (used + serialized.length <= maxChars) {
      output.unshift(record);
      used += serialized.length;
      continue;
    }
    if (!output.length && typeof record.content === "string") {
      const allowance = Math.max(0, maxChars - 500);
      output.unshift({
        ...record,
        content: record.content.slice(-allowance),
        responseViewTruncated: true
      });
    }
    break;
  }
  return output;
}

export async function syncConversationTranscript({
  projectRoot: projectRootInput,
  conversationId,
  includeAll = false,
  maxRecords = 100,
  maxChars = 50_000
}) {
  const projectRoot = await requireEnabledProject(projectRootInput);
  const selected = await resolveConversation(projectRoot, conversationId);
  const events = await listSessionEvents(projectRoot, 100_000);
  const codexRequests = events
    .filter((event) => event.conversationId === selected)
    .map((event) => event.request)
    .filter((request) => typeof request === "string" && request);

  const sourcePath = getAgyTranscriptPath(selected);
  const source = await readJsonLines(sourcePath);
  const filtered = source.records.flatMap((record) =>
    filterTranscriptRecord(record, codexRequests)
  );

  const mirrorPath = getProjectTranscriptPath(projectRoot, selected);
  await ensureProjectIgnoreRules(projectRoot);
  const existing = await readJsonLines(mirrorPath, { missingIsEmpty: true });
  const merged = [];
  const seen = new Set();
  for (const record of [...existing.records, ...filtered]) {
    const sanitized = stripPrivateFields(record);
    const id = sanitized.id || stableRecordId(sanitized);
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push({ ...sanitized, id });
  }
  const existingIds = new Set(existing.records.map((record) => record.id));
  const added = merged.filter((record) => !existingIds.has(record.id));
  await writeJsonLinesAtomic(mirrorPath, merged);

  const candidates = includeAll ? merged : added;
  return {
    ok: true,
    projectRoot,
    conversationId: selected,
    sourcePath,
    mirrorPath,
    sourceRecordCount: source.records.length,
    visibleRecordCount: merged.length,
    newRecordCount: added.length,
    malformedSourceLines: source.malformed,
    filteredFields: ["thinking", "thoughts", "reasoning", "system", "checkpoint"],
    records: boundRecords(candidates, maxRecords, maxChars)
  };
}

export async function getConversationTranscript({
  projectRoot,
  conversationId,
  maxRecords = 200,
  maxChars = 100_000,
  sync = true
}) {
  if (sync) {
    return await syncConversationTranscript({
      projectRoot,
      conversationId,
      includeAll: true,
      maxRecords,
      maxChars
    });
  }
  const root = await requireEnabledProject(projectRoot);
  const selected = await resolveConversation(root, conversationId);
  const mirrorPath = getProjectTranscriptPath(root, selected);
  const mirror = await readJsonLines(mirrorPath, { missingIsEmpty: true });
  return {
    ok: true,
    projectRoot: root,
    conversationId: selected,
    mirrorPath,
    visibleRecordCount: mirror.records.length,
    newRecordCount: 0,
    records: boundRecords(mirror.records.map(stripPrivateFields), maxRecords, maxChars)
  };
}
