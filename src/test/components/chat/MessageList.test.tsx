import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { VirtuosoMockContext } from "react-virtuoso";
import { renderWithProviders } from "../../providers";
import { JsonlRecord } from "../../../types";

import MessageList from "../../../components/chat/MessageList";

const { notificationsShowMock } = vi.hoisted(() => ({
  notificationsShowMock: vi.fn(),
}));

vi.mock("@mantine/notifications", () => ({
  notifications: {
    show: notificationsShowMock,
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(""),
}));

function makeMessages(count: number): JsonlRecord[] {
  return Array.from({ length: count }).map((_, index) => ({
    type: index % 2 === 0 ? "user" : "assistant",
    timestamp: `2026-03-08T10:${String(index).padStart(2, "0")}:00Z`,
    message: {
      role: index % 2 === 0 ? "user" : "assistant",
      content: index % 2 === 0 ? `user-${index}` : [{ type: "text", text: `assistant-${index}` }],
    },
  }));
}

function setupViewport() {
  const viewport = screen.getByTestId("viewport") as HTMLDivElement;
  let scrollTop = 0;
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 200 });
  Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 2000 });
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value) => {
      scrollTop = value;
    },
  });
  viewport.scrollTo = vi.fn(({ top }: { top: number }) => {
    scrollTop = top;
  }) as unknown as typeof viewport.scrollTo;
  viewport.scrollBy = vi.fn(({ top }: { top: number }) => {
    scrollTop += top;
  }) as unknown as typeof viewport.scrollBy;
  return viewport;
}

function renderMessageList(node: React.ReactElement) {
  return renderWithProviders(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 200, itemHeight: 80 }}>
      {node}
    </VirtuosoMockContext.Provider>
  );
}

