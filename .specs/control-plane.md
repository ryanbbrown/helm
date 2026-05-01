# Coding Agent Control Plane MVP

## Overview
This domain defines a multi-chat orchestration product where users manage many concurrent coding agent sessions across repositories through a clean messaging-first interface, so they can run, supervise, and steer autonomous coding work without relying on terminal-centric tooling.

## User stories
- A user can create a new chat session and bind it to a repository so that the agent has clear project context.
- A user can attach an existing repository or create a brand-new repository from a template so that project setup does not block execution.
- A user can choose where a session runs (local machine or remote sandbox) so that they can balance speed, cost, privacy, and reliability.
- A user can start multiple sessions in parallel so that they can make progress across many tasks and projects at once.
- A user can pause, resume, stop, and send follow-up guidance to a session so that they stay in control during long-running agent work.
- A user can view high-level session status, summaries, and outputs so that they can quickly triage progress without reading raw logs.
- A user can inspect key outputs (commits, branches, pull requests, artifacts) so that they can review and act on results.
- A user can switch between chats and optionally view multiple chats simultaneously so that they can coordinate parallel work efficiently.
- When a session fails, the system should show a clear failure state and next action options.
- When runtime capacity is constrained, the system should queue or defer starts predictably and surface expected wait behavior.
- When execution target connectivity is lost, the system should preserve session history and recover gracefully when possible.
- When a repository is already in use by another active session, the system should enforce safe isolation boundaries.

## Acceptance criteria
### Session and chat lifecycle
- GIVEN a user has workspace access, WHEN they create a new chat, THEN the system creates a distinct session record with unique identity and initial idle status.
- GIVEN a session is idle and fully configured, WHEN the user starts it, THEN the status transitions to running and execution begins in the selected target.
- GIVEN a running session, WHEN the user sends a new message, THEN the message is appended to the session timeline and routed to the active agent runtime.
- GIVEN a running session, WHEN the user pauses it, THEN active execution stops safely and status becomes paused without losing prior context.
- GIVEN a paused session, WHEN the user resumes it, THEN execution continues from preserved session context.
- GIVEN a running or paused session, WHEN the user stops it, THEN status becomes stopped and no further autonomous execution occurs unless explicitly restarted.
- GIVEN a stopped or failed session, WHEN the user duplicates it, THEN the system creates a new session seeded from selected prior context without mutating the original.

### Multi-chat orchestration and visibility
- GIVEN multiple sessions exist, WHEN the user opens the dashboard, THEN each session displays current status, repo binding, execution target, most recent activity time, and latest summary.
- GIVEN many active sessions, WHEN statuses change, THEN the dashboard updates within an acceptable near-real-time interval.
- GIVEN concurrent sessions in different repositories, WHEN all are running, THEN each progresses independently with no cross-session message mixing.
- GIVEN concurrent sessions in the same repository, WHEN both are configured, THEN the system requires separate isolation contexts before allowing both to run.
- GIVEN a user filters sessions by project, status, or runtime, WHEN filters are applied, THEN only matching sessions are shown.

### Repository lifecycle management
- GIVEN a user selects existing repository onboarding, WHEN repository validation succeeds, THEN the repository can be bound to one or more sessions under isolation rules.
- GIVEN a user selects new repository creation, WHEN they choose blank or template initialization, THEN the system provisions the repository and returns it in ready state for session binding.
- GIVEN a session is configured with a repository, WHEN execution starts, THEN work occurs in an isolated branch or workspace context that does not mutate default branch directly.
- GIVEN session work produces code changes, WHEN the agent completes or is stopped, THEN branch and commit outputs remain discoverable from the session output view.
- GIVEN a user archives or disconnects a repository, WHEN no active session depends on it, THEN repository linkage is removed from active dashboard scope.

### Execution target model (local and remote)
- GIVEN a user configures a local execution target, WHEN prerequisites are satisfied, THEN sessions can execute locally through the same session UX as remote targets.
- GIVEN a user configures a remote execution target, WHEN capacity is available, THEN sessions can execute remotely with equivalent lifecycle controls.
- GIVEN the same session type, WHEN run locally vs remotely, THEN core user controls and status semantics remain consistent.
- GIVEN a target becomes unavailable during execution, WHEN health checks fail, THEN the session transitions to degraded or failed state with recovery guidance.
- GIVEN policy restricts certain repositories or runtimes from local execution, WHEN a user attempts disallowed launch, THEN the launch is blocked with clear policy feedback.

### Agent adapter system
- GIVEN a supported agent runtime is connected, WHEN a user selects it for a session, THEN the session can start and exchange messages through a unified interface.
- GIVEN different runtimes have different native output formats, WHEN results are presented, THEN the system normalizes them into consistent session timeline entries and output summaries.
- GIVEN an adapter encounters unsupported runtime behavior, WHEN execution reaches that behavior, THEN the system reports a structured compatibility error without corrupting session history.
- GIVEN adapter authentication expires, WHEN the user starts or resumes a session, THEN the system requests re-authentication before execution proceeds.

