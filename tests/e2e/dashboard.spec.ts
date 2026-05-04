import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { readE2eToken } from "./auth";

test("dashboard loads configured repos and agents without browser errors", async ({ page }) => {
  const messages: string[] = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      messages.push(message.text());
    }
  });
  page.on("pageerror", (error) => messages.push(error.message));

  await page.goto(`/?token=${await readE2eToken()}`);

  await expect(page.locator('select[name="repo"]')).toContainText("test-repo-1");
  await expect(page.locator('select[name="repo"]')).toContainText("test-repo-2");
  await expect(page.locator('select[name="agent"]')).toContainText("codex");
  await expect(page.locator('select[name="agent"]')).toContainText("claude");
  await expect(page.getByText("No repos configured")).toHaveCount(0);
  await expect(page.getByText("No agents configured")).toHaveCount(0);
  await expect(page.getByText(/Error:/)).toHaveCount(0);

  expect(messages).toEqual([]);
});

test("dashboard renders manager tool calls and child lifecycle rows", async ({ page }) => {
  seedManagerTimeline();
  await page.goto(`/?token=${await readE2eToken()}`);

  await page.getByRole("button", { name: /manager\s+awaiting input/i }).click();

  await expect(page.getByText("Tool pending: create child from branch origin/main in test-repo-1 with codex, new branch helm/e2e-child-branch")).toBeVisible();
  await expect(page.getByText("Tool pending: pass src/app.ts from child-source-e2e to child-target-e2e")).toBeVisible();
  await expect(page.getByTestId("child-lifecycle").filter({ hasText: "Child session child-target-e2e reached awaiting input" })).toBeVisible();
  await expect(page.getByText("Reviewing child output now.")).toBeVisible();
});

/** Seeds deterministic manager timeline data through Bun's SQLite runtime. */
function seedManagerTimeline(): void {
  execFileSync("bun", ["run", "tests/e2e/seed-manager-timeline.ts"], { cwd: process.cwd(), stdio: "inherit" });
}
