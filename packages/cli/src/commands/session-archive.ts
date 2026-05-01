import { DaemonClient } from "../client";
import { createLocalManager } from "../local";

type ArchiveCommandOptions = {
  force?: boolean;
};

/** Archives a session and removes its worktree. */
export async function archiveSession(id: string, options: ArchiveCommandOptions = {}): Promise<void> {
  const client = new DaemonClient();
  if (await client.isUp()) {
    await client.archive(id, options.force);
    console.log("archived");
    return;
  }
  await createLocalManager().archive(id, { force: options.force });
  console.log("archived");
}
