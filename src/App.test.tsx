import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "./test/providers";
import { mockWorkspace } from "./test/fixtures";
import { DiscoveredWorkspace } from "./types";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("./views/HomeView", () => ({
  default: ({
    workspaces,
    onOpenWorkspace,
    onCreateSession,
    mainHeader,
  }: {
    workspaces: DiscoveredWorkspace[];
    onOpenWorkspace: (workspace: DiscoveredWorkspace) => void;
    onCreateSession: (workspacePath: string) => void;
    mainHeader?: React.ReactNode;
  }) => (
    <div>
      <div data-testid="home-header">{mainHeader}</div>
      <div>home-view</div>
      {workspaces.map((workspace) => (
        <button key={workspace.encoded_name} onClick={() => onOpenWorkspace(workspace)}>
          open-{workspace.display_name}
        </button>
      ))}
      <button onClick={() => onCreateSession("/picked/project")}>create-session</button>
    </div>
  ),
}));

vi.mock("./views/ChatView", () => ({
  default: ({
    workspace,
    onBack,
    mainHeader,
  }: {
    workspace: DiscoveredWorkspace;
    onBack: () => void;
    mainHeader?: React.ReactNode;
  }) => (
    <div>
      <div data-testid="chat-header">{mainHeader}</div>
      <div>chat-{workspace.display_name}</div>
      <button onClick={onBack}>back-to-home</button>
    </div>
  ),
}));

import App from "./App";

const workspaceA: DiscoveredWorkspace = mockWorkspace;
const workspaceB: DiscoveredWorkspace = {
  ...mockWorkspace,
  encoded_name: "-Users-andrei-_work-backend",
  decoded_path: "/Users/andrei/_work/backend",
  display_name: "backend",
  sessions: [
    {
      id: "session-backend",
      file_path: "/tmp/backend.jsonl",
      modified_at: `${Math.floor(Date.now() / 1000) - 500}`,
      first_message: "Investigate the API",
    },
  ],
};

describe("App tab and session flow", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    window.localStorage.clear();
    invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case "scan_existing_sessions":
          return Promise.resolve([workspaceA, workspaceB]);
        case "claude-account-info":
        case "get_claude_account_info":
          return Promise.resolve(null);
        case "get_workspace_favicon":
          return Promise.resolve(null);
        case "describe_workspace":
          return Promise.resolve(
            (args?.workspacePath === workspaceB.decoded_path || args?.workspacePath === "/picked/project")
              ? workspaceB
              : workspaceA
          );
        default:
          return Promise.resolve(null);
      }
    });
  });

  it("opening a project creates and selects the right chat tab", async () => {
    renderWithProviders(<App />);

    await waitFor(() => expect(screen.getByRole("button", { name: "open-claudy" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "open-claudy" }));

    await waitFor(() => expect(screen.getByText("chat-claudy")).toBeInTheDocument());
    expect(screen.getByText("claudy - Implement the login flow")).toBeInTheDocument();
  });

  it("plus creates a home tab and choosing a project replaces that home tab", async () => {
    renderWithProviders(<App />);

    await waitFor(() => expect(screen.getByRole("button", { name: "open-claudy" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "open-claudy" }));
    await waitFor(() => expect(screen.getByText("chat-claudy")).toBeInTheDocument());

    fireEvent.click(screen.getByTitle("New tab"));
    await waitFor(() => expect(screen.getByText("home-view")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "open-backend" }));
    await waitFor(() => expect(screen.getByText("chat-backend")).toBeInTheDocument());

    expect(screen.getByText("backend - Investigate the API")).toBeInTheDocument();
    expect(screen.getByText("claudy - Implement the login flow")).toBeInTheDocument();
  });

  it("closing the active tab falls back to the previous available tab", async () => {
    renderWithProviders(<App />);

    await waitFor(() => expect(screen.getByRole("button", { name: "open-claudy" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "open-claudy" }));
    await waitFor(() => expect(screen.getByText("chat-claudy")).toBeInTheDocument());

    fireEvent.click(screen.getByTitle("New tab"));
    await waitFor(() => expect(screen.getByText("home-view")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "open-backend" }));
    await waitFor(() => expect(screen.getByText("chat-backend")).toBeInTheDocument());

    const closeButtons = screen.getAllByText("×");
    fireEvent.click(closeButtons[1]);

    await waitFor(() => expect(screen.getByText("chat-claudy")).toBeInTheDocument());
    expect(screen.queryByText("chat-backend")).not.toBeInTheDocument();
  });
});
