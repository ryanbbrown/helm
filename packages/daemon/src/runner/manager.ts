import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DEFAULT_MANAGER_LIMITS, type AgentConfig, type ManagerMode, type NormalizedEvent } from "@helm/core";
import { AsyncQueue } from "./queue";
import { renderSystemPrompt } from "./manager-prompt";
import { renderStateSnapshot } from "./manager-state";
import { executeManagerTool, managerToolSchemas } from "./manager-tools";
import { OpenRouterClient, writeJsonLine, type ManagerChatClient, type ManagerChatMessage, type ManagerChatToolCall } from "./openrouter";
import type { ManagerToolContext } from "./manager-context";
import type { RunnerAdapter, RunnerHandle, RunnerSpawnOptions } from "./types";

type PendingToolResolution = {
  approved: boolean;
};

type PendingToolCall = {
  resolve: (resolution: PendingToolResolution) => void;
};

export class ManagerRunnerAdapter implements RunnerAdapter {
  /** Creates a manager runner adapter. */
  constructor(
    private agent: AgentConfig,
    private ctx: ManagerToolContext,
    private client?: ManagerChatClient
  ) {}

  /** Spawns an in-process manager loop. */
  spawn(opts: RunnerSpawnOptions): RunnerHandle {
    const handle = new ManagerRunnerHandle(this.agent, this.ctx, this.client, opts);
    if (opts.initialPrompt) {
      void handle.send(opts.initialPrompt);
    }
    return handle;
  }
}

export class ManagerRunnerHandle implements RunnerHandle {
  events: AsyncIterable<NormalizedEvent>;
  pid = -1;
  private queue = new AsyncQueue<NormalizedEvent>();
  private messages: ManagerChatMessage[];
  private abortController: AbortController | null = null;
  private running = false;
  private stopped = false;
  private pending = new Map<string, PendingToolCall>();
  private wakeQueue: string[] = [];
  private userQueue: string[] = [];
  private unsubscribe: () => void;

  /** Creates a running manager handle. */
  constructor(
    private agent: AgentConfig,
    private ctx: ManagerToolContext,
    private client: ManagerChatClient | undefined,
    private opts: RunnerSpawnOptions
  ) {
    this.events = this.queue;
    this.messages = [{ role: "system", content: renderSystemPrompt(ctx.managerSessionId, readManagerPrompt(agent.system_prompt_path)) }];
    this.unsubscribe = ctx.manager.subscribe((event) => {
      if (event.type === "event") {
        const session = ctx.manager.get(event.event.session_id);
        if (session?.parent_session_id === ctx.managerSessionId && event.event.kind === "turn_complete") {
          this.enqueueWake(`session ${session.id} reached awaiting_input. last assistant message: "${(session.last_assistant_message ?? "").slice(0, 200)}"`);
        }
      }
      if (event.type === "session" && event.session.parent_session_id === ctx.managerSessionId && ["completed", "failed", "stopped"].includes(event.session.status)) {
        this.enqueueWake(`session ${event.session.id} reached ${event.session.status}. last assistant message: "${(event.session.last_assistant_message ?? "").slice(0, 200)}"`);
      }
    });
  }

  /** Sends a user message into the manager loop. */
  async send(userText: string): Promise<void> {
    this.userQueue.push(userText);
    this.kick();
  }

  /** Stops the manager loop and closes its event stream. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.abortController?.abort();
    for (const pending of this.pending.values()) {
      pending.resolve({ approved: false });
    }
    this.pending.clear();
    this.unsubscribe();
    this.queue.push({ kind: "exit", code: 0 });
    this.queue.close();
  }

  /** Resolves a pending approval-mode tool call. */
  resolveToolCall(toolCallId: string, approved: boolean): boolean {
    const pending = this.pending.get(toolCallId);
    if (!pending) {
      return false;
    }
    this.pending.delete(toolCallId);
    this.queue.push({ kind: "tool_call_resolved", toolCallId, approved, resolvedBy: "user" });
    pending.resolve({ approved });
    return true;
  }

  /** Adds a child wake notice and schedules a manager turn. */
  private enqueueWake(notice: string): void {
    const limits = this.limits();
    if (this.wakeQueue.length >= limits.max_queued_wakes_per_turn) {
      return;
    }
    if (!this.wakeQueue.includes(notice)) {
      this.wakeQueue.push(notice);
    }
    this.kick();
  }

  /** Starts the manager turn processor when idle. */
  private kick(): void {
    if (this.running || this.stopped) {
      return;
    }
    this.running = true;
    void this.runTurnQueue()
      .catch((error) => {
        if (!this.stopped) {
          this.queue.push({ kind: "error", message: error instanceof Error ? error.message : String(error) });
          this.queue.push({ kind: "turn_complete" });
        }
      })
      .finally(() => {
        this.running = false;
        if (!this.stopped && (this.wakeQueue.length > 0 || this.userQueue.length > 0)) {
          this.kick();
        }
      });
  }

  /** Runs all pending turn work serially. */
  private async runTurnQueue(): Promise<void> {
    while (!this.stopped) {
      const wakeNotice = this.wakeQueue.splice(0).join("\n");
      const userMessages = this.userQueue.splice(0);
      if (!wakeNotice && userMessages.length === 0) {
        return;
      }
      for (const userMessage of userMessages) {
        this.messages.push({ role: "user", content: userMessage });
      }
      this.messages.push({ role: "user", content: await renderStateSnapshot(this.ctx, wakeNotice ? { wakeNotice } : {}) });
      const emitted = await this.runOneTurn();
      if (!emitted && wakeNotice) {
        this.messages.push({ role: "assistant", content: "" });
      }
      if (this.wakeQueue.length === 0 && this.userQueue.length === 0) {
        return;
      }
    }
  }

