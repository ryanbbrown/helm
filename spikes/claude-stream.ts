const prompt = Bun.argv.slice(2).join(" ") || "Reply with the word OK.";

/** Runs the Claude stream-json spike. */
async function main(): Promise<void> {
  const proc = Bun.spawn({
    cmd: [
      "claude",
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose"
    ],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit"
  });
  proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
  proc.stdin.flush();
  let results = 0;
  await readJsonLines(proc.stdout, (value) => {
    const event = value as { type?: string };
    console.log(JSON.stringify(value));
    if (event.type === "result") {
      results += 1;
      if (results === 1) {
        proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "Now reply with the word AGAIN." } }) + "\n");
        proc.stdin.flush();
      } else {
        proc.kill();
      }
    }
  });
  process.exitCode = await proc.exited;
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
