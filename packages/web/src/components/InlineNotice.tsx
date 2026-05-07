import type { ReactNode } from "react";

type InlineNoticeProps = {
  tone?: "info" | "error" | "warning";
  children: ReactNode;
};

/** Renders a compact inline notice near the related control. */
export function InlineNotice({ tone = "info", children }: InlineNoticeProps) {
  return <div className={`inline-notice inline-notice-${tone}`}>{children}</div>;
}
