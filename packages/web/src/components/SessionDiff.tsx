"use client";

import dynamic from "next/dynamic";
import { ChevronDown, ChevronRight, ExternalLink, GitCompare, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DiffBase, DiffFileEntry, DiffResult, PublicSession, PublicSessionEvent } from "@helm/core";
import { ApiError, getSessionDiff } from "../lib/api";
import { CreatePRDialog } from "./CreatePRDialog";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";

const LazyPatchDiff = dynamic(() => import("./SessionPatchDiff").then((mod) => mod.SessionPatchDiff), {
  ssr: false,
  loading: () => <div className="diff-placeholder">Loading diff renderer...</div>
});

type SessionDiffProps = {
  session: PublicSession;
  events: PublicSessionEvent[];
  diffRefreshToken: number;
  onSessionUpdate: (session: PublicSession) => void;
};

/** Renders the per-session diff review panel. */
export function SessionDiff({ session, events, diffRefreshToken, onSessionUpdate }: SessionDiffProps) {
  const storageKey = `helm.diffBase.${session.id}`;
  const [base, setBase] = useState<DiffBase>("branch");
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPrDialog, setShowPrDialog] = useState(false);
  const refreshTimer = useRef<number | null>(null);
  const seenDiffRefreshToken = useRef(diffRefreshToken);

  useEffect(() => {
    const saved = window.localStorage.getItem(storageKey);
    if (saved === "branch" || saved === "uncommitted") {
      setBase(saved);
    }
  }, [storageKey]);

  useEffect(() => {
    window.localStorage.setItem(storageKey, base);
  }, [base, storageKey]);

  const refresh = useCallback(async () => {
    if (session.status === "archived") {
      return;
    }
    setLoading(true);
    try {
      setDiff(await getSessionDiff(session.id, base));
      setError(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "archived") {
        setError("Diff unavailable - session archived.");
      } else {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      setLoading(false);
    }
  }, [base, session.id, session.status]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current !== null) {
      window.clearTimeout(refreshTimer.current);
    }
    refreshTimer.current = window.setTimeout(() => void refresh(), 250);
  }, [refresh]);

  useEffect(() => {
    if (seenDiffRefreshToken.current === diffRefreshToken) {
      return;
    }
    seenDiffRefreshToken.current = diffRefreshToken;
    scheduleRefresh();
  }, [diffRefreshToken, scheduleRefresh]);

  useEffect(() => {
    return () => {
      if (refreshTimer.current !== null) {
        window.clearTimeout(refreshTimer.current);
      }
    };
  }, []);

  /** Toggles a file patch open or closed. */
  function toggle(path: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }

  const emptyText = useMemo(() => base === "branch" ? "No branch changes." : "No uncommitted changes.", [base]);

  if (session.status === "archived") {
    return <div className="diff-panel"><div className="diff-placeholder">Diff unavailable - session archived.</div></div>;
  }

  return (
    <div className="diff-panel">
      <div className="diff-header">
        <div>
          <div className="title">Diff</div>
          <div className="muted">{diff ? `${diff.totalFiles} files` : "Worktree changes"}</div>
        </div>
        <div className="diff-actions">
          <div className="segment">
            <button className={base === "branch" ? "active" : ""} type="button" onClick={() => setBase("branch")}>Branch</button>
            <button className={base === "uncommitted" ? "active" : ""} type="button" onClick={() => setBase("uncommitted")}>Uncommitted</button>
          </div>
          <IconButton label="Refresh diff" onClick={() => void refresh()}>
            <RefreshCw size={15} />
          </IconButton>
          {session.pull_request_url ? (
            <a className="button-link" href={session.pull_request_url} rel="noreferrer" target="_blank">
              <ExternalLink size={15} />
              View PR
            </a>
          ) : (
            <Button type="button" disabled={session.status === "running"} onClick={() => setShowPrDialog(true)}>
              <GitCompare size={15} />
              Create PR
            </Button>
          )}
        </div>
      </div>
      <div className="diff-scroll">
        {error ? <div className="error-line">{error}</div> : null}
        {diff?.truncated ? <div className="diff-banner">Showing first {diff.fileLimit} of {diff.totalFiles} files.</div> : null}
        <div className="diff-files">
          {loading && !diff ? <div className="diff-placeholder">Loading diff...</div> : null}
          {!loading && diff && diff.files.length === 0 ? <div className="diff-placeholder">{emptyText}</div> : null}
          {diff?.files.map((file) => (
            <DiffFile key={`${file.oldPath ?? ""}:${file.path}`} file={file} expanded={expanded.has(file.path)} onToggle={() => toggle(file.path)} />
          ))}
        </div>
      </div>
      {showPrDialog ? <CreatePRDialog session={session} events={events} onClose={() => setShowPrDialog(false)} onCreated={onSessionUpdate} /> : null}
    </div>
  );
}

/** Renders one file row and optional patch body. */
function DiffFile({ file, expanded, onToggle }: { file: DiffFileEntry; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="diff-file">
      <button className="diff-file-header" type="button" onClick={onToggle}>
        {expanded ? <ChevronDown className="diff-chevron" size={16} /> : <ChevronRight className="diff-chevron" size={16} />}
        <span className="diff-path">{file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path}</span>
        <span className="diff-stat">+{file.additions} -{file.deletions}</span>
      </button>
      {expanded ? <DiffFileBody file={file} /> : null}
    </div>
  );
}

/** Renders the expanded contents for one diff file. */
function DiffFileBody({ file }: { file: DiffFileEntry }) {
  if (file.isBinary) {
    return <div className="diff-placeholder">Binary file changed, {formatSize(file.oldSize)} to {formatSize(file.newSize)}.</div>;
  }
  if (file.isTooLarge) {
    return <div className="diff-placeholder">File too large to render - showing summary only.</div>;
  }
  if (!file.patch) {
    return <div className="diff-placeholder">No patch text available.</div>;
  }
  return <LazyPatchDiff patch={file.patch} />;
}

/** Formats optional byte sizes for binary placeholders. */
function formatSize(value: number | undefined): string {
  return value === undefined ? "unknown" : `${value} bytes`;
}
