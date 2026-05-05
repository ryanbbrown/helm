import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const fixtureHelmHome = `${process.cwd()}/tests/fixtures/helm-home`;
const helmHome = process.env.HELM_E2E_HELM_HOME ?? createE2eHelmHome();
const configuredApiUrl = process.env.HELM_E2E_API_URL;
const webPort = await e2ePort("HELM_E2E_WEB_PORT");
const daemonPort = await e2ePort("HELM_E2E_DAEMON_PORT", configuredApiUrl ? new URL(configuredApiUrl).port || undefined : undefined);
const webUrl = `http://127.0.0.1:${webPort}`;
const apiUrl = configuredApiUrl ?? `http://127.0.0.1:${daemonPort}`;

process.env.HELM_E2E_API_URL = apiUrl;
process.env.HELM_E2E_DAEMON_PORT = daemonPort;
process.env.HELM_E2E_DB_PATH = join(helmHome, "state", "helm.db");
process.env.HELM_E2E_HELM_HOME = helmHome;
process.env.HELM_E2E_WEB_PORT = webPort;
process.env.HELM_HOME = helmHome;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: {
    timeout: 10_000
  },
  use: {
    baseURL: webUrl
  },
  webServer: [
    {
      command: "bun run --cwd packages/cli start daemon start",
      url: `${apiUrl}/health`,
      reuseExistingServer: true,
      env: {
        ...process.env,
        HELM_ALLOWED_ORIGINS: webUrl,
        HELM_HOME: helmHome,
        HELM_PORT: daemonPort
      },
      timeout: 15_000
    },
    {
      command: `bun run --cwd packages/web dev --hostname 127.0.0.1 --port ${webPort}`,
      url: webUrl,
      reuseExistingServer: true,
      env: {
        ...process.env,
        NEXT_PUBLIC_HELM_API_URL: apiUrl
      },
      timeout: 20_000
    }
  ]
});

/** Resolves an e2e port from env or an available local port. */
async function e2ePort(envName: string, fallback?: string): Promise<string> {
  return process.env[envName] ?? fallback ?? String(await findFreePort());
}

/** Creates an isolated Helm home for one Playwright run. */
function createE2eHelmHome(): string {
  const path = mkdtempSync(join(tmpdir(), "helm-e2e-"));
  mkdirSync(join(path, "state"), { recursive: true });
  cpSync(join(fixtureHelmHome, "config"), join(path, "config"), { recursive: true });
  return path;
}

/** Asks the OS for a currently available localhost TCP port. */
async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate e2e port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}
