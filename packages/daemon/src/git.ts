import { $ } from "bun";
import { join } from "node:path";
import type { DiffBase, DiffFileEntry, DiffFileStatus } from "@helm/core";

type GitDiffOptions = {
  base: DiffBase;
  defaultBranch: string;
  fileSizeLimit: number;
  fileCountLimit: number;
};

type GitDiffResult = {
  files: DiffFileEntry[];
  totalFiles: number;
};

type DiffName = {
  path: string;
  status: DiffFileStatus;
  oldPath?: string;
};

type DiffStat = {
  path: string;
  oldPath?: string;
  additions: number;
  deletions: number;
  isBinary: boolean;
};

/** Checks whether a path is a git work tree. */
export async function isGitRepository(path: string): Promise<boolean> {
  const result = await $`git -C ${path} rev-parse --is-inside-work-tree`.quiet().nothrow();
  return result.exitCode === 0 && result.stdout.toString().trim() === "true";
}

/** Fetches origin for a repository without changing the current checkout. */
export async function fetchOrigin(repoPath: string): Promise<void> {
  await $`git -C ${repoPath} fetch origin`.quiet();
}

/** Checks whether a git ref resolves to a commit. */
export async function gitRefExists(repoPath: string, ref: string): Promise<boolean> {
  const result = await $`git -C ${repoPath} rev-parse --verify --quiet ${`${ref}^{commit}`}`.quiet().nothrow();
  return result.exitCode === 0;
}

/** Detects the default remote branch name for a repository. */
export async function detectDefaultBranch(repoPath: string): Promise<string> {
  const result = await $`git -C ${repoPath} symbolic-ref --short refs/remotes/origin/HEAD`.quiet();
  return result.stdout.toString().trim().replace(/^origin\//, "");
}

/** Creates a named branch worktree from a base ref. */
export async function createWorktree(repoPath: string, branch: string, path: string, baseRef: string): Promise<void> {
  await $`git -C ${repoPath} worktree add -b ${branch} ${path} ${baseRef}`.quiet();
}

/** Removes a worktree forcefully from its owning repository. */
export async function removeWorktree(repoPath: string, path: string): Promise<void> {
  await $`git -C ${repoPath} worktree remove --force ${path}`.quiet();
  await $`git -C ${repoPath} worktree prune`.quiet();
}

/** Deletes a local branch if it exists. */
export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  await $`git -C ${repoPath} branch -D ${branch}`.quiet().nothrow();
}

/** Reads uncommitted changes in a worktree. */
export async function worktreeStatus(path: string): Promise<string> {
  const result = await $`git -C ${path} status --porcelain`.quiet();
  return result.stdout.toString().trim();
}

/** Reads commits reachable only from the session branch. */
export async function unsharedCommits(repoPath: string, branch: string): Promise<string> {
  const format = "%(refname)";
  const refsResult = await $`git -C ${repoPath} for-each-ref --format=${format} refs/heads refs/remotes`.quiet();
  const refs = refsResult.stdout
    .toString()
    .split("\n")
    .map((ref) => ref.trim())
    .filter((ref) => ref && ref !== `refs/heads/${branch}`);
  const result = refs.length === 0
    ? await $`git -C ${repoPath} log ${branch} --oneline`.quiet()
    : await $`git -C ${repoPath} log ${branch} --not ${refs} --oneline`.quiet();
  return result.stdout.toString().trim();
}

/** Finds the merge base between a worktree HEAD and the default remote branch. */
export async function gitMergeBase(worktreePath: string, defaultBranch: string): Promise<string> {
  const result = await $`git -C ${worktreePath} merge-base ${`origin/${defaultBranch}`} HEAD`.quiet();
  return result.stdout.toString().trim();
}

/** Reads a structured git diff from a worktree. */
export async function gitDiff(worktreePath: string, options: GitDiffOptions): Promise<GitDiffResult> {
  const baseRef = options.base === "branch" ? await gitMergeBase(worktreePath, options.defaultBranch) : "HEAD";
  const names = await gitDiffStatus(worktreePath, baseRef);
  const stats = await gitDiffNumstat(worktreePath, baseRef);
  const trackedPaths = new Set(names.map((name) => name.path));
  const untracked = (await gitUntrackedFiles(worktreePath)).filter((path) => !trackedPaths.has(path));
  const totalFiles = names.length + untracked.length;
  const trackedLimit = names.slice(0, options.fileCountLimit);
  const untrackedLimit = untracked.slice(0, Math.max(0, options.fileCountLimit - trackedLimit.length));
  const entries = await Promise.all(trackedLimit.map((name) => buildTrackedDiffEntry(worktreePath, baseRef, name, stats.get(diffKey(name)), options.fileSizeLimit)));
  for (const path of untrackedLimit) {
    entries.push(await buildUntrackedDiffEntry(worktreePath, path, options.fileSizeLimit));
  }
  return { files: entries, totalFiles };
}

