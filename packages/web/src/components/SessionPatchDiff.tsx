"use client";

import { PatchDiff, WorkerPoolContextProvider } from "@pierre/diffs/react";

type SessionPatchDiffProps = {
  patch: string;
};

/** Renders one patch through Pierre's client-only diff renderer. */
export function SessionPatchDiff({ patch }: SessionPatchDiffProps) {
  return (
    <WorkerPoolContextProvider
      highlighterOptions={{}}
      poolOptions={{
        poolSize: 2,
        workerFactory: () => new Worker(new URL("@pierre/diffs/worker/worker.js", import.meta.url), { type: "module" })
      }}
    >
      <PatchDiff
        patch={patch}
        options={{
          diffStyle: "unified",
          disableFileHeader: true,
          disableLineNumbers: false,
          overflow: "wrap"
        }}
      />
    </WorkerPoolContextProvider>
  );
}
