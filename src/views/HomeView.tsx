import { useState, useMemo, useEffect } from "react";
import { Box, Text, TextInput, Button, Group, Stack, ScrollArea, UnstyledButton, Skeleton, Switch } from "@mantine/core";
import { ChevronDown, Cog, Plus, Search } from "lucide-react";
import { ClaudeAccountInfo, DiscoveredWorkspace } from "../types";
import ProjectListItem from "../components/ProjectListItem";
import sidebarTitle from "../assets/sidebar-title.svg";
import { md5 } from "../shared/md5";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import UsageDashboardView from "./UsageDashboardView";
import { AppSettings, loadAppSettings, saveAppSettings } from "../shared/settings";
import {
  extractMcpServers,
  loadDefaultToolPolicy,
  loadToolInventoryCache,
  saveDefaultToolPolicy,
  SessionToolState,
  saveToolInventoryCache,
  splitToolsBySource,
} from "../shared/toolPolicy";

type NavItem = "projects" | "favorites" | "usage" | "settings";
type SettingsTab = "general" | "permissions" | "skills" | "hooks";
const FAVORITES_STORAGE_KEY = "claudy.favoriteWorkspaces";
const FAVICON_STORAGE_KEY = "claudy.workspaceFavicons";

interface ClaudeInstallation {
  label: string;
  path: string;
  is_available: boolean;
  is_selected: boolean;
}

interface ClaudeSessionInit {
  session_id: string | null;
  cwd: string | null;
  model: string | null;
  tools: string[];
  mcp_servers: unknown;
}

