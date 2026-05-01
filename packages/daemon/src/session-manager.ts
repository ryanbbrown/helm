import {
  DIFF_FILE_COUNT_LIMIT,
  DIFF_FILE_SIZE_LIMIT,
  createId,
  logPath,
  toPublicSession,
  type DiffBase,
  type DiffResult,
  type NormalizedEvent,
  type PublicSession,
  type Session,
  type SessionEvent
} from "@helm/core";
import { findAgent, findRepo, loadConfig, type HelmConfig } from "./config-loader";
import { Store } from "./store";
import { createRunnerAdapter } from "./runner";
import type { RunnerHandle } from "./runner/types";
import { EventBus, type BusEvent } from "./event-bus";
import { LocalWorktreeProvider } from "./workspace/local";
import type { WorkspaceProvider } from "./workspace/types";

export { ArchiveSafetyError } from "./workspace/types";

export type SessionManagerOptions = {
  config?: HelmConfig;
  configDir?: string;
  store?: Store;
  bus?: EventBus;
  workspace?: WorkspaceProvider;
};

export type CreateSessionInput = {
  repo: string;
  agent: string;
  prompt?: string;
};

export type PublicHelmConfig = {
  repos: Array<{ name: string }>;
  agents: Array<{ name: string; headless_mode: HelmConfig["agents"][number]["headless_mode"] }>;
};

export type ArchiveOptions = {
  force?: boolean;
};

export type CreatePullRequestInput = {
  title?: string;
  body?: string;
};

export class SessionManager {
  private store: Store;
  private bus: EventBus;
  private workspace: WorkspaceProvider;
  private handles = new Map<string, RunnerHandle>();
  private cachedConfig?: HelmConfig;
  private configDir?: string;

  /** Creates a session manager. */
  constructor(options: SessionManagerOptions = {}) {
    this.store = options.store ?? new Store();
    this.bus = options.bus ?? new EventBus();
    this.workspace = options.workspace ?? new LocalWorktreeProvider();
    this.cachedConfig = options.config;
    this.configDir = options.configDir;
  }

  /** Creates a workspace-backed agent session. */
  async create(input: CreateSessionInput): Promise<Session> {
    const config = await this.loadHelmConfig();
    const repo = findRepo(config, input.repo);
    const agent = findAgent(config, input.agent);
    const id = createId();
    const workspace = await this.workspace.create({ repo, sessionId: id });
    const now = new Date().toISOString();

    this.store.insertSession({
      id,
      repo_name: repo.name,
      agent_name: agent.name,
      branch: workspace.branch,
      worktree_path: workspace.cwd,
      status: "created",
      created_at: now,
      updated_at: now
    });
    this.persistEvent(id, {
      kind: "session_started",
      sessionId: id,
      repo: repo.name,
      branch: workspace.branch,
      worktreePath: workspace.cwd
    });
    if (input.prompt) {
      this.persistEvent(id, { kind: "user_message", text: input.prompt });
    }

    const adapter = createRunnerAdapter(agent);
    const handle = adapter.spawn({
      command: agent.command,
      cwd: workspace.cwd,
      extraArgs: agent.args,
      initialPrompt: input.prompt,
      logPath: logPath(id),
      onThreadId: (threadId) => this.patch(id, { agent_thread_id: threadId })
    });
    this.handles.set(id, handle);
    this.patch(id, { pid: handle.pid, status: "running" });
    void this.consumeEvents(id, handle);
    const session = this.get(id);
    if (!session) {
      throw new Error(`Failed to read created session: ${id}`);
    }
    return session;
  }

  /** Returns the validated Helm config. */
  async getConfig(): Promise<HelmConfig> {
    return this.loadHelmConfig();
  }

  /** Returns dashboard-safe config without filesystem paths or commands. */
  async getPublicConfig(): Promise<PublicHelmConfig> {
    const config = await this.loadHelmConfig();
    return {
      repos: config.repos.map((repo) => ({ name: repo.name })),
      agents: config.agents.map((agent) => ({ name: agent.name, headless_mode: agent.headless_mode }))
    };
  }

  /** Sends a follow-up message to a running in-memory session. */
  async send(id: string, text: string): Promise<Session> {
    const handle = this.handles.get(id);
    if (!handle) {
      throw new Error(`Session is not running in this process: ${id}`);
    }
    const previous = this.getRequired(id);
    this.persistEvent(id, { kind: "user_message", text });
    try {
      await handle.send(text);
      this.patch(id, { status: "running" });
    } catch (error) {
      this.patch(id, { status: previous.status });
      throw error;
    }
    const session = this.get(id);
    if (!session) {
      throw new Error(`Unknown session: ${id}`);
    }
    return session;
  }

  /** Stops a running session and keeps it visible. */
  async stop(id: string): Promise<Session> {
    const handle = this.handles.get(id);
    if (handle) {
      await handle.stop();
      this.handles.delete(id);
    }
    this.patch(id, { status: "stopped", pid: null });
    const session = this.get(id);
    if (!session) {
      throw new Error(`Unknown session: ${id}`);
    }
    return session;
  }

