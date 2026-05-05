import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ClaudeRunnerAdapter } from "./claude";
import { CodexRunnerAdapter } from "./codex";

describe("runner resume commands", () => {
  test("Codex resume handles spawn lazily and send with exec resume", async () => {
    const fixture = createCommandFixture("codex", [
      "for arg in \"$@\"; do printf '%s\\n' \"$arg\" >> \"$0.capture\"; done",
      "printf '%s\\n' '---' >> \"$0.capture\"",
      "printf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}'",
      "printf '%s\\n' '{\"type\":\"turn.started\"}'",
      "printf '%s\\n' '{\"type\":\"turn.completed\"}'"
    ]);
    const handle = new CodexRunnerAdapter().spawn({
      command: fixture.command,
      cwd: fixture.dir,
      extraArgs: ["--sandbox", "read-only"],
      logPath: join(fixture.dir, "codex.jsonl"),
      resumeThreadId: "thread-1"
    });

    expect(existsSync(fixture.capturePath)).toBe(false);
    await handle.send("continue");
    const args = await readCapturedArgs(fixture.capturePath);

    expect(args).toEqual(["exec", "resume", "thread-1", "--json", "--sandbox", "read-only", "continue"]);
    await handle.stop();
  });

  test("Claude resume handles spawn lazily and send with --resume", async () => {
    const fixture = createCommandFixture("claude", [
      "for arg in \"$@\"; do printf '%s\\n' \"$arg\" >> \"$0.capture\"; done",
      "printf '%s\\n' '---' >> \"$0.capture\"",
      "cat >/dev/null"
    ]);
    const handle = new ClaudeRunnerAdapter().spawn({
      command: fixture.command,
      cwd: fixture.dir,
      extraArgs: ["--dangerously-skip-permissions"],
      logPath: join(fixture.dir, "claude.jsonl"),
      resumeThreadId: "claude-thread-1"
    });

    expect(existsSync(fixture.capturePath)).toBe(false);
    await handle.send("continue");
    const args = await readCapturedArgs(fixture.capturePath);

    expect(args).toEqual([
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--resume",
      "claude-thread-1",
      "--dangerously-skip-permissions"
    ]);
    await handle.stop();
  });
});

type CommandFixture = {
  capturePath: string;
  command: string;
  dir: string;
};

/** Creates an executable command fixture that records argv to disk. */
function createCommandFixture(name: string, body: string[]): CommandFixture {
  const dir = mkdtempSync(join(tmpdir(), `helm-runner-${name}-`));
  const command = join(dir, name);
  const capturePath = `${command}.capture`;
  writeFileSync(command, ["#!/bin/sh", ...body].join("\n"));
  chmodSync(command, 0o755);
  return { capturePath, command, dir };
}

/** Waits for a fake command to record its arguments. */
async function readCapturedArgs(capturePath: string): Promise<string[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (existsSync(capturePath)) {
      const content = readFileSync(capturePath, "utf8");
      if (content.includes("---")) {
        return content.trim().split("\n").filter((line) => line && line !== "---");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${capturePath}`);
}
