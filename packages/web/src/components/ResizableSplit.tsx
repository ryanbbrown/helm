"use client";

import { type KeyboardEvent, type ReactNode, useEffect, useState } from "react";

type ResizableSplitProps = {
  storageKey: string;
  left: ReactNode;
  right: ReactNode;
};

const MIN_RIGHT_WIDTH = 320;
const MAX_RIGHT_WIDTH = 920;

/** Renders a two-pane split with a persisted draggable divider. */
export function ResizableSplit({ storageKey, left, right }: ResizableSplitProps) {
  const [rightWidth, setRightWidth] = useState(520);

  useEffect(() => {
    const saved = window.localStorage.getItem(storageKey);
    if (saved) {
      setRightWidth(Number(saved));
    }
  }, [storageKey]);

  useEffect(() => {
    window.localStorage.setItem(storageKey, String(rightWidth));
  }, [rightWidth, storageKey]);

  /** Starts pointer dragging for the divider. */
  function startDrag() {
    const move = (event: PointerEvent) => {
      setRightWidth(clamp(window.innerWidth - event.clientX));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  /** Handles keyboard resizing for the divider. */
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") {
      setRightWidth((current) => clamp(current + 32));
    } else if (event.key === "ArrowRight") {
      setRightWidth((current) => clamp(current - 32));
    }
  }

  return (
    <div className="split" style={{ gridTemplateColumns: `minmax(0, 1fr) 8px minmax(${MIN_RIGHT_WIDTH}px, ${rightWidth}px)` }}>
      <div className="split-pane">{left}</div>
      <div
        aria-label="Resize diff panel"
        aria-valuemax={MAX_RIGHT_WIDTH}
        aria-valuemin={MIN_RIGHT_WIDTH}
        aria-valuenow={rightWidth}
        className="split-divider"
        role="separator"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={startDrag}
      />
      <div className="split-pane">{right}</div>
    </div>
  );
}

/** Keeps the diff panel width inside supported bounds. */
function clamp(value: number): number {
  return Math.max(MIN_RIGHT_WIDTH, Math.min(MAX_RIGHT_WIDTH, value));
}
