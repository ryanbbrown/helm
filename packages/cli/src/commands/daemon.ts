import { DaemonClient } from "../client";
import { startServer } from "@helm/daemon/server";
import { createDaemonToken } from "@helm/daemon/auth";

/** Starts the daemon in the foreground. */
export async function startDaemon(): Promise<void> {
  const port = Number(Bun.env.HELM_PORT ?? "7878");
  const token = createDaemonToken();
  const server = startServer(port, token);
  console.log(`helm daemon listening on http://${server.hostname}:${server.port}`);
  console.log(`helm dashboard URL: http://localhost:3000/?token=${token}`);
  await new Promise(() => {});
}

/** Prints daemon health. */
export async function daemonStatus(): Promise<void> {
  const client = new DaemonClient();
  console.log((await client.isUp()) ? "running" : "stopped");
}

/** Reports daemon stop support. */
export function stopDaemon(): void {
  console.log("daemon stop is not implemented; stop the foreground daemon process with Ctrl-C");
}
