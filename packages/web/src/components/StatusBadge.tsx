import type { SessionStatus } from "@helm/core";

/** Renders a compact session status badge. */
export function StatusBadge({ status }: { status: SessionStatus }) {
  return <span className={`badge ${status}`}>{status.replace("_", " ")}</span>;
}
