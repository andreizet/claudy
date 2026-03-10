import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { Box, Text, UnstyledButton } from "@mantine/core";
import { Folder, Plus, X } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { ClaudeAccountInfo, DiscoveredWorkspace } from "./types";
import { ACTIVE_TAB_STORAGE_KEY, loadAppSettings, OPEN_TABS_STORAGE_KEY } from "./shared/settings";
import { extractMcpServers, loadToolInventoryCache, saveToolInventoryCache } from "./shared/toolPolicy";
import HomeView from "./views/HomeView";
import ChatView from "./views/ChatView";
import SplashScreen from "./components/SplashScreen";

type HomeTabLabel = "Projects" | "Usage" | "Settings";

type AppTab =
  | { id: string; kind: "home"; viewLabel: HomeTabLabel }
  | { id: string; kind: "chat"; workspace: DiscoveredWorkspace; sessionTitle: string | null };
const FAVICON_STORAGE_KEY = "claudy.workspaceFavicons";

interface ClaudeSessionInit {
  session_id: string | null;
  cwd: string | null;
  model: string | null;
  tools: string[];
  mcp_servers: unknown;
}

function createTabId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createHomeTab(id = createTabId()): AppTab {
  return { id, kind: "home", viewLabel: "Projects" };
}

function isDiscoveredWorkspace(value: unknown): value is DiscoveredWorkspace {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<DiscoveredWorkspace>;
  return (
    typeof candidate.encoded_name === "string"
    && typeof candidate.decoded_path === "string"
    && typeof candidate.display_name === "string"
    && typeof candidate.path_exists === "boolean"
    && Array.isArray(candidate.sessions)
  );
}

function loadStoredTabs(): { tabs: AppTab[]; activeTabId: string | null } {
  try {
    if (!loadAppSettings().rememberOpenTabs) {
      return { tabs: [createHomeTab()], activeTabId: null };
    }
    const rawTabs = window.localStorage.getItem(OPEN_TABS_STORAGE_KEY);
    const rawActiveTabId = window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    if (!rawTabs) {
      return { tabs: [createHomeTab()], activeTabId: null };
    }

    const parsed = JSON.parse(rawTabs);
    if (!Array.isArray(parsed)) {
      return { tabs: [createHomeTab()], activeTabId: null };
    }

    const tabs = parsed.flatMap((tab): AppTab[] => {
      if (!tab || typeof tab !== "object") return [];
      const candidate = tab as Partial<AppTab>;
      if (typeof candidate.id !== "string") return [];
      if (candidate.kind === "home") {
        return [{
          id: candidate.id,
          kind: "home",
          viewLabel: candidate.viewLabel === "Usage" || candidate.viewLabel === "Settings" ? candidate.viewLabel : "Projects",
        }];
      }
      if (
        candidate.kind === "chat"
        && isDiscoveredWorkspace(candidate.workspace)
        && (typeof candidate.sessionTitle === "string" || candidate.sessionTitle === null || candidate.sessionTitle === undefined)
      ) {
        return [{
          id: candidate.id,
          kind: "chat",
          workspace: candidate.workspace,
          sessionTitle: candidate.sessionTitle ?? null,
        }];
      }
      return [];
    });

    if (tabs.length === 0) {
      return { tabs: [createHomeTab()], activeTabId: null };
    }

    const activeTabId = typeof rawActiveTabId === "string" && tabs.some((tab) => tab.id === rawActiveTabId)
      ? rawActiveTabId
      : tabs[0].id;

    return { tabs, activeTabId };
  } catch {
    return { tabs: [createHomeTab()], activeTabId: null };
  }
}

