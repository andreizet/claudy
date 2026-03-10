import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "../providers";
import { missingWorkspace, mockWorkspace } from "../fixtures";
import HomeView from "../../views/HomeView";

const invokeMock = vi.fn();
const openMock = vi.fn();
let installedSkillsState: Array<{
  folder_name: string;
  display_name: string;
  description: string | null;
  path: string;
}> = [];
let skillCatalogState: Array<{
  id: string;
  name: string;
  description: string | null;
  repo_label: string;
  repo_url: string;
  github_repo: string;
  github_ref: string;
  github_path: string;
  destination_name: string;
}> = [];

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: (...args: unknown[]) => openMock(...args),
}));

vi.mock("../../views/UsageDashboardView", () => ({
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
    installedSkillsState = [
      {
        folder_name: "existing-skill",
        display_name: "Existing Skill",
        description: "Already installed",
        path: "/Users/test/.claude/skills/existing-skill",
      },
    ];
    skillCatalogState = [
      {
        id: "catalog-skill",
        name: "catalog-skill",
        description: "Install from repo",
        repo_label: "anthropics/skills",
        repo_url: "https://github.com/anthropics/skills/tree/main/skills",
        github_repo: "anthropics/skills",
        github_ref: "main",
        github_path: "skills/catalog-skill",
        destination_name: "catalog-skill",
      },
      {
        id: "existing-catalog-skill",
        name: "existing-skill",
        description: "Already present in Claude skills",
        repo_label: "anthropics/skills",
        repo_url: "https://github.com/anthropics/skills/tree/main/skills",
        github_repo: "anthropics/skills",
        github_ref: "main",
        github_path: "skills/existing-skill",
        destination_name: "existing-skill",
      },
      {
        id: "repo-two-skill",
        name: "repo-two-skill",
        description: "Another repository entry",
        repo_label: "obra/superpowers",
        repo_url: "https://github.com/obra/superpowers/tree/main/skills",
        github_repo: "obra/superpowers",
        github_ref: "main",
        github_path: "skills/repo-two-skill",
        destination_name: "repo-two-skill",
      },
    ];
    invokeMock.mockImplementation((command: string) => {
      switch (command) {
        case "list_claude_installations":
          return Promise.resolve([
            {
              label: "/usr/local/bin/claude",
              path: "/usr/local/bin/claude",
              is_available: true,
              is_selected: true,
            },
          ]);
        case "get_claude_session_init":
          return Promise.resolve({
            session_id: "session-init",
            cwd: mockWorkspace.decoded_path,
            model: "sonnet",
            tools: ["Read", "Edit", "Bash", "mcp__github__issues"],
            mcp_servers: ["github"],
          });
        case "list_installed_skills":
          return Promise.resolve([...installedSkillsState]);
        case "get_skill_catalog":
          return Promise.resolve([...skillCatalogState]);
        case "install_skill_from_folder":
          installedSkillsState = [
            ...installedSkillsState,
            {
              folder_name: "picked-folder",
              display_name: "picked-folder",
              description: "Installed from folder",
              path: "/Users/test/.claude/skills/picked-folder",
            },
          ];
          return Promise.resolve(installedSkillsState[installedSkillsState.length - 1]);
        case "install_catalog_skill":
          installedSkillsState = [
            ...installedSkillsState,
            {
              folder_name: "catalog-skill",
              display_name: "catalog-skill",
              description: "Install from repo",
              path: "/Users/test/.claude/skills/catalog-skill",
            },
          ];
          return Promise.resolve(installedSkillsState[installedSkillsState.length - 1]);
        case "delete_installed_skill":
          installedSkillsState = installedSkillsState.filter((skill) => skill.folder_name !== "existing-skill");
          return Promise.resolve(null);
        default:
          return Promise.resolve(null);
      }
    });
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

    expect(screen.getAllByText("claudy")).toHaveLength(2);
    fireEvent.click(screen.getAllByLabelText("Remove from favorites")[0]);
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

    expect(screen.queryByLabelText("Remove from favorites")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    expect(screen.getAllByLabelText("Remove from favorites")).toHaveLength(2);
  });

  it("switches between usage, projects, and settings nav", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() => expect(screen.getByText("Claude Installation")).toBeInTheDocument());
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

  it("opens the settings page and persists general settings", async () => {
    renderWithProviders(
      <HomeView
        workspaces={workspaces}
        isLoading={false}
        accountInfo={null}
        onOpenWorkspace={() => {}}
        onCreateSession={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByText("Claude Installation")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Claude Installation" })).toBeInTheDocument();
    expect(screen.getByText("Remember Open Tabs")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Enabled" }));

    await waitFor(() => {
      expect(window.localStorage.getItem("claudy.appSettings")).toContain("\"rememberOpenTabs\":false");
    });
  });

  it("shows default tool permissions under settings", async () => {
    renderWithProviders(
      <HomeView
        workspaces={workspaces}
        isLoading={false}
        accountInfo={null}
        onOpenWorkspace={() => {}}
        onCreateSession={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Permissions" }));

    await waitFor(() => expect(screen.getByText("Default tool permissions")).toBeInTheDocument());
    expect(screen.getByText("Built-in Tools (3)")).toBeInTheDocument();
    expect(screen.getByText("github")).toBeInTheDocument();
  });

  it("manages Claude skills from settings", async () => {
    openMock.mockResolvedValue("/tmp/picked-folder");

    renderWithProviders(
      <HomeView
        workspaces={workspaces}
        isLoading={false}
        accountInfo={null}
        onOpenWorkspace={() => {}}
        onCreateSession={() => {}}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(screen.getByRole("button", { name: "Skills" }));

    await waitFor(() => expect(screen.getByText("Installed Skills")).toBeInTheDocument());
    expect(screen.getByText("Existing Skill")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse anthropics/skills" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse obra/superpowers" })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Installed" })[0]).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Collapse anthropics/skills" }));
    expect(screen.queryByText("catalog-skill")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand anthropics/skills" }));
    expect(screen.getByText("catalog-skill")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Search installable skills" }), {
      target: { value: "repo-two" },
    });
    expect(screen.queryByText("catalog-skill")).not.toBeInTheDocument();
    expect(screen.getByText("repo-two-skill")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Search installable skills" }), {
      target: { value: "" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByText("Existing Skill")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Select Skill Folder" }));
    await waitFor(() => expect(openMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByText("picked-folder").length).toBeGreaterThan(0));

    fireEvent.click(screen.getAllByRole("button", { name: "Install" })[0]);
    await waitFor(() => expect(screen.getAllByText("catalog-skill").length).toBeGreaterThan(0));
    expect(screen.getAllByRole("button", { name: "Installed" }).length).toBeGreaterThan(0);
  });
});