/** Reads tracked file status entries for a git diff. */
export async function gitDiffStatus(worktreePath: string, baseRef: string): Promise<DiffName[]> {
  const result = await $`git -C ${worktreePath} diff --name-status -z -M -C --find-copies-harder ${baseRef}`.quiet();
  const parts = splitNull(result.stdout.toString());
  const entries: DiffName[] = [];
  for (let index = 0; index < parts.length;) {
    const code = parts[index++] ?? "";
    const status = normalizeDiffStatus(code);
    if (code.startsWith("R") || code.startsWith("C")) {
      const oldPath = parts[index++];
      const path = parts[index++];
      if (oldPath && path) {
        entries.push({ path, oldPath, status });
      }
    } else {
      const path = parts[index++];
      if (path) {
        entries.push({ path, status });
      }
    }
  }
  return entries;
}

/** Reads the patch text for one tracked diff entry. */
export async function gitDiffPatch(worktreePath: string, baseRef: string, entry: Pick<DiffFileEntry, "path" | "oldPath">): Promise<string> {
  const pathspecs = entry.oldPath ? [entry.oldPath, entry.path] : [entry.path];
  const result = await $`git -C ${worktreePath} diff -M -C --find-copies-harder --patch ${baseRef} -- ${pathspecs}`.quiet();
  return result.stdout.toString();
}

/** Lists untracked, non-ignored files in a worktree. */
export async function gitUntrackedFiles(worktreePath: string): Promise<string[]> {
  const result = await $`git -C ${worktreePath} ls-files --others --exclude-standard -z`.quiet();
  return splitNull(result.stdout.toString());
}

/** Counts commits reachable from HEAD and not from a remote base branch. */
export async function commitsAheadOf(worktreePath: string, defaultBranch: string): Promise<number> {
  const result = await $`git -C ${worktreePath} rev-list ${`origin/${defaultBranch}..HEAD`} --count`.quiet();
  return Number(result.stdout.toString().trim());
}

/** Pushes a session branch to origin and configures upstream tracking. */
export async function pushBranch(worktreePath: string, branch: string): Promise<void> {
  await $`git -C ${worktreePath} push -u origin ${branch}`.quiet();
}

/** Fetches origin for a worktree or repository. */
export async function fetchBranch(path: string): Promise<void> {
  await $`git -C ${path} fetch origin`.quiet();
}

/** Reads a repository's origin URL. */
export async function originUrl(path: string): Promise<string> {
  const result = await $`git -C ${path} remote get-url origin`.quiet();
  return result.stdout.toString().trim();
}

/** Creates a GitHub pull request with the gh CLI and returns its URL. */
export async function createGitHubPullRequest(worktreePath: string, branch: string, defaultBranch: string, title: string, body: string): Promise<string> {
  const result = await $`gh pr create --base ${defaultBranch} --head ${branch} --title ${title} --body ${body}`.cwd(worktreePath).quiet().nothrow();
  if (result.exitCode === 0) {
    return result.stdout.toString().trim();
  }
  const details = `${result.stdout.toString()}\n${result.stderr.toString()}`.trim();
  if (/already exists|pull request .* exists/i.test(details)) {
    const existing = await $`gh pr list --head ${branch} --state open --json url --jq ${".[0].url"}`.cwd(worktreePath).quiet();
    const url = existing.stdout.toString().trim();
    if (url) {
      return url;
    }
  }
  throw new Error(details || "gh pr create failed");
}

/** Verifies that the gh CLI is installed and authenticated. */
export async function assertGhAvailable(worktreePath: string): Promise<void> {
  const result = await $`gh auth status`.cwd(worktreePath).quiet().nothrow();
  if (result.exitCode !== 0) {
    const details = `${result.stdout.toString()}\n${result.stderr.toString()}`.trim();
    throw new Error(details || "gh CLI is missing or unauthenticated");
  }
}