export default function App() {
  const queryClient = useQueryClient();
  const [initialState] = useState(loadStoredTabs);
  const [tabs, setTabs] = useState<AppTab[]>(initialState.tabs);
  const [activeTabId, setActiveTabId] = useState(initialState.activeTabId ?? initialState.tabs[0]?.id ?? createTabId());
  const [showSplash, setShowSplash] = useState(() => !import.meta.env.TEST);

  const { data: workspaces = [], isLoading } = useQuery({
    queryKey: ["existing-sessions"],
    queryFn: () => invoke<DiscoveredWorkspace[]>("scan_existing_sessions"),
  });

  const { data: accountInfo = null } = useQuery({
    queryKey: ["claude-account-info"],
    queryFn: () => invoke<ClaudeAccountInfo>("get_claude_account_info"),
  });
  const [favicons, setFavicons] = useState<Record<string, string | null>>({});

  const openWorkspaceInNewTab = (workspace: DiscoveredWorkspace) => {
    const id = createTabId();
    setTabs([{ id, kind: "chat", workspace, sessionTitle: workspace.sessions[0]?.first_message ?? null }]);
    setActiveTabId(id);
  };

  const replaceActiveTabWithWorkspace = (workspace: DiscoveredWorkspace) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.id === activeTabId
          ? { id: activeTabId, kind: "chat", workspace, sessionTitle: workspace.sessions[0]?.first_message ?? null }
          : t
      )
    );
  };

  const updateTabSessionTitle = useCallback((tabId: string, sessionTitle: string | null) => {
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        if (tab.id !== tabId || tab.kind !== "chat" || tab.sessionTitle === sessionTitle) {
          return tab;
        }
        changed = true;
        return { ...tab, sessionTitle };
      });
      return changed ? next : prev;
    });
  }, []);

  const updateHomeTabLabel = useCallback((tabId: string, viewLabel: HomeTabLabel) => {
    setTabs((prev) => {
      let changed = false;
      const next = prev.map((tab) => {
        if (tab.id !== tabId || tab.kind !== "home" || tab.viewLabel === viewLabel) {
          return tab;
        }
        changed = true;
        return { ...tab, viewLabel };
      });
      return changed ? next : prev;
    });
  }, []);

  const handleCreateSession = async (workspacePath: string, replaceActive = false) => {
    const workspace = await invoke<DiscoveredWorkspace>("describe_workspace", { workspacePath });
    await queryClient.invalidateQueries({ queryKey: ["existing-sessions"] });
    if (replaceActive) {
      replaceActiveTabWithWorkspace(workspace);
      return;
    }
    openWorkspaceInNewTab(workspace);
  };

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
    const chatTabs = tabs.filter((t): t is Extract<AppTab, { kind: "chat" }> => t.kind === "chat");
    const missing = chatTabs.filter((t) => favicons[t.workspace.encoded_name] === undefined);
    if (missing.length === 0) return;
    let cancelled = false;

    Promise.all(
      missing.map(async (t) => {
        try {
          const icon = await invoke<string | null>("get_workspace_favicon", {
            workspacePath: t.workspace.decoded_path,
          });
          return { key: t.workspace.encoded_name, icon: icon ?? null };
        } catch {
          return { key: t.workspace.encoded_name, icon: null };
        }
      })
    ).then((results) => {
      if (cancelled) return;
      setFavicons((prev) => {
        const next = { ...prev };
        for (const { key, icon } of results) {
          if (next[key] === undefined) next[key] = icon;
        }
        try {
          window.localStorage.setItem(FAVICON_STORAGE_KEY, JSON.stringify(next));
        } catch {
          // Ignore storage errors.
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [tabs, favicons]);

  useEffect(() => {
    if (loadToolInventoryCache()) return;
    const workspace = workspaces.find((item) => item.path_exists) ?? workspaces[0];
    if (!workspace) return;
    invoke<ClaudeSessionInit>("get_claude_session_init", {
      workspacePath: workspace.decoded_path,
    })
      .then((init) => {
        saveToolInventoryCache({
          availableTools: Array.isArray(init.tools) ? init.tools : [],
          mcpServers: extractMcpServers(init.mcp_servers),
          workspacePath: workspace.decoded_path,
        });
      })
      .catch(() => {
        // Ignore startup inventory failures.
      });
  }, [workspaces]);

  useEffect(() => {
    try {
      const settings = loadAppSettings();
      if (!settings.rememberOpenTabs) {
        window.localStorage.removeItem(OPEN_TABS_STORAGE_KEY);
        window.localStorage.removeItem(ACTIVE_TAB_STORAGE_KEY);
        return;
      }
      window.localStorage.setItem(OPEN_TABS_STORAGE_KEY, JSON.stringify(tabs));
      window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, activeTabId);
    } catch {
      // Ignore storage errors.
    }
  }, [tabs, activeTabId]);

  const hasProjectTabs = tabs.some((t) => t.kind === "chat");
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  const closeTab = (id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      const stillHasProject = next.some((t) => t.kind === "chat");

      if (!stillHasProject) {
        const homeTab = createHomeTab();
        setActiveTabId(homeTab.id);
        return [homeTab];
      }

      if (id === activeTabId) {
        const fallback = next[Math.max(0, idx - 1)] ?? next[0];
        setActiveTabId(fallback.id);
      }
      return next;
    });
  };

  const handleSessionTitleChange = useCallback((sessionTitle: string | null) => {
    const currentActiveTabId = activeTabId;
    updateTabSessionTitle(currentActiveTabId, sessionTitle);
  }, [activeTabId, updateTabSessionTitle]);

  useEffect(() => {
    if (!showSplash) return;
    const timer = window.setTimeout(() => {
      setShowSplash(false);
    }, 1800);

    return () => {
      window.clearTimeout(timer);
    };
  }, [showSplash]);

  if (showSplash) {
    return <SplashScreen />;
  }

  if (!hasProjectTabs) {
    return (
      <Box style={{ height: "100vh", minHeight: 0 }}>
        <HomeView
          workspaces={workspaces}
          isLoading={isLoading}
          accountInfo={accountInfo}
          onOpenWorkspace={openWorkspaceInNewTab}
          onCreateSession={(workspacePath) => void handleCreateSession(workspacePath)}
        />
      </Box>
    );
  }

  const tabHeader = (
    <Box
      style={{
        height: 50,
        borderBottom: "1px solid #1f1f23",
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 12px",
        background: "#07090d",
        flexShrink: 0,
        overflowX: "auto",
      }}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const label = tab.kind === "chat"
          ? `${tab.workspace.display_name} - ${tab.sessionTitle ?? "Session"}`
          : tab.viewLabel;
        const tabIcon = tab.kind === "chat" ? favicons[tab.workspace.encoded_name] ?? null : null;
        const handleMiddleClickClose = (event: MouseEvent) => {
          if (event.button !== 1) return;
          event.preventDefault();
          event.stopPropagation();
          closeTab(tab.id);
        };
        return (
          <Box
            key={tab.id}
            className="app-tab"
            onMouseDown={handleMiddleClickClose}
            style={{
              minWidth: 150,
              maxWidth: 260,
              height: 28,
              border: "1px solid #2a3243",
              borderRadius: 8,
              background: active ? "#171c26" : "#11151c",
              display: "flex",
              alignItems: "center",
              boxShadow: active ? "inset 0 1px 0 rgba(255,255,255,0.03)" : "none",
              transition: "background 180ms ease, border-color 180ms ease, color 180ms ease",
              flexShrink: 0,
            }}
          >
            <UnstyledButton
              onClick={() => setActiveTabId(tab.id)}
              onMouseDown={handleMiddleClickClose}
              className="app-tab__button"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                minWidth: 0,
                flex: 1,
                padding: "0 12px",
                height: "100%",
                color: active ? "#e7e9f2" : "#98a3b8",
                transition: "color 180ms ease",
              }}
            >
              {tab.kind === "chat" && (
                tabIcon ? (
                  <Box
                    component="img"
                    src={tabIcon}
                    alt=""
                    style={{ width: 14, height: 14, objectFit: "contain", borderRadius: 3, flexShrink: 0 }}
                  />
                ) : (
                  <Folder size={14} strokeWidth={1.7} style={{ color: "#71717a", flexShrink: 0 }} />
                )
              )}
              <Text size="14px" fw={active ? 600 : 500} truncate>
                {label}
              </Text>
            </UnstyledButton>
            <UnstyledButton
              onClick={() => closeTab(tab.id)}
              aria-label={`Close ${label} tab`}
              title={`Close ${label} tab`}
              className="app-tab-close"
              style={{
                width: 22,
                height: 22,
                marginRight: 6,
                borderRadius: 4,
                color: "#66758f",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                transition: "color 180ms ease, background 180ms ease, transform 180ms ease",
              }}
            >
              <X size={14} strokeWidth={2} />
            </UnstyledButton>
          </Box>
        );
      })}
      <UnstyledButton
        onClick={() => {
          const id = createTabId();
          setTabs((prev) => [...prev, createHomeTab(id)]);
          setActiveTabId(id);
        }}
        style={{
          width: 28,
          height: 28,
          border: "1px solid #1f2531",
          borderRadius: 8,
          color: "#98a3b8",
          background: "#0d1118",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
        title="New tab"
      >
        <Plus size={16} strokeWidth={2.2} />
      </UnstyledButton>
    </Box>
  );

  if (activeTab.kind === "chat") {
    return (
      <Box style={{ height: "100vh", minHeight: 0 }}>
        <ChatView
          key={activeTab.id}
          workspace={activeTab.workspace}
          accountInfo={accountInfo}
          mainHeader={tabHeader}
          onSessionTitleChange={handleSessionTitleChange}
          onBack={() =>
            setTabs((prev) =>
              prev.map((t) =>
                t.id === activeTab.id ? createHomeTab(activeTab.id) : t
              )
            )
          }
        />
      </Box>
    );
  }

  return (
    <Box style={{ height: "100vh", minHeight: 0 }}>
      <HomeView
        key={activeTab.id}
        workspaces={workspaces}
        isLoading={isLoading}
        accountInfo={accountInfo}
        mainHeader={tabHeader}
        onViewLabelChange={(viewLabel) => updateHomeTabLabel(activeTab.id, viewLabel)}
        onOpenWorkspace={replaceActiveTabWithWorkspace}
        onCreateSession={(workspacePath) => void handleCreateSession(workspacePath, true)}
      />
    </Box>
  );
}
