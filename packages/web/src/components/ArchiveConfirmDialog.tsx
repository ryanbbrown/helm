"use client";

import { Archive } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "./ui/Button";

type ArchiveConfirmDialogProps = {
  details: string;
  archiving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

/** Renders an explicit archive confirmation for unsafe worktree removal. */
export function ArchiveConfirmDialog({ details, archiving, onCancel, onConfirm }: ArchiveConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    /** Closes the archive dialog when Escape is pressed. */
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <div aria-labelledby="archive-dialog-title" aria-modal="true" className="modal" role="dialog" onMouseDown={(event) => event.stopPropagation()}>
        <div>
          <div className="modal-title" id="archive-dialog-title">Archive session?</div>
          <p className="modal-copy">Archiving will remove this session worktree and local branch. The daemon reported work that may be lost.</p>
        </div>
        <pre className="modal-details">{details}</pre>
        <div className="modal-actions">
          <Button ref={cancelRef} type="button" onClick={onCancel}>Cancel</Button>
          <Button variant="danger" type="button" disabled={archiving} onClick={onConfirm}>
            <Archive size={15} />
            {archiving ? "Archiving" : "Force archive"}
          </Button>
        </div>
      </div>
    </div>
  );
}