function loadFavoriteWorkspaces(): Set<string> {
  try {
    const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

interface Props {
  workspaces: DiscoveredWorkspace[];
  isLoading: boolean;
  accountInfo: ClaudeAccountInfo | null;
  onOpenWorkspace: (workspace: DiscoveredWorkspace) => void;
  onCreateSession: (workspacePath: string) => void;
  mainHeader?: React.ReactNode;
}

export default function HomeView({ workspaces, isLoading, accountInfo, onOpenWorkspace, onCreateSession, mainHeader }: Props) {
  const [activeNav, setActiveNav] = useState<NavItem>("projects");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("general");
  const [search, setSearch] = useState("");
  const [favorites, setFavorites] = useState<Set<string>>(loadFavoriteWorkspaces);
  const [favicons, setFavicons] = useState<Record<string, string | null>>({});
  const [appSettings, setAppSettings] = useState<AppSettings>(loadAppSettings);
  const [defaultToolState, setDefaultToolState] = useState<SessionToolState | null>(null);
  const [loadingDefaultTools, setLoadingDefaultTools] = useState(false);
  const [claudeInstallations, setClaudeInstallations] = useState<ClaudeInstallation[]>([]);

  useEffect(() => {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(Array.from(favorites)));
  }, [favorites]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(FAVICON_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      const entries = Object.entries(parsed)
        .filter(([k, v]) => typeof k === "string" && (typeof v === "string" || v === null));
      setFavicons(Object.fromEntries(entries) as Record<string, string | null>);
    } catch {
      // Ignore malformed cache values.
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(FAVICON_STORAGE_KEY, JSON.stringify(favicons));
  }, [favicons]);

  useEffect(() => {
    saveAppSettings(appSettings);
  }, [appSettings]);

  useEffect(() => {
    if (activeNav !== "settings" || settingsTab !== "general" || claudeInstallations.length > 0) return;
    invoke<ClaudeInstallation[]>("list_claude_installations")
      .then((items) => {
        setClaudeInstallations(items);
        setAppSettings((current) => {
          if (current.selectedClaudeInstallation) return current;
          const selected = items.find((item) => item.is_selected) ?? items.find((item) => item.is_available) ?? items[0];
          return selected
            ? { ...current, selectedClaudeInstallation: selected.path }
            : current;
        });
      })
      .catch(() => {
        setClaudeInstallations([]);
      });
  }, [activeNav, settingsTab, claudeInstallations.length]);

  useEffect(() => {
    const missing = workspaces.filter((w) => favicons[w.encoded_name] === undefined);
    if (missing.length === 0) return;
    let cancelled = false;

    Promise.all(
      missing.map(async (w) => {
        try {
          const icon = await invoke<string | null>("get_workspace_favicon", {
            workspacePath: w.decoded_path,
          });
          return { key: w.encoded_name, icon: icon ?? null };
        } catch {
          return { key: w.encoded_name, icon: null };
        }
      })
    ).then((results) => {
      if (cancelled) return;
      setFavicons((prev) => {
        const next = { ...prev };
        for (const { key, icon } of results) {
          if (next[key] === undefined) {
            next[key] = icon;
          }
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [workspaces, favicons]);

  useEffect(() => {
    if (activeNav !== "settings" || settingsTab !== "permissions" || defaultToolState || loadingDefaultTools) return;
    const persisted = loadDefaultToolPolicy();
    const cachedInventory = loadToolInventoryCache();

    if (cachedInventory) {
      const selectedTools = persisted
        ? cachedInventory.availableTools.filter((tool) => persisted.selectedTools.includes(tool))
        : cachedInventory.availableTools;
      setDefaultToolState({
        sessionId: null,
        model: null,
        cwd: cachedInventory.workspacePath,
        availableTools: cachedInventory.availableTools,
        selectedTools,
        mcpServers: cachedInventory.mcpServers,
      });
      return;
    }

    const workspace = workspaces.find((item) => item.path_exists) ?? workspaces[0];

    if (!workspace) {
      setDefaultToolState(
        persisted
          ? {
              sessionId: null,
              model: null,
              cwd: null,
              availableTools: persisted.availableTools ?? persisted.selectedTools,
              selectedTools: persisted.selectedTools,
              mcpServers: persisted.mcpServers ?? [],
            }
          : null
      );
      return;
    }

    setLoadingDefaultTools(true);
    invoke<ClaudeSessionInit>("get_claude_session_init", { workspacePath: workspace.decoded_path })
      .then((init) => {
        const availableTools = Array.isArray(init.tools) ? init.tools : [];
        const mcpServers = extractMcpServers(init.mcp_servers);
        const selectedTools = persisted
          ? availableTools.filter((tool) => persisted.selectedTools.includes(tool))
          : availableTools;
        setDefaultToolState({
          sessionId: init.session_id,
          model: init.model,
          cwd: init.cwd ?? workspace.decoded_path,
          availableTools,
          selectedTools,
          mcpServers,
        });
        saveToolInventoryCache({
          availableTools,
          mcpServers,
          workspacePath: workspace.decoded_path,
        });
        saveDefaultToolPolicy({
          selectedTools,
          availableTools,
          mcpServers,
        });
      })
      .catch(() => {
        if (persisted) {
          setDefaultToolState({
            sessionId: null,
            model: null,
            cwd: null,
            availableTools: persisted.availableTools ?? persisted.selectedTools,
            selectedTools: persisted.selectedTools,
            mcpServers: persisted.mcpServers ?? [],
          });
        }
      })
      .finally(() => setLoadingDefaultTools(false));
  }, [activeNav, settingsTab, defaultToolState, loadingDefaultTools, workspaces]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    if (!q) return workspaces;
    return workspaces.filter(
      (w) =>
        w.display_name.toLowerCase().includes(q) ||
        w.decoded_path.toLowerCase().includes(q)
    );
  }, [workspaces, search]);

  const listed =
    activeNav === "favorites"
      ? filtered.filter((w) => favorites.has(w.encoded_name))
      : filtered;
  const email = accountInfo?.email?.trim().toLowerCase() ?? "";
  const avatarUrl = email
    ? `https://www.gravatar.com/avatar/${md5(email)}?s=80&d=identicon`
    : "https://www.gravatar.com/avatar/?s=80&d=mp";
  const accountName = accountInfo?.display_name ?? "Claude account";
  const accountSubtitle = accountInfo?.email ?? "No account detected";

  return (
    <Box
      style={{
        display: "flex",
        height: "100%",
        background: "#0c0c0f",
        color: "#f4f4f5",
      }}
    >
      {/* ── Sidebar ── */}
      <Box
        style={{
          width: 220,
          flexShrink: 0,
          background: "#131316",
          borderRight: "1px solid #1f1f23",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* macOS traffic light spacer */}
        <Box style={{ height: 52 }} />

        {/* App identity */}
        <Box px={16} pb={24}>
          <Group justify="space-between" align="flex-end" wrap="nowrap" gap={8}>
            <Box
              component="img"
              src={sidebarTitle}
              alt="Claudy"
              style={{
                display: "block",
                width: "100%",
                maxWidth: 150,
                height: "auto",
                minWidth: 0,
              }}
            />
            <Text size="xs" c="#52525b" lh={1.2} mb={2} style={{ flexShrink: 0 }}>
              0.1.0
            </Text>
          </Group>
        </Box>

        {/* Nav */}
        <Stack gap={1} px={8} style={{ flex: 1 }}>
          <NavButton active={activeNav === "projects"} onClick={() => setActiveNav("projects")}>
            Projects
          </NavButton>
          <NavButton active={activeNav === "favorites"} onClick={() => setActiveNav("favorites")}>
            Favorites
          </NavButton>
          <NavButton active={activeNav === "usage"} onClick={() => setActiveNav("usage")}>
            Usage
          </NavButton>
        </Stack>

        {/* Settings */}
        <Box px={14} pb={18}>
          <UnstyledButton
            onClick={() => {
              setActiveNav("settings");
              setSettingsTab("general");
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              padding: "8px 12px",
              borderRadius: 6,
              color: "#52525b",
              width: "fit-content",
              margin: "0 auto",
              transition: "color 180ms ease, background 180ms ease",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLElement).style.color = "#a1a1aa";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLElement).style.color = "#52525b";
            }}
          >
            <SettingsIcon />
            <Text size="sm" inherit>Settings</Text>
          </UnstyledButton>
        </Box>
      </Box>

      {/* ── Main content ── */}
      <Box style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {mainHeader}
        {/* Top bar */}
        {activeNav !== "usage" && activeNav !== "settings" ? (
          <Box
            px={20}
            style={{
              height: 52,
              display: "flex",
              alignItems: "center",
              gap: 16,
              borderBottom: "1px solid #1f1f23",
              flexShrink: 0,
            }}
          >
            <Group gap={6} style={{ flex: 1, maxWidth: 300 }}>
              <SearchIcon />
              <TextInput
                placeholder="Search projects"
                value={search}
                onChange={(e) => setSearch(e.currentTarget.value)}
                variant="unstyled"
                style={{ flex: 1 }}
                styles={{
                  input: {
                    color: "#d4d4d8",
                    fontSize: 13,
                    padding: 0,
                    height: "auto",
                    minHeight: "auto",
                    lineHeight: 1.5,
                  },
                }}
              />
            </Group>

            <Button
              ml="auto"
              size="xs"
              onClick={async () => {
                const selected = await open({
                  directory: true,
                  multiple: false,
                  title: "Choose project folder",
                });
              if (typeof selected === "string" && selected) {
                  onCreateSession(selected);
                }
              }}
              leftSection={<Plus size={12} strokeWidth={2.5} />}
              styles={{
                root: {
                  background: "#f4f4f5",
                  color: "#0c0c0f",
                  fontSize: 12,
                  fontWeight: 500,
                  height: 28,
                  padding: "0 12px",
                  border: "none",
                  "&:hover": { background: "#e4e4e7" },
                },
              }}
            >
              New Session
            </Button>
          </Box>
        ) : (
          <Box
            px={20}
            style={{
              height: 52,
              display: "flex",
              alignItems: "center",
              borderBottom: "1px solid #1f1f23",
              flexShrink: 0,
            }}
          >
            <Text size="sm" fw={600} c="#e4e4e7">
              {activeNav === "settings" ? "Settings" : "Claude Usage"}
            </Text>
          </Box>
        )}

        {/* Project list */}
        {activeNav === "usage" ? (
          <UsageDashboardView />
        ) : activeNav === "settings" ? (
          <SettingsView
            settingsTab={settingsTab}
            onSettingsTabChange={setSettingsTab}
            appSettings={appSettings}
            onAppSettingsChange={setAppSettings}
            claudeInstallations={claudeInstallations}
            defaultToolState={defaultToolState}
            loadingDefaultTools={loadingDefaultTools}
            onToggleDefaultTool={(tool) => {
              setDefaultToolState((current) => {
                if (!current) return current;
                const selectedTools = current.selectedTools.includes(tool)
                  ? current.selectedTools.filter((item) => item !== tool)
                  : [...current.selectedTools, tool].sort(
                      (a, b) => current.availableTools.indexOf(a) - current.availableTools.indexOf(b)
                    );
                const next = { ...current, selectedTools };
                saveDefaultToolPolicy({
                  selectedTools,
                  availableTools: current.availableTools,
                  mcpServers: current.mcpServers,
                });
                return next;
              });
            }}
            onEnableAllDefaultTools={() => {
              setDefaultToolState((current) => {
                if (!current) return current;
                const next = { ...current, selectedTools: current.availableTools };
                saveDefaultToolPolicy({
                  selectedTools: next.selectedTools,
                  availableTools: current.availableTools,
                  mcpServers: current.mcpServers,
                });
                return next;
              });
            }}
            onDisableAllDefaultTools={() => {
              setDefaultToolState((current) => {
                if (!current) return current;
                const next = { ...current, selectedTools: [] };
                saveDefaultToolPolicy({
                  selectedTools: [],
                  availableTools: current.availableTools,
                  mcpServers: current.mcpServers,
                });
                return next;
              });
            }}
          />
        ) : (
          <ScrollArea style={{ flex: 1 }}>
            {isLoading ? (
              <LoadingSkeleton />
            ) : listed.length === 0 ? (
              <EmptyState activeNav={activeNav} hasSearch={!!search} />
            ) : (
              <Box>
                {listed.map((w) => (
                  <ProjectListItem
                    key={w.encoded_name}
                    workspace={w}
                    faviconDataUrl={favicons[w.encoded_name] ?? null}
                    isFavorite={favorites.has(w.encoded_name)}
                    onToggleFavorite={() =>
                      setFavorites((prev) => {
                        const next = new Set(prev);
                        if (next.has(w.encoded_name)) {
                          next.delete(w.encoded_name);
                        } else {
                          next.add(w.encoded_name);
                        }
                        return next;
                      })
                    }
                    onClick={() => w.path_exists && onOpenWorkspace(w)}
                  />
                ))}
              </Box>
            )}
          </ScrollArea>
        )}
        <Box
          px={20}
          py={12}
          style={{
            borderTop: "1px solid #1f1f23",
            display: "flex",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Group
            gap={10}
            wrap="nowrap"
            style={{
              width: "100%",
              maxWidth: 420,
              minWidth: 0,
              padding: "8px 10px",
              borderRadius: 10,
              background: "#121217",
              border: "1px solid #23232a",
            }}
          >
            <Box
              component="img"
              src={avatarUrl}
              alt="Account avatar"
              style={{
                width: 28,
                height: 28,
                borderRadius: "50%",
                border: "1px solid #2f2f38",
                flexShrink: 0,
              }}
            />
            <Stack gap={1} style={{ minWidth: 0, flex: 1 }}>
              <Text size="sm" c="#e4e4e7" truncate>{accountName}</Text>
              <Text size="xs" c="#71717a" truncate>{accountSubtitle}</Text>
            </Stack>
          </Group>
        </Box>
      </Box>
    </Box>
  );
}

function SettingsView({
  settingsTab,
  onSettingsTabChange,
  appSettings,
  onAppSettingsChange,
  claudeInstallations,
  defaultToolState,
  loadingDefaultTools,
  onToggleDefaultTool,
  onEnableAllDefaultTools,
  onDisableAllDefaultTools,
}: {
  settingsTab: SettingsTab;
  onSettingsTabChange: (value: SettingsTab) => void;
  appSettings: AppSettings;
  onAppSettingsChange: React.Dispatch<React.SetStateAction<AppSettings>>;
  claudeInstallations: ClaudeInstallation[];
  defaultToolState: SessionToolState | null;
  loadingDefaultTools: boolean;
  onToggleDefaultTool: (tool: string) => void;
  onEnableAllDefaultTools: () => void;
  onDisableAllDefaultTools: () => void;
}) {
  const { builtinTools, mcpGroups } = splitToolsBySource(defaultToolState?.availableTools ?? [], defaultToolState?.mcpServers ?? []);
  const [expandedMcpGroups, setExpandedMcpGroups] = useState<Set<string>>(() => new Set());

  const toggleGroupTools = (tools: string[], checked: boolean) => {
    if (!tools.length) return;
    if (checked) {
      tools.forEach((tool) => {
        if (!defaultToolState?.selectedTools.includes(tool)) onToggleDefaultTool(tool);
      });
      return;
    }
    tools.forEach((tool) => {
      if (defaultToolState?.selectedTools.includes(tool)) onToggleDefaultTool(tool);
    });
  };

  return (
    <Box style={{ flex: 1, minHeight: 0, display: "flex" }}>
      <Box
        style={{
          width: 220,
          borderRight: "1px solid #1f1f23",
          background: "#101015",
          padding: 12,
          flexShrink: 0,
        }}
      >
        <Stack gap={4}>
          <SettingsTabButton active={settingsTab === "general"} onClick={() => onSettingsTabChange("general")}>
            General
          </SettingsTabButton>
          <SettingsTabButton active={settingsTab === "permissions"} onClick={() => onSettingsTabChange("permissions")}>
            Permissions
          </SettingsTabButton>
          <SettingsTabButton active={settingsTab === "skills"} onClick={() => onSettingsTabChange("skills")}>
            Skills
          </SettingsTabButton>
          <SettingsTabButton active={settingsTab === "hooks"} onClick={() => onSettingsTabChange("hooks")}>
            Hooks
          </SettingsTabButton>
        </Stack>
      </Box>
      <ScrollArea style={{ flex: 1 }}>
        <Box px={24} py={22} maw={860}>
          {settingsTab === "general" ? (
            <Stack gap={14}>
              <SectionCard title="Claude Installation" description="Claude Code CLI is required to scan sessions and start new ones.">
                <Box style={{ maxWidth: 420, position: "relative" }}>
                  <select
                    aria-label="Claude Installation"
                    value={appSettings.selectedClaudeInstallation ?? ""}
                    onChange={(event) => onAppSettingsChange((current) => ({
                      ...current,
                      selectedClaudeInstallation: event.target.value || null,
                    }))}
                    style={{
                      width: "100%",
                      appearance: "none",
                      background: "#18181b",
                      border: "1px solid #27272a",
                      borderRadius: 10,
                      padding: "10px 36px 10px 12px",
                      fontSize: 13,
                      color: "#e4e4e7",
                      outline: "none",
                      fontFamily: "inherit",
                    }}
                  >
                    {claudeInstallations.length === 0 ? (
                      <option value="">No Claude installations found</option>
                    ) : (
                      claudeInstallations.map((installation) => (
                        <option key={installation.path} value={installation.path}>
                          {installation.is_available ? installation.label : `${installation.label} (missing)`}
                        </option>
                      ))
                    )}
                  </select>
                </Box>
              </SectionCard>
              <SectionCard title="Theme" description="Light mode can be selected now even though the UI still renders in dark mode.">
                <Group gap={8}>
                  <ModeButton
                    active={appSettings.theme === "dark"}
                    onClick={() => onAppSettingsChange((current) => ({ ...current, theme: "dark" }))}
                  >
                    Dark
                  </ModeButton>
                  <ModeButton
                    active={appSettings.theme === "light"}
                    onClick={() => onAppSettingsChange((current) => ({ ...current, theme: "light" }))}
                  >
                    Light
                  </ModeButton>
                </Group>
              </SectionCard>
              <SectionCard title="Remember Open Tabs" description="Restore the tabs from the previous session when Claudy opens again.">
                <Switch
                  checked={appSettings.rememberOpenTabs}
                  onChange={(event) => onAppSettingsChange((current) => ({
                    ...current,
                    rememberOpenTabs: event.currentTarget.checked,
                  }))}
                  label={appSettings.rememberOpenTabs ? "Enabled" : "Disabled"}
                  color="#FFE100"
                />
              </SectionCard>
            </Stack>
          ) : null}
          {settingsTab === "permissions" ? (
            <Stack gap={16}>
              <Box>
                <Text size="lg" fw={600} c="#f4f4f5">Default tool permissions</Text>
                <Text size="sm" c="#71717a" mt={4}>
                  These permissions are applied by default when a new session starts.
                </Text>
              </Box>
              {loadingDefaultTools ? (
                <Text size="sm" c="#a1a1aa">Loading default Claude tools…</Text>
              ) : !defaultToolState ? (
                <Text size="sm" c="#71717a">No tool information available yet.</Text>
              ) : (
                <>
                  <Group gap={8}>
                    <Button
                      size="xs"
                      variant="default"
                      onClick={onEnableAllDefaultTools}
                      styles={{
                        root: { background: "#18181b", borderColor: "#2a2a32", color: "#e4e4e7" },
                      }}
                    >
                      Enable all
                    </Button>
                    <Button
                      size="xs"
                      variant="default"
                      onClick={onDisableAllDefaultTools}
                      styles={{
                        root: { background: "#18181b", borderColor: "#2a2a32", color: "#e4e4e7" },
                      }}
                    >
                      Disable all
                    </Button>
                  </Group>
                  <PermissionSection
                    title={`Built-in Tools (${builtinTools.length})`}
                    tools={builtinTools.map((tool) => ({ raw: tool, label: tool }))}
                    selectedTools={defaultToolState.selectedTools}
                    onToggle={onToggleDefaultTool}
                  />
                  {mcpGroups.map((group) => (
                    <PermissionSection
                      key={group.rawServer}
                      title={group.label}
                      tools={group.tools}
                      selectedTools={defaultToolState.selectedTools}
                      onToggle={onToggleDefaultTool}
                      collapsible
                      collapsed={!expandedMcpGroups.has(group.rawServer)}
                      onToggleCollapsed={() => setExpandedMcpGroups((current) => {
                        const next = new Set(current);
                        if (next.has(group.rawServer)) next.delete(group.rawServer);
                        else next.add(group.rawServer);
                        return next;
                      })}
                      onToggleGroup={(checked) => toggleGroupTools(group.tools.map((tool) => tool.raw), checked)}
                    />
                  ))}
                </>
              )}
            </Stack>
          ) : null}
          {settingsTab === "skills" ? <EmptySettingsPanel label="Skills" /> : null}
          {settingsTab === "hooks" ? <EmptySettingsPanel label="Hooks" /> : null}
        </Box>
      </ScrollArea>
    </Box>
  );
}

function SettingsTabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <UnstyledButton
      onClick={onClick}
      style={{
        width: "100%",
        padding: "10px 12px",
        borderRadius: 10,
        background: active ? "#1b1b22" : "transparent",
        border: `1px solid ${active ? "#2a2a32" : "transparent"}`,
        color: active ? "#f4f4f5" : "#71717a",
        textAlign: "left",
        fontSize: 13,
        fontWeight: 500,
      }}
    >
      {children}
    </UnstyledButton>
  );
}

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <Box
      style={{
        padding: 16,
        borderRadius: 14,
        background: "#111115",
        border: "1px solid #23232a",
      }}
    >
      <Text size="sm" fw={600} c="#f4f4f5">{title}</Text>
      <Text size="xs" c="#71717a" mt={4} mb={12}>{description}</Text>
      {children}
    </Box>
  );
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <UnstyledButton
      onClick={onClick}
      style={{
        minWidth: 86,
        height: 34,
        borderRadius: 9,
        border: `1px solid ${active ? "#3a3a45" : "#2a2a32"}`,
        background: active ? "#1e1e24" : "#141419",
        color: active ? "#f4f4f5" : "#a1a1aa",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 13,
        fontWeight: 500,
      }}
    >
      {children}
    </UnstyledButton>
  );
}

function PermissionSection({
  title,
  tools,
  selectedTools,
  onToggle,
  collapsible,
  collapsed,
  onToggleCollapsed,
  onToggleGroup,
}: {
  title: string;
  tools: Array<{ raw: string; label: string }>;
  selectedTools: string[];
  onToggle: (tool: string) => void;
  collapsible?: boolean;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  onToggleGroup?: (checked: boolean) => void;
}) {
  const selectedCount = tools.filter((tool) => selectedTools.includes(tool.raw)).length;
  const allChecked = tools.length > 0 && selectedCount === tools.length;
  const partiallyChecked = selectedCount > 0 && selectedCount < tools.length;

  return (
    <Box>
      <Box style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
        <Box style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {onToggleGroup ? (
            <GroupToggleCheckbox
              label={title}
              checked={allChecked}
              indeterminate={partiallyChecked}
              onChange={onToggleGroup}
            />
          ) : (
            <Text size="xs" fw={600} c="#a1a1aa">{title}</Text>
          )}
        </Box>
        {collapsible ? (
          <UnstyledButton
            onClick={onToggleCollapsed}
            style={{ color: "#71717a", display: "flex", alignItems: "center", justifyContent: "center" }}
            aria-label={`${collapsed ? "Expand" : "Collapse"} ${title}`}
          >
            <ChevronDown size={14} strokeWidth={2} style={{ transform: collapsed ? "rotate(-90deg)" : "rotate(0deg)", transition: "transform 180ms ease" }} />
          </UnstyledButton>
        ) : null}
      </Box>
      {!collapsed ? (
        tools.length === 0 ? (
          <Text size="xs" c="#52525b">No tools available.</Text>
        ) : (
          <Box style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {tools.map((tool) => {
              const checked = selectedTools.includes(tool.raw);
              return (
                <label
                  key={tool.raw}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "6px 10px",
                    borderRadius: 999,
                    border: `1px solid ${checked ? "#3f3f46" : "#27272a"}`,
                    background: checked ? "#18181b" : "#0f1014",
                    cursor: "pointer",
                  }}
                >
                  <input
                    aria-label={tool.label}
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggle(tool.raw)}
                    style={{ margin: 0 }}
                  />
                  <Text size="xs" c={checked ? "#ffffff" : "#e4e4e7"}>{tool.label}</Text>
                </label>
              );
            })}
          </Box>
        )
      ) : null}
    </Box>
  );
}

