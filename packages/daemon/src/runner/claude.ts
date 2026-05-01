import { AsyncQueue } from "./queue";
import { readJsonLines } from "./jsonl";
import { extractClaudeAssistantText, normalizeError } from "./normalize";
import type { RunnerAdapter, RunnerHandle, RunnerSpawnOptions } from "./types";
import type { NormalizedEvent } from "@helm/core";

export class ClaudeRunnerAdapter implements RunnerAdapter {
  /** Spawns Claude Code in stream-json mode. */
  spawn(opts: RunnerSpawnOptions): RunnerHandle {
    const queue = new AsyncQueue<NormalizedEvent>();
    const proc = Bun.spawn({
      cmd: [
        opts.command,
        "--print",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        ...opts.extraArgs
      ],
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe"
    });
    const handle = new ClaudeRunnerHandle(proc, queue, opts);
    handle.start();
    if (opts.initialPrompt) {
      void handle.send(opts.initialPrompt);
    }
    return handle;
  }
}

class ClaudeRunnerHandle implements RunnerHandle {
  events: AsyncIterable<NormalizedEvent>;
  pid: number;
  private emittedAssistantThisTurn = false;

  /** Creates a Claude runner handle. */
  constructor(
    private proc: Bun.Subprocess<"pipe", "pipe", "pipe">,
    private queue: AsyncQueue<NormalizedEvent>,
    private opts: RunnerSpawnOptions
  ) {
    this.events = queue;
    this.pid = proc.pid;
  }

  /** Starts stdout parsing and exit handling. */
  start(): void {
    void readJsonLines(this.proc.stdout, this.opts.logPath, (value) => this.handleEvent(value)).catch((error) => this.queue.push(normalizeError(error)));
    void this.proc.exited.then((code) => {
      this.queue.push({ kind: "exit", code });
    });
  }

  /** Sends a user message into Claude stdin. */
  async send(userText: string): Promise<void> {
    this.proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: userText } }) + "\n");
    this.proc.stdin.flush();
  }

  /** Stops the Claude child process. */
  async stop(): Promise<void> {
    this.proc.kill();
    await this.proc.exited;
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
      if (text) {
        this.queue.push({ kind: "assistant_message", text });
        this.emittedAssistantThisTurn = true;
      } else if (!this.emittedAssistantThisTurn) {
        this.queue.push({ kind: "thinking" });
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
    }
  }
}
