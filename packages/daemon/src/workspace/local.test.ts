import { describe, expect, test } from "bun:test";
import { isGitHubRemote } from "./local";

describe("isGitHubRemote", () => {
  test("accepts common GitHub remote formats", () => {
    expect(isGitHubRemote("git@github.com:owner/repo.git")).toBe(true);
    expect(isGitHubRemote("https://github.com/owner/repo.git")).toBe(true);
    expect(isGitHubRemote("ssh://git@github.com/owner/repo.git")).toBe(true);
  });

  test("rejects non-GitHub remotes", () => {
    expect(isGitHubRemote("git@gitlab.com:owner/repo.git")).toBe(false);
    expect(isGitHubRemote("https://example.com/owner/repo.git")).toBe(false);
  });
});
