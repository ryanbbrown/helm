import { ulid } from "ulid";

/** Generates a short sortable session id. */
export function createId(): string {
  return ulid();
}
