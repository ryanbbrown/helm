import type { NormalizedEvent } from "@helm/core";

/** Extracts text from common Claude content block shapes. */
export function extractClaudeAssistantText(value: unknown): string {
  const event = value as { message?: { content?: unknown }; result?: string };
  const content = event.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") {
          return block;
        }
        if (block && typeof block === "object" && "text" in block && typeof block.text === "string") {
          return block.text;
        }
        return "";
      })
      .join("");
  }
  return typeof event.result === "string" ? event.result : "";
}

/** Extracts text from common Codex agent_message item shapes. */
export function extractCodexAgentMessage(value: unknown): string {
  const event = value as { item?: { text?: string; content?: unknown }; text?: string; content?: unknown };
  const item = event.item ?? event;
  if (typeof item.text === "string") {
    return item.text;
  }
  if (typeof item.content === "string") {
    return item.content;
  }
  if (Array.isArray(item.content)) {
    return item.content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

/** Extracts Codex thread ids from observed exec event shapes. */
export function extractCodexThreadId(value: unknown): string | undefined {
  const event = value as { thread?: { id?: unknown }; thread_id?: unknown };
  if (typeof event.thread?.id === "string") {
    return event.thread.id;
  }
  return typeof event.thread_id === "string" ? event.thread_id : undefined;
}

/** Converts thrown values to normalized error events. */
export function normalizeError(error: unknown): NormalizedEvent {
  return {
    kind: "error",
    message: error instanceof Error ? error.message : String(error),
    payload: error
  };
}
