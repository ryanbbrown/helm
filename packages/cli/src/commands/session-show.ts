import { DaemonClient } from "../client";
import { printEvent, printSession } from "../format";
import { createLocalManager } from "../local";

/** Shows a session detail and surfaced events. */
export async function showSession(id: string): Promise<void> {
  const client = new DaemonClient();
  if (await client.isUp()) {
    const detail = await client.show(id);
    printSession(detail.session);
    for (const event of detail.events) {
      printEvent(event);
    }
    return;
  }
  const manager = createLocalManager();
  const session = manager.getRequired(id);
  printSession(session);
  for (const event of manager.store.listEvents(id)) {
    printEvent(event);
  }
}
