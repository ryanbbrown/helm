export type ManagerMode = "approval" | "autopilot";

export type ManagerToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type ManagerToolResult = {
  ok: boolean;
  result?: unknown;
  errorMessage?: string;
};

export type ManagerLimits = {
  max_tool_iterations_per_turn: number;
  max_tool_calls_per_batch: number;
  max_queued_wakes_per_turn: number;
  max_live_children: number;
};

export const DEFAULT_MANAGER_LIMITS: ManagerLimits = {
  max_tool_iterations_per_turn: 20,
  max_tool_calls_per_batch: 20,
  max_queued_wakes_per_turn: 50,
  max_live_children: 25
};
