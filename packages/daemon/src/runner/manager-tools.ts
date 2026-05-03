import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_MANAGER_LIMITS, type ChildEvent, type DiffBase, type DiffFileEntry, type ManagerToolResult } from "@helm/core";
import type { ManagerChatTool } from "./openrouter";
import type { ManagerToolContext } from "./manager-context";

const MAX_FILE_BYTES = 256 * 1024;
const MAX_PATCH_BYTES = 64 * 1024;

export type ManagerToolExecution = ManagerToolResult & {
  childEvents?: ChildEvent[];
};

export type ManagerToolDefinition = {
  schema: ManagerChatTool;
  execute(args: Record<string, unknown>, ctx: ManagerToolContext): Promise<ManagerToolExecution>;
};

export const managerTools: ManagerToolDefinition[] = [
  {
    schema: toolSchema("create_child_session", "Create a child coding session.", {
      type: "object",
      additionalProperties: false,
      required: ["repo", "agent", "prompt"],
      properties: {
        repo: { type: "string" },
        agent: { type: "string" },
        prompt: { type: "string" }
      }
    }),
    execute: createChildSession
  },
  {
    schema: toolSchema("create_child_from_session", "Create a child coding session from another child session's current branch HEAD.", {
      type: "object",
      additionalProperties: false,
      required: ["sourceSessionId", "agent", "prompt"],
      properties: {
        sourceSessionId: { type: "string" },
        agent: { type: "string" },
        prompt: { type: "string" },
        branchName: { type: "string" }
      }
    }),
    execute: createChildFromSession
  },
  {
    schema: toolSchema("create_child_from_branch", "Create a child coding session from a named local branch or ref.", {
      type: "object",
      additionalProperties: false,
      required: ["repo", "agent", "branch", "prompt"],
      properties: {
        repo: { type: "string" },
        agent: { type: "string" },
        branch: { type: "string" },
        prompt: { type: "string" },
        branchName: { type: "string" }
      }
    }),
    execute: createChildFromBranch
  },
  {
    schema: toolSchema("send_message", "Send a user message to a child session.", {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "text"],
      properties: {
        sessionId: { type: "string" },
        text: { type: "string" }
      }
    }),
    execute: sendMessage
  },
  {
    schema: toolSchema("stop_child", "Stop a child session.", {
      type: "object",
      additionalProperties: false,
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" }
      }
    }),
    execute: stopChild
  },
  {
    schema: toolSchema("read_file", "Read a UTF-8 file from a child session worktree.", {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "path"],
      properties: {
        sessionId: { type: "string" },
        path: { type: "string" }
      }
    }),
    execute: readChildFile
  },
  {
    schema: toolSchema("pass_file_content", "Send one child worktree file to another child session without exposing the content to the manager LLM.", {
      type: "object",
      additionalProperties: false,
      required: ["fromSessionId", "path", "toSessionId"],
      properties: {
        fromSessionId: { type: "string" },
        path: { type: "string" },
        toSessionId: { type: "string" },
        header: { type: "string" }
      }
    }),
    execute: passFileContent
  },
  {
    schema: toolSchema("read_diff", "Read a compact structured diff for a child session.", {
      type: "object",
      additionalProperties: false,
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string" },
        base: { type: "string", enum: ["branch", "uncommitted"] }
      }
    }),
    execute: readDiff
  }
];

/** Executes one manager tool by name. */
export async function executeManagerTool(name: string, args: Record<string, unknown>, ctx: ManagerToolContext): Promise<ManagerToolExecution> {
  const tool = managerTools.find((entry) => entry.schema.function.name === name);
  if (!tool) {
    return { ok: false, errorMessage: "unknown_tool" };
  }
  try {
    return await tool.execute(args, ctx);
  } catch (error) {
    return { ok: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

/** Returns manager tool schemas for OpenAI-compatible calls. */
export function managerToolSchemas(): ManagerChatTool[] {
  return managerTools.map((tool) => tool.schema);
}

/** Builds one OpenAI-compatible tool schema. */
function toolSchema(name: string, description: string, parameters: Record<string, unknown>): ManagerChatTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters
    }
  };
}

