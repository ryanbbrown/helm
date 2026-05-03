import { DaemonClient } from "../client";
import { createLocalManager } from "../local";
import { printSessionTable } from "../format";

type ListOptions = {
  parent?: string;
};

/** Lists sessions from the daemon or local store. */
export async function listSessions(options: ListOptions = {}): Promise<void> {
  const client = new DaemonClient();
  if (await client.isUp()) {
    printSessionTable(await client.list(options.parent));
    return;
  }
  const manager = createLocalManager();
  printSessionTable(options.parent ? manager.listChildren(options.parent) : manager.list());
}
