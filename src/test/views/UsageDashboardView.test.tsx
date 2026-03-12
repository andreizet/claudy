import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderWithProviders } from "../providers";
import UsageDashboardView from "../../views/UsageDashboardView";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const usageDashboardFixture = {
  interval: "30d",
  summary: {
    total_sessions: 12,
    total_messages: 48,
    total_input_tokens: 1000,
    total_output_tokens: 500,
    total_tokens: 1500,
    total_cost_usd: 3.14,
    total_tool_calls: 8,
    total_lines_added: 20,
    total_lines_removed: 5,
    total_files_modified: 4,
    active_days: 6,
    avg_messages_per_session: 4,
  },
  daily: [
    { date: "2026-03-10", sessions: 2, messages: 8, total_tokens: 300, cost_usd: 0.64 },
  ],
  models: [
    { model: "sonnet", input_tokens: 1000, output_tokens: 500, total_tokens: 1500, cost_usd: 3.14, sessions: 12 },
  ],
  projects: [
    {
      project_path: "/tmp/project",
      display_name: "project",
      sessions: 12,
      messages: 48,
      input_tokens: 1000,
      output_tokens: 500,
      total_tokens: 1500,
      cost_usd: 3.14,
      lines_added: 20,
      lines_removed: 5,
      files_modified: 4,
      last_active: "2026-03-10T10:00:00Z",
    },
  ],
  sessions: [
    {
      session_id: "abcdef12-3456-7890",
      project_path: "/tmp/project",
      display_name: "project",
      start_time: "2026-03-10T10:00:00Z",
      duration_minutes: 15,
      user_messages: 4,
      assistant_messages: 4,
      input_tokens: 1000,
      output_tokens: 500,
      total_tokens: 1500,
      cost_usd: 3.14,
      first_prompt: "Review the changes",
    },
  ],
};

describe("UsageDashboardView", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("shows an overlay while loading usage data", async () => {
    let resolveQuery: ((value: typeof usageDashboardFixture) => void) | undefined;
    invokeMock.mockImplementation(() => new Promise<typeof usageDashboardFixture>((resolve) => {
      resolveQuery = resolve;
    }));

    renderWithProviders(<UsageDashboardView />);

    expect(screen.getByTestId("usage-loading-overlay")).toBeInTheDocument();

    resolveQuery?.(usageDashboardFixture);

    await waitFor(() => expect(screen.getByText("Usage Dashboard")).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByTestId("usage-loading-overlay")).not.toBeInTheDocument());
  });

  it("keeps the dashboard visible and shows the overlay while changing intervals", async () => {
    let first = true;
    let resolveSecond: ((value: typeof usageDashboardFixture) => void) | undefined;

    invokeMock.mockImplementation(() => {
      if (first) {
        first = false;
        return Promise.resolve(usageDashboardFixture);
      }
      return new Promise<typeof usageDashboardFixture>((resolve) => {
        resolveSecond = resolve;
      });
    });

    renderWithProviders(<UsageDashboardView />);

    await waitFor(() => expect(screen.getByText("Usage Dashboard")).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText("project").length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole("button", { name: "Last 7 days" }));

    await waitFor(() => expect(screen.getByTestId("usage-loading-overlay")).toBeInTheDocument());
    expect(screen.getAllByText("project").length).toBeGreaterThan(0);

    resolveSecond?.({ ...usageDashboardFixture, interval: "7d" });

    await waitFor(() => expect(screen.queryByTestId("usage-loading-overlay")).not.toBeInTheDocument());
  });
});
