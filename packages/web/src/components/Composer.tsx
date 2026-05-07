"use client";

import { Send } from "lucide-react";
import { forwardRef, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { InlineNotice } from "./InlineNotice";
import { Button } from "./ui/Button";
import { Textarea } from "./ui/Textarea";

type ComposerProps = {
  label: string;
  placeholder: string;
  disabled?: boolean;
  submitLabel?: string;
  submitIcon?: ReactNode;
  textareaName?: string;
  className?: string;
  onSubmit: (text: string) => Promise<void>;
};

/** Renders an autosizing keyboard-friendly message composer. */
export const Composer = forwardRef<HTMLTextAreaElement, ComposerProps>(function Composer(
  { label, placeholder, disabled = false, submitLabel = "Send", submitIcon = <Send size={15} />, textareaName, className = "", onSubmit },
  forwardedRef
) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  /** Stores the textarea node in local and forwarded refs. */
  function setTextareaRef(node: HTMLTextAreaElement | null): void {
    textareaRef.current = node;
    if (typeof forwardedRef === "function") {
      forwardedRef(node);
    } else if (forwardedRef) {
      forwardedRef.current = node;
    }
  }

  useEffect(() => {
    const node = textareaRef.current;
    if (!node) {
      return;
    }
    node.style.height = "0px";
    node.style.height = `${Math.min(node.scrollHeight, 180)}px`;
  }, [text]);

  /** Submits the current composer text. */
  async function submit(): Promise<void> {
    const value = text.trim();
    if (!value || disabled || sending) {
      return;
    }
    setSending(true);
    setError(null);
    try {
      await onSubmit(value);
      setText("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  }

  /** Handles composer keyboard shortcuts. */
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === "Escape" && text) {
      event.preventDefault();
      setText("");
      setError(null);
      return;
    }
    const wantsSend = event.key === "Enter" && (!event.shiftKey || event.metaKey || event.ctrlKey);
    if (!wantsSend) {
      return;
    }
    event.preventDefault();
    void submit();
  }

  return (
    <form className={`composer ${className}`.trim()} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label className="sr-only" htmlFor={`${label.replace(/\W+/g, "-").toLowerCase()}-composer`}>{label}</label>
      <Textarea
        id={`${label.replace(/\W+/g, "-").toLowerCase()}-composer`}
        name={textareaName}
        ref={setTextareaRef}
        disabled={disabled || sending}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        rows={1}
      />
      {error ? <InlineNotice tone="error">{error}</InlineNotice> : null}
      <div className="composer-actions">
        <Button variant="primary" type="submit" disabled={disabled || sending || !text.trim()}>
          {submitIcon}
          {sending ? `${submitLabel}ing` : submitLabel}
        </Button>
      </div>
    </form>
  );
});
