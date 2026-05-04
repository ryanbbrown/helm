Coding Agent Control Plane — Product Brief

Goal

Build a local/cloud-capable command center for running multiple coding agents across multiple repositories and tasks. The product should make it easy to create, monitor, steer, and review many agent sessions without manually managing terminal tabs, tmux panes, repo clones, branches, and task state.

The core idea is not just “a nicer terminal UI.” It is a higher-level control plane where the user can interact with individual agent sessions when needed, but can also use a single manager-level chat/interface that receives updates from all active sessions, asks clarifying questions, delegates work, summarizes progress, and helps decide what to do next.

Core Use Case

A developer wants to run several coding agents in parallel. Some may be Claude Code sessions, some may be Codex sessions, and eventually other CLI or API-based coding agents. The developer should be able to start a task, assign it to an agent, watch status updates, inspect diffs, intervene when needed, and merge or discard the result.

The system should support both local execution and cloud/remote execution. Locally, it should use isolated git worktrees. In cloud mode, it should use isolated workspace containers or VMs created from a remote Git repository.

Key Product Principles

* Do not require the user to watch raw terminal streams by default.
* Preserve access to the raw terminal/session when needed.
* Treat each coding session as a durable task with state, logs, branch, diff, and summary.
* Use isolated workspaces so agents do not step on each other’s files.
* Make it easy to run heterogeneous agents, not just one vendor’s model or CLI.
* Prefer simple primitives first: repos, workspaces, sessions, tasks, branches, diffs, and messages.
* Add more advanced autonomous orchestration later, after the core multi-session control plane works.

MVP Scope

The MVP should focus on being a clean multi-agent, multi-repo workspace manager.

MVP Features

1. Repository registry
    * Add a local repo or remote Git repo.
    * Track repo name, path/URL, default branch, and workspace root.
2. Session creation
    * Create a new agent session from a selected repo.
    * Create an isolated git worktree and branch for each local session.
    * For cloud/remote mode, create an isolated clone/container per session.
    * Store session metadata: task name, agent type, branch, worktree path, status, created time, last update.
3. Agent runner abstraction
    * Support pluggable agent runners.
    * Initial runners can be shell-command based, for example:
        * claude
        * codex
        * aider
        * custom command template
    * Each runner should define how to start a session, pass an initial prompt, resume if supported, and collect output.
4. Session dashboard
    * Show all active and completed sessions.
    * Include status, repo, branch, agent type, last activity, and short summary.
    * Allow opening the raw terminal/log view for any session.
5. Diff/review view
    * Show changed files per session.
    * Show git diff.
    * Allow the user to accept, reject, or manually continue work.
    * Optionally create a PR or push branch.
6. Manager chat / command interface
    * Provide a top-level chat-like interface where the user can ask:
        * “What is each agent doing?”
        * “Which sessions need my input?”
        * “Summarize progress on auth refactor.”
        * “Start a new Claude Code session on repo X to fix issue Y.”
    * In MVP, this can be mostly deterministic/tool-driven rather than fully autonomous.
    * The manager should read structured session state, logs, summaries, and diffs.

Important Non-Goals for MVP

* Do not build a complex autonomous planner first.
* Do not require deep integration with every coding agent on day one.
* Do not build a full project-management system before the session/workspace model is solid.
* Do not depend on only one vendor or one CLI.
* Do not hide the underlying git model from power users.

Recommended Local Workspace Model

Use git worktrees for local execution.

Example layout:

~/agent-workspaces/
  repos/
    my-repo/                         # canonical local clone
  worktrees/
    my-repo/
      task-123-claude/
      task-124-codex/
      spike-auth-refactor/

Example session creation:

git fetch origin
git worktree add ~/agent-workspaces/worktrees/my-repo/task-123-claude \
  -b agent/task-123-claude origin/main
cd ~/agent-workspaces/worktrees/my-repo/task-123-claude
claude

Each session should have:

* its own worktree
* its own branch
* its own agent conversation/log state
* isolated environment variables where possible
* isolated ports where needed
* optionally isolated database/test resources

Recommended Cloud Workspace Model

For cloud execution, use an isolated container or VM per task/session.

The cloud flow should be:

1. Start from a remote Git repository.
2. Clone the repo into an isolated workspace.
3. Check out a new task branch.
4. Run the selected coding agent in that workspace.
5. Persist logs, summaries, diffs, and session metadata.
6. Push the branch or open a PR when complete.
7. Tear down or archive the workspace.