### Output, summaries, and drill-down
- GIVEN a session has completed steps, WHEN the user views it, THEN they see user messages, agent thinking state indicator, and final or interim agent responses.
- GIVEN the system captures raw execution traces, WHEN the user does not open drill-down mode, THEN raw logs remain hidden by default.
- GIVEN a user opens session outputs, WHEN artifacts exist, THEN commits, pull requests, branches, and generated files are listed with source session attribution.
- GIVEN a long-running session, WHEN summary snapshots are generated, THEN users can read concise progress summaries without scanning full transcripts.

### Mobile and lightweight control
- GIVEN a user accesses from mobile, WHEN viewing sessions, THEN they can check status, read summaries, approve prompts, and send short guidance.
- GIVEN mobile constraints, WHEN complex inspection is needed, THEN the system can defer advanced views to desktop while preserving session continuity.

### Extensibility for future task workflows
- GIVEN task objects are introduced later, WHEN they are linked to sessions, THEN session lifecycle and chat UX remain valid without schema-breaking migration.
- GIVEN future task-first workflows, WHEN enabled, THEN they can orchestrate sessions as reusable execution units rather than replacing the session model.

## Constraints
- v1 does not provide a full IDE, code editor, or terminal multiplexer experience.
- v1 does not require exposing full raw logs in primary UI and may omit deep log visualization entirely.
- v1 does not include autonomous portfolio-level planning, dependency graph scheduling, or multi-agent debate workflows.
- v1 does not support unrestricted cross-session shared memory that could leak context between projects.
- v1 must enforce isolation so active sessions cannot directly overwrite each other’s working state in the same repository context.
- v1 must preserve an auditable timeline of user instructions and agent-visible responses per session.
- v1 must provide role-appropriate access control for repository binding, execution launch, and output visibility.
- v1 must meet baseline accessibility expectations for keyboard navigation and readable status signaling.
- v1 should keep status and summary views responsive under high session counts expected in orchestration use.
- v1 should prioritize reliability of lifecycle controls (start, pause, resume, stop) over advanced visualization.
- v1 should avoid coupling core session model to any single vendor runtime so adapters remain replaceable.

## Open questions
- [NEEDS CLARIFICATION] What is the precise user persona for MVP: single power user only, small team, or mixed tenancy from day one?
- [NEEDS CLARIFICATION] Should a single chat/session ever be allowed to span multiple repositories, or must it always bind to exactly one repository?
- [NEEDS CLARIFICATION] What repository template sources are in scope for v1 (local templates, hosted templates, organization-curated templates)?
- [NEEDS CLARIFICATION] What are the required approval checkpoints (for example: command execution, branch push, pull request creation, secret access)?
- [NEEDS CLARIFICATION] What level of “thinking” visibility is acceptable, given provider policy differences and possible redaction requirements?
- [NEEDS CLARIFICATION] Are session summaries generated continuously, on demand, or only at lifecycle milestones?
- [NEEDS CLARIFICATION] What is the expected maximum number of concurrently running sessions per user for MVP sizing?
- [NEEDS CLARIFICATION] Should queued sessions support priority ordering, and if so, what rules determine priority?
- [NEEDS CLARIFICATION] How should retries behave after failure: manual only, policy-based automatic retry, or both?
- [NEEDS CLARIFICATION] What minimum artifact set is mandatory for v1 outputs (commits only vs commits plus PRs plus downloadable artifacts)?
- [NEEDS CLARIFICATION] Are local and remote execution targets both mandatory for initial launch, or can one ship first behind the same conceptual model?
- [NEEDS CLARIFICATION] What security posture is required for remote sandboxes (network policy strictness, secret injection policy, data retention windows)?
- [NEEDS CLARIFICATION] Should users be able to move an in-progress session between local and remote targets, or only between runs?
- [NEEDS CLARIFICATION] Which agent runtimes are required at MVP launch, and what qualifies as “supported” vs “experimental” adapter status?
- [NEEDS CLARIFICATION] What mobile interactions are required for GA versus deferred (for example: approvals only vs full message authoring)?
- [NEEDS CLARIFICATION] What notification channels are required in MVP (in-app only, email, push, chat integrations)?
- [NEEDS CLARIFICATION] What retention and deletion guarantees are required for transcripts, summaries, and artifacts?
- [NEEDS CLARIFICATION] Should repository creation from templates include optional initial CI/setup scaffolding, or remain minimal?
- [NEEDS CLARIFICATION] How should session ownership and handoff work if multiple humans can supervise the same session?
- [NEEDS CLARIFICATION] What explicit v1 boundary should separate “chat orchestration” from future “task orchestration” in user-facing language?
