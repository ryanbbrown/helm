import type { SessionStatus } from "@helm/core";

/** Renders a compact status pill. */
export function StatusPill({ status }: { status: SessionStatus }) {
  return <span className={`status-pill status-${status}`}>{status.replace("_", " ")}</span>;
}
