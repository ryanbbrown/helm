import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Reads the daemon token for browser e2e tests. */
export async function readE2eToken(): Promise<string> {
  const candidates = [
    process.env.HELM_E2E_TOKEN,
    process.env.HELM_E2E_HELM_HOME ? join(process.env.HELM_E2E_HELM_HOME, "state/token") : null,
    process.env.HELM_HOME ? join(process.env.HELM_HOME, "state/token") : null,
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

/** Builds a dashboard URL that points the browser at the test daemon. */
export async function e2eDashboardUrl(path = "/"): Promise<string> {
  const url = new URL(path, "http://127.0.0.1");
  url.searchParams.set("api", e2eApiUrl());
  url.searchParams.set("token", await readE2eToken());
  return `${url.pathname}${url.search}`;
}

/** Checks a token against the running daemon. */
async function tokenWorks(token: string): Promise<boolean> {
  const response = await fetch(`${e2eApiUrl()}/auth/check`, {
    headers: { Authorization: `Bearer ${token}` }
  }).catch(() => null);
  return response?.ok ?? false;
}

/** Returns the daemon API URL for e2e tests. */
function e2eApiUrl(): string {
  return process.env.HELM_E2E_API_URL ?? "http://127.0.0.1:7878";
}
