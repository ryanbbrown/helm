import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ManagerRunnerAdapter, type ManagerRunnerHandle } from "./manager";
import { SessionManager } from "../session-manager";
import { Store } from "../store";
import type { AgentConfig, NormalizedEvent } from "@helm/core";
import type { ManagerChatClient, ManagerChatCompletion, ManagerChatCompletionInput } from "./openrouter";
import type { HelmConfig } from "../config-loader";

describe("ManagerRunnerAdapter", () => {
  test("gates tool calls in approval mode and appends tool results", async () => {
    const fixture = createLoopFixture();
    const client = new FakeManagerChatClient([
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call-1", type: "function", function: { name: "missing_tool", arguments: "{}" } }]
        },
        finishReason: "tool_calls"
      },
      { message: { role: "assistant", content: "done" }, finishReason: "stop" }
    ]);
    const handle = new ManagerRunnerAdapter(fixture.agent, { manager: fixture.manager, managerSessionId: "manager" }, client).spawn({
      command: "manager",
      cwd: "",
      extraArgs: [],
      initialPrompt: "start",
      logPath: join(fixture.dir, "manager.jsonl")
    }) as ManagerRunnerHandle;

    const invocation = await nextEvent(handle.events);
    expect(invocation).toMatchObject({ kind: "tool_invocation", toolCallId: "call-1", status: "pending" });
    expect(handle.resolveToolCall("call-1", true)).toBe(true);

    const rest = await collectUntil(handle.events, "turn_complete");
    expect(rest).toContainEqual(expect.objectContaining({ kind: "tool_call_resolved", approved: true }));
    expect(rest).toContainEqual(expect.objectContaining({ kind: "tool_result", ok: false, errorMessage: "unknown_tool" }));
    expect(rest).toContainEqual(expect.objectContaining({ kind: "assistant_message", text: "done" }));
    expect(client.calls).toHaveLength(2);
    expect(client.calls[1]?.messages.at(-1)).toMatchObject({ role: "tool" });
  });

  test("emits a visible lifecycle notice when a child turn completes", async () => {
    const fixture = createLoopFixture();
    insertChildSession(fixture, "child-1", "working on tests");
    const client = new FakeManagerChatClient([
      { message: { role: "assistant", content: "checking child output" }, finishReason: "stop" }
    ]);
    const handle = new ManagerRunnerAdapter(fixture.agent, { manager: fixture.manager, managerSessionId: "manager" }, client).spawn({
      command: "manager",
      cwd: "",
      extraArgs: [],
      logPath: join(fixture.dir, "manager.jsonl")
    }) as ManagerRunnerHandle;

    consumePrivateEvents(fixture.manager, "manager", handle);
    emitPrivateEvent(fixture.manager, "child-1", { kind: "turn_complete" });

    await waitForPersistedEvent(fixture.manager, "manager", "turn_complete");
    expect(fixture.manager.listEvents("manager")).toContainEqual(expect.objectContaining({
      kind: "child_event",
      payload: { kind: "child_event", childKind: "awaiting_input", childId: "child-1" }
    }));
    expect(fixture.manager.listEvents("manager")).toContainEqual(expect.objectContaining({
      kind: "assistant_message",
      payload: { kind: "assistant_message", text: "checking child output" }
    }));
    await handle.stop();
  });
});

/** Reads the next runner event. */
async function nextEvent(events: AsyncIterable<NormalizedEvent>): Promise<NormalizedEvent> {
  const iterator = events[Symbol.asyncIterator]();
  const value = await iterator.next();
  if (value.done) {
    throw new Error("events closed");
  }
  return value.value;
}

/** Collects events until a specific event kind appears. */
async function collectUntil(events: AsyncIterable<NormalizedEvent>, kind: NormalizedEvent["kind"]): Promise<NormalizedEvent[]> {
  const collected: NormalizedEvent[] = [];
  for await (const event of events) {
    collected.push(event);
    if (event.kind === kind) {
      return collected;
    }
  }
  return collected;
}

type LoopFixture = {
  agent: AgentConfig;
  dir: string;
  manager: SessionManager;
  store: Store;
};

/** Creates a manager session row and fake manager config. */
function createLoopFixture(): LoopFixture {
  const dir = mkdtempSync(join(tmpdir(), "helm-manager-loop-"));
  const store = new Store(join(dir, "helm.db"));
  const now = new Date().toISOString();
  store.insertSession({
    id: "manager",
    repo_name: "fixture",
    agent_name: "manager",
    branch: null,
    worktree_path: null,
    workspace_uri: null,
    manager_mode: "approval",
    status: "running",
    created_at: now,
    updated_at: now
  });
  const agent: AgentConfig = { name: "manager", command: "manager", args: [], headless_mode: "manager_loop", model: "test-model", api_key: "test-key" };
  const config: HelmConfig = {
    repos: [{ name: "fixture", path: dir, default_branch: "main" }],
    agents: [agent]
  };
  return { agent, dir, manager: new SessionManager({ config, store }), store };
}

/** Inserts a manager-owned child session row for manager loop tests. */
function insertChildSession(fixture: LoopFixture, id: string, lastAssistantMessage: string): void {
  const now = new Date().toISOString();
  fixture.store.insertSession({
    id,
    repo_name: "fixture",
    agent_name: "codex",
    branch: `helm/${id}`,
    worktree_path: join(fixture.dir, id),
    workspace_uri: `file://${join(fixture.dir, id)}`,
    parent_session_id: "manager",
    status: "running",
    created_at: now,
    updated_at: now
  });
  fixture.store.updateSession(id, { last_assistant_message: lastAssistantMessage });
}

/** Emits an event through the manager's private persistence path for subscription tests. */
function emitPrivateEvent(manager: SessionManager, sessionId: string, event: NormalizedEvent): void {
  (manager as unknown as { persistEvent(id: string, event: NormalizedEvent): void }).persistEvent(sessionId, event);
}

/** Starts the manager's private event consumer for a test handle. */
function consumePrivateEvents(manager: SessionManager, sessionId: string, handle: ManagerRunnerHandle): void {
  void (manager as unknown as { consumeEvents(id: string, handle: ManagerRunnerHandle): Promise<void> }).consumeEvents(sessionId, handle);
}

/** Waits until a persisted event kind appears on a session. */
async function waitForPersistedEvent(manager: SessionManager, sessionId: string, kind: NormalizedEvent["kind"]): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (manager.listEvents(sessionId).some((event) => event.kind === kind)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${kind}`);
}

class FakeManagerChatClient implements ManagerChatClient {
  calls: ManagerChatCompletionInput[] = [];

  /** Creates a fake client with queued responses. */
  constructor(private responses: ManagerChatCompletion[]) {}

  /** Returns the next queued manager completion. */
  async chatCompletion(input: ManagerChatCompletionInput): Promise<ManagerChatCompletion> {
    this.calls.push({ ...input, messages: [...input.messages] });
    const response = this.responses.shift();
    if (!response) {
      throw new Error("No fake response queued");
    }
    return response;
  }
}
