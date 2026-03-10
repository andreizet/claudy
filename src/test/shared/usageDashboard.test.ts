import { describe, expect, it } from "vitest";
import { compareProjectRows, compareSessionRows, toggleSort } from "../../shared/usageDashboard";
import { UsageProjectBreakdown, UsageSessionBreakdown } from "../../types";

const projectA: UsageProjectBreakdown = {
  project_path: "/tmp/a",
  display_name: "alpha",
  sessions: 2,
  messages: 14,
  input_tokens: 120,
  output_tokens: 80,
  total_tokens: 200,
  cost_usd: 1.25,
  lines_added: 10,
  lines_removed: 5,
  files_modified: 3,
  last_active: "2026-03-07T10:00:00Z",
};

const projectB: UsageProjectBreakdown = {
  ...projectA,
  project_path: "/tmp/b",
  display_name: "beta",
  sessions: 5,
  messages: 7,
  total_tokens: 90,
  cost_usd: 0.45,
  last_active: "2026-03-08T11:00:00Z",
};

const sessionA: UsageSessionBreakdown = {
  session_id: "aaa",
  project_path: "/tmp/a",
  display_name: "alpha",
  start_time: "2026-03-07T10:00:00Z",
  duration_minutes: 12,
  user_messages: 4,
  assistant_messages: 4,
  input_tokens: 120,
  output_tokens: 80,
  total_tokens: 200,
  cost_usd: 1.25,
  first_prompt: "alpha prompt",
};

const sessionB: UsageSessionBreakdown = {
  ...sessionA,
  session_id: "bbb",
  display_name: "beta",
  start_time: "2026-03-08T11:00:00Z",
  duration_minutes: 8,
  total_tokens: 90,
  cost_usd: 0.45,
  first_prompt: "beta prompt",
};

describe("toggleSort", () => {
  it("toggles direction when the same key is selected", () => {
    expect(toggleSort({ key: "tokens", direction: "desc" }, "tokens")).toEqual({
      key: "tokens",
      direction: "asc",
    });
  });

  it("resets to descending when a new key is selected", () => {
    expect(toggleSort({ key: "tokens", direction: "asc" }, "cost")).toEqual({
      key: "cost",
      direction: "desc",
    });
  });
});

describe("compareProjectRows", () => {
  it("sorts numeric project fields in descending order", () => {
    expect(compareProjectRows(projectA, projectB, { key: "sessions", direction: "desc" })).toBeGreaterThan(0);
    expect(compareProjectRows(projectA, projectB, { key: "cost", direction: "desc" })).toBeLessThan(0);
  });

  it("sorts project names alphabetically", () => {
    expect(compareProjectRows(projectA, projectB, { key: "project", direction: "asc" })).toBeLessThan(0);
  });
});

describe("compareSessionRows", () => {
  it("sorts started timestamps with newest first in descending mode", () => {
    expect(compareSessionRows(sessionA, sessionB, { key: "started", direction: "desc" })).toBeGreaterThan(0);
  });

  it("sorts prompts alphabetically in ascending mode", () => {
    expect(compareSessionRows(sessionA, sessionB, { key: "prompt", direction: "asc" })).toBeLessThan(0);
  });
});