  /** Archives a session and removes its worktree and local branch. */
  async archive(id: string, options: ArchiveOptions = {}): Promise<Session> {
    const config = await this.loadHelmConfig();
    const session = this.getRequired(id);
    const repo = findRepo(config, session.repo_name);
    const workspace = this.workspace.fromSession({ repo, session });
    if (!options.force) {
      await this.workspace.assertRemoveSafe(workspace, { repo });
    }
    const handle = this.handles.get(id);
    if (handle) {
      await handle.stop();
      this.handles.delete(id);
    }
    await this.workspace.remove(workspace, { repo, force: options.force ?? false });
    this.patch(id, { status: "archived", pid: null });
    return this.getRequired(id);
  }

  /** Reads a structured diff for a session worktree. */
  async diff(id: string, opts: { base: DiffBase }): Promise<DiffResult> {
    const config = await this.loadHelmConfig();
    const session = this.getRequired(id);
    const repo = findRepo(config, session.repo_name);
    const workspace = this.workspace.fromSession({ repo, session });
    return this.workspace.diff(workspace, {
      repo,
      base: opts.base,
      fileSizeLimit: DIFF_FILE_SIZE_LIMIT,
      fileCountLimit: DIFF_FILE_COUNT_LIMIT
    });
  }

  /** Pushes a session branch and opens or records a pull request. */
  async createPullRequest(id: string, input: CreatePullRequestInput): Promise<PublicSession> {
    const session = this.getRequired(id);
    if (session.pull_request_url) {
      return toPublicSession(session);
    }
    const config = await this.loadHelmConfig();
    const repo = findRepo(config, session.repo_name);
    const workspace = this.workspace.fromSession({ repo, session });
    const title = input.title?.trim() || this.defaultPullRequestTitle(session);
    const body = input.body?.trim() || `Created from Helm session ${session.id}.`;
    const result = await this.workspace.createPullRequest(workspace, { repo, title, body });
    this.store.updatePullRequestUrl(id, result.url);
    const updated = this.getRequired(id);
    this.bus.publish({ type: "session", session: updated });
    return toPublicSession(updated);
  }

  /** Lists sessions. */
  list(includeArchived = false): Session[] {
    return this.store.listSessions(includeArchived);
  }

  /** Lists persisted events for one session. */
  listEvents(sessionId: string, afterId = 0): SessionEvent[] {
    return this.store.listEvents(sessionId, afterId);
  }

  /** Lists persisted events across all sessions. */
  listAllEvents(afterId = 0): SessionEvent[] {
    return this.store.listAllEvents(afterId);
  }

  /** Subscribes to manager-level session and event updates. */
  subscribe(listener: (event: BusEvent) => void): () => void {
    return this.bus.subscribe(listener);
  }

  /** Reads a session. */
  get(id: string): Session | null {
    return this.store.getSession(id);
  }

  /** Reads a session or throws. */
  getRequired(id: string): Session {
    const session = this.get(id);
    if (!session) {
      throw new Error(`Unknown session: ${id}`);
    }
    return session;
  }

  /** Persists and applies events from a runner handle. */
  private async consumeEvents(id: string, handle: RunnerHandle): Promise<void> {
    for await (const event of handle.events) {
      this.persistEvent(id, event);
      if (event.kind === "assistant_message") {
        this.patch(id, { last_assistant_message: event.text });
      } else if (event.kind === "thinking") {
        this.patch(id, { status: "running" });
      } else if (event.kind === "turn_complete") {
        this.patch(id, { status: "awaiting_input" });
        this.bus.publish({ type: "hint", hint: { kind: "diff_changed", sessionId: id } });
      } else if (event.kind === "error") {
        this.patch(id, { status: "failed", pid: null });
      } else if (event.kind === "exit") {
        this.handleExit(id, event.code);
      }
    }
  }

  /** Applies an exit event to session status. */
  private handleExit(id: string, code: number | null): void {
    const session = this.get(id);
    if (!session) {
      return;
    }
    if (code !== 0) {
      this.patch(id, { status: "failed", pid: null });
      return;
    }
    if (session.status === "running") {
      this.patch(id, { status: "completed", pid: null });
    }
  }

  /** Persists a normalized event and publishes it. */
  private persistEvent(id: string, event: NormalizedEvent): void {
    const row = this.store.appendEvent(id, event);
    this.patch(id, { last_event_at: row.created_at });
    this.bus.publish({ type: "event", event: row });
  }

  /** Patches a session and publishes the resulting row. */
  private patch(id: string, patch: Partial<Pick<Session, "agent_thread_id" | "pid" | "status" | "last_assistant_message" | "last_event_at">>): void {
    this.store.updateSession(id, patch);
    const session = this.get(id);
    if (session) {
      this.bus.publish({ type: "session", session });
    }
  }

  /** Loads Helm config on demand. */
  private async loadHelmConfig(): Promise<HelmConfig> {
    this.cachedConfig ??= await loadConfig(this.configDir);
    return this.cachedConfig;
  }

  /** Builds a default pull request title from the first user message. */
  private defaultPullRequestTitle(session: Session): string {
    const prompt = this.store.listEvents(session.id).find((event) => event.kind === "user_message" && "text" in event.payload);
    const text = prompt?.payload.kind === "user_message" ? prompt.payload.text.trim() : "";
    return truncateTitle(text || `Helm session ${session.id}`);
  }
}

/** Truncates pull request titles to a concise length. */
function truncateTitle(value: string): string {
  return value.length > 72 ? `${value.slice(0, 69)}...` : value;
}
