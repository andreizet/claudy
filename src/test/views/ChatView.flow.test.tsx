import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../providers";
import { mockWorkspace } from "../fixtures";
import { ClaudeAccountInfo, DiscoveredWorkspace } from "../../types";

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

vi.mock("../../components/chat/MessageList", () => ({
  default: ({
    messages,
    streamMessages,
    pendingUserText,
    showGenerating,
    streamBlocks,
  }: {
    messages: Array<{ message?: { content?: string } }>;
    streamMessages?: Array<{ message?: { content?: Array<{ type: string; text?: string; name?: string }> } }>;
    pendingUserText?: string;
    showGenerating?: boolean;
    streamBlocks?: Array<{ type: string; text?: string; name?: string; thinking?: string }>;
  }) => (
    <div data-testid="message-list">
      <div>message-count:{messages.length}</div>
      <div>stream-message-count:{(streamMessages ?? []).length}</div>
      <div>pending-user:{pendingUserText ?? ""}</div>
      <div>show-generating:{String(!!showGenerating)}</div>
      <div>stream-blocks:{(streamBlocks ?? []).map((block) => {
        if (block.type === "text") return block.text ?? "";
        if (block.type === "thinking") return `thinking:${block.thinking ?? ""}`;
        return `${block.type}:${block.name ?? ""}`;
      }).join("|")}</div>
    </div>
  ),
}));

