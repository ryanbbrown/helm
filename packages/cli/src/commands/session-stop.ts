import { DaemonClient } from "../client";
import { createLocalManager } from "../local";

/** Stops a session. */
export async function stopSession(id: string): Promise<void> {
  const client = new DaemonClient();
  if (await client.isUp()) {
    await client.stop(id);
    console.log("stopped");
    return;
  }
  await createLocalManager().stop(id);
  console.log("stopped");
}
