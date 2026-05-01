import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { DaemonClient } from "../client";
import { printEvent } from "../format";
import { createLocalManager, streamLocalEvents } from "../local";

type CreateOptions = {
  prompt?: string;
};

/** Creates a session and enters the follow-up prompt loop. */
export async function createSession(repo: string, agent: string, options: CreateOptions): Promise<void> {
  const prompt = options.prompt ?? (await ask("Initial prompt: "));
  const client = new DaemonClient();
  if (await client.isUp()) {
    const session = await client.create(repo, agent, prompt);
    void printEvents(client.streamEvents(session.id));
    await followUps((text) => client.send(session.id, text));
    return;
  }

  const manager = createLocalManager();
  const session = await manager.create({ repo, agent, prompt });
  void printEvents(streamLocalEvents(manager, session.id));
  await followUps((text) => manager.send(session.id, text));
}

/** Prints streamed events until the process exits. */
async function printEvents(events: AsyncIterable<Parameters<typeof printEvent>[0]>): Promise<void> {
  for await (const event of events) {
    printEvent(event);
  }
}

/** Reads follow-up messages from stdin. */
async function followUps(send: (text: string) => Promise<unknown>): Promise<void> {
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const text = await rl.question("> ");
      if (text.trim() === "/exit") {
        return;
      }
      if (text.trim()) {
        await send(text);
      }
    }
  } finally {
    rl.close();
  }
}

/** Asks one prompt on stdin. */
async function ask(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}