import ChatView from "../../views/ChatView";

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
    const listeners = new Map<string, (payload: { payload: string }) => void>();
    listenMock.mockImplementation((event: string, callback: (payload: { payload: string }) => void) => {
      listeners.set(event, callback);
      return Promise.resolve(() => listeners.delete(event));
    });
    const workspace = { ...mockWorkspace, sessions: [] };
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case "get_claude_session_init":
          return Promise.resolve({
            session_id: null,
            cwd: workspace.decoded_path,
            model: "claude-sonnet-4-6",
            tools: ["Read", "Edit", "Bash"],
            mcp_servers: [],
          });
        case "get_workspace_files":
          return Promise.resolve([]);
        case "get_workspace_slash_commands":
          return Promise.resolve([]);
        case "get_workspace_favicon":
          return Promise.resolve(null);
        case "send_new_message":
          return Promise.resolve(null);
        case "describe_workspace":
          return Promise.resolve({
            ...workspace,
            sessions: [
              {
                id: "session-created",
                file_path: "/tmp/claudy/session-created.jsonl",
                modified_at: `${Math.floor(Date.now() / 1000)}`,
                first_message: "hello from new session",
              },
            ],
          });
        default:
          return Promise.resolve([]);
      }
    });

    renderChat(workspace);
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(screen.getByText("Configuring Claude Code")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Ask for follow-up changes…")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_claude_session_init", expect.any(Object)));
    expect(await screen.findByRole("button", { name: "Save" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

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

    listeners.get("claude-stream")?.({
      payload: JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "session-created",
        cwd: workspace.decoded_path,
        model: "claude-sonnet-4-6",
        tools: ["Read", "Edit", "Bash"],
        mcp_servers: [],
      }),
    });

    expect(await screen.findByText("hello from new session")).toBeInTheDocument();
  });

  it("normal send uses send_message", async () => {
    window.localStorage.setItem("claudy.appSettings", JSON.stringify({ yoloMode: true }));

    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case "get_claude_session_init":
          return Promise.resolve({
            session_id: mockWorkspace.sessions[0].id,
            cwd: mockWorkspace.decoded_path,
            model: "claude-sonnet-4-6",
            tools: ["Read", "Edit", "Bash", "mcp__claude_ai_MCP_AWR__GetKeywordsDifficulty"],
            mcp_servers: ["Claude AI MCP AWR"],
          });
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
        yoloMode: true,
      }));
    });
  });

  it("existing session settings can be loaded and dismissed", async () => {
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case "get_claude_session_init":
          return Promise.resolve({
            session_id: mockWorkspace.sessions[0].id,
            cwd: mockWorkspace.decoded_path,
            model: "claude-sonnet-4-6",
            tools: ["Read", "Edit", "WebFetch", "mcp__claude_ai_MCP_AWR__GetKeywordsDifficulty"],
            mcp_servers: ["Claude AI MCP AWR"],
          });
        case "get_session_messages":
          return Promise.resolve([]);
        case "get_workspace_files":
          return Promise.resolve([]);
        case "get_workspace_slash_commands":
          return Promise.resolve([]);
        case "get_workspace_favicon":
          return Promise.resolve(null);
        default:
          return Promise.resolve([]);
      }
    });

    renderChat(mockWorkspace);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_session_messages", expect.any(Object)));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_claude_session_init", expect.any(Object)));

    fireEvent.click(screen.getByTitle("Session settings"));
    expect(await screen.findByText("Built-in Tools (3)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "CLAUDE.md" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument());
  });

  it("loads and creates CLAUDE.md from the session settings overlay", async () => {
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case "get_claude_session_init":
          return Promise.resolve({
            session_id: mockWorkspace.sessions[0].id,
            cwd: mockWorkspace.decoded_path,
            model: "claude-sonnet-4-6",
            tools: ["Read", "Edit", "Bash"],
            mcp_servers: [],
          });
        case "get_session_messages":
          return Promise.resolve([]);
        case "get_workspace_files":
          return Promise.resolve([]);
        case "get_workspace_slash_commands":
          return Promise.resolve([]);
        case "get_workspace_favicon":
          return Promise.resolve(null);
        case "get_workspace_claude_md":
          return Promise.resolve({ exists: false, content: "" });
        case "save_workspace_claude_md":
          return Promise.resolve(null);
        default:
          return Promise.resolve([]);
      }
    });

    renderChat(mockWorkspace);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_session_messages", expect.any(Object)));

    fireEvent.click(screen.getByTitle("Session settings"));
    expect(await screen.findByRole("button", { name: "CLAUDE.md" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "CLAUDE.md" }));

    expect(await screen.findByText("No CLAUDE.md file exists yet. Start typing and save to create it.")).toBeInTheDocument();
    const editor = screen.getByRole("textbox", { name: "CLAUDE.md editor" });
    fireEvent.change(editor, { target: { value: "# Project rules\n\n- Keep tests green." } });

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(await screen.findByText("Project rules")).toBeInTheDocument();
    expect(screen.getByText("Keep tests green.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("save_workspace_claude_md", {
        workspacePath: mockWorkspace.decoded_path,
        content: "# Project rules\n\n- Keep tests green.",
      });
    });
  });

  it("slash command opens interactive overlay instead of normal send", async () => {
    window.localStorage.setItem("claudy.appSettings", JSON.stringify({ yoloMode: true }));

    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case "get_claude_session_init":
          return Promise.resolve({
            session_id: mockWorkspace.sessions[0].id,
            cwd: mockWorkspace.decoded_path,
            model: "claude-sonnet-4-6",
            tools: ["Read", "Edit", "Bash", "mcp__claude_ai_MCP_AWR__GetKeywordsDifficulty"],
            mcp_servers: ["Claude AI MCP AWR"],
          });
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
        yoloMode: true,
      });
    });
    expect(invokeMock).not.toHaveBeenCalledWith("send_message", expect.anything());
    expect(screen.getByText("Type directly in the terminal. Press Esc or use close to return to chat.")).toBeInTheDocument();
  });

  it("selected skill slash command sends normally without opening the interactive overlay", async () => {
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case "get_claude_session_init":
          return Promise.resolve({
            session_id: mockWorkspace.sessions[0].id,
            cwd: mockWorkspace.decoded_path,
            model: "claude-sonnet-4-6",
            tools: ["Read", "Edit", "Bash"],
            mcp_servers: [],
          });
        case "get_session_messages":
          return Promise.resolve([]);
        case "get_workspace_files":
          return Promise.resolve([]);
        case "get_workspace_slash_commands":
          return Promise.resolve([
            {
              name: "my-skill",
              description: "Run a custom skill",
              source: "user",
              kind: "skill",
            },
          ]);
        case "get_workspace_favicon":
          return Promise.resolve(null);
        case "send_message":
          return Promise.resolve(null);
        default:
          return Promise.resolve([]);
      }
    });

    renderChat(mockWorkspace);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("get_workspace_slash_commands", expect.any(Object)));

    const textarea = screen.getByPlaceholderText("Ask for follow-up changes…");
    fireEvent.change(textarea, { target: { value: "/my", selectionStart: 3 } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await screen.findByText("/my-skill");

    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("send_message", expect.objectContaining({
        sessionId: mockWorkspace.sessions[0].id,
        message: "/my-skill",
      }));
    });
    expect(invokeMock).not.toHaveBeenCalledWith("start_interactive_command", expect.anything());
    expect(screen.queryByText("Type directly in the terminal. Press Esc or use close to return to chat.")).not.toBeInTheDocument();
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

  it("uses the selected tool allowlist from the session card", async () => {
    const listeners = new Map<string, (payload: { payload: string }) => void>();
    listenMock.mockImplementation((event: string, callback: (payload: { payload: string }) => void) => {
      listeners.set(event, callback);
      return Promise.resolve(() => listeners.delete(event));
    });
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case "get_claude_session_init":
          return Promise.resolve({
            session_id: mockWorkspace.sessions[0].id,
            cwd: mockWorkspace.decoded_path,
            model: "claude-sonnet-4-6",
            tools: ["Read", "Edit", "Bash"],
            mcp_servers: [],
          });
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

    listeners.get("claude-stream")?.({
      payload: JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: mockWorkspace.sessions[0].id,
        cwd: mockWorkspace.decoded_path,
        model: "claude-sonnet-4-6",
        tools: ["Read", "Edit", "Bash", "mcp__claude_ai_MCP_AWR__GetKeywordsDifficulty"],
        mcp_servers: ["Claude AI MCP AWR"],
      }),
    });

    fireEvent.click(screen.getByTitle("Session settings"));
    expect(await screen.findByRole("button", { name: "Save" })).toBeInTheDocument();
    fireEvent.click(screen.getByText("Disable all"));
    fireEvent.click(screen.getByLabelText("Read"));
    fireEvent.click(screen.getByLabelText("Bash"));
    expect(screen.queryByLabelText("GetKeywordsDifficulty")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /MCP Servers \(1\)/ }));
    expect(screen.getByText("Claude AI MCP AWR")).toBeInTheDocument();
    expect(screen.getByLabelText("GetKeywordsDifficulty")).toBeInTheDocument();
    expect(screen.queryByText("mcp__claude_ai_MCP_AWR__GetKeywordsDifficulty")).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("GetKeywordsDifficulty"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const textarea = screen.getByPlaceholderText("Ask for follow-up changes…");
    fireEvent.change(textarea, { target: { value: "continue this", selectionStart: 13 } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenLastCalledWith("send_message", expect.objectContaining({
        sessionId: mockWorkspace.sessions[0].id,
        message: "continue this",
        allowedTools: ["Read", "Bash", "mcp__claude_ai_MCP_AWR__GetKeywordsDifficulty"],
      }));
    });
  });

  it("renders incremental stream deltas while a response is in flight", async () => {
    const listeners = new Map<string, (payload: { payload: string }) => void>();
    listenMock.mockImplementation((event: string, callback: (payload: { payload: string }) => void) => {
      listeners.set(event, callback);
      return Promise.resolve(() => listeners.delete(event));
    });
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

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "stream this", selectionStart: 11 } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    listeners.get("claude-stream")?.({
      payload: JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: {
            type: "text_delta",
            text: "Hello",
          },
        },
      }),
    });
    listeners.get("claude-stream")?.({
      payload: JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: {
            type: "text_delta",
            text: " world",
          },
        },
      }),
    });

    expect(await screen.findByText("stream-blocks:Hello world")).toBeInTheDocument();
  });

  it("keeps earlier streamed tool steps visible when a later assistant message starts", async () => {
    const listeners = new Map<string, (payload: { payload: string }) => void>();
    listenMock.mockImplementation((event: string, callback: (payload: { payload: string }) => void) => {
      listeners.set(event, callback);
      return Promise.resolve(() => listeners.delete(event));
    });
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

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "use a tool", selectionStart: 10 } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    listeners.get("claude-stream")?.({
      payload: JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-1",
            name: "Read",
            input: {
              file_path: "src/App.tsx",
            },
          },
        },
      }),
    });

    expect(await screen.findByText("stream-blocks:tool_use:Read")).toBeInTheDocument();

    listeners.get("claude-stream")?.({
      payload: JSON.stringify({
        type: "stream_event",
        event: {
          type: "message_start",
        },
      }),
    });

    listeners.get("claude-stream")?.({
      payload: JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tool-2",
            name: "Bash",
            input: {
              command: "npm test",
            },
          },
        },
      }),
    });

    expect(await screen.findByText("stream-message-count:1")).toBeInTheDocument();
    expect(await screen.findByText("stream-blocks:tool_use:Bash")).toBeInTheDocument();
  });

  it("shows thinking only while the current block is active", async () => {
    const listeners = new Map<string, (payload: { payload: string }) => void>();
    listenMock.mockImplementation((event: string, callback: (payload: { payload: string }) => void) => {
      listeners.set(event, callback);
      return Promise.resolve(() => listeners.delete(event));
    });
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

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "think first", selectionStart: 11 } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    listeners.get("claude-stream")?.({
      payload: JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "Inspecting context",
          },
        },
      }),
    });

    expect(await screen.findByText("stream-blocks:thinking:Inspecting context")).toBeInTheDocument();

    listeners.get("claude-stream")?.({
      payload: JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_stop",
          index: 0,
        },
      }),
    });

    await waitFor(() => {
      expect(screen.getByText("stream-blocks:")).toBeInTheDocument();
    });
  });

  it("keeps a generating marker on the original session and turns it into a check when completion happens off-screen", async () => {
    const listeners = new Map<string, (payload: { payload: string }) => void>();
    listenMock.mockImplementation((event: string, callback: (payload: { payload: string }) => void) => {
      listeners.set(event, callback);
      return Promise.resolve(() => listeners.delete(event));
    });
    invokeMock.mockImplementation((command: string, args?: { filePath?: string }) => {
      switch (command) {
        case "get_session_messages":
          if (args?.filePath === mockWorkspace.sessions[1].file_path) return Promise.resolve([]);
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

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "keep working", selectionStart: 12 } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(screen.getByLabelText("Session generating")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Fix the dashboard charts"));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("get_session_messages", {
        filePath: mockWorkspace.sessions[1].file_path,
      });
    });
    expect(screen.getByLabelText("Session generating")).toBeInTheDocument();

    listeners.get("claude-done")?.({ payload: "" });

    await waitFor(() => {
      expect(screen.getByLabelText("Session completed")).toBeInTheDocument();
    });
  });
});