/** Creates a manager-owned child session. */
async function createChildSession(args: Record<string, unknown>, ctx: ManagerToolContext): Promise<ManagerToolExecution> {
  const repo = requireString(args.repo);
  const agent = requireString(args.agent);
  const prompt = requireString(args.prompt);
  const config = await ctx.manager.getConfig();
  const agentConfig = config.agents.find((entry) => entry.name === agent);
  if (!config.repos.some((entry) => entry.name === repo)) {
    return { ok: false, errorMessage: "unknown_repo" };
  }
  if (!agentConfig) {
    return { ok: false, errorMessage: "unknown_agent" };
  }
  if (agentConfig.headless_mode === "manager_loop") {
    return { ok: false, errorMessage: "nested_manager_forbidden" };
  }
  const limits = { ...DEFAULT_MANAGER_LIMITS, ...config.agents.find((entry) => entry.name === ctx.manager.getRequired(ctx.managerSessionId).agent_name)?.manager_limits };
  if (ctx.manager.listChildren(ctx.managerSessionId).length >= limits.max_live_children) {
    return { ok: false, errorMessage: "max_live_children" };
  }
  const child = await ctx.manager.create({ repo, agent, prompt, parent_session_id: ctx.managerSessionId });
  return {
    ok: true,
    result: { sessionId: child.id, repo: child.repo_name, agent: child.agent_name, status: child.status },
    childEvents: [{ kind: "child_event", childKind: "spawned", childId: child.id, detail: `${repo}/${agent}` }]
  };
}

/** Creates a manager-owned child from another child session branch. */
async function createChildFromSession(args: Record<string, unknown>, ctx: ManagerToolContext): Promise<ManagerToolExecution> {
  const sourceSessionId = requireString(args.sourceSessionId);
  const agent = requireString(args.agent);
  const prompt = requireString(args.prompt);
  const branchName = typeof args.branchName === "string" && args.branchName.trim() ? args.branchName.trim() : undefined;
  const source = requireChild(ctx, sourceSessionId);
  const config = await ctx.manager.getConfig();
  const agentConfig = config.agents.find((entry) => entry.name === agent);
  if (!agentConfig) {
    return { ok: false, errorMessage: "unknown_agent" };
  }
  if (agentConfig.headless_mode === "manager_loop") {
    return { ok: false, errorMessage: "nested_manager_forbidden" };
  }
  if (!source.branch || source.status === "archived") {
    return { ok: false, errorMessage: "invalid_source_session" };
  }
  const limits = { ...DEFAULT_MANAGER_LIMITS, ...config.agents.find((entry) => entry.name === ctx.manager.getRequired(ctx.managerSessionId).agent_name)?.manager_limits };
  if (ctx.manager.listChildren(ctx.managerSessionId).length >= limits.max_live_children) {
    return { ok: false, errorMessage: "max_live_children" };
  }
  const child = await ctx.manager.create({
    repo: source.repo_name,
    agent,
    prompt,
    parent_session_id: ctx.managerSessionId,
    source_session_id: sourceSessionId,
    branch_name: branchName
  });
  return {
    ok: true,
    result: { sessionId: child.id, repo: child.repo_name, agent: child.agent_name, branch: child.branch, sourceSessionId, sourceBranch: source.branch, status: child.status },
    childEvents: [{ kind: "child_event", childKind: "spawned", childId: child.id, detail: `from ${sourceSessionId}` }]
  };
}

