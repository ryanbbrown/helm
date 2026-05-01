import { createWriteStream } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

export type JsonLineHandler = (value: unknown) => void;

/** Pipes stdout bytes into a JSONL parser and append-only raw log. */
export async function readJsonLines(stream: ReadableStream<Uint8Array> | null, logPath: string, onValue: JsonLineHandler): Promise<void> {
  if (!stream) {
    return;
  }
  mkdirSync(dirname(logPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: "a" });
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream) {
    log.write(chunk);
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      parseLine(line, onValue);
    }
  }

  const remaining = buffer + decoder.decode();
  parseLine(remaining, onValue);
  log.end();
}

/** Parses one JSONL line when it has content. */
function parseLine(line: string, onValue: JsonLineHandler): void {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }
  onValue(JSON.parse(trimmed));
}
