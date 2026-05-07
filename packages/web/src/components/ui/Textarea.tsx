import { forwardRef, type TextareaHTMLAttributes } from "react";

/** Renders a dashboard textarea. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(props, ref) {
  return <textarea className={`ui-textarea ${props.className ?? ""}`.trim()} ref={ref} {...props} />;
});
