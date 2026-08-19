import { spawn } from "node:child_process";
import { stat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_AGY_BIN = "agy";

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const DEFAULT_RESPONSE_CHARS = 12_000;
const MAX_RESPONSE_CHARS = 50_000;

const SAFE_ENV_NAMES = new Set(
  [
    "ALL_PROXY",
    "APPDATA",
    "COMSPEC",
    "HOMEDRIVE",
    "HOMEPATH",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "LOGNAME",
    "NODE_EXTRA_CA_CERTS",
    "NO_PROXY",
    "PATH",
    "PATHEXT",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "SHELL",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SYSTEMDRIVE",
    "SYSTEMROOT",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "USER",
    "USERDOMAIN",
    "USERNAME",
    "USERPROFILE",
    "WINDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "XDG_STATE_HOME"
  ].map((name) => name.toUpperCase())
);

export function getAgyBin() {
  return process.env.AGY_BIN || DEFAULT_AGY_BIN;
}

export function isAgySandboxEnabled() {
  return /^(1|true|yes)$/i.test(process.env.ANTIGRAVITY_USE_SANDBOX || "");
}

export function getAllowedRootInputs() {
  const configured = process.env.ANTIGRAVITY_ALLOWED_ROOTS;
  if (!configured) return [process.cwd()];
  return configured
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeForComparison(value) {
  const normalized = path.resolve(value).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isPathWithin(candidate, root) {
  const normalizedCandidate = normalizeForComparison(candidate);
  const normalizedRoot = normalizeForComparison(root);
  if (normalizedCandidate === normalizedRoot) return true;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function resolveAllowedDirectory(
  requestedDirectory,
  allowedRootInputs = getAllowedRootInputs()
) {
  const candidateInput = requestedDirectory || process.cwd();
  const candidate = await realpath(path.resolve(candidateInput));
  const info = await stat(candidate);
  if (!info.isDirectory()) {
    throw new Error(`Working directory is not a directory: ${candidate}`);
  }

  const roots = [];
  for (const rootInput of allowedRootInputs) {
    roots.push(await realpath(path.resolve(rootInput)));
  }

  if (!roots.some((root) => isPathWithin(candidate, root))) {
    throw new Error(
      `Working directory is outside ANTIGRAVITY_ALLOWED_ROOTS: ${candidate}`
    );
  }
  return candidate;
}

export function buildSafeChildEnv() {
  const extraNames = new Set(
    (process.env.ANTIGRAVITY_PASSTHROUGH_ENV || "")
      .split(",")
      .map((name) => name.trim().toUpperCase())
      .filter(Boolean)
  );
  const childEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upperName = name.toUpperCase();
    if (SAFE_ENV_NAMES.has(upperName) || extraNames.has(upperName)) {
      childEnv[name] = value;
    }
  }
  if (process.platform !== "win32" && !childEnv.HOME) {
    childEnv.HOME = homedir();
  }
  return childEnv;
}

export function buildAgyArgs({
  prompt,
  conversationId,
  model,
  effort,
  timeoutSeconds = 300,
  sandbox = isAgySandboxEnabled(),
  mode = "plan",
  outputFormat = "json",
  disableSlashCommands = true,
  jsonSchema
}) {
  const args = [
    "-p",
    prompt,
    "--output-format",
    outputFormat,
    `--mode=${mode}`,
    "--print-timeout",
    `${timeoutSeconds}s`
  ];
  if (disableSlashCommands && mode !== "plan") {
    args.push("--disable-slash-commands");
  }
  if (sandbox) args.push("--sandbox");
  if (jsonSchema) args.push("--json-schema", JSON.stringify(jsonSchema));
  if (conversationId) args.push("--conversation", conversationId);
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  return args;
}

function appendLimited(chunks, chunk, state) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.bytes += buffer.length;
  if (state.bytes > MAX_CAPTURE_BYTES) {
    state.overflow = true;
    return;
  }
  chunks.push(buffer);
}

function truncateMiddle(text, maxChars) {
  if (text.length <= maxChars) {
    return { text, truncated: false, originalChars: text.length };
  }
  const marker = `\n\n...[truncated ${text.length - maxChars} characters]...\n\n`;
  const remaining = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(remaining * 0.67);
  const tail = remaining - head;
  return {
    text: `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`,
    truncated: true,
    originalChars: text.length
  };
}

export function parseAgyJson(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("Antigravity CLI returned empty stdout");
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch {
        // Keep scanning in case a diagnostic line preceded the JSON envelope.
      }
    }
    throw new Error(`Antigravity CLI returned invalid JSON: ${trimmed.slice(0, 500)}`);
  }
}

