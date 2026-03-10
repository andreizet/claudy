import { useState, useMemo, useEffect } from "react";
import { Box, Text, TextInput, Button, Group, Stack, ScrollArea, UnstyledButton, Skeleton, Switch, Tooltip } from "@mantine/core";
import { ChevronDown, Cog, Plus, Search, Star } from "lucide-react";
import { ClaudeAccountInfo, DiscoveredWorkspace } from "../types";
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

interface InstalledSkill {
  folder_name: string;
  display_name: string;
  description: string | null;
  path: string;
}

interface SkillCatalogEntry {
  id: string;
  name: string;
  description: string | null;
  repo_label: string;
  repo_url: string;
  github_repo: string;
  github_ref: string;
  github_path: string;
  destination_name: string;
}

interface SkillStatusMessage {
  tone: "success" | "error";
  message: string;
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

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
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
  const [installedSkills, setInstalledSkills] = useState<InstalledSkill[]>([]);
  const [loadingInstalledSkills, setLoadingInstalledSkills] = useState(false);
  const [hasLoadedInstalledSkills, setHasLoadedInstalledSkills] = useState(false);
  const [skillCatalog, setSkillCatalog] = useState<SkillCatalogEntry[]>([]);
  const [loadingSkillCatalog, setLoadingSkillCatalog] = useState(false);
  const [hasLoadedSkillCatalog, setHasLoadedSkillCatalog] = useState(false);
  const [skillStatus, setSkillStatus] = useState<SkillStatusMessage | null>(null);
  const [folderInstallInFlight, setFolderInstallInFlight] = useState(false);
  const [busySkillId, setBusySkillId] = useState<string | null>(null);

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

  useEffect(() => {
    if (activeNav !== "settings" || settingsTab !== "skills" || loadingInstalledSkills || hasLoadedInstalledSkills) return;
    setLoadingInstalledSkills(true);
    invoke<InstalledSkill[]>("list_installed_skills")
      .then((skills) => {
        setInstalledSkills(skills);
        setHasLoadedInstalledSkills(true);
      })
      .catch(() => {
        setInstalledSkills([]);
        setHasLoadedInstalledSkills(true);
        setSkillStatus({ tone: "error", message: "Could not load installed Claude skills." });
      })
      .finally(() => setLoadingInstalledSkills(false));
  }, [activeNav, settingsTab, loadingInstalledSkills, hasLoadedInstalledSkills]);

  useEffect(() => {
    if (activeNav !== "settings" || settingsTab !== "skills" || hasLoadedSkillCatalog || loadingSkillCatalog) return;
    setLoadingSkillCatalog(true);
    invoke<SkillCatalogEntry[]>("get_skill_catalog")
      .then((skills) => {
        setSkillCatalog(skills);
        setHasLoadedSkillCatalog(true);
      })
      .catch(() => {
        setSkillCatalog([]);
        setHasLoadedSkillCatalog(true);
        setSkillStatus({ tone: "error", message: "Could not load the installable skills catalog." });
      })
      .finally(() => setLoadingSkillCatalog(false));
  }, [activeNav, settingsTab, hasLoadedSkillCatalog, loadingSkillCatalog]);

  const refreshInstalledSkills = async () => {
    setLoadingInstalledSkills(true);
    try {
      const skills = await invoke<InstalledSkill[]>("list_installed_skills");
      setInstalledSkills(skills);
      setHasLoadedInstalledSkills(true);
    } catch {
      setInstalledSkills([]);
      setHasLoadedInstalledSkills(true);
      throw new Error("Could not refresh installed skills.");
    } finally {
      setLoadingInstalledSkills(false);
    }
  };

