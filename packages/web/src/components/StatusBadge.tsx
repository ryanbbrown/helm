import type { SessionStatus } from "@helm/core";
import { StatusPill } from "./ui/StatusPill";

/** Renders a compact session status badge. */
export function StatusBadge({ status }: { status: SessionStatus }) {
  return <StatusPill status={status} />;
}
