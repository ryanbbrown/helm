import type { SessionManager } from "../session-manager";

export type ManagerToolContext = {
  manager: SessionManager;
  managerSessionId: string;
};
