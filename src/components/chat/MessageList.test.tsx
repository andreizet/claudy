import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../../test/providers";
import { JsonlRecord } from "../../types";

vi.mock("@mantine/core", async () => {
  const actual = await vi.importActual<typeof import("@mantine/core")>("@mantine/core");
  return {
    ...actual,
    ScrollArea: ({
      children,
      viewportRef,
      ...props
    }: {
      children: React.ReactNode;
      viewportRef?: React.Ref<HTMLDivElement>;
    }) => (
      <div {...props} data-testid="viewport" ref={viewportRef}>
        {children}
      </div>
    ),
  };
});

import MessageList from "./MessageList";

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

describe("MessageList behavior", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("scrolls to bottom when the session changes", async () => {
    const { rerender } = renderWithProviders(
      <MessageList messages={makeMessages(20)} sessionId="session-a" />
    );
    const viewport = setupViewport();

    rerender(
      <MessageList messages={makeMessages(20)} sessionId="session-b" />
    );

    await waitFor(() => {
      expect(viewport.scrollTop).toBe(2000);
    });
  });

  it("Home, End, PageUp, and PageDown work repeatedly", async () => {
    renderWithProviders(<MessageList messages={makeMessages(40)} sessionId="session-nav" />);
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
    renderWithProviders(<MessageList messages={makeMessages(60)} sessionId="session-buttons" />);
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
});