function GroupToggleCheckbox({
  label,
  checked,
  indeterminate,
  onChange,
}: {
  label: string;
  checked: boolean;
  indeterminate: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
      <input
        aria-label={label}
        type="checkbox"
        checked={checked}
        ref={(node) => {
          if (node) node.indeterminate = indeterminate;
        }}
        onChange={(event) => onChange(event.currentTarget.checked)}
        style={{ margin: 0 }}
      />
      <Text size="xs" fw={600} c="#a1a1aa">{label}</Text>
    </label>
  );
}

function EmptySettingsPanel({ label }: { label: string }) {
  return (
    <Box
      style={{
        minHeight: 280,
        borderRadius: 16,
        border: "1px dashed #2a2a32",
        background: "#101015",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text size="sm" c="#52525b">{label} will live here.</Text>
    </Box>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function NavButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <UnstyledButton
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: "100%",
        padding: "7px 12px",
        borderRadius: 0,
        fontSize: 13,
        fontWeight: active ? 500 : 400,
        color: active ? "#f0f0f2" : hovered ? "#a1a1aa" : "#71717a",
        transition: "background 180ms ease, color 180ms ease, border-color 180ms ease",
        background: active ? "#1e1e24" : hovered ? "#18181b" : "transparent",
        border: active ? "1px solid" : "1px solid transparent",
        borderColor: active ? "#2a2a32" : "transparent",
        borderLeft: active ? "2px solid #FFE100" : "2px solid transparent",
      }}
    >
      {children}
    </UnstyledButton>
  );
}


