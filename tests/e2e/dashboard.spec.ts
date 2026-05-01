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
