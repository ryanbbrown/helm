import { DaemonClient } from "../client";
import { createLocalManager } from "../local";

/** Sends a follow-up message to a session. */
export async function sendSession(id: string, text: string): Promise<void> {
  const client = new DaemonClient();
  if (await client.isUp()) {
    await client.send(id, text);
    console.log("sent");
    return;
  }
  await createLocalManager().send(id, text);
  console.log("sent");
}
