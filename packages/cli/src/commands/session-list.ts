import { DaemonClient } from "../client";
import { createLocalManager } from "../local";
import { printSessionTable } from "../format";

/** Lists sessions from the daemon or local store. */
export async function listSessions(): Promise<void> {
  const client = new DaemonClient();
  if (await client.isUp()) {
    printSessionTable(await client.list());
    return;
  }
  printSessionTable(createLocalManager().list());
}
