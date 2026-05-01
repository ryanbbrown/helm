import { DaemonClient } from "../client";
import { createLocalManager } from "../local";

/** Archives a session and removes its worktree. */
export async function archiveSession(id: string): Promise<void> {
  const client = new DaemonClient();
  if (await client.isUp()) {
    await client.archive(id);
    console.log("archived");
    return;
  }
  await createLocalManager().archive(id);
  console.log("archived");
}
