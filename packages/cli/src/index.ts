#!/usr/bin/env bun
import { Command } from "commander";
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
session.command("list").description("List sessions").action(run(listSessions));
session.command("show").argument("<id>").description("Show a session").action((id) => run(() => showSession(id))());
session.command("send").argument("<id>").argument("<text>").description("Send a follow-up").action((id, text) => run(() => sendSession(id, text))());
session.command("stop").argument("<id>").description("Stop a session").action((id) => run(() => stopSession(id))());
session.command("archive").argument("<id>").option("--force").description("Archive a session").action((id, options) => run(() => archiveSession(id, options))());

const daemon = program.command("daemon").description("Run the HTTP/SSE daemon");
daemon.command("start").description("Start daemon in the foreground").action(startDaemon);
daemon.command("status").description("Show daemon status").action(run(daemonStatus));
daemon.command("stop").description("Show daemon stop guidance").action(stopDaemon);

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