/** Creates a manager-owned child from a named repo branch or ref. */
async function createChildFromBranch(args: Record<string, unknown>, ctx: ManagerToolContext): Promise<ManagerToolExecution> {
  const repo = requireString(args.repo);
  const agent = requireString(args.agent);
  const branch = requireString(args.branch);
  const prompt = requireString(args.prompt);
  const branchName = typeof args.branchName === "string" && args.branchName.trim() ? args.branchName.trim() : undefined;
  const config = await ctx.manager.getConfig();
  const agentConfig = config.agents.find((entry) => entry.name === agent);
  if (!config.repos.some((entry) => entry.name === repo)) {
    return { ok: false, errorMessage: "unknown_repo" };
  }
  if (!agentConfig) {
    return { ok: false, errorMessage: "unknown_agent" };
  }
  if (agentConfig.headless_mode === "manager_loop") {
    return { ok: false, errorMessage: "nested_manager_forbidden" };
  }
  const limits = { ...DEFAULT_MANAGER_LIMITS, ...config.agents.find((entry) => entry.name === ctx.manager.getRequired(ctx.managerSessionId).agent_name)?.manager_limits };
  if (ctx.manager.listChildren(ctx.managerSessionId).length >= limits.max_live_children) {
    return { ok: false, errorMessage: "max_live_children" };
  }
  const child = await ctx.manager.create({
    repo,
    agent,
    prompt,
    parent_session_id: ctx.managerSessionId,
    source_branch: branch,
    branch_name: branchName
  });
  return {
    ok: true,
    result: { sessionId: child.id, repo: child.repo_name, agent: child.agent_name, branch: child.branch, sourceBranch: branch, status: child.status },
    childEvents: [{ kind: "child_event", childKind: "spawned", childId: child.id, detail: `from branch ${branch}` }]
  };
}

/** Sends a prompt to a manager-owned child session. */
async function sendMessage(args: Record<string, unknown>, ctx: ManagerToolContext): Promise<ManagerToolExecution> {
  const sessionId = requireString(args.sessionId);
  const text = requireString(args.text);
  const child = requireChild(ctx, sessionId);
  if (child.status === "archived") {
    return { ok: false, errorMessage: "archived" };
  }
  if (!["running", "awaiting_input", "created"].includes(child.status)) {
    return { ok: false, errorMessage: "not_running" };
  }
  const session = await ctx.manager.send(sessionId, text);
  return {
    ok: true,
    result: { sessionId, status: session.status },
    childEvents: [{ kind: "child_event", childKind: "message_sent", childId: sessionId }]
  };
}

/** Stops a manager-owned child session. */
async function stopChild(args: Record<string, unknown>, ctx: ManagerToolContext): Promise<ManagerToolExecution> {
  const sessionId = requireString(args.sessionId);
  const child = requireChild(ctx, sessionId);
  if (["stopped", "completed", "failed"].includes(child.status)) {
    return { ok: false, errorMessage: "already_stopped" };
  }
  const session = await ctx.manager.stop(sessionId);
  return {
    ok: true,
    result: { sessionId, status: session.status },
    childEvents: [{ kind: "child_event", childKind: "stopped", childId: sessionId }]
  };
}

/** Reads a sandboxed file from a child session. */
async function readChildFile(args: Record<string, unknown>, ctx: ManagerToolContext): Promise<ManagerToolExecution> {
  const sessionId = requireString(args.sessionId);
  const filePath = requireString(args.path);
  const resolved = await resolveChildFile(ctx, sessionId, filePath);
  if (!resolved.ok) {
    return resolved;
  }
  const content = await readFile(resolved.result.path, "utf8").catch(() => null);
  if (content === null) {
    return { ok: false, errorMessage: "read_failed" };
  }
  return {
    ok: true,
    result: {
      path: filePath,
      bytes: Buffer.byteLength(content, "utf8"),
      content
    }
  };
}

/** Sends one child's file contents to another child without returning the body to the LLM. */
async function passFileContent(args: Record<string, unknown>, ctx: ManagerToolContext): Promise<ManagerToolExecution> {
  const fromSessionId = requireString(args.fromSessionId);
  const toSessionId = requireString(args.toSessionId);
  const filePath = requireString(args.path);
  const header = typeof args.header === "string" && args.header.trim() ? `${args.header.trim()}\n\n` : "";
  requireChild(ctx, toSessionId);
  const target = ctx.manager.getRequired(toSessionId);
  if (target.status === "archived") {
    return { ok: false, errorMessage: "archived" };
  }
  if (!["running", "awaiting_input", "created"].includes(target.status)) {
    return { ok: false, errorMessage: "target_not_running" };
  }
  const resolved = await resolveChildFile(ctx, fromSessionId, filePath);
  if (!resolved.ok) {
    return resolved;
  }
  const content = await readFile(resolved.result.path, "utf8").catch(() => null);
  if (content === null) {
    return { ok: false, errorMessage: "read_failed" };
  }
  await ctx.manager.send(toSessionId, `${header}File from session ${fromSessionId}: ${filePath}\n\n${content}`);
  return {
    ok: true,
    result: { bytes: Buffer.byteLength(content, "utf8") },
    childEvents: [
      { kind: "child_event", childKind: "notice", childId: fromSessionId, detail: `passed ${filePath}` },
      { kind: "child_event", childKind: "message_sent", childId: toSessionId, detail: `received ${filePath}` }
    ]
  };
}

