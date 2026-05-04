# Coding Agent Control Plane Tools

| Tool | Fit for this idea | Notes |
|---|---:|---|
| **Maestro** | Very high | Cross-platform desktop agent command center. Supports Claude Code, Codex, OpenCode, Factory Droid, and similar coding agents. Includes worktrees, session discovery, group chat, mobile/remote control, and remote execution patterns. |
| **Nimbalyst** | Very high | Visual workspace for Codex and Claude Code. Successor to Crystal. Supports parallel sessions, kanban-style task management, worktrees, inline diffs, and mobile workflows. |
| **Superset** | Very high | Code editor/workspace for running many AI coding agents locally. Emphasizes git-worktree isolation, monitoring, and support for multiple agents such as Claude Code and Codex. |
| **Vibe Kanban** | High | Kanban/project-management layer for coding agents. Supports Claude Code, Codex, Gemini CLI, OpenCode, and workspace-based execution. Useful reference for task-board-driven orchestration. |
| **Conductor** | High | Polished Mac app for running parallel Claude Code and Codex agents in isolated git worktrees. Includes dashboard, review, and merge-oriented workflows. |
| **Helmor** | High | Open-source local workbench for multi-agent software development. Focuses on orchestration, review, testing, merge, and running Claude Code/Codex-style agents side by side. |
| **Intent / Augment** | High but more opinionated | Developer workspace built around coordinated agents, live specs, and isolated workspaces. More spec-driven and productized than a raw local session manager. |
| **1Code** | High | UI for Claude Code with local and remote agent execution. Public references mention Claude Code, OpenCode, Codex, isolated worktrees, integrated terminal, and visual change tracking. |
| **CliDeck** | Medium-high | Browser dashboard for Claude Code, Codex, Gemini CLI, and OpenCode. Includes live status, session resume, mobile relay, and autopilot-style routing. |
| **agent-kanban / agtx** | Medium-high | Kanban-first multi-agent boards. agent-kanban supports Claude Code, Codex, Gemini CLI, and Copilot CLI. agtx uses git worktrees/tmux with an orchestrator. |
| **Agent Deck / CCManager / Agent of Empires** | Medium | Terminal/TUI session managers for multiple coding agents, usually worktree/tmux-based. Strong for local operations, weaker for manager-chat orchestration. |
| **cmux / dmux / herdr / amux** | Medium | Terminal/multiplexer layer for running many agents side by side. Useful as an execution substrate, but less of a full project-management or control-plane layer. |
| **Constellagent / parallel-code / multiclaude** | Medium | Smaller open-source implementations around parallel agents, terminals, branches, and git worktrees. Useful design references rather than mature products. |
| **handclaw / Untether** | Medium, mobile-first | Mobile or chat-channel bridges for controlling Claude Code, Codex, OpenCode, or similar agents remotely. More remote-control layer than full IDE/control plane. |
| **OpenAI Symphony / Claude Agent Teams / GitHub Agent HQ** | Important references | Formal orchestration references: issue/task orchestration, lead-agent coordination, or GitHub-native mission-control patterns for multiple coding agents. |

## Takeaway

The category is real and increasingly crowded. The main gap is not “a multi-agent coding dashboard.” The stronger gap is a local/cloud hybrid, agent-agnostic, chat-native manager that can supervise many sessions, synthesize state, delegate work, route questions, coordinate dependencies, and maintain durable project/task memory across agents.

The first tools to evaluate before building are:

1. Maestro
2. Nimbalyst
3. Superset
4. Vibe Kanban
5. Conductor
6. Helmor
7. Intent / Augment
8. CliDeck
