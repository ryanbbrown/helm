import { AsyncQueue } from "./queue";
import { readJsonLines } from "./jsonl";
import { extractCodexAgentMessage, extractCodexThreadId, normalizeError } from "./normalize";
import type { RunnerAdapter, RunnerHandle, RunnerSpawnOptions } from "./types";
import type { NormalizedEvent } from "@helm/core";

export class CodexRunnerAdapter implements RunnerAdapter {
  /** Spawns Codex exec mode. */
  spawn(opts: RunnerSpawnOptions): RunnerHandle {
    const queue = new AsyncQueue<NormalizedEvent>();
    const handle = new CodexRunnerHandle(queue, opts);
    if (!opts.resumeThreadId || opts.initialPrompt) {
      handle.spawnTurn(opts.initialPrompt ?? "", opts.resumeThreadId);
    }
    return handle;
  }
}

class CodexRunnerHandle implements RunnerHandle {
  events: AsyncIterable<NormalizedEvent>;
  pid: number | null = null;
  private proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  private pendingFollowUps: string[] = [];
  private threadId: string | undefined;

  /** Creates a Codex runner handle. */
  constructor(
    private queue: AsyncQueue<NormalizedEvent>,
    private opts: RunnerSpawnOptions
  ) {
    this.events = queue;
    this.threadId = opts.resumeThreadId;
  }

  /** Spawns a Codex first-turn or resume process. */
  spawnTurn(prompt: string, resumeThreadId?: string): void {
    const cmd = resumeThreadId
      ? [this.opts.command, "exec", "resume", resumeThreadId, "--json", ...this.opts.extraArgs, prompt]
      : [this.opts.command, "exec", "--json", ...this.opts.extraArgs, prompt];
    this.proc = Bun.spawn({
      cmd,
      cwd: this.opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe"
    });
    this.pid = this.proc.pid;
    void readJsonLines(this.proc.stdout, this.opts.logPath, (value) => this.handleEvent(value)).catch((error) => this.queue.push(normalizeError(error)));
    void this.proc.exited.then((code) => {
      this.queue.push({ kind: "exit", code });
      if (code === 0) {
        this.drainPendingFollowUps();
      }
    });
  }

  /** Sends a follow-up by spawning codex exec resume. */
  async send(userText: string): Promise<void> {
    const threadId = this.threadId ?? this.opts.resumeThreadId;
    if (!threadId) {
      this.pendingFollowUps.push(userText);
      return;
    }
    this.spawnTurn(userText, threadId);
  }

  /** Stops the current Codex child process. */
  async stop(): Promise<void> {
    this.proc?.kill();
    await this.proc?.exited;
  }

  /** Handles one Codex JSON event. */
  private handleEvent(value: unknown): void {
    const event = value as { type?: string; item?: { type?: string } };
    const threadId = extractCodexThreadId(value);
    if (event.type === "thread.started" && threadId) {
      this.threadId = threadId;
      this.opts.onThreadId?.(threadId);
      return;
    }
    if (event.type === "turn.started") {
      this.queue.push({ kind: "thinking" });
      return;
    }
    if (event.type?.startsWith("item.") && event.item?.type === "agent_message") {
      const text = extractCodexAgentMessage(value).trim();
      if (text) {
        this.queue.push({ kind: "assistant_message", text });
      }
      return;
    }
    if (event.type === "turn.completed") {
      this.queue.push({ kind: "turn_complete" });
      return;
    }
    if (event.type === "turn.failed" || event.type === "error") {
      this.queue.push({ kind: "error", message: event.type, payload: value });
    }
  }

  /** Starts queued follow-ups once Codex has emitted a resumable thread id. */
  private drainPendingFollowUps(): void {
    const threadId = this.threadId ?? this.opts.resumeThreadId;
    const userText = this.pendingFollowUps.shift();
    if (!threadId || !userText) {
      return;
    }
    this.spawnTurn(userText, threadId);
  }
}