  const handleInstallSkillFolder = async () => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "Choose skill folder",
    });
    if (typeof selected !== "string" || !selected) return;

    setFolderInstallInFlight(true);
    setSkillStatus(null);
    try {
      await invoke<InstalledSkill>("install_skill_from_folder", { folderPath: selected });
      await refreshInstalledSkills();
      setSkillStatus({ tone: "success", message: `Installed skill from ${selected}.` });
    } catch (error) {
      setSkillStatus({ tone: "error", message: errorMessage(error, "Could not install the selected skill folder.") });
    } finally {
      setFolderInstallInFlight(false);
    }
  };

  const handleInstallCatalogSkill = async (skillId: string, skillName: string) => {
    setBusySkillId(skillId);
    setSkillStatus(null);
    try {
      await invoke<InstalledSkill>("install_catalog_skill", { skillId });
      await refreshInstalledSkills();
      setSkillStatus({ tone: "success", message: `Installed ${skillName}.` });
    } catch (error) {
      setSkillStatus({ tone: "error", message: errorMessage(error, `Could not install ${skillName}.`) });
    } finally {
      setBusySkillId(null);
    }
  };

  const handleDeleteInstalledSkill = async (folderName: string, skillName: string) => {
    setBusySkillId(folderName);
    setSkillStatus(null);
    try {
      await invoke("delete_installed_skill", { folderName });
      await refreshInstalledSkills();
      setSkillStatus({ tone: "success", message: `Deleted ${skillName}.` });
    } catch (error) {
      setSkillStatus({ tone: "error", message: errorMessage(error, `Could not delete ${skillName}.`) });
    } finally {
      setBusySkillId(null);
    }
  };

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
  const sortedListed = useMemo(
    () => [...listed].sort((a, b) => {
      const aLast = Number(a.sessions[0]?.modified_at ?? 0);
      const bLast = Number(b.sessions[0]?.modified_at ?? 0);
      return bLast - aLast || a.display_name.localeCompare(b.display_name);
    }),
    [listed]
  );
  const pinnedProjects = useMemo(
    () => sortedListed.filter((workspace) => favorites.has(workspace.encoded_name)),
    [favorites, sortedListed]
  );
  const tableProjects = activeNav === "projects" ? sortedListed : pinnedProjects;
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
            px={22}
            style={{
              height: 56,
              display: "flex",
              alignItems: "center",
              gap: 16,
              borderBottom: "1px solid #1f1f23",
              flexShrink: 0,
            }}
          >
            <Text size="lg" fw={600} c="#f4f4f5" style={{ flexShrink: 0, minWidth: 0 }}>
              {activeNav === "favorites" ? "Favorites" : "Projects"}
            </Text>

            <Box
              style={{
                width: 240,
                maxWidth: "100%",
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 12px",
                height: 36,
                borderRadius: 9,
                border: "1px solid #2a2f3d",
                background: "linear-gradient(180deg, #171922 0%, #12141b 100%)",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
              }}
            >
              <SearchIcon />
              <TextInput
                placeholder="Search projects..."
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
            </Box>

            <Box style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
              <UnstyledButton
                style={{
                  height: 32,
                  padding: "0 12px",
                  borderRadius: 10,
                  border: "1px solid #2a2f3d",
                  background: "linear-gradient(180deg, #171922 0%, #12141b 100%)",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  color: "#8b90a3",
                  fontSize: 12,
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
                }}
              >
                <Text size="xs" inherit>Sort: Recent</Text>
                <ChevronDown size={12} strokeWidth={2} />
              </UnstyledButton>

              <Button
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
                    background: "#f3c63b",
                    color: "#0c0c0f",
                    fontSize: 12,
                    fontWeight: 600,
                    height: 34,
                    padding: "0 16px",
                    border: "1px solid #e5be48",
                    borderRadius: 10,
                    boxShadow: "0 8px 24px rgba(243,198,59,0.16)",
                    "&:hover": { background: "#f7d14e" },
                  },
                }}
              >
                New Session
              </Button>
            </Box>
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
            installedSkills={installedSkills}
            loadingInstalledSkills={loadingInstalledSkills}
            skillCatalog={skillCatalog}
            loadingSkillCatalog={loadingSkillCatalog}
            skillStatus={skillStatus}
            folderInstallInFlight={folderInstallInFlight}
            busySkillId={busySkillId}
            onInstallSkillFolder={handleInstallSkillFolder}
            onInstallCatalogSkill={handleInstallCatalogSkill}
            onDeleteInstalledSkill={handleDeleteInstalledSkill}
          />
        ) : (
          <ScrollArea style={{ flex: 1 }}>
            {isLoading ? (
              <LoadingSkeleton />
            ) : sortedListed.length === 0 ? (
              <EmptyState activeNav={activeNav} hasSearch={!!search} />
            ) : (
              <Box px={22} py={20} style={{ minHeight: "100%" }}>
                {activeNav === "projects" && pinnedProjects.length > 0 ? (
                  <Box mb={34}>
                    <SectionLabel title="Pinned" />
                    <Box
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(auto-fit, minmax(220px, 240px))",
                        gap: 12,
                      }}
                    >
                      {pinnedProjects.map((workspace) => (
                        <ProjectPinnedCard
                          key={`pinned-${workspace.encoded_name}`}
                          workspace={workspace}
                          faviconDataUrl={favicons[workspace.encoded_name] ?? null}
                          isFavorite={favorites.has(workspace.encoded_name)}
                          onToggleFavorite={() =>
                            setFavorites((prev) => {
                              const next = new Set(prev);
                              if (next.has(workspace.encoded_name)) next.delete(workspace.encoded_name);
                              else next.add(workspace.encoded_name);
                              return next;
                            })
                          }
                          onClick={() => workspace.path_exists && onOpenWorkspace(workspace)}
                        />
                      ))}
                    </Box>
                  </Box>
                ) : null}

                <Box>
                  <SectionLabel title={activeNav === "favorites" ? "Favorite Projects" : "All Projects"} />
                  <ProjectTableHeader />
                  <Box style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4 }}>
                    {tableProjects.map((workspace) => (
                      <ProjectTableRow
                        key={workspace.encoded_name}
                        workspace={workspace}
                        faviconDataUrl={favicons[workspace.encoded_name] ?? null}
                        isFavorite={favorites.has(workspace.encoded_name)}
                        maxSessions={Math.max(...tableProjects.map((item) => item.sessions.length), 1)}
                        onToggleFavorite={() =>
                          setFavorites((prev) => {
                            const next = new Set(prev);
                            if (next.has(workspace.encoded_name)) next.delete(workspace.encoded_name);
                            else next.add(workspace.encoded_name);
                            return next;
                          })
                        }
                        onClick={() => workspace.path_exists && onOpenWorkspace(workspace)}
                      />
                    ))}
                  </Box>
                </Box>
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
  installedSkills,
  loadingInstalledSkills,
  skillCatalog,
  loadingSkillCatalog,
  skillStatus,
  folderInstallInFlight,
  busySkillId,
  onInstallSkillFolder,
  onInstallCatalogSkill,
  onDeleteInstalledSkill,
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
  installedSkills: InstalledSkill[];
  loadingInstalledSkills: boolean;
  skillCatalog: SkillCatalogEntry[];
  loadingSkillCatalog: boolean;
  skillStatus: SkillStatusMessage | null;
  folderInstallInFlight: boolean;
  busySkillId: string | null;
  onInstallSkillFolder: () => Promise<void>;
  onInstallCatalogSkill: (skillId: string, skillName: string) => Promise<void>;
  onDeleteInstalledSkill: (folderName: string, skillName: string) => Promise<void>;
}) {
  const { builtinTools, mcpGroups } = splitToolsBySource(defaultToolState?.availableTools ?? [], defaultToolState?.mcpServers ?? []);
  const [expandedMcpGroups, setExpandedMcpGroups] = useState<Set<string>>(() => new Set());
  const [skillSearch, setSkillSearch] = useState("");
  const [expandedSkillGroups, setExpandedSkillGroups] = useState<Set<string>>(() => new Set());
  const catalogGroups = useMemo(() => {
    const grouped = new Map<string, SkillCatalogEntry[]>();
    for (const entry of skillCatalog) {
      const current = grouped.get(entry.repo_label) ?? [];
      current.push(entry);
      grouped.set(entry.repo_label, current);
    }
    return Array.from(grouped.entries()).map(([repo, skills]) => ({
      repo,
      skills: skills.sort((a, b) => a.name.localeCompare(b.name)),
    }));
  }, [skillCatalog]);
  const installedSkillFolders = useMemo(
    () => new Set(installedSkills.map((skill) => skill.folder_name)),
    [installedSkills]
  );
  const filteredCatalogGroups = useMemo(() => {
    const query = skillSearch.trim().toLowerCase();
    if (!query) return catalogGroups;
    return catalogGroups
      .map((group) => ({
        ...group,
        skills: group.skills.filter((skill) => {
          const haystack = [
            skill.name,
            skill.description ?? "",
            skill.repo_label,
            skill.repo_url,
          ].join(" ").toLowerCase();
          return haystack.includes(query);
        }),
      }))
      .filter((group) => group.skills.length > 0);
  }, [catalogGroups, skillSearch]);

  useEffect(() => {
    if (catalogGroups.length === 0 || expandedSkillGroups.size > 0) return;
    setExpandedSkillGroups(new Set(catalogGroups.map((group) => group.repo)));
  }, [catalogGroups, expandedSkillGroups.size]);

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
          {settingsTab === "skills" ? (
            <Stack gap={16}>
              {skillStatus ? (
                <Box
                  style={{
                    padding: "10px 12px",
                    borderRadius: 12,
                    border: `1px solid ${skillStatus.tone === "success" ? "#28583b" : "#5a262c"}`,
                    background: skillStatus.tone === "success" ? "#102216" : "#261115",
                  }}
                >
                  <Text size="sm" c={skillStatus.tone === "success" ? "#b7f7c7" : "#f6b7c0"}>{skillStatus.message}</Text>
                </Box>
              ) : null}
              <SectionCard title="Installed Skills" description="Claude loads personal skills from ~/.claude/skills. Remove any skill directly from here.">
                {loadingInstalledSkills ? (
                  <Text size="sm" c="#a1a1aa">Loading installed skills…</Text>
                ) : installedSkills.length === 0 ? (
                  <Text size="sm" c="#71717a">No skills are installed yet.</Text>
                ) : (
                  <Stack gap={10}>
                    {installedSkills.map((skill) => (
                      <SkillRow
                        key={skill.folder_name}
                        title={skill.display_name}
                        subtitle={skill.description ?? skill.path}
                        meta={skill.folder_name}
                        actionLabel={busySkillId === skill.folder_name ? "Deleting…" : "Delete"}
                        actionDisabled={busySkillId !== null}
                        onAction={() => void onDeleteInstalledSkill(skill.folder_name, skill.display_name)}
                        destructive
                      />
                    ))}
                  </Stack>
                )}
              </SectionCard>
              <SectionCard title="Install From Folder" description="Choose a local skill folder that contains SKILL.md and copy it into Claude's skills directory.">
                <Button
                  size="sm"
                  onClick={() => void onInstallSkillFolder()}
                  loading={folderInstallInFlight}
                  styles={{
                    root: {
                      background: "#f4f4f5",
                      color: "#0c0c0f",
                      border: "none",
                      "&:hover": { background: "#e4e4e7" },
                    },
                  }}
                >
                  Select Skill Folder
                </Button>
              </SectionCard>
              <SectionCard title="Installable Skills" description="Install curated skills grouped by their source repository.">
                <TextInput
                  aria-label="Search installable skills"
                  placeholder="Search installable skills"
                  value={skillSearch}
                  onChange={(event) => setSkillSearch(event.currentTarget.value)}
                  leftSection={<SearchIcon />}
                  styles={{
                    input: {
                      background: "#121217",
                      borderColor: "#2a2a32",
                      color: "#f4f4f5",
                    },
                  }}
                  mb={12}
                />
                {loadingSkillCatalog ? (
                  <Text size="sm" c="#a1a1aa">Loading skill catalog…</Text>
                ) : catalogGroups.length === 0 ? (
                  <Text size="sm" c="#71717a">No installable skills are configured.</Text>
                ) : filteredCatalogGroups.length === 0 ? (
                  <Text size="sm" c="#71717a">No skills match this search.</Text>
                ) : (
                  <Stack gap={14}>
                    {filteredCatalogGroups.map((group) => {
                      const expanded = skillSearch.trim().length > 0 || expandedSkillGroups.has(group.repo);
                      return (
                        <Box
                          key={group.repo}
                          style={{
                            borderRadius: 12,
                            overflow: "hidden",
                            border: "1px solid #23232a",
                            background: "#0d0d11",
                          }}
                        >
                          <UnstyledButton
                            onClick={() => setExpandedSkillGroups((current) => {
                              const next = new Set(current);
                              if (next.has(group.repo)) next.delete(group.repo);
                              else next.add(group.repo);
                              return next;
                            })}
                            style={{
                              width: "100%",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "space-between",
                              padding: "10px 12px",
                              background: "#121217",
                              borderBottom: expanded ? "1px solid #23232a" : "none",
                            }}
                            aria-label={`${expanded ? "Collapse" : "Expand"} ${group.repo}`}
                          >
                            <Text size="xs" fw={700} c="#e4e4e7">{group.repo} ({group.skills.length})</Text>
                            <ChevronDown
                              size={14}
                              strokeWidth={2}
                              style={{ color: "#8b8b96", transform: expanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 180ms ease" }}
                            />
                          </UnstyledButton>
                          {expanded ? (
                            <Stack gap={0}>
                              {group.skills.map((skill, index) => {
                                const isInstalled = installedSkillFolders.has(skill.destination_name);
                                const isBusy = busySkillId === skill.id;
                                return (
                                  <SkillRow
                                    key={skill.id}
                                    title={skill.name}
                                    subtitle={skill.description ?? skill.repo_url}
                                    meta={skill.repo_url}
                                    actionLabel={isInstalled ? "Installed" : isBusy ? "Installing…" : "Install"}
                                    actionDisabled={isInstalled || busySkillId !== null}
                                    onAction={() => void onInstallCatalogSkill(skill.id, skill.name)}
                                    grouped
                                    firstInGroup={index === 0}
                                  />
                                );
                              })}
                            </Stack>
                          ) : null}
                        </Box>
                      );
                    })}
                  </Stack>
                )}
              </SectionCard>
            </Stack>
          ) : null}
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

function SkillRow({
  title,
  subtitle,
  meta,
  actionLabel,
  actionDisabled,
  onAction,
  destructive,
  grouped,
  firstInGroup,
}: {
  title: string;
  subtitle: string;
  meta: string;
  actionLabel: string;
  actionDisabled: boolean;
  onAction: () => void;
  destructive?: boolean;
  grouped?: boolean;
  firstInGroup?: boolean;
}) {
  return (
    <Box
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "12px 14px",
        borderRadius: grouped ? 0 : 12,
        border: grouped ? "none" : "1px solid #23232a",
        borderTop: grouped && !firstInGroup ? "1px solid #1a1a22" : "none",
        background: grouped ? "transparent" : "#0d0d11",
      }}
    >
      <Box style={{ minWidth: 0, flex: 1 }}>
        <Text size="sm" fw={600} c="#f4f4f5">{title}</Text>
        <Text size="xs" c="#8b8b96" mt={4} style={{ wordBreak: "break-word" }}>{subtitle}</Text>
        <Text size="xs" c="#5f5f69" mt={6} style={{ wordBreak: "break-word" }}>{meta}</Text>
      </Box>
      <Button
        size="xs"
        variant="default"
        onClick={onAction}
        disabled={actionDisabled}
        styles={{
          root: {
            background: destructive ? "#2a1115" : "#18181b",
            borderColor: destructive ? "#5a262c" : "#2a2a32",
            color: destructive ? "#f6b7c0" : "#e4e4e7",
            minWidth: 88,
          },
        }}
      >
        {actionLabel}
      </Button>
    </Box>
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
      <Text size="sm" c="#52525b">{label} coming soon.</Text>
    </Box>
  );
}

const PROJECT_ACCENT_COLORS = [
  "#2a3f5c",
  "#1e4d3a",
  "#4d2a2a",
  "#352a4d",
  "#4d3b1e",
  "#1e3d4d",
  "#2a2a4d",
  "#4d2a3b",
];

function projectColorFor(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = name.charCodeAt(index) + ((hash << 5) - hash);
  }
  return PROJECT_ACCENT_COLORS[Math.abs(hash) % PROJECT_ACCENT_COLORS.length];
}

