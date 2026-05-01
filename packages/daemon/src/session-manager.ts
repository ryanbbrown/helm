import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createId, logPath, worktreePath, type NormalizedEvent, type Session, type SessionEvent } from "@helm/core";
import { findAgent, findRepo, loadConfig, type HelmConfig } from "./config-loader";
import { deleteBranch, fetchOrigin, createWorktree as gitCreateWorktree, removeWorktree as gitRemoveWorktree, unsharedCommits, worktreeStatus } from "./git";
import { Store } from "./store";
import { createRunnerAdapter } from "./runner";
import type { RunnerHandle } from "./runner/types";
import { EventBus, type BusEvent } from "./event-bus";

export type SessionManagerOptions = {
  config?: HelmConfig;
  configDir?: string;
  store?: Store;
  bus?: EventBus;
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

export class ArchiveSafetyError extends Error {
  /** Creates an archive safety error. */
  constructor(
    readonly code: "dirty_worktree" | "unshared_commits",
    readonly details: string
  ) {
    super(code);
  }
}

export class SessionManager {
  private store: Store;
  private bus: EventBus;
  private handles = new Map<string, RunnerHandle>();
  private cachedConfig?: HelmConfig;
  private configDir?: string;

  /** Creates a session manager. */
  constructor(options: SessionManagerOptions = {}) {
    this.store = options.store ?? new Store();
    this.bus = options.bus ?? new EventBus();
    this.cachedConfig = options.config;
    this.configDir = options.configDir;
  }

  /** Creates a worktree-backed agent session. */
  async create(input: CreateSessionInput): Promise<Session> {
    const config = await this.loadHelmConfig();
    const repo = findRepo(config, input.repo);
    const agent = findAgent(config, input.agent);
    const id = createId();
    const branch = `helm/${id}`;
    const wtPath = worktreePath(repo.name, id);
    const now = new Date().toISOString();

    await fetchOrigin(repo.path);
    mkdirSync(dirname(wtPath), { recursive: true });
    await gitCreateWorktree(repo.path, branch, wtPath, repo.default_branch);
    this.store.insertSession({
      id,
      repo_name: repo.name,
      agent_name: agent.name,
      branch,
      worktree_path: wtPath,
      status: "created",
      created_at: now,
      updated_at: now
    });
    this.persistEvent(id, {
      kind: "session_started",
      sessionId: id,
      repo: repo.name,
      branch,
      worktreePath: wtPath
    });
    if (input.prompt) {
      this.persistEvent(id, { kind: "user_message", text: input.prompt });
    }

    const adapter = createRunnerAdapter(agent);
    const handle = adapter.spawn({
      command: agent.command,
      cwd: wtPath,
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
    if (!options.force) {
      await this.assertArchiveSafe(repo.path, session);
    }
    const handle = this.handles.get(id);
    if (handle) {
      await handle.stop();
      this.handles.delete(id);
    }
    await gitRemoveWorktree(repo.path, session.worktree_path);
    await deleteBranch(repo.path, session.branch);
    this.patch(id, { status: "archived", pid: null });
    return this.getRequired(id);
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

  /** Refuses destructive archive when work could be lost. */
  private async assertArchiveSafe(repoPath: string, session: Session): Promise<void> {
    const dirty = await worktreeStatus(session.worktree_path);
    if (dirty) {
      throw new ArchiveSafetyError("dirty_worktree", dirty);
    }
    const commits = await unsharedCommits(repoPath, session.branch);
    if (commits) {
      throw new ArchiveSafetyError("unshared_commits", commits);
    }
  }
}