/** Parses numstat entries for a git diff. */
async function gitDiffNumstat(worktreePath: string, baseRef: string): Promise<Map<string, DiffStat>> {
  const result = await $`git -C ${worktreePath} diff --numstat -z -M -C --find-copies-harder ${baseRef}`.quiet();
  const parts = splitNull(result.stdout.toString());
  const stats = new Map<string, DiffStat>();
  for (let index = 0; index < parts.length;) {
    const header = parts[index++] ?? "";
    const [additionsRaw, deletionsRaw, pathInHeader] = header.split("\t");
    const isBinary = additionsRaw === "-" || deletionsRaw === "-";
    const additions = isBinary ? 0 : Number(additionsRaw);
    const deletions = isBinary ? 0 : Number(deletionsRaw);
    if (pathInHeader) {
      const entry = { path: pathInHeader, additions, deletions, isBinary };
      stats.set(pathInHeader, entry);
    } else {
      const oldPath = parts[index++];
      const path = parts[index++];
      if (oldPath && path) {
        stats.set(`${oldPath}\0${path}`, { path, oldPath, additions, deletions, isBinary });
      }
    }
  }
  return stats;
}

/** Builds a diff entry for a tracked file. */
async function buildTrackedDiffEntry(worktreePath: string, baseRef: string, name: DiffName, stat: DiffStat | undefined, fileSizeLimit: number): Promise<DiffFileEntry> {
  const oldSize = name.status !== "added" ? await gitObjectSize(worktreePath, baseRef, name.oldPath ?? name.path) : undefined;
  const newSize = name.status !== "deleted" ? await fileSize(join(worktreePath, name.path)) : undefined;
  const isTooLarge = Math.max(oldSize ?? 0, newSize ?? 0) > fileSizeLimit;
  const entry: DiffFileEntry = {
    path: name.path,
    status: name.status,
    oldPath: name.oldPath,
    additions: stat?.additions ?? 0,
    deletions: stat?.deletions ?? 0,
    isBinary: stat?.isBinary ?? false,
    oldSize,
    newSize,
    isTooLarge
  };
  if (!entry.isBinary && !entry.isTooLarge) {
    const patch = await gitDiffPatch(worktreePath, baseRef, entry);
    if (Buffer.byteLength(patch) <= fileSizeLimit) {
      entry.patch = patch;
    } else {
      entry.isTooLarge = true;
    }
  }
  return entry;
}

/** Builds a synthetic addition entry for an untracked file. */
async function buildUntrackedDiffEntry(worktreePath: string, path: string, fileSizeLimit: number): Promise<DiffFileEntry> {
  const absolutePath = join(worktreePath, path);
  const newSize = await fileSize(absolutePath);
  const isTooLarge = (newSize ?? 0) > fileSizeLimit;
  const isBinary = !isTooLarge && await isBinaryFile(absolutePath);
  const entry: DiffFileEntry = {
    path,
    status: "added",
    additions: 0,
    deletions: 0,
    isBinary,
    newSize,
    isTooLarge
  };
  if (!entry.isBinary && !entry.isTooLarge) {
    const text = await Bun.file(absolutePath).text();
    entry.additions = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    entry.patch = syntheticAddedPatch(path, text);
  }
  return entry;
}

/** Reads a git object size if it exists at a revision. */
async function gitObjectSize(worktreePath: string, rev: string, path: string): Promise<number | undefined> {
  const result = await $`git -C ${worktreePath} cat-file -s ${`${rev}:${path}`}`.quiet().nothrow();
  return result.exitCode === 0 ? Number(result.stdout.toString().trim()) : undefined;
}

/** Reads a filesystem file size. */
async function fileSize(path: string): Promise<number | undefined> {
  const file = Bun.file(path);
  return await file.exists() ? file.size : undefined;
}

/** Checks a file prefix for binary null bytes. */
async function isBinaryFile(path: string): Promise<boolean> {
  const buffer = Buffer.from(await Bun.file(path).slice(0, 8000).arrayBuffer());
  return buffer.includes(0);
}

/** Creates a minimal git patch for an untracked text file. */
function syntheticAddedPatch(path: string, text: string): string {
  const lines = text.length === 0 ? [] : text.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const body = lines.map((line) => `+${line}`).join("\n");
  const newline = body ? "\n" : "";
  return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}${newline}`;
}

/** Converts a git name-status code into Helm's public status. */
function normalizeDiffStatus(code: string): DiffFileStatus {
  if (code.startsWith("A")) {
    return "added";
  }
  if (code.startsWith("D")) {
    return "deleted";
  }
  if (code.startsWith("R")) {
    return "renamed";
  }
  if (code.startsWith("C")) {
    return "copied";
  }
  if (code.startsWith("M")) {
    return "modified";
  }
  return "changed";
}

/** Returns the stat map key for a diff entry. */
function diffKey(name: DiffName): string {
  return name.oldPath ? `${name.oldPath}\0${name.path}` : name.path;
}

/** Splits git -z output into non-empty parts. */
function splitNull(value: string): string[] {
  return value.split("\0").filter(Boolean);
}