function projectInitials(name: string): string {
  const words = name.split(/[-_.\s]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const camelWords = name.replace(/([A-Z])/g, " $1").trim().split(/\s+/);
  if (camelWords.length >= 2) return (camelWords[0][0] + camelWords[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function shortenProjectPath(fullPath: string): string {
  const home = fullPath.match(/^\/(?:Users|home)\/[^/]+/)?.[0];
  if (home) return "~" + fullPath.slice(home.length);
  const windowsHome = fullPath.match(/^[A-Za-z]:\\Users\\[^\\]+/i)?.[0];
  if (windowsHome) return "~" + fullPath.slice(windowsHome.length).replace(/\\/g, "/");
  return fullPath;
}

function projectRelativeTime(secs: string | undefined): string {
  if (!secs) return "";
  const diff = Date.now() - Number(secs) * 1000;
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return "just now";
}

function SectionLabel({ title }: { title: string }) {
  return (
    <Box
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        marginBottom: 18,
      }}
    >
      <Text size="xs" fw={700} tt="uppercase" c="#5f6b85" style={{ letterSpacing: 1.3 }}>
        {title}
      </Text>
      <Box style={{ flex: 1, height: 1, background: "#1b2230" }} />
    </Box>
  );
}

function ProjectBadgeAvatar({
  workspace,
  faviconDataUrl,
  size = 38,
}: {
  workspace: DiscoveredWorkspace;
  faviconDataUrl: string | null;
  size?: number;
}) {
  const color = projectColorFor(workspace.display_name);
  const initials = projectInitials(workspace.display_name);

  return (
    <Box
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.28),
        background: workspace.path_exists ? color : "#1e1e24",
        border: "1px solid rgba(255,255,255,0.04)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "rgba(255,255,255,0.9)",
        fontSize: size >= 36 ? (initials.length === 1 ? 16 : 12) : 12,
        fontWeight: 700,
        letterSpacing: 0.3,
        flexShrink: 0,
      }}
    >
      {faviconDataUrl ? (
        <Box
          component="img"
          src={faviconDataUrl}
          alt={`${workspace.display_name} favicon`}
          style={{
            width: "70%",
            height: "70%",
            objectFit: "contain",
            borderRadius: 6,
          }}
        />
      ) : (
        initials
      )}
    </Box>
  );
}

