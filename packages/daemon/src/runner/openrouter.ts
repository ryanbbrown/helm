import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import OpenAI from "openai";

export type ManagerChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ManagerChatToolCall[];
};

export type ManagerChatToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ManagerChatTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ManagerChatCompletion = {
  message: ManagerChatMessage;
  finishReason: string | null;
  usage?: unknown;
};

export type ManagerChatCompletionInput = {
  model: string;
  messages: ManagerChatMessage[];
  tools: ManagerChatTool[];
  signal: AbortSignal;
  logPath: string;
};

export interface ManagerChatClient {
  /** Runs one non-streaming manager chat completion. */
  chatCompletion(input: ManagerChatCompletionInput): Promise<ManagerChatCompletion>;
}

export class OpenRouterClient implements ManagerChatClient {
  private client: OpenAI;

  /** Creates an OpenRouter client using an OpenAI-compatible endpoint. */
  constructor(apiKey: string) {
    if (!apiKey) {
      throw new Error("Missing OpenRouter API key");
    }
    this.client = new OpenAI({
      apiKey,
      baseURL: "https://openrouter.ai/api/v1"
    });
  }

  /** Runs one non-streaming OpenRouter chat completion. */
  async chatCompletion({ model, messages, tools, signal, logPath }: ManagerChatCompletionInput): Promise<ManagerChatCompletion> {
    writeJsonLine(logPath, { type: "request", model, messages, tools });
    const response = await this.client.chat.completions.create(
      {
        model,
        messages: messages as never,
        stream: false,
        tools: tools as never
      },
      { signal }
    );
    writeJsonLine(logPath, { type: "response", response });
    const choice = response.choices[0];
    return {
      message: choice?.message as ManagerChatMessage,
      finishReason: choice?.finish_reason ?? null,
      usage: response.usage
    };
  }
}

/** Appends one JSON object to the manager debug log. */
export function writeJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`);
}
