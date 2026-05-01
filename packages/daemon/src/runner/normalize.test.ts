import { describe, expect, test } from "bun:test";
import { extractClaudeAssistantText, extractCodexAgentMessage, extractCodexThreadId } from "./normalize";

describe("runner normalization helpers", () => {
  test("extracts Claude assistant content blocks", () => {
    expect(
      extractClaudeAssistantText({
        message: {
          content: [
            { type: "text", text: "hello" },
            { type: "text", text: " world" }
          ]
        }
      })
    ).toBe("hello world");
  });

  test("extracts Claude result text", () => {
    expect(extractClaudeAssistantText({ type: "result", result: "done" })).toBe("done");
  });

  test("extracts Codex agent message content blocks", () => {
    expect(
      extractCodexAgentMessage({
        item: {
          type: "agent_message",
          content: [{ text: "ok" }]
        }
      })
    ).toBe("ok");
  });

  test("extracts Codex thread id from current exec shape", () => {
    expect(extractCodexThreadId({ type: "thread.started", thread_id: "thread-1" })).toBe("thread-1");
  });

  test("extracts Codex thread id from nested exec shape", () => {
    expect(extractCodexThreadId({ type: "thread.started", thread: { id: "thread-2" } })).toBe("thread-2");
  });
});
