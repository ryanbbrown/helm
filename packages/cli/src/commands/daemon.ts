import { DaemonClient } from "../client";
import { startServer } from "@helm/daemon/server";

/** Starts the daemon in the foreground. */
export function startDaemon(): void {
  const port = Number(Bun.env.HELM_PORT ?? "7878");
  const server = startServer(port);
  console.log(`helm daemon listening on http://${server.hostname}:${server.port}`);
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