function FavoriteButton({
  isFavorite,
  onClick,
}: {
  isFavorite: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={isFavorite ? "Remove from favorites" : "Add to favorites"} withArrow>
      <Box
        component="button"
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
        aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
        style={{
          width: 22,
          height: 22,
          border: "none",
          background: "transparent",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: isFavorite ? "#f3c63b" : "#44516b",
          cursor: "pointer",
          padding: 0,
          flexShrink: 0,
        }}
      >
        <Star size={14} strokeWidth={1.8} fill={isFavorite ? "currentColor" : "none"} />
      </Box>
    </Tooltip>
  );
}

function ProjectPinnedCard({
  workspace,
  faviconDataUrl,
  isFavorite,
  onToggleFavorite,
  onClick,
}: {
  workspace: DiscoveredWorkspace;
  faviconDataUrl: string | null;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  onClick: () => void;
}) {
  const latestSession = workspace.sessions[0];
  const sessionCount = workspace.sessions.length;

  return (
    <Box
      onClick={onClick}
      style={{
        minHeight: 146,
        padding: 16,
        borderRadius: 14,
        border: "1px solid #2a3243",
        background: "linear-gradient(180deg, #1a1d28 0%, #171a22 100%)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
        cursor: workspace.path_exists ? "pointer" : "default",
        opacity: workspace.path_exists ? 1 : 0.45,
      }}
    >
      <Box style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <ProjectBadgeAvatar workspace={workspace} faviconDataUrl={faviconDataUrl} />
        <FavoriteButton isFavorite={isFavorite} onClick={onToggleFavorite} />
      </Box>
      <Text size="lg" fw={600} c="#e7e9f2" mt={14} truncate>
        {workspace.display_name}
      </Text>
      <Tooltip label={workspace.decoded_path} withArrow openDelay={500}>
        <Text size="xs" c="#66758f" mt={4} truncate>
          {shortenProjectPath(workspace.decoded_path)}
        </Text>
      </Tooltip>
      <Box style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 18 }}>
        <Box
          style={{
            display: "inline-flex",
            alignItems: "center",
            height: 22,
            padding: "0 10px",
            borderRadius: 999,
            border: "1px solid #2a3243",
            background: "#171c24",
          }}
        >
          <Text size="xs" c="#99a4bb">
            {sessionCount} {sessionCount === 1 ? "session" : "sessions"}
          </Text>
        </Box>
        <Text size="xs" c={workspace.path_exists ? "#66758f" : "#7f1d1d"}>
          {workspace.path_exists ? projectRelativeTime(latestSession?.modified_at) : "not found"}
        </Text>
      </Box>
    </Box>
  );
}