describe("MessageList behavior", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    notificationsShowMock.mockReset();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("scrolls to bottom when the session changes", async () => {
    const { rerender } = renderMessageList(
      <MessageList messages={makeMessages(20)} sessionId="session-a" />
    );
    const viewport = setupViewport();

    rerender(
      <VirtuosoMockContext.Provider value={{ viewportHeight: 200, itemHeight: 80 }}>
        <MessageList messages={makeMessages(20)} sessionId="session-b" />
      </VirtuosoMockContext.Provider>
    );

    await waitFor(() => {
      expect(viewport.scrollTop).toBe(2000);
    });
  });

  it("Home, End, PageUp, and PageDown work repeatedly", async () => {
    renderMessageList(<MessageList messages={makeMessages(40)} sessionId="session-nav" />);
    const viewport = setupViewport();
    viewport.scrollTop = 800;

    fireEvent.keyDown(window, { key: "PageUp" });
    fireEvent.keyDown(window, { key: "PageUp" });
    expect(viewport.scrollBy).toHaveBeenCalledTimes(2);
    expect(viewport.scrollTop).toBeLessThan(800);

    fireEvent.keyDown(window, { key: "PageDown" });
    fireEvent.keyDown(window, { key: "PageDown" });
    expect(viewport.scrollBy).toHaveBeenCalledTimes(4);

    fireEvent.keyDown(window, { key: "Home" });
    expect(viewport.scrollTop).toBe(0);

    fireEvent.keyDown(window, { key: "End" });
    expect(viewport.scrollTop).toBe(2000);
  });

  it("top and bottom buttons disable correctly in the virtualized list", async () => {
    renderMessageList(<MessageList messages={makeMessages(60)} sessionId="session-buttons" />);
    const viewport = setupViewport();
    viewport.scrollTop = 0;
    fireEvent.scroll(viewport);

    const topButton = screen.getByTitle("Scroll to Top") as HTMLButtonElement;
    const bottomButton = screen.getByTitle("Scroll to Bottom") as HTMLButtonElement;

    await waitFor(() => {
      expect(topButton.disabled).toBe(true);
      expect(bottomButton.disabled).toBe(false);
    });

    viewport.scrollTop = 1800;
    fireEvent.scroll(viewport);

    await waitFor(() => {
      expect(topButton.disabled).toBe(false);
      expect(bottomButton.disabled).toBe(true);
    });
  });

  it("shows a collapsed thinking card only for the active stream and expands on click", async () => {
    renderMessageList(
      <MessageList
        messages={[]}
        sessionId="session-thinking"
        showGenerating
        streamBlocks={[
          { type: "thinking", thinking: "Inspecting files" },
          { type: "text", text: "Done" },
        ]}
      />
    );
    setupViewport();

    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.queryByText("Inspecting files")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Thinking"));

    expect(await screen.findByText("Inspecting files")).toBeInTheDocument();
  });

  it("renders leading file references in user messages as badges without remove controls", () => {
    renderMessageList(
      <MessageList
        sessionId="session-files"
        messages={[
          {
            type: "user",
            timestamp: "2026-03-10T08:00:00Z",
            message: {
              role: "user",
              content: "@src/App.tsx\n@src/views/HomeView.tsx\n\nplease review these files",
            },
          },
        ]}
      />
    );
    setupViewport();

    const firstBadge = screen.getByText("src/App.tsx").parentElement as HTMLElement;
    const secondBadge = screen.getByText("src/views/HomeView.tsx").parentElement as HTMLElement;

    expect(firstBadge).toBeInTheDocument();
    expect(secondBadge).toBeInTheDocument();
    expect(screen.getByText("please review these files")).toBeInTheDocument();
    expect(within(firstBadge).queryByRole("button")).not.toBeInTheDocument();
    expect(within(secondBadge).queryByRole("button")).not.toBeInTheDocument();
  });

  it("hides expanded skill prompt boilerplate recorded as a user message", () => {
    renderMessageList(
      <MessageList
        sessionId="session-skill"
        messages={[
          {
            type: "user",
            timestamp: "2026-03-10T08:05:00Z",
            message: {
              role: "user",
              content: "Base directory for this skill: /Users/test/.claude/skills/my-skill\n\nWhen referencing files in this skill, prefer relative paths.",
            },
          },
        ]}
      />
    );
    setupViewport();

    expect(screen.queryByText(/Base directory for this skill/)).not.toBeInTheDocument();
  });

  it("copies assistant markdown and shows a toast", async () => {
    const writeTextMock = vi.mocked(navigator.clipboard.writeText);

    renderMessageList(
      <MessageList
        sessionId="session-copy-assistant"
        messages={[
          {
            type: "assistant",
            timestamp: "2026-03-10T08:10:00Z",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "## Title\n\n- item" }],
            },
          },
        ]}
      />
    );
    setupViewport();

    fireEvent.click(screen.getByLabelText("Copy assistant message"));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("## Title\n\n- item");
      expect(notificationsShowMock).toHaveBeenCalledWith(expect.objectContaining({
        title: "Copied to clipboard",
        message: "Assistant message copied",
      }));
    });
  });

  it("copies expanded tool section content and shows a toast", async () => {
    const writeTextMock = vi.mocked(navigator.clipboard.writeText);

    renderMessageList(
      <MessageList
        sessionId="session-copy-tool"
        messages={[
          {
            type: "user",
            timestamp: "2026-03-10T08:11:00Z",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "tool-1",
                  content: "first line\nsecond line",
                },
              ],
            },
          },
          {
            type: "assistant",
            timestamp: "2026-03-10T08:12:00Z",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "tool-1",
                  name: "Bash",
                  input: { command: "npm test" },
                },
              ],
            },
          },
        ]}
      />
    );
    setupViewport();

    fireEvent.click(screen.getByText("Run command"));
    fireEvent.click(screen.getByLabelText("Copy Run command command"));

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("npm test");
      expect(notificationsShowMock).toHaveBeenCalledWith(expect.objectContaining({
        title: "Copied to clipboard",
        message: "Run command command copied",
      }));
    });
  });
});
