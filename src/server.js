import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";

import { getAgyHealth, runAgy } from "./agy.js";
import { executeIsolated, getRun, listRuns } from "./execution.js";
import {
  disableProject,
  enableProject,
  getActiveSession,
  listSessionEvents,
  projectStatus,
  recordAgyCall,
  requireEnabledProject
} from "./projects.js";
import {
  getConversationTranscript,
  syncConversationTranscript
} from "./transcripts.js";

const BRIDGE_VERSION = "0.3.0";

const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "conversation_id must be a UUID"
  );

const projectRootSchema = z
  .string()
  .min(1)
  .describe("Absolute root directory of the current Codex project.");

const sharedModelInput = {
  model: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/)
    .max(100)
    .optional()
    .describe("Optional Antigravity model slug; omit to use the account default."),
  effort: z.enum(["low", "medium", "high"]).optional(),
  timeout_seconds: z.number().int().min(10).max(1800).default(300),
  max_response_chars: z.number().int().min(1000).max(50000).default(12000)
};

const READ_ONLY_PREFIX = [
  "You are a delegated read-only analysis worker reporting to Codex.",
  "Do not modify, create, rename, or delete files. Do not run state-changing commands.",
  "Inspect only what is necessary. Put conclusions and actionable findings first.",
  "Be concise because your answer is returned through an MCP tool."
].join(" ");

function toolResult(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: result?.ok === false
  };
}

function errorResult(error) {
  return {
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error)
      }
    ],
    isError: true
  };
}

async function runReadOnly({
  projectRoot,
  prompt,
  conversationId,
  model,
  effort,
  timeoutSeconds,
  maxResponseChars
}) {
  const root = await requireEnabledProject(projectRoot);
  return await runAgy({
    prompt,
    workingDirectory: root,
    conversationId,
    model,
    effort,
    timeoutSeconds,
    maxResponseChars,
    mode: "plan",
    allowedRoots: [root]
  });
}

