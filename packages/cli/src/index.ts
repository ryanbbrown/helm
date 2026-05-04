#!/usr/bin/env bun
import { Command } from "commander";
import type { ManagerMode } from "@helm/core";
import { validateConfig } from "./commands/config";
import { createSession } from "./commands/session-create";
import { listSessions } from "./commands/session-list";
import { showSession } from "./commands/session-show";
import { sendSession } from "./commands/session-send";
import { stopSession } from "./commands/session-stop";
import { archiveSession } from "./commands/session-archive";
import { daemonStatus, startDaemon, stopDaemon } from "./commands/daemon";

const program = new Command();

program.name("helm").description("Local coding-agent session control plane").version("0.0.0");

const config = program.command("config").description("Manage config");
config.command("validate").description("Validate repos.json and agents.json").action(run(validateConfig));

const session = program.command("session").description("Manage sessions");
session
  .command("create")
  .argument("<repo>")
  .argument("<agent>")
  .option("-p, --prompt <prompt>")
  .description("Create and start a session")
  .action((repo, agent, options) => run(() => createSession(repo, agent, options))());
session.command("list").option("--parent <id>").description("List sessions").action((options) => run(() => listSessions(options))());
session.command("show").argument("<id>").description("Show a session").action((id) => run(() => showSession(id))());
session.command("send").argument("<id>").argument("<text>").description("Send a follow-up").action((id, text) => run(() => sendSession(id, text))());
session.command("stop").argument("<id>").description("Stop a session").action((id) => run(() => stopSession(id))());
session.command("archive").argument("<id>").option("--force").description("Archive a session").action((id, options) => run(() => archiveSession(id, options))());

const daemon = program.command("daemon").description("Run the HTTP/SSE daemon");
daemon.command("start").description("Start daemon in the foreground").action(startDaemon);
daemon.command("status").description("Show daemon status").action(run(daemonStatus));
daemon.command("stop").description("Show daemon stop guidance").action(stopDaemon);

const manager = program.command("manager").description("Manage the singleton manager session");
manager.command("create")
  .argument("<repo>")
  .argument("<agent>")
  .option("-p, --prompt <prompt>")
  .option("--mode <mode>", "approval or autopilot", "approval")
  .description("Create the manager session")
  .action((repo, agent, options) => run(async () => {
    const { DaemonClient } = await import("./client");
    const { printSession } = await import("./format");
    printSession(await new DaemonClient().create(repo, agent, options.prompt, { manager_mode: parseManagerMode(options.mode) }));
  })());
manager.command("show").description("Show the manager session").action(run(async () => {
  const { DaemonClient } = await import("./client");
  const { printSession } = await import("./format");
  printSession(await new DaemonClient().manager());
}));
manager.command("send").argument("<text>").description("Send a manager message").action((text) => run(async () => {
  const { DaemonClient } = await import("./client");
  const client = new DaemonClient();
  const session = await client.manager();
  await client.send(session.id, text);
  console.log("sent");
})());
manager.command("mode").argument("<mode>").description("Set manager mode").action((mode) => run(async () => {
  const { DaemonClient } = await import("./client");
  const client = new DaemonClient();
  const session = await client.manager();
  await client.setManagerMode(session.id, parseManagerMode(mode));
  console.log("updated");
})());
manager.command("approve").argument("<toolCallId>").description("Approve a pending manager tool call").action((toolCallId) => run(async () => {
  const { DaemonClient } = await import("./client");
  const client = new DaemonClient();
  const session = await client.manager();
  await client.approveToolCall(session.id, toolCallId);
  console.log("approved");
})());
manager.command("deny").argument("<toolCallId>").description("Deny a pending manager tool call").action((toolCallId) => run(async () => {
  const { DaemonClient } = await import("./client");
  const client = new DaemonClient();
  const session = await client.manager();
  await client.denyToolCall(session.id, toolCallId);
  console.log("denied");
})());

program.parse();

/** Wraps command handlers with consistent error output. */
function run(fn: () => Promise<void> | void): () => void {
  return () => {
    Promise.resolve(fn()).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  };
}

/** Parses a manager mode CLI argument. */
function parseManagerMode(value: string): ManagerMode {
  if (value === "approval" || value === "autopilot") {
    return value;
  }
  throw new Error("invalid_manager_mode");
}