function LoadingSkeleton() {
  return (
    <Stack gap={0} pt={4}>
      {Array.from({ length: 6 }).map((_, i) => (
        <Box
          key={i}
          px={20}
          py={11}
          style={{ display: "flex", gap: 14, alignItems: "center" }}
        >
          <Skeleton width={38} height={38} radius={8} />
          <Stack gap={6} style={{ flex: 1 }}>
            <Skeleton height={12} width="28%" radius="sm" />
            <Skeleton height={10} width="45%" radius="sm" />
          </Stack>
        </Box>
      ))}
    </Stack>
  );
}

function EmptyState({
  activeNav,
  hasSearch,
}: {
  activeNav: NavItem;
  hasSearch: boolean;
}) {
  return (
    <Box
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: 280,
      }}
    >
      <Text size="sm" c="#52525b">
        {hasSearch
          ? "No projects match your search"
          : activeNav === "favorites"
          ? "No favorites yet"
          : activeNav === "usage"
          ? "No usage data available"
          : "No Claude Code sessions found in ~/.claude/projects/"}
      </Text>
    </Box>
  );
}

function SearchIcon() {
  return <Search size={14} strokeWidth={1.8} style={{ color: "#52525b", flexShrink: 0 }} />;
}

function SettingsIcon() {
  return <Cog size={24} strokeWidth={1.8} />;
}