export function parseAgyStreamJson(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Non-JSON diagnostics are ignored here; stderr remains the diagnostic channel.
    }
  }
  const resultEvent = [...events].reverse().find((event) => event?.event === "result");
  if (!resultEvent?.result) {
    throw new Error("Antigravity CLI stream did not contain a terminal result event");
  }
  return { envelope: resultEvent.result, events };
}

export function sanitizeDiagnostic(text) {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED_TOKEN]");
}

export async function runAgy({
  prompt,
  workingDirectory,
  conversationId,
  model,
  effort,
  timeoutSeconds = 300,
  maxResponseChars = DEFAULT_RESPONSE_CHARS,
  mode = "plan",
  outputFormat = "json",
  sandbox = isAgySandboxEnabled(),
  extraEnv = {},
  jsonSchema,
  allowedRoots
}) {
  const cwd = await resolveAllowedDirectory(workingDirectory, allowedRoots);
  const binary = getAgyBin();
  const boundedResponseChars = Math.min(
    MAX_RESPONSE_CHARS,
    Math.max(1_000, maxResponseChars)
  );
  const args = buildAgyArgs({
    prompt,
    conversationId,
    model,
    effort,
    timeoutSeconds,
    mode,
    outputFormat,
    sandbox,
    jsonSchema
  });

  return await new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const stdoutState = { bytes: 0, overflow: false };
    const stderrState = { bytes: 0, overflow: false };
    let settled = false;

    const child = spawn(binary, args, {
      cwd,
      env: { ...buildSafeChildEnv(), ...extraEnv },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const hardTimeout = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      reject(new Error(`Antigravity CLI exceeded ${timeoutSeconds + 15}s hard timeout`));
    }, (timeoutSeconds + 15) * 1_000);

    child.stdout.on("data", (chunk) =>
      appendLimited(stdoutChunks, chunk, stdoutState)
    );
    child.stderr.on("data", (chunk) =>
      appendLimited(stderrChunks, chunk, stderrState)
    );
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      reject(new Error(`Failed to start Antigravity CLI at ${binary}: ${error.message}`));
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);

      if (stdoutState.overflow || stderrState.overflow) {
        reject(new Error("Antigravity CLI output exceeded the 4 MiB safety limit"));
        return;
      }

      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      let envelope;
      let events = [];
      try {
        if (outputFormat === "stream-json") {
          const parsed = parseAgyStreamJson(stdout);
          envelope = parsed.envelope;
          events = parsed.events;
        } else {
          envelope = parseAgyJson(stdout);
        }
      } catch (error) {
        reject(
          new Error(
            `${error.message}; exit=${exitCode}; signal=${signal || "none"}; stderr=${stderr.slice(0, 1000)}`
          )
        );
        return;
      }

      const response = truncateMiddle(
        typeof envelope.response === "string" ? envelope.response.trimEnd() : "",
        boundedResponseChars
      );
      resolve({
        ok: exitCode === 0 && envelope.status === "SUCCESS",
        exitCode,
        signal: signal || null,
        cwd,
        conversationId: envelope.conversation_id || null,
        status: envelope.status || "UNKNOWN",
        response: response.text,
        responseTruncated: response.truncated,
        responseOriginalChars: response.originalChars,
        durationSeconds: envelope.duration_seconds ?? null,
        numTurns: envelope.num_turns ?? null,
        usage: envelope.usage ?? null,
        structuredOutput: envelope.structured_output ?? null,
        error: envelope.error || null,
        warnings: stderr ? [sanitizeDiagnostic(stderr).slice(0, 4_000)] : [],
        events
      });
    });
  });
}

export async function getAgyHealth() {
  const binary = getAgyBin();
  const roots = [];
  if (process.env.ANTIGRAVITY_ALLOWED_ROOTS) {
    for (const rootInput of getAllowedRootInputs()) {
      roots.push(await realpath(path.resolve(rootInput)));
    }
  }

  const version = await new Promise((resolve, reject) => {
    const child = spawn(binary, ["--version"], {
      env: buildSafeChildEnv(),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(new Error(`agy --version failed (${code}): ${diagnostic}`));
      } else {
        resolve(output);
      }
    });
  });

  return {
    binary,
    version,
    staticAllowedRoots: roots,
    dynamicProjectAuthorization: true,
    mode: "plan",
    sandbox: isAgySandboxEnabled()
  };
}
