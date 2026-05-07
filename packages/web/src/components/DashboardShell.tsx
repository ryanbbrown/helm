import type { ReactNode } from "react";

type DashboardShellProps = {
  sidebar: ReactNode;
  detail: ReactNode;
};

/** Renders dashboard layout around session navigation and details. */
export function DashboardShell({ sidebar, detail }: DashboardShellProps) {
  return (
    <main className="dashboard-shell">
      {sidebar}
      <section className="dashboard-main">{detail}</section>
    </main>
  );
}
