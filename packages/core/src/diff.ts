import { z } from "zod";

export const DIFF_FILE_SIZE_LIMIT = 500_000;
export const DIFF_FILE_COUNT_LIMIT = 200;

export const DiffBaseSchema = z.enum(["uncommitted", "branch"]);
export type DiffBase = z.infer<typeof DiffBaseSchema>;

export const DiffFileStatusSchema = z.enum(["added", "deleted", "modified", "renamed", "copied", "changed"]);
export type DiffFileStatus = z.infer<typeof DiffFileStatusSchema>;

export const DiffFileEntrySchema = z.object({
  path: z.string(),
  status: DiffFileStatusSchema,
  oldPath: z.string().optional(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  isBinary: z.boolean(),
  oldSize: z.number().int().nonnegative().optional(),
  newSize: z.number().int().nonnegative().optional(),
  isTooLarge: z.boolean(),
  patch: z.string().optional()
});
export type DiffFileEntry = z.infer<typeof DiffFileEntrySchema>;

export const DiffResultSchema = z.object({
  base: DiffBaseSchema,
  generatedAt: z.string(),
  files: z.array(DiffFileEntrySchema),
  truncated: z.boolean(),
  fileLimit: z.number().int().positive(),
  totalFiles: z.number().int().nonnegative()
});
export type DiffResult = z.infer<typeof DiffResultSchema>;

export const DiffChangedHintSchema = z.object({
  kind: z.literal("diff_changed"),
  sessionId: z.string()
});
export type DiffChangedHint = z.infer<typeof DiffChangedHintSchema>;

export const PullRequestResultSchema = z.object({
  url: z.string().url()
});
export type PullRequestResult = z.infer<typeof PullRequestResultSchema>;

export const PullRequestErrorSchema = z.object({
  code: z.enum(["dirty_worktree", "no_commits_ahead", "gh_unavailable", "non_github_remote", "gh_failed"]),
  details: z.string().optional()
});
export type PullRequestError = z.infer<typeof PullRequestErrorSchema>;
