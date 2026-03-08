import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} }; }
    onKey() { return { dispose() {} }; }
    write() {}
    clear() {}
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

import { SessionItem } from "./ChatView";
import { mockSessions } from "../test/fixtures";
import { renderWithMantine } from "../test/render";

describe("SessionItem", () => {
  it("renders session label and relative time", () => {
    renderWithMantine(
      <SessionItem
        session={mockSessions[0]}
        active={true}
        pinned={false}
        confirmingDelete={false}
        loading={false}
        onClick={() => {}}
        onPin={() => {}}
        onDelete={() => {}}
        onConfirmDelete={() => {}}
        onCancelDelete={() => {}}
      />
    );

    expect(screen.getByText("Implement the login flow")).toBeInTheDocument();
    expect(screen.getByText("1h ago")).toBeInTheDocument();
  });

  it("calls pin and delete actions after hover", () => {
    const onPin = vi.fn();
    const onDelete = vi.fn();

    const { container } = renderWithMantine(
      <SessionItem
        session={mockSessions[0]}
        active={false}
        pinned={false}
        confirmingDelete={false}
        loading={false}
        onClick={() => {}}
        onPin={onPin}
        onDelete={onDelete}
        onConfirmDelete={() => {}}
        onCancelDelete={() => {}}
      />
    );

    fireEvent.mouseEnter(container.firstChild as HTMLElement);
    fireEvent.click(within(container).getByTitle("Pin session"));
    fireEvent.click(within(container).getByTitle("Delete session"));

    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("shows inline delete confirmation controls", () => {
    const onCancelDelete = vi.fn();
    const onConfirmDelete = vi.fn();

    renderWithMantine(
      <SessionItem
        session={mockSessions[1]}
        active={false}
        pinned={false}
        confirmingDelete={true}
        loading={false}
        onClick={() => {}}
        onPin={() => {}}
        onDelete={() => {}}
        onConfirmDelete={onConfirmDelete}
        onCancelDelete={onCancelDelete}
      />
    );

    expect(screen.getByText("Delete session?")).toBeInTheDocument();
    fireEvent.click(screen.getByTitle("Cancel"));
    fireEvent.click(screen.getByTitle("Confirm delete"));

    expect(onCancelDelete).toHaveBeenCalledTimes(1);
    expect(onConfirmDelete).toHaveBeenCalledTimes(1);
  });
});