async function bestEffortTranscriptSync(projectRoot, conversationId, includeAll = false) {
  try {
    return await syncConversationTranscript({
      projectRoot,
      conversationId,
      includeAll,
      maxRecords: 100,
      maxChars: 50_000
    });
  } catch (error) {
    return {
      ok: false,
      conversationId: conversationId || null,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

const activeExecutions = new Set();

export function createServer() {
  const server = new McpServer(
    { name: "antigravity-codex-mcp", version: BRIDGE_VERSION },
    {
      instructions:
        "Never enable or call Antigravity unless the user explicitly asks to load, use, or get help from AGY/Antigravity. The server is globally available but idle by default. On explicit request, use antigravity_project_status for the current project root, then antigravity_enable_project if needed, then start or reuse that project's active AGY conversation. Always report project_root, conversation_id, and run_id. Use read-only analysis by default; implementation must use antigravity_execute and remain isolated from source."
    }
  );

  server.registerTool(
    "antigravity_health",
    {
      title: "Check Antigravity bridge",
      description:
        "Check the configured agy binary and bridge version without enabling a project or consuming a model turn.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => {
      try {
        return toolResult({ ok: true, ...(await getAgyHealth()), bridgeVersion: BRIDGE_VERSION });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "antigravity_project_status",
    {
      title: "Check AGY project status",
      description:
        "Check whether one exact project root is initialized, trusted, read-authorized, and linked to an active AGY conversation. Does not call a model.",
      inputSchema: z.object({ project_root: projectRootSchema }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ project_root }) => {
      try {
        return toolResult({ ok: true, ...(await projectStatus(project_root)) });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "antigravity_enable_project",
    {
      title: "Enable AGY for one project",
      description:
        "Initialize .antigravity-mcp in one exact project root and atomically add only that root to Antigravity trustedWorkspaces and read_file allow rules. Call only after the user explicitly requests AGY. Does not call a model.",
      inputSchema: z.object({ project_root: projectRootSchema }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ project_root }) => {
      try {
        return toolResult({ ok: true, ...(await enableProject(project_root)) });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "antigravity_disable_project",
    {
      title: "Disable AGY for one project",
      description:
        "Remove only one project's exact Antigravity trusted workspace and read_file rule, mark it disabled, and preserve all local session and run history.",
      inputSchema: z.object({ project_root: projectRootSchema }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ project_root }) => {
      try {
        return toolResult({ ok: true, ...(await disableProject(project_root)) });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "antigravity_start_session",
    {
      title: "Start a project AGY session",
      description:
        "Create a new AGY conversation for an enabled project, save it as active, and return its conversation ID. Consumes one Antigravity model turn.",
      inputSchema: z.object({
        project_root: projectRootSchema,
        prompt: z
          .string()
          .max(30000)
          .default("Register this project conversation and reply exactly: AGY_PROJECT_READY"),
        ...sharedModelInput
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ project_root, prompt, model, effort, timeout_seconds, max_response_chars }) => {
      try {
        const result = await runReadOnly({
          projectRoot: project_root,
          prompt: `${READ_ONLY_PREFIX}\n\nProject session initialization:\n${prompt}`,
          model,
          effort,
          timeoutSeconds: timeout_seconds,
          maxResponseChars: max_response_chars
        });
        await recordAgyCall(project_root, {
          event: "session_started",
          tool: "antigravity_start_session",
          request: prompt,
          result
        });
        const after = await bestEffortTranscriptSync(
          project_root,
          result.conversationId
        );
        return toolResult({ ...result, transcriptSync: { after } });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "antigravity_get_active_session",
    {
      title: "Get active project AGY session",
      description:
        "Return the active AGY conversation ID for a project without calling a model.",
      inputSchema: z.object({ project_root: projectRootSchema }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ project_root }) => {
      try {
        return toolResult({ ok: true, ...(await getActiveSession(project_root)) });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "antigravity_list_sessions",
    {
      title: "List project AGY session events",
      description:
        "List recent persisted AGY delegation and conversation events for one project without calling a model.",
      inputSchema: z.object({
        project_root: projectRootSchema,
        limit: z.number().int().min(1).max(500).default(50)
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ project_root, limit }) => {
      try {
        const sessions = await listSessionEvents(project_root, limit);
        return toolResult({ ok: true, projectRoot: project_root, sessions });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "antigravity_sync_conversation",
    {
      title: "Sync an AGY conversation",
      description:
        "Read the official AGY transcript for a conversation registered to this project, filter internal thinking/system/checkpoint records, and update the project-local visible transcript mirror. Does not call a model.",
      inputSchema: z.object({
        project_root: projectRootSchema,
        conversation_id: uuidSchema.optional(),
        include_all: z.boolean().default(false),
        max_records: z.number().int().min(1).max(1000).default(100),
        max_chars: z.number().int().min(1000).max(500000).default(50000)
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ project_root, conversation_id, include_all, max_records, max_chars }) => {
      try {
        return toolResult(
          await syncConversationTranscript({
            projectRoot: project_root,
            conversationId: conversation_id,
            includeAll: include_all,
            maxRecords: max_records,
            maxChars: max_chars
          })
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "antigravity_get_transcript",
    {
      title: "Read a visible AGY transcript",
      description:
        "Refresh and return the bounded project-local user/assistant/tool transcript for a registered AGY conversation. Internal thinking, system messages, and checkpoints are never returned.",
      inputSchema: z.object({
        project_root: projectRootSchema,
        conversation_id: uuidSchema.optional(),
        refresh: z.boolean().default(true),
        max_records: z.number().int().min(1).max(1000).default(200),
        max_chars: z.number().int().min(1000).max(500000).default(100000)
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ project_root, conversation_id, refresh, max_records, max_chars }) => {
      try {
        return toolResult(
          await getConversationTranscript({
            projectRoot: project_root,
            conversationId: conversation_id,
            sync: refresh,
            maxRecords: max_records,
            maxChars: max_chars
          })
        );
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "antigravity_ask",
    {
      title: "Delegate a new analysis to Antigravity",
      description:
        "Start a new read-only AGY analysis conversation for an enabled project and persist it as active.",
      inputSchema: z.object({
        project_root: projectRootSchema,
        prompt: z.string().min(1).max(30000),
        ...sharedModelInput
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ project_root, prompt, model, effort, timeout_seconds, max_response_chars }) => {
      try {
        const result = await runReadOnly({
          projectRoot: project_root,
          prompt: `${READ_ONLY_PREFIX}\n\nTask:\n${prompt}`,
          model,
          effort,
          timeoutSeconds: timeout_seconds,
          maxResponseChars: max_response_chars
        });
        await recordAgyCall(project_root, {
          tool: "antigravity_ask",
          request: prompt,
          result
        });
        const after = await bestEffortTranscriptSync(
          project_root,
          result.conversationId
        );
        return toolResult({ ...result, transcriptSync: { after } });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "antigravity_continue",
    {
      title: "Continue a project AGY conversation",
      description:
        "Continue a specified conversation or the project's active AGY conversation and persist the result.",
      inputSchema: z.object({
        project_root: projectRootSchema,
        conversation_id: uuidSchema.optional(),
        prompt: z.string().min(1).max(30000),
        ...sharedModelInput
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true
      }
    },
    async ({ project_root, conversation_id, prompt, model, effort, timeout_seconds, max_response_chars }) => {
      try {
        const active = await getActiveSession(project_root);
        const selected = conversation_id || active.conversationId;
        if (!selected) {
          throw new Error("No active AGY conversation; start a session or use antigravity_ask");
        }
        const before = await bestEffortTranscriptSync(project_root, selected);
        const result = await runReadOnly({
          projectRoot: project_root,
          conversationId: selected,
          prompt: `${READ_ONLY_PREFIX}\n\nFollow-up task:\n${prompt}`,
          model,
          effort,
          timeoutSeconds: timeout_seconds,
          maxResponseChars: max_response_chars
        });
        await recordAgyCall(project_root, {
          event: "continued",
          tool: "antigravity_continue",
          conversationId: selected,
          request: prompt,
          result
        });
        const after = await bestEffortTranscriptSync(
          project_root,
          result.conversationId || selected
        );
        return toolResult({ ...result, transcriptSync: { before, after } });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "antigravity_review",
    {
      title: "Request an independent Antigravity review",
      description:
        "Start a read-only evidence-oriented review for an enabled project and persist the conversation.",
      inputSchema: z.object({
        project_root: projectRootSchema,
        target: z.string().min(1).max(10000),
        focus: z.string().max(10000).optional(),
        ...sharedModelInput
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ project_root, target, focus, model, effort, timeout_seconds, max_response_chars }) => {
      try {
        const prompt = [
          READ_ONLY_PREFIX,
          "Review independently. Prioritize correctness, regressions, security, and missing tests.",
          "Cite file paths and line numbers when available. Separate findings from uncertainty.",
          `Target:\n${target}`,
          focus ? `Additional focus:\n${focus}` : ""
        ]
          .filter(Boolean)
          .join("\n\n");
        const result = await runReadOnly({
          projectRoot: project_root,
          prompt,
          model,
          effort,
          timeoutSeconds: timeout_seconds,
          maxResponseChars: max_response_chars
        });
        await recordAgyCall(project_root, {
          event: "reviewed",
          tool: "antigravity_review",
          request: `${target}\n${focus || ""}`,
          result
        });
        const after = await bestEffortTranscriptSync(
          project_root,
          result.conversationId
        );
        return toolResult({ ...result, transcriptSync: { after } });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "antigravity_execute",
    {
      title: "Execute a task in an isolated AGY workspace",
      description:
        "For an enabled project, ask AGY for schema-validated file replacements, apply only validated paths to a disposable copy, optionally run one fixed verification, and never merge into source.",
      inputSchema: z.object({
        project_root: projectRootSchema,
        task: z.string().min(1).max(30000),
        model: sharedModelInput.model,
        effort: sharedModelInput.effort,
        timeout_seconds: z.number().int().min(30).max(1800).default(600),
        max_response_chars: sharedModelInput.max_response_chars,
        verification: z
          .enum(["none", "npm-test", "pytest", "cargo-test", "go-test", "dotnet-test"])
          .default("none"),
        verification_timeout_seconds: z.number().int().min(10).max(900).default(300)
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false
      }
    },
    async ({ project_root, task, model, effort, timeout_seconds, max_response_chars, verification, verification_timeout_seconds }) => {
      let root;
      try {
        root = await requireEnabledProject(project_root);
        if (activeExecutions.has(root)) {
          throw new Error("Another antigravity_execute task is active for this project");
        }
        activeExecutions.add(root);
        const result = await executeIsolated({
          task,
          projectRoot: root,
          model,
          effort,
          timeoutSeconds: timeout_seconds,
          maxResponseChars: max_response_chars,
          verification,
          verificationTimeoutSeconds: verification_timeout_seconds
        });
        const after = await bestEffortTranscriptSync(
          root,
          result.conversationId
        );
        return toolResult({
          ...result,
          ok: result.status === "completed",
          transcriptSync: { after }
        });
      } catch (error) {
        return errorResult(error);
      } finally {
        if (root) activeExecutions.delete(root);
      }
    }
  );

  server.registerTool(
    "antigravity_list_runs",
    {
      title: "List isolated AGY runs",
      description: "List recent isolated execution runs for one project.",
      inputSchema: z.object({
        project_root: projectRootSchema,
        limit: z.number().int().min(1).max(100).default(20)
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ project_root, limit }) => {
      try {
        const runs = await listRuns(project_root, limit);
        return toolResult({ ok: true, projectRoot: project_root, runs });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "antigravity_get_run",
    {
      title: "Inspect an isolated AGY run",
      description:
        "Read one project's run response, token usage, verification output, changed-file manifest, and optional external events.",
      inputSchema: z.object({
        project_root: projectRootSchema,
        run_id: z.string().regex(/^\d{8}T\d{6}Z-[0-9a-f]{8}$/),
        include_events: z.boolean().default(false),
        max_events: z.number().int().min(1).max(500).default(100)
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ project_root, run_id, include_events, max_events }) => {
      try {
        const run = await getRun(project_root, run_id, include_events, max_events);
        return toolResult({ ok: true, ...run });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  return server;
}