/** Reads a compact structured diff from a child session. */
async function readDiff(args: Record<string, unknown>, ctx: ManagerToolContext): Promise<ManagerToolExecution> {
  const sessionId = requireString(args.sessionId);
  const base = (args.base ?? "branch") as DiffBase;
  const child = requireChild(ctx, sessionId);
  if (child.status === "archived") {
    return { ok: false, errorMessage: "archived" };
  }
  if (child.manager_mode) {
    return { ok: false, errorMessage: "is_manager_session" };
  }
  if (base !== "branch" && base !== "uncommitted") {
    return { ok: false, errorMessage: "invalid_base" };
  }
  try {
    const diff = await ctx.manager.diff(sessionId, { base });
    return {
      ok: true,
      result: {
        base: diff.base,
        totalFiles: diff.totalFiles,
        truncated: diff.truncated,
        files: diff.files.map(compactDiffFile)
      }
    };
  } catch (error) {
    return { ok: false, errorMessage: error instanceof Error ? error.message : "git_failed" };
  }
}

/** Returns a compact diff file entry for LLM context. */
function compactDiffFile(file: DiffFileEntry): Record<string, unknown> {
  const patch = file.patch && Buffer.byteLength(file.patch, "utf8") <= MAX_PATCH_BYTES ? file.patch : undefined;
  return {
    path: file.path,
    oldPath: file.oldPath,
    status: file.status,
    additions: file.additions,
    deletions: file.deletions,
    isBinary: file.isBinary,
    isTooLarge: file.isTooLarge || (file.patch ? !patch : false),
    patch
  };
}

/** Resolves a sandboxed child file path. */
async function resolveChildFile(ctx: ManagerToolContext, sessionId: string, requestedPath: string): Promise<ManagerToolExecution & { result: { path: string } }> {
  const child = requireChild(ctx, sessionId);
  if (child.status === "archived") {
    return { ok: false, errorMessage: "archived", result: { path: "" } };
  }
  if (!child.worktree_path) {
    return { ok: false, errorMessage: "not_a_file", result: { path: "" } };
  }
  if (path.isAbsolute(requestedPath) || requestedPath.split(/[\\/]/).includes("..")) {
    return { ok: false, errorMessage: "path_traversal", result: { path: "" } };
  }
  const root = await realpath(child.worktree_path);
  const candidate = path.resolve(root, requestedPath);
  const resolved = await realpath(candidate).catch(() => null);
  if (!resolved || path.relative(root, resolved).startsWith("..") || path.isAbsolute(path.relative(root, resolved))) {
    return { ok: false, errorMessage: "path_traversal", result: { path: "" } };
  }
  const info = await stat(resolved).catch(() => null);
  if (!info?.isFile()) {
    return { ok: false, errorMessage: "not_a_file", result: { path: "" } };
  }
  if (info.size > MAX_FILE_BYTES) {
    return { ok: false, errorMessage: "too_large", result: { path: "" } };
  }
  return { ok: true, result: { path: resolved } };
}

/** Reads a string argument or throws a tool argument error. */
function requireString(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("invalid_arguments");
  }
  return value;
}

/** Reads and validates a child session. */
function requireChild(ctx: ManagerToolContext, sessionId: string) {
  const child = ctx.manager.getRequired(sessionId);
  if (child.parent_session_id !== ctx.managerSessionId) {
    throw new Error("not_a_child");
  }
  return child;
}
