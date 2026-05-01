import type { NormalizedEvent } from "@helm/core";

export type RunnerSpawnOptions = {
  command: string;
  cwd: string;
  extraArgs: string[];
  initialPrompt?: string;
  resumeThreadId?: string;
  logPath: string;
  onThreadId?: (threadId: string) => void;
};

export type RunnerHandle = {
  events: AsyncIterable<NormalizedEvent>;
  send(userText: string): Promise<void>;
  stop(): Promise<void>;
  pid: number;
};

export type RunnerAdapter = {
  spawn(opts: RunnerSpawnOptions): RunnerHandle;
};