function ProjectTableHeader() {
  return (
    <Box
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 180px 110px 56px",
        gap: 12,
        padding: "0 14px 10px",
        borderBottom: "1px solid #1b2230",
      }}
    >
      <Text size="xs" fw={700} tt="uppercase" c="#5f6b85" style={{ letterSpacing: 1.1 }}>Name</Text>
      <Text size="xs" fw={700} tt="uppercase" c="#5f6b85" style={{ letterSpacing: 1.1 }}>Sessions</Text>
      <Text size="xs" fw={700} tt="uppercase" c="#5f6b85" style={{ letterSpacing: 1.1 }}>Last Active</Text>
      <Text size="xs" fw={700} tt="uppercase" c="#5f6b85" style={{ letterSpacing: 1.1, textAlign: "center" }}>Fav</Text>
    </Box>
  );
}

function ProjectTableRow({
  workspace,
  faviconDataUrl,
  isFavorite,
  maxSessions,
  onToggleFavorite,
  onClick,
}: {
  workspace: DiscoveredWorkspace;
  faviconDataUrl: string | null;
  isFavorite: boolean;
  maxSessions: number;
  onToggleFavorite: () => void;
  onClick: () => void;
}) {
  const latestSession = workspace.sessions[0];
  const sessionCount = workspace.sessions.length;
  const progress = maxSessions > 0 ? Math.max(0.08, sessionCount / maxSessions) : 0;

  return (
    <Box
      onClick={onClick}
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 180px 110px 56px",
        gap: 12,
        alignItems: "center",
        padding: "14px",
        borderRadius: 12,
        cursor: workspace.path_exists ? "pointer" : "default",
        opacity: workspace.path_exists ? 1 : 0.45,
        transition: "background 180ms ease, border-color 180ms ease",
        border: "1px solid transparent",
      }}
      onMouseEnter={(event) => {
        event.currentTarget.style.background = "#171b25";
        event.currentTarget.style.borderColor = "#2a3243";
      }}
      onMouseLeave={(event) => {
        event.currentTarget.style.background = "transparent";
        event.currentTarget.style.borderColor = "transparent";
      }}
    >
      <Box style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
        <ProjectBadgeAvatar workspace={workspace} faviconDataUrl={faviconDataUrl} />
        <Box style={{ minWidth: 0 }}>
          <Text size="sm" fw={600} c="#e7e9f2" truncate>
            {workspace.display_name}
          </Text>
          <Tooltip label={workspace.decoded_path} withArrow openDelay={500}>
            <Text size="xs" c="#66758f" truncate>
              {shortenProjectPath(workspace.decoded_path)}
            </Text>
          </Tooltip>
        </Box>
      </Box>

      <Box style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Box
          style={{
            width: 56,
            height: 4,
            borderRadius: 999,
            background: "#232a36",
            overflow: "hidden",
            flexShrink: 0,
          }}
        >
          <Box
            style={{
              width: `${progress * 100}%`,
              height: "100%",
              borderRadius: 999,
              background: sessionCount > 0 ? "#b99a3d" : "#394352",
            }}
          />
        </Box>
        <Text size="sm" c="#98a3b8">
          {sessionCount} {sessionCount === 1 ? "session" : "sessions"}
        </Text>
      </Box>

      <Text size="sm" c={workspace.path_exists ? "#66758f" : "#7f1d1d"}>
        {workspace.path_exists ? projectRelativeTime(latestSession?.modified_at) : "not found"}
      </Text>

      <Box style={{ display: "flex", justifyContent: "center" }}>
        <FavoriteButton isFavorite={isFavorite} onClick={onToggleFavorite} />
      </Box>
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
