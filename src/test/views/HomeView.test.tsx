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
let mcpServersState: Array<{
  name: string;
  scope: "local" | "user" | "project";
  transport: "stdio" | "sse" | "http";
  status: "connected" | "connecting" | "needs-auth" | "invalid-config" | "error" | "disabled" | "unknown";
  command?: string | null;
  args: string[];
  url?: string | null;
  headers: Array<{ name: string; value_preview: string }>;
  env: Array<{ name: string; value_preview: string }>;
  auth_mode: "none" | "bearer" | "oauth" | "env";
  has_secret: boolean;
  workspace_path?: string | null;
  last_error?: string | null;
}> = [];
type McpServerFixture = (typeof mcpServersState)[number];

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
    mcpServersState = [
      {
        name: "github",
        scope: "user",
        transport: "http",
        status: "connected",
        url: "https://example.com/mcp",
        args: [],
        headers: [{ name: "Authorization", value_preview: "Bearer demo...ok" }],
        env: [],
        auth_mode: "bearer",
        has_secret: true,
        workspace_path: null,
        last_error: null,
      },
      {
        name: "local-tool",
        scope: "project",
        transport: "stdio",
        status: "error",
        command: "npx",
        args: ["tool-server"],
        headers: [],
        env: [{ name: "API_KEY", value_preview: "demo...ok" }],
        auth_mode: "env",
        has_secret: true,
        workspace_path: mockWorkspace.decoded_path,
        last_error: "Failed to connect",
      },
    ];
    invokeMock.mockImplementation((command: string, payload?: Record<string, unknown>) => {
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
        case "list_mcp_servers":
          return Promise.resolve([...mcpServersState]);
        case "probe_mcp_server":
          return Promise.resolve((() => {
            const server = mcpServersState.find((item) => item.name === payload?.name);
            if (!server) return null;
            return server.name === "local-tool"
              ? { ...server, status: "connected", last_error: null }
              : server;
          })());
        case "remove_mcp_server":
          mcpServersState = mcpServersState.filter((server) => server.name !== "github");
          return Promise.resolve(null);
        case "add_mcp_server":
          mcpServersState = [
            ...mcpServersState,
            {
              name: "new-remote",
              scope: "project",
              transport: "http",
              status: "unknown",
              url: "https://new.example.com/mcp",
              args: [],
              headers: [],
              env: [],
              auth_mode: "oauth",
              has_secret: false,
              workspace_path: mockWorkspace.decoded_path,
              last_error: null,
            },
          ];
          return Promise.resolve(mcpServersState[mcpServersState.length - 1]);
        case "add_mcp_server_json":
          mcpServersState = [
            ...mcpServersState,
            {
              name: "json-server",
              scope: "local",
              transport: "sse",
              status: "unknown",
              url: "https://json.example.com/sse",
              args: [],
              headers: [],
              env: [],
              auth_mode: "none",
              has_secret: false,
              workspace_path: null,
              last_error: null,
            },
          ];
          return Promise.resolve(mcpServersState[mcpServersState.length - 1]);
        case "import_mcp_servers_from_claude_desktop":
          mcpServersState = [
            ...mcpServersState,
            {
              name: "desktop-import",
              scope: "user",
              transport: "http",
              status: "unknown",
              url: "https://desktop.example.com/mcp",
              args: [],
              headers: [],
              env: [],
              auth_mode: "none",
              has_secret: false,
              workspace_path: null,
              last_error: null,
            },
          ];
          return Promise.resolve(null);
        case "authenticate_mcp_server":
          return Promise.resolve("Claude Code needs to complete OAuth in the browser.");
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

  it("uses folder picker result for New Project", async () => {
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

    fireEvent.click(screen.getByRole("button", { name: "New Project" }));

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
    expect(screen.getByText("YOLO Mode")).toBeInTheDocument();

    const switches = screen.getAllByRole("switch");
    fireEvent.click(switches[0]);
    fireEvent.click(switches[1]);

    await waitFor(() => {
      expect(window.localStorage.getItem("claudy.appSettings")).toContain("\"rememberOpenTabs\":false");
      expect(window.localStorage.getItem("claudy.appSettings")).toContain("\"yoloMode\":true");
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

  it("manages MCP servers from settings", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "MCP" }));

    await waitFor(() => expect(screen.getByText("Configured Servers")).toBeInTheDocument());
    expect(screen.getByText("github")).toBeInTheDocument();
    expect(screen.getByText("local-tool")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Disable" })[0]);
    expect(screen.getByText("Disabled")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[1]);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("probe_mcp_server", expect.any(Object)));

    fireEvent.click(screen.getByRole("button", { name: "Add Server" }));
    await waitFor(() => expect(screen.getByText("Add MCP Server")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("MCP Name"), { target: { value: "new-remote" } });
    fireEvent.change(screen.getByLabelText("MCP Scope"), { target: { value: "project" } });
    fireEvent.change(screen.getByLabelText("MCP Workspace"), { target: { value: mockWorkspace.decoded_path } });
    fireEvent.change(screen.getByLabelText("MCP URL"), { target: { value: "https://new.example.com/mcp" } });
    fireEvent.change(screen.getByLabelText("MCP Auth Mode"), { target: { value: "oauth" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Server" }));
    await waitFor(() => expect(screen.getByText("Added new-remote.")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Paste JSON" }));
    await waitFor(() => expect(screen.getByText("Paste MCP JSON")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("MCP JSON Name"), { target: { value: "json-server" } });
    fireEvent.change(screen.getByLabelText("MCP JSON"), { target: { value: "{\"type\":\"sse\",\"url\":\"https://json.example.com/sse\"}" } });
    fireEvent.click(screen.getByRole("button", { name: "Add From JSON" }));
    await waitFor(() => expect(screen.getByText("Added json-server from JSON.")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Import From Claude Desktop" }));
    await waitFor(() => expect(screen.getByText("Imported MCP servers from Claude Desktop.")).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole("button", { name: "Authenticate" })[0]);
    await waitFor(() => expect(screen.getByText("Claude Code needs to complete OAuth in the browser.")).toBeInTheDocument());

    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    await waitFor(() => expect(screen.queryByText("github")).not.toBeInTheDocument());
  });

  it("shows a non-blocking loading state while refreshing MCP servers", async () => {
    let listCalls = 0;
    let resolveRefresh: ((value: McpServerFixture[]) => void) | undefined;

    invokeMock.mockImplementation((command: string, payload?: Record<string, unknown>) => {
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
        case "list_mcp_servers":
          listCalls += 1;
          if (listCalls === 1) {
            return Promise.resolve([...mcpServersState]);
          }
          return new Promise<McpServerFixture[]>((resolve) => {
            resolveRefresh = resolve;
          });
        case "probe_mcp_server": {
          const server = mcpServersState.find((item) => item.name === payload?.name);
          return Promise.resolve(server ?? null);
        }
        default:
          return Promise.resolve(null);
      }
    });

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
    fireEvent.click(screen.getByRole("button", { name: "MCP" }));

    await waitFor(() => expect(screen.getByText("github")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Refresh Status" }));
    await waitFor(() => expect(screen.getByTestId("mcp-loading-overlay")).toBeInTheDocument());
    expect(screen.getByText("github")).toBeInTheDocument();

    resolveRefresh?.([...mcpServersState]);
    await waitFor(() => expect(screen.queryByTestId("mcp-loading-overlay")).not.toBeInTheDocument());
  });
});
