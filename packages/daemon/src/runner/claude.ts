import { AsyncQueue } from "./queue";
import { readJsonLines } from "./jsonl";
import { extractClaudeAssistantText, normalizeError } from "./normalize";
import type { RunnerAdapter, RunnerHandle, RunnerSpawnOptions } from "./types";
import type { NormalizedEvent } from "@helm/core";

export class ClaudeRunnerAdapter implements RunnerAdapter {
  /** Spawns Claude Code in stream-json mode. */
  spawn(opts: RunnerSpawnOptions): RunnerHandle {
    const queue = new AsyncQueue<NormalizedEvent>();
    const handle = new ClaudeRunnerHandle(queue, opts);
    if (!opts.resumeThreadId || opts.initialPrompt) {
      handle.start();
    }
    if (opts.initialPrompt) {
      void handle.send(opts.initialPrompt);
    }
    return handle;
  }
}

/** Builds the Claude stream-json command. */
function claudeCommand(opts: RunnerSpawnOptions): string[] {
  return [
    opts.command,
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    ...(opts.resumeThreadId ? ["--resume", opts.resumeThreadId] : []),
    ...opts.extraArgs
  ];
}

class ClaudeRunnerHandle implements RunnerHandle {
  events: AsyncIterable<NormalizedEvent>;
  pid: number | null = null;
  private proc: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
  private emittedAssistantThisTurn = false;
  private emittedThinkingThisTurn = false;

  /** Creates a Claude runner handle. */
  constructor(
    private queue: AsyncQueue<NormalizedEvent>,
    private opts: RunnerSpawnOptions
  ) {
    this.events = queue;
  }

  /** Starts stdout parsing and exit handling. */
  start(): void {
    if (this.proc) {
      return;
    }
    this.proc = Bun.spawn({
      cmd: claudeCommand(this.opts),
      cwd: this.opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    this.pid = this.proc.pid;
    void readJsonLines(this.proc.stdout, this.opts.logPath, (value) => this.handleEvent(value)).catch((error) => this.queue.push(normalizeError(error)));
    void this.proc.exited.then((code) => {
      this.queue.push({ kind: "exit", code });
    });
  }

  /** Sends a user message into Claude stdin. */
  async send(userText: string): Promise<void> {
    this.start();
    this.proc!.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: userText } }) + "\n");
    this.proc!.stdin.flush();
  }

  /** Stops the Claude child process. */
  async stop(): Promise<void> {
    this.proc?.kill();
    await this.proc?.exited;
  }

  /** Handles one Claude stream-json event. */
  private handleEvent(value: unknown): void {
    const event = value as { type?: string; subtype?: string; session_id?: string };
    if (event.type === "system" && event.subtype === "init" && event.session_id) {
      this.opts.onThreadId?.(event.session_id);
      return;
    }
    if (event.type === "assistant") {
      const text = extractClaudeAssistantText(value).trim();
      if (!this.emittedThinkingThisTurn) {
        this.queue.push({ kind: "thinking" });
        this.emittedThinkingThisTurn = true;
      }
      if (text) {
        this.queue.push({ kind: "assistant_message", text });
        this.emittedAssistantThisTurn = true;
      }
      return;
    }
    if (event.type === "result") {
      const text = extractClaudeAssistantText(value).trim();
      if (text && !this.emittedAssistantThisTurn) {
        this.queue.push({ kind: "assistant_message", text });
      }
      this.queue.push({ kind: "turn_complete" });
      this.emittedAssistantThisTurn = false;
      this.emittedThinkingThisTurn = false;
    }
  }
}
