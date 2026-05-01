const prompt = Bun.argv.slice(2).join(" ") || "Reply with the word OK.";

/** Runs the Codex exec/resume spike. */
async function main(): Promise<void> {
  const first = await runCodex(["exec", "--json", prompt]);
  if (!first.threadId) {
    throw new Error("No Codex thread id observed");
  }
  await runCodex(["exec", "resume", first.threadId, "--json", "Reply with the word AGAIN."]);
}

/** Runs one Codex command and returns the observed thread id. */
async function runCodex(args: string[]): Promise<{ threadId?: string }> {
  const proc = Bun.spawn({ cmd: ["codex", ...args], stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  let threadId: string | undefined;
  await readJsonLines(proc.stdout, (value) => {
    const event = value as { type?: string; thread?: { id?: string } };
    console.log(JSON.stringify(value));
    if (event.type === "thread.started" && event.thread?.id) {
      threadId = event.thread.id;
    }
  });
  process.exitCode = await proc.exited;
  return { threadId };
}

/** Parses JSONL from a readable stream. */
async function readJsonLines(stream: ReadableStream<Uint8Array>, onValue: (value: unknown) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) {
        onValue(JSON.parse(line));
      }
    }
  }
}

await main();
