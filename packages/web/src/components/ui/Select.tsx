import type { SelectHTMLAttributes } from "react";

/** Renders a dashboard select control. */
export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`ui-select ${props.className ?? ""}`.trim()} {...props} />;
}
