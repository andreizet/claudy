import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ProjectListItem from "./ProjectListItem";
import { missingWorkspace, mockWorkspace } from "../test/fixtures";
import { renderWithMantine } from "../test/render";

describe("ProjectListItem", () => {
  it("renders project metadata from mock workspace data", () => {
    const { container } = renderWithMantine(
      <ProjectListItem
        workspace={mockWorkspace}
        faviconDataUrl={null}
        isFavorite={false}
        onToggleFavorite={() => {}}
      />
    );

    expect(screen.getByText("claudy")).toBeInTheDocument();
    expect(screen.getByText("~/_work/claudy/claudy")).toBeInTheDocument();
    expect(screen.getByText("2 sessions")).toBeInTheDocument();
  });

  it("calls favorite toggle without triggering row click", () => {
    const onToggleFavorite = vi.fn();
    const onClick = vi.fn();

    const { container } = renderWithMantine(
      <ProjectListItem
        workspace={mockWorkspace}
        faviconDataUrl={null}
        isFavorite={false}
        onToggleFavorite={onToggleFavorite}
        onClick={onClick}
      />
    );

    fireEvent.click(within(container).getByLabelText("Add to favorites"));

    expect(onToggleFavorite).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("shows missing-project state from mock data", () => {
    renderWithMantine(
      <ProjectListItem
        workspace={missingWorkspace}
        faviconDataUrl={null}
        isFavorite={false}
        onToggleFavorite={() => {}}
      />
    );

    expect(screen.getByText("not found")).toBeInTheDocument();
  });
});