Cloud mode should treat the remote Git repo as the source of truth. Local mode can optimize with shared repo caches and git worktrees.

Core Data Model

Suggested entities:

type Repo = {
  id: string;
  name: string;
  remoteUrl?: string;
  localPath?: string;
  defaultBranch: string;
};
type AgentRunner = {
  id: string;
  name: string;
  commandTemplate: string;
  supportsResume: boolean;
  supportsNonInteractivePrompt: boolean;
};
type Session = {
  id: string;
  repoId: string;
  taskTitle: string;
  agentRunnerId: string;
  branchName: string;
  workspacePath: string;
  status: "created" | "running" | "blocked" | "complete" | "failed" | "archived";
  summary?: string;
  lastUpdate?: string;
  createdAt: string;
  updatedAt: string;
};
type SessionEvent = {
  id: string;
  sessionId: string;
  type: "log" | "status" | "summary" | "user_message" | "agent_message" | "diff" | "error";
  content: string;
  createdAt: string;
};

UI Shape

A reasonable first UI could have three panes:

1. Left pane: repos and sessions
    * Repo list
    * Active sessions grouped by repo
    * Status indicators
2. Center pane: selected session
    * Session summary
    * Timeline/logs
    * Terminal output when expanded
    * Current branch and task state
3. Right pane: review / manager
    * Diff view
    * Manager chat
    * Actions: continue, pause, archive, push branch, create PR

The manager chat can be global rather than tied to one selected session.

Agent Runner Design

Start with a generic process runner. Do not overfit to one agent’s internals.

A runner should be configurable with:

* executable path
* startup command
* working directory
* environment variables
* whether it needs a PTY
* whether it accepts a non-interactive initial prompt
* how to detect completion/blocking/failure if possible

Example config:

{
  "id": "claude-code",
  "name": "Claude Code",
  "commandTemplate": "claude",
  "requiresPty": true,
  "supportsResume": true,
  "supportsNonInteractivePrompt": false
}
{
  "id": "codex",
  "name": "Codex CLI",
  "commandTemplate": "codex",
  "requiresPty": true,
  "supportsResume": true,
  "supportsNonInteractivePrompt": true
}

Manager Chat Behavior

The manager should not be magical in the first version. It should operate over structured tools:

* list repos
* list sessions
* read session summary
* read session logs
* read git status
* read git diff
* create session
* send message to session, if supported
* mark session blocked/complete/archived
* push branch
* create PR

The manager’s job is to synthesize state and help the user take action, not to replace the lower-level sessions entirely on day one.

Design Questions to Resolve

* Should the app be desktop-first, web-first, or local server plus web UI?
* Should local execution use the user’s shell directly, Docker, or both?
* How much should the app understand each agent’s native session/resume model?
* Should session summaries be generated by a separate model call, by the agent itself, or manually from logs?
* How should the manager chat communicate with agents that do not expose a clean message API?
* Should each task always map to one branch, or can multiple sessions collaborate on one branch?
* What is the minimal cloud execution backend: SSH machine, Docker host, Fly.io, Modal, Kubernetes, or custom VM workers?

Reference Products / Projects

Use these as conceptual references:

* OpenAI Codex app: polished agent app, worktree-based local task isolation, Codex-centric.
* Claude Code desktop app: GUI wrapper around Claude Code sessions, terminal/editor/diff integration.
* Conductor / Conductor OSS: local-first parallel coding-agent workspace manager.
* Code Conductor: GitHub/worktree-oriented orchestration around issues and coding agents.
* Symphony: task-board-driven orchestration model where a control plane delegates tasks to coding agents.

Suggested Build Order

1. Implement repo registry.
2. Implement local git worktree creation and cleanup.
3. Implement generic PTY process runner.
4. Add session metadata persistence using SQLite.
5. Add dashboard showing sessions and logs.
6. Add git status/diff view per session.
7. Add configurable agent runners.
8. Add manager chat with read-only tools over session state.
9. Add manager actions for creating sessions and pushing branches.
10. Add cloud workspace abstraction after local flow works.

Success Criteria

The MVP is successful if a developer can:

* register a repo
* start three isolated coding-agent sessions on three branches
* see what each one is doing without switching terminal tabs
* open any raw session when needed
* inspect diffs for each session
* ask a top-level interface what needs attention
* continue, archive, push, or create a PR from completed work

The product should feel like a command center for coding agents, not just a prettier terminal multiplexer.