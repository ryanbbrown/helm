import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Reads the daemon token for browser e2e tests. */
export async function readE2eToken(): Promise<string> {
  const candidates = [
    process.env.HELM_E2E_TOKEN,
    join(homedir(), ".helm/state/token"),
    join(process.cwd(), "tests/fixtures/helm-home/state/token")
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      const token = readFileSync(candidate, "utf8").trim();
      if (await tokenWorks(token)) {
        return token;
      }
    }
  }
  throw new Error("Helm daemon token was not found");
}

/** Returns auth headers for e2e daemon requests. */
export async function e2eAuthHeaders(): Promise<HeadersInit> {
  return { Authorization: `Bearer ${await readE2eToken()}` };
}

/** Checks a token against the running daemon. */
async function tokenWorks(token: string): Promise<boolean> {
  const response = await fetch(`${process.env.HELM_E2E_API_URL ?? "http://127.0.0.1:7878"}/auth/check`, {
    headers: { Authorization: `Bearer ${token}` }
  }).catch(() => null);
  return response?.ok ?? false;
}
