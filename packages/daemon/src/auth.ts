import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tokenPath } from "@helm/core";

/** Generates and persists a daemon auth token for this daemon start. */
export function createDaemonToken(): string {
  const token = randomBytes(32).toString("hex");
  const path = tokenPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, token, { mode: 0o600 });
  chmodSync(path, 0o600);
  return token;
}

/** Reads the current daemon auth token from disk. */
export function readDaemonToken(): string {
  return readFileSync(tokenPath(), "utf8").trim();
}
