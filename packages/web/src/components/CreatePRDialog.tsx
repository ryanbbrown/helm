"use client";

import { ExternalLink } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import type { PublicSession, PublicSessionEvent } from "@helm/core";
import { ApiError, createPullRequest } from "../lib/api";
import { isEditableTarget } from "../lib/shortcuts";
import { Button } from "./ui/Button";
import { Textarea } from "./ui/Textarea";

type CreatePRDialogProps = {
  session: PublicSession;
  events: PublicSessionEvent[];
  onClose: () => void;
  onCreated: (session: PublicSession) => void;
};

/** Renders the pull request creation dialog. */
export function CreatePRDialog({ session, events, onClose, onCreated }: CreatePRDialogProps) {
  const defaultTitle = useMemo(() => defaultPullRequestTitle(session, events), [events, session]);
  const [title, setTitle] = useState(defaultTitle);
  const [body, setBody] = useState(`Created from Helm session ${session.id}.`);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    /** Closes the PR dialog when Escape is pressed outside editable controls. */
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape" && !isEditableTarget(event.target)) {
        onClose();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  /** Submits the pull request request to the daemon. */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const updated = await createPullRequest(session.id, { title, body });
      onCreated(updated);
      onClose();
    } catch (cause) {
      setError(formatPullRequestError(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal" onSubmit={(event) => void submit(event)} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-title">Create PR</div>
        <label>
          <span>Title</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          <span>Body</span>
          <Textarea value={body} onChange={(event) => setBody(event.target.value)} />
        </label>
        {error ? <div className="error-line">{error}</div> : null}
        <div className="modal-actions">
          <Button type="button" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={submitting || !title.trim()}>
            <ExternalLink size={15} />
            {submitting ? "Creating" : "Create PR"}
          </Button>
        </div>
      </form>
    </div>
  );
}

/** Builds a title from the first user message. */
function defaultPullRequestTitle(session: PublicSession, events: PublicSessionEvent[]): string {
  const event = events.find((entry) => entry.kind === "user_message" && entry.payload.kind === "user_message");
  const text = event?.payload.kind === "user_message" ? event.payload.text.trim() : "";
  const fallback = `Helm session ${session.id}`;
  return truncate(text || fallback);
}

/** Truncates dialog title defaults. */
function truncate(value: string): string {
  return value.length > 72 ? `${value.slice(0, 69)}...` : value;
}

/** Formats structured daemon PR errors for display. */
function formatPullRequestError(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.code === "dirty_worktree") {
      return `Commit or discard uncommitted work first.\n${cause.details ?? ""}`.trim();
    }
    if (cause.code === "no_commits_ahead") {
      return "This branch has no commits ahead of the default branch.";
    }
    if (cause.code === "gh_unavailable") {
      return `GitHub CLI is unavailable or unauthenticated.\n${cause.details ?? ""}`.trim();
    }
    if (cause.code === "non_github_remote") {
      return "The origin remote is not a GitHub repository.";
    }
    return cause.details ?? cause.message;
  }
  return cause instanceof Error ? cause.message : String(cause);
}
