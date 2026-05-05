import type { NormalizedEvent } from "@helm/core";
import type { ManagerChatMessage } from "./openrouter";

export type ManagerConversationStore = {
  /** Appends one message to a durable manager transcript. */
  append(sessionId: string, message: ManagerChatMessage): void;
  /** Loads the durable manager transcript for a resumed manager. */
  load(sessionId: string): ManagerChatMessage[];
};

export type RunnerSpawnOptions = {
  command: string;
  cwd: string;
  extraArgs: string[];
  sessionId?: string;
  initialPrompt?: string;
  resumeThreadId?: string;
  isResume?: boolean;
  managerConversation?: ManagerConversationStore;
  logPath: string;
  onThreadId?: (threadId: string) => void;
};

export type RunnerHandle = {
  events: AsyncIterable<NormalizedEvent>;
  send(userText: string): Promise<void>;
  stop(): Promise<void>;
  pid: number | null;
};

export type RunnerAdapter = {
  spawn(opts: RunnerSpawnOptions): RunnerHandle;
};
