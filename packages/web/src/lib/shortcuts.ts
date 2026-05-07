"use client";

import { useEffect } from "react";

export type ShortcutBinding = {
  key: string;
  run: () => void;
};

/** Returns true when a keyboard event started inside editable content. */
export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

/** Registers global dashboard shortcuts that do not hijack text entry. */
export function useGlobalShortcuts(bindings: ShortcutBinding[]): void {
  useEffect(() => {
    /** Handles one global shortcut keydown. */
    function onKeyDown(event: KeyboardEvent): void {
      if (event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) {
        return;
      }
      const binding = bindings.find((entry) => entry.key === event.key);
      if (!binding) {
        return;
      }
      event.preventDefault();
      binding.run();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bindings]);
}