  /** Runs one LLM turn through any tool-call iterations. */
  private async runOneTurn(): Promise<boolean> {
    let emittedVisibleOutput = false;
    const limits = this.limits();
    for (let iteration = 0; iteration < limits.max_tool_iterations_per_turn; iteration += 1) {
      this.abortController = new AbortController();
      this.client ??= new OpenRouterClient(this.agent.api_key_env ?? "OPENROUTER_API_KEY");
      const response = await this.client.chatCompletion({
        model: this.agent.model ?? "",
        messages: this.messages,
        tools: managerToolSchemas(),
        signal: this.abortController.signal,
        logPath: this.opts.logPath
      });
      writeJsonLine(this.opts.logPath, { type: "usage", usage: response.usage });
      const assistant = response.message;
      this.messages.push(assistant);
      if (assistant.content?.trim()) {
        this.queue.push({ kind: "assistant_message", text: assistant.content });
        emittedVisibleOutput = true;
      }
      const toolCalls = assistant.tool_calls ?? [];
      if (toolCalls.length === 0) {
        this.queue.push({ kind: "turn_complete" });
        return emittedVisibleOutput;
      }
      emittedVisibleOutput = true;
      if (toolCalls.length > limits.max_tool_calls_per_batch) {
        await this.appendToolErrors(toolCalls, "max_tool_calls_per_batch");
        continue;
      }
      const results = await this.executeToolBatch(toolCalls, this.currentMode());
      this.messages.push(...results);
    }
    this.queue.push({ kind: "error", message: "max_tool_iterations_per_turn" });
    this.queue.push({ kind: "turn_complete" });
    return true;
  }

  /** Executes one assistant tool-call batch. */
  private async executeToolBatch(toolCalls: ManagerChatToolCall[], mode: ManagerMode): Promise<ManagerChatMessage[]> {
    const results: ManagerChatMessage[] = [];
    const approvals = new Map<string, Promise<PendingToolResolution>>();
    for (const toolCall of toolCalls) {
      const args = parseToolArguments(toolCall.function.arguments);
      this.queue.push({
        kind: "tool_invocation",
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        arguments: args,
        status: mode === "approval" ? "pending" : "auto"
      });
      if (mode === "approval") {
        approvals.set(toolCall.id, this.waitForApproval(toolCall.id));
      }
    }
    for (const toolCall of toolCalls) {
      const args = parseToolArguments(toolCall.function.arguments);
      const approved = mode === "autopilot" ? true : (await approvals.get(toolCall.id)!).approved;
      if (!approved) {
        const result = { ok: false, errorMessage: "denied_by_user" };
        this.queue.push({ kind: "tool_result", toolCallId: toolCall.id, toolName: toolCall.function.name, ...result, result });
        results.push(toolMessage(toolCall.id, result));
        continue;
      }
      const result = await executeManagerTool(toolCall.function.name, args, this.ctx);
      this.queue.push({
        kind: "tool_result",
        toolCallId: toolCall.id,
        toolName: toolCall.function.name,
        ok: result.ok,
        result: result.result ?? null,
        errorMessage: result.errorMessage
      });
      for (const childEvent of result.childEvents ?? []) {
        this.queue.push(childEvent);
      }
      results.push(toolMessage(toolCall.id, { ok: result.ok, result: result.result, errorMessage: result.errorMessage }));
    }
    return results;
  }

  /** Waits for the user to approve or deny one tool call. */
  private waitForApproval(toolCallId: string): Promise<PendingToolResolution> {
    return new Promise((resolve) => {
      this.pending.set(toolCallId, { resolve });
    });
  }

  /** Appends errors for a rejected tool-call batch. */
  private async appendToolErrors(toolCalls: ManagerChatToolCall[], errorMessage: string): Promise<void> {
    for (const toolCall of toolCalls) {
      const result = { ok: false, errorMessage };
      this.queue.push({ kind: "tool_result", toolCallId: toolCall.id, toolName: toolCall.function.name, result, ...result });
      this.messages.push(toolMessage(toolCall.id, result));
    }
  }

  /** Reads the manager's current operating mode. */
  private currentMode(): ManagerMode {
    return this.ctx.manager.getRequired(this.ctx.managerSessionId).manager_mode ?? "approval";
  }

  /** Returns merged manager limits. */
  private limits() {
    return { ...DEFAULT_MANAGER_LIMITS, ...this.agent.manager_limits };
  }
}

/** Reads the optional user-configured manager prompt markdown file. */
function readManagerPrompt(promptPath: string | undefined): string | undefined {
  if (!promptPath) {
    return undefined;
  }
  const expanded = promptPath.startsWith("~/") ? path.join(homedir(), promptPath.slice(2)) : promptPath;
  return readFileSync(expanded, "utf8");
}

/** Parses an OpenAI function-call argument string. */
function parseToolArguments(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value || "{}") as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

/** Converts a manager tool result to an OpenAI tool message. */
function toolMessage(toolCallId: string, value: unknown): ManagerChatMessage {
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify(value)
  };
}
