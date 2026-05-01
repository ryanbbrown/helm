"use client";

import { Send } from "lucide-react";
import { useState } from "react";

type ComposerProps = {
  disabled: boolean;
  onSend: (text: string) => Promise<void>;
};

/** Renders the follow-up composer. */
export function Composer({ disabled, onSend }: ComposerProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  /** Sends the current composer text. */
  async function submit(): Promise<void> {
    const value = text.trim();
    if (!value) {
      return;
    }
    setSending(true);
    try {
      await onSend(value);
      setText("");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="composer">
      <textarea disabled={disabled || sending} value={text} onChange={(event) => setText(event.target.value)} placeholder="Send a follow-up" />
      <div className="composer-actions">
        <button className="primary" type="button" disabled={disabled || sending} onClick={submit}>
          <Send size={15} />
          Send
        </button>
      </div>
    </div>
  );
}
