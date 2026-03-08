import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../test/providers";
import { mockWorkspace } from "../test/fixtures";
import { ClaudeAccountInfo, DiscoveredWorkspace } from "../types";

const invokeMock = vi.fn();
const listenMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    attachCustomKeyEventHandler() {}
    onData() { return { dispose() {} }; }
    write() {}
    focus() {}
    dispose() {}
    cols = 80;
    rows = 24;
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

vi.mock("../components/chat/MessageList", () => ({
  default: ({
    messages,
    pendingUserText,
    showGenerating,
    streamText,
  }: {
    messages: Array<{ message?: { content?: string } }>;
    pendingUserText?: string;
    showGenerating?: boolean;
    streamText?: string;
  }) => (
    <div data-testid="message-list">
      <div>message-count:{messages.length}</div>
      <div>pending-user:{pendingUserText ?? ""}</div>
      <div>show-generating:{String(!!showGenerating)}</div>
      <div>stream-text:{streamText ?? ""}</div>
    </div>
  ),
}));

import ChatView from "./ChatView";

const accountInfo: ClaudeAccountInfo = {
  email: "awrcloud.app@caphyon.com",
  display_name: "Philip",
  organization_name: null,
  organization_role: null,
};

function renderChat(workspace: DiscoveredWorkspace) {
  return renderWithProviders(
    <ChatView
      workspace={workspace}
      accountInfo={accountInfo}
      onBack={() => {}}
    />
  );
}

describe("ChatView core message flow", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    listenMock.mockResolvedValue(() => {});
    window.localStorage.clear();
  });

  it("first prompt in a new session shows optimistic user message and generating state and uses send_new_message", async () => {
    const workspace = { ...mockWorkspace, sessions: [] };
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case "get_workspace_files":
          return Promise.resolve([]);
        case "get_workspace_slash_commands":
          return Promise.resolve([]);
        case "get_workspace_favicon":
          return Promise.resolve(null);
        case "send_new_message":
          return Promise.resolve(null);
        default:
          return Promise.resolve([]);
      }
    });

    renderChat(workspace);

    const textarea = screen.getByPlaceholderText("Ask for follow-up changes…");
    fireEvent.change(textarea, { target: { value: "hello from new session", selectionStart: 22 } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("send_new_message", expect.objectContaining({
        cwd: workspace.decoded_path,
        message: "hello from new session",
      }));
    });

    expect(screen.getByText("pending-user:hello from new session")).toBeInTheDocument();
    expect(screen.getByText("show-generating:true")).toBeInTheDocument();
  });

  it("normal send uses send_message", async () => {
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case "get_session_messages":
          return Promise.resolve([]);
        case "get_workspace_files":
          return Promise.resolve([]);
        case "get_workspace_slash_commands":
          return Promise.resolve([]);
        case "get_workspace_favicon":
          return Promise.resolve(null);
        case "send_message":
          return Promise.resolve(null);
        default:
          return Promise.resolve([]);
      }
    });

    renderChat(mockWorkspace);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_session_messages", expect.any(Object)));

    const textarea = screen.getByPlaceholderText("Ask for follow-up changes…");
    fireEvent.change(textarea, { target: { value: "continue this", selectionStart: 13 } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("send_message", expect.objectContaining({
        sessionId: mockWorkspace.sessions[0].id,
        message: "continue this",
      }));
    });
  });

  it("slash command opens interactive overlay instead of normal send", async () => {
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case "get_session_messages":
          return Promise.resolve([]);
        case "get_workspace_files":
          return Promise.resolve([]);
        case "get_workspace_slash_commands":
          return Promise.resolve([]);
        case "get_workspace_favicon":
          return Promise.resolve(null);
        case "start_interactive_command":
          return Promise.resolve("interactive-1");
        default:
          return Promise.resolve([]);
      }
    });

    renderChat(mockWorkspace);
    const textarea = screen.getByPlaceholderText("Ask for follow-up changes…");
    fireEvent.change(textarea, { target: { value: "/help ", selectionStart: 6 } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("start_interactive_command", {
        workspacePath: mockWorkspace.decoded_path,
        initialInput: "/help",
      });
    });
    expect(invokeMock).not.toHaveBeenCalledWith("send_message", expect.anything());
    expect(screen.getByText("Type directly in the terminal. Press Esc or use close to return to chat.")).toBeInTheDocument();
  });

  it("@file autocomplete creates removable badges and changes the sent payload", async () => {
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case "get_session_messages":
          return Promise.resolve([]);
        case "get_workspace_files":
          return Promise.resolve(["src/App.tsx", "src/views/HomeView.tsx"]);
        case "get_workspace_slash_commands":
          return Promise.resolve([]);
        case "get_workspace_favicon":
          return Promise.resolve(null);
        case "send_message":
          return Promise.resolve(null);
        default:
          return Promise.resolve([]);
      }
    });

    renderChat(mockWorkspace);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_workspace_files", expect.any(Object)));

    const textarea = screen.getByPlaceholderText("Ask for follow-up changes…");
    fireEvent.change(textarea, { target: { value: "@App", selectionStart: 4 } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    const badgeText = await screen.findByText("src/App.tsx");
    const badge = badgeText.parentElement as HTMLElement;
    expect(badgeText).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: "please review", selectionStart: 13 } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("send_message", expect.objectContaining({
        message: "@src/App.tsx\n\nplease review",
      }));
    });

    fireEvent.click(within(badge).getByRole("button"));
    expect(screen.queryByText("src/App.tsx")).not.toBeInTheDocument();
  });
});
