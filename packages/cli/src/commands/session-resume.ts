import { createLocalManager } from "../local";
import { DaemonClient } from "../client";

/** Resumes an interrupted session. */
export async function resumeSession(id: string): Promise<void> {
  const client = new DaemonClient();
  if (await client.isUp()) {
    await client.resume(id);
    console.log("resumed");
    return;
  }
  await createLocalManager({ reconcileInProcessSessions: true }).resume(id);
  console.log("resumed");
}
