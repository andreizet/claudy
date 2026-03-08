import { UsageDashboard } from "../types";

export type ProjectSortKey = "project" | "sessions" | "tokens" | "cost" | "messages" | "last_active";
export type SessionSortKey = "session" | "project" | "started" | "duration" | "tokens" | "cost" | "prompt";
export type SortDirection = "asc" | "desc";
export type SortState<TSortKey extends string> = { key: TSortKey; direction: SortDirection };

export function toggleSort<TSortKey extends string>(
  current: SortState<TSortKey>,
  key: TSortKey,
): SortState<TSortKey> {
  if (current.key === key) {
    const direction: SortDirection = current.direction === "asc" ? "desc" : "asc";
    return { key, direction };
  }

  return { key, direction: "desc" };
}

export function compareProjectRows(
  a: UsageDashboard["projects"][number],
  b: UsageDashboard["projects"][number],
  sort: SortState<ProjectSortKey>,
) {
  const multiplier = sort.direction === "asc" ? 1 : -1;
  switch (sort.key) {
    case "project":
      return a.display_name.localeCompare(b.display_name) * multiplier;
    case "sessions":
      return (a.sessions - b.sessions) * multiplier;
    case "tokens":
      return (a.total_tokens - b.total_tokens) * multiplier;
    case "cost":
      return (a.cost_usd - b.cost_usd) * multiplier;
    case "messages":
      return (a.messages - b.messages) * multiplier;
    case "last_active":
      return a.last_active.localeCompare(b.last_active) * multiplier;
  }
}

export function compareSessionRows(
  a: UsageDashboard["sessions"][number],
  b: UsageDashboard["sessions"][number],
  sort: SortState<SessionSortKey>,
) {
  const multiplier = sort.direction === "asc" ? 1 : -1;
  switch (sort.key) {
    case "session":
      return a.session_id.localeCompare(b.session_id) * multiplier;
    case "project":
      return a.display_name.localeCompare(b.display_name) * multiplier;
    case "started":
      return a.start_time.localeCompare(b.start_time) * multiplier;
    case "duration":
      return (a.duration_minutes - b.duration_minutes) * multiplier;
    case "tokens":
      return (a.total_tokens - b.total_tokens) * multiplier;
    case "cost":
      return (a.cost_usd - b.cost_usd) * multiplier;
    case "prompt":
      return a.first_prompt.localeCompare(b.first_prompt) * multiplier;
  }
}
