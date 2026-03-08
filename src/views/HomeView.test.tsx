import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/providers";
import { missingWorkspace, mockWorkspace } from "../test/fixtures";
import HomeView from "./HomeView";

const invokeMock = vi.fn();
const openMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

vi.mock("./UsageDashboardView", () => ({
  default: () => <div>usage-dashboard</div>,
}));

const workspaces = [
  mockWorkspace,
  {
    ...mockWorkspace,
    encoded_name: "-Users-andrei-_work-backend",
    decoded_path: "/Users/andrei/_work/backend",
    display_name: "backend",
    sessions: [mockWorkspace.sessions[0]],
  },
  missingWorkspace,
];

describe("HomeView behavior", () => {
  beforeEach(() => {
    window.localStorage.clear();
    invokeMock.mockReset();
    openMock.mockReset();
    invokeMock.mockResolvedValue(null);
  });

  it("hydrates favorites from localStorage and persists toggles", async () => {
    window.localStorage.setItem("claudy.favoriteWorkspaces", JSON.stringify([mockWorkspace.encoded_name]));

    renderWithProviders(
      <HomeView
        workspaces={workspaces}
        isLoading={false}
        accountInfo={null}
        onOpenWorkspace={() => {}}
        onCreateSession={() => {}}
      />
    );

    fireEvent.click(screen.getByText("Favorites"));
    expect(screen.getByText("claudy")).toBeInTheDocument();
    expect(screen.queryByText("backend")).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Remove from favorites"));
    await waitFor(() =>
      expect(window.localStorage.getItem("claudy.favoriteWorkspaces")).toBe(JSON.stringify([]))
    );
  });

  it("filters projects and favorites by search", async () => {
    window.localStorage.setItem("claudy.favoriteWorkspaces", JSON.stringify([mockWorkspace.encoded_name]));

    renderWithProviders(
      <HomeView
        workspaces={workspaces}
        isLoading={false}
        accountInfo={null}
        onOpenWorkspace={() => {}}
        onCreateSession={() => {}}
      />
    );

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "back" } });
    expect(screen.getByText("backend")).toBeInTheDocument();
    expect(screen.queryByText("claudy")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Favorites"));
    expect(screen.queryByText("backend")).not.toBeInTheDocument();
  });

  it("switches between usage, projects, and favorites nav", async () => {
    renderWithProviders(
      <HomeView
        workspaces={workspaces}
        isLoading={false}
        accountInfo={null}
        onOpenWorkspace={() => {}}
        onCreateSession={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Usage" }));
    expect(screen.getByText("usage-dashboard")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(screen.getByText("claudy")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Favorites" }));
    expect(screen.getByText("No favorites yet")).toBeInTheDocument();
  });

  it("uses folder picker result for New Session", async () => {
    const onCreateSession = vi.fn();
    openMock.mockResolvedValue("/tmp/picked-folder");

    renderWithProviders(
      <HomeView
        workspaces={workspaces}
        isLoading={false}
        accountInfo={null}
        onOpenWorkspace={() => {}}
        onCreateSession={onCreateSession}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "New Session" }));

    await waitFor(() => expect(openMock).toHaveBeenCalledTimes(1));
    expect(onCreateSession).toHaveBeenCalledWith("/tmp/picked-folder");
  });
});
