import { defineConfig } from "@playwright/test";

const helmHome = `${process.cwd()}/tests/fixtures/helm-home`;

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: {
    timeout: 10_000
  },
  use: {
    baseURL: "http://127.0.0.1:3000"
  },
  webServer: [
    {
      command: "bun run --cwd packages/cli start daemon start",
      url: "http://127.0.0.1:7878/health",
      reuseExistingServer: true,
      env: {
        ...process.env,
        HELM_HOME: helmHome
      },
      timeout: 15_000
    },
    {
      command: "bun run --cwd packages/web dev --hostname 127.0.0.1 --port 3000",
      url: "http://127.0.0.1:3000",
      reuseExistingServer: true,
      timeout: 20_000
    }
  ]
});
