import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { e2eDashboardUrl } from "./auth";

test("dashboard loads configured repos and agents without browser errors", async ({ page }) => {
  const messages: string[] = [];
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      messages.push(message.text());
    }
  });
  page.on("pageerror", (error) => messages.push(error.message));

  await page.goto(await e2eDashboardUrl());

  await expect(page.locator('select[name="repo"]')).toContainText("test-repo-1");
  await expect(page.locator('select[name="repo"]')).toContainText("test-repo-2");
  await expect(page.locator('select[name="agent"]')).toContainText("codex");
  await expect(page.locator('select[name="agent"]')).toContainText("claude");
  await expect(page.getByText("No repos configured")).toHaveCount(0);
  await expect(page.getByText("No agents configured")).toHaveCount(0);
  await expect(page.getByText(/Error:/)).toHaveCount(0);

  expect(messages).toEqual([]);
});

test("dashboard supports session search, keyboard selection, and diff toggle", async ({ page }) => {
  seedDashboard();
  await page.goto(await e2eDashboardUrl());

  await expect(page.getByRole("button", { name: /test-repo-1 awaiting input/i })).toBeVisible();
  await page.keyboard.press("/");
  await expect(page.getByRole("searchbox", { name: /search sessions/i })).toBeFocused();
  await page.keyboard.type("beta");
  await expect(page.getByRole("button", { name: /test-repo-2 stopped/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /test-repo-1 awaiting input/i })).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /^stopped$/i }).click();
  await page.keyboard.press("j");
  await expect(page.getByRole("button", { name: /test-repo-2 stopped/i })).toHaveAttribute("aria-current", "page");
  await page.getByRole("button", { name: /^all$/i }).click();
  await page.keyboard.press("k");
  await expect(page.getByRole("button", { name: /test-repo-1 awaiting input/i })).toHaveAttribute("aria-current", "page");
  await page.keyboard.press("d");
  await expect(page.getByText("Worktree changes")).toBeVisible();
});

test("composer keeps Shift+Enter as newline and preserves failed sends", async ({ page }) => {
  seedDashboard();
  await page.goto(await e2eDashboardUrl());

  const composer = page.getByRole("textbox", { name: /follow-up message/i });
  await composer.fill("first line");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("second line");
  await expect(composer).toHaveValue("first line\nsecond line");
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("first line\nsecond line");
  await expect(page.getByText(/Session is not running in this process/)).toBeVisible();

  await composer.fill("control send");
  await page.keyboard.press("Control+Enter");
  await expect(composer).toHaveValue("control send");
  await expect(page.getByText(/Session is not running in this process/)).toBeVisible();
});

test("new-session composer focuses with n and clears draft with Escape", async ({ page }) => {
  await page.goto(await e2eDashboardUrl());
  await expect(page.locator('select[name="repo"]')).toContainText("test-repo-1");

  await page.keyboard.press("n");
  const composer = page.getByRole("textbox", { name: /initial prompt/i });
  await expect(composer).toBeFocused();
  await page.keyboard.type("draft prompt");
  await page.keyboard.press("Escape");
  await expect(composer).toHaveValue("");
});

test("refresh backfills session events and interrupted sessions expose resume only", async ({ page }) => {
  seedDashboard();
  await page.goto(await e2eDashboardUrl());

  await expect(page.getByText("Session resumed.")).toHaveCount(0);
  await expect(page.getByText("Turn complete.")).toHaveCount(0);
  appendResumeEvent();
  await page.keyboard.press("r");
  await expect(page.getByText("Session resumed.")).toBeVisible();

  await page.getByRole("button", { name: /test-repo-1 interrupted/i }).click();
  await expect(page.getByRole("button", { name: /^resume$/i })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /follow-up message/i })).toBeDisabled();
});

test("dashboard renders manager tool calls and child lifecycle rows", async ({ page }) => {
  seedManagerTimeline();
  await page.goto(await e2eDashboardUrl());

  await page.getByRole("button", { name: /manager\s+awaiting input/i }).click();

  await expect(page.getByText("Tool pending: create child from branch origin/main in test-repo-1 with codex, new branch helm/e2e-child-branch")).toBeVisible();
  await expect(page.getByText("Tool pending: pass src/app.ts from child-source-e2e to child-target-e2e")).toBeVisible();
  await expect(page.getByTestId("child-lifecycle").filter({ hasText: "Child session child-target-e2e reached awaiting input" })).toBeVisible();
  await expect(page.getByTestId("assistant-message").filter({ hasText: "Reviewing child output now." })).toBeVisible();
});

/** Seeds deterministic manager timeline data through Bun's SQLite runtime. */
function seedManagerTimeline(): void {
  execFileSync("bun", ["run", "tests/e2e/seed-manager-timeline.ts"], { cwd: process.cwd(), stdio: "inherit" });
}

/** Seeds deterministic dashboard sessions through Bun's SQLite runtime. */
function seedDashboard(): void {
  execFileSync("bun", ["run", "tests/e2e/seed-dashboard.ts"], { cwd: process.cwd(), stdio: "inherit" });
}

/** Appends a deterministic resume event without emitting SSE. */
function appendResumeEvent(): void {
  execFileSync("bun", ["run", "tests/e2e/seed-dashboard.ts", "append-resume-event"], { cwd: process.cwd(), stdio: "inherit" });
}
