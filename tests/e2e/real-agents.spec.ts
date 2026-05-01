import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { NormalizedEvent, Session, SessionEvent } from "@helm/core";
import { e2eAuthHeaders, readE2eToken } from "./auth";

const cases = [
  { repo: "test-repo-1", agent: "codex" },
  { repo: "test-repo-1", agent: "claude" },
  { repo: "test-repo-2", agent: "codex" },
  { repo: "test-repo-2", agent: "claude" }
] as const;

test.skip(process.env.HELM_REAL_AGENT_E2E !== "1", "Set HELM_REAL_AGENT_E2E=1 to run real Claude/Codex sessions.");
test.describe.configure({ mode: "serial" });

for (const entry of cases) {
  test(`creates a markdown file with ${entry.agent} in ${entry.repo}`, async ({ page }) => {
    test.setTimeout(180_000);
    const fileName = `helm-${entry.repo}-${entry.agent}-${Date.now()}.md`;
    const initialPrompt = `Create a markdown file named ${fileName} with one short sentence of random content. Do not ask follow-up questions.`;
    let createdSession: Session | null = null;

    page.on("response", async (response) => {
      if (response.request().method() === "POST" && response.url().endsWith("/sessions") && response.ok()) {
        createdSession = (await response.json()) as Session;
      }
    });

    try {
      await page.goto(`/?token=${await readE2eToken()}`);
      await page.locator('select[name="repo"]').selectOption(entry.repo);
      await page.locator('select[name="agent"]').selectOption(entry.agent);
      await page.locator('textarea[name="prompt"]').fill(initialPrompt);
      await page.getByRole("button", { name: "Start" }).click();

      await expect.poll(() => createdSession?.id ?? null, { timeout: 30_000 }).not.toBeNull();
      await expect(page.getByTestId("user-message").filter({ hasText: initialPrompt })).toBeVisible({ timeout: 10_000 });
      await waitForFile(createdSession!, fileName, 150_000);
      await expect.poll(async () => readSessionStatus(createdSession!.id), { timeout: 30_000 }).toBe("awaiting_input");
      await expect(page.getByTestId("assistant-message").first()).toBeVisible({ timeout: 10_000 });

      const followUpFileName = `helm-${entry.repo}-${entry.agent}-followup-${Date.now()}.md`;
      const followUpPrompt = `Create another markdown file named ${followUpFileName} with one short sentence of random content.`;
      await page.locator('textarea[placeholder="Send a follow-up"]').fill(followUpPrompt);
      await page.getByRole("button", { name: "Send" }).click();

      const followUpMessage = page.getByTestId("user-message").filter({ hasText: followUpPrompt });
      await expect(followUpMessage).toBeVisible({ timeout: 10_000 });
      await expect(followUpMessage).toHaveClass(/user/);
      await expectUserMessageRightOfAssistant(page, followUpPrompt);
      await waitForFile(createdSession!, followUpFileName, 150_000);
      await expect.poll(async () => readSessionStatus(createdSession!.id), { timeout: 30_000 }).toBe("awaiting_input");

      if (entry.agent === "codex") {
        await expect.poll(async () => countAssistantMessages(createdSession!.id), { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
      }
    } finally {
      if (process.env.HELM_E2E_CLEANUP === "1" && createdSession) {
        await archiveSession(createdSession.id);
      }
    }
  });
}

/** Verifies user chat bubbles are visually right of assistant bubbles. */
async function expectUserMessageRightOfAssistant(page: Page, userText: string): Promise<void> {
  const userBox = await page.getByTestId("user-message").filter({ hasText: userText }).boundingBox();
  const assistantBox = await page.getByTestId("assistant-message").first().boundingBox();
  expect(userBox).not.toBeNull();
  expect(assistantBox).not.toBeNull();
  expect(userBox!.x).toBeGreaterThan(assistantBox!.x);
}

/** Waits for a session file and stops early on terminal agent failures. */
async function waitForFile(session: Session, fileName: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const filePath = `${session.worktree_path}/${fileName}`;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      return;
    }
    const detail = await readSessionDetail(session.id);
    if (detail.session.status === "failed") {
      const message = latestErrorMessage(detail.events);
      test.skip(isExternalAgentLimit(message), `External agent limit: ${message}`);
      throw new Error(`Session ${session.id} failed before creating ${fileName}: ${message}`);
    }
    await sleep(1_000);
  }
  expect(existsSync(filePath)).toBe(true);
}

/** Reads a session and all persisted events from the test daemon. */
async function readSessionDetail(id: string): Promise<{ session: Session; events: SessionEvent[] }> {
  const response = await fetch(`${apiUrl()}/sessions/${id}`, { headers: await e2eAuthHeaders() });
  return (await response.json()) as { session: Session; events: SessionEvent[] };
}

/** Reads a session status from the test daemon. */
async function readSessionStatus(id: string): Promise<string> {
  const value = await readSessionDetail(id);
  return value.session.status;
}

/** Counts persisted assistant messages for a session. */
async function countAssistantMessages(id: string): Promise<number> {
  const value = await readSessionDetail(id);
  return value.events.filter((event) => event.kind === "assistant_message").length;
}

/** Archives a test-created session. */
async function archiveSession(id: string): Promise<void> {
  await fetch(`${apiUrl()}/sessions/${id}/archive?force=1`, {
    headers: await e2eAuthHeaders(),
    method: "POST"
  });
}

/** Returns the daemon API URL for e2e tests. */
function apiUrl(): string {
  return process.env.HELM_E2E_API_URL ?? "http://127.0.0.1:7878";
}

/** Returns the latest readable error message from a session event list. */
function latestErrorMessage(events: SessionEvent[]): string {
  const error = events
    .slice()
    .reverse()
    .find((event) => event.kind === "error");
  if (!error) {
    return "unknown error";
  }
  return extractErrorText(error.payload);
}

/** Extracts provider error text from a normalized error payload. */
function extractErrorText(payload: NormalizedEvent): string {
  if (payload.kind !== "error") {
    return "unknown error";
  }
  return findErrorMessage(payload.payload) ?? payload.message;
}

/** Detects quota and subscription failures from external coding-agent CLIs. */
function isExternalAgentLimit(message: string): boolean {
  return /usage limit|upgrade to pro|try again at|rate limit|quota/i.test(message);
}

/** Finds nested provider error text in a raw agent event. */
function findErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  if ("message" in value && typeof value.message === "string") {
    return value.message;
  }
  if ("error" in value) {
    return findErrorMessage(value.error);
  }
  return null;
}

/** Sleeps for a short polling interval. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
