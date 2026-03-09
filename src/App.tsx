import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Text, UnstyledButton } from "@mantine/core";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { ClaudeAccountInfo, DiscoveredWorkspace } from "./types";
import HomeView from "./views/HomeView";
import ChatView from "./views/ChatView";
import SplashScreen from "./components/SplashScreen";

type AppTab =
  | { id: string; kind: "home" }
  | { id: string; kind: "chat"; workspace: DiscoveredWorkspace; sessionTitle: string | null };
const FAVICON_STORAGE_KEY = "claudy.workspaceFavicons";

function createTabId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function App() {
  const queryClient = useQueryClient();
  const initialTabId = useMemo(createTabId, []);
  const [tabs, setTabs] = useState<AppTab[]>([{ id: initialTabId, kind: "home" }]);
  const [activeTabId, setActiveTabId] = useState(initialTabId);
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

  const hasProjectTabs = tabs.some((t) => t.kind === "chat");
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  const closeTab = (id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      const stillHasProject = next.some((t) => t.kind === "chat");

      if (!stillHasProject) {
        const homeId = createTabId();
        setActiveTabId(homeId);
        return [{ id: homeId, kind: "home" }];
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
        height: 40,
        borderBottom: "1px solid #1f1f23",
        display: "flex",
        alignItems: "stretch",
        background: "#0f1115",
        flexShrink: 0,
      }}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const label = tab.kind === "chat"
          ? `${tab.workspace.display_name} - ${tab.sessionTitle ?? "Session"}`
          : "Home";
        const tabIcon = tab.kind === "chat" ? favicons[tab.workspace.encoded_name] ?? null : null;
        return (
          <Box
            key={tab.id}
            style={{
              minWidth: 140,
              maxWidth: 220,
              borderRight: "1px solid #1f1f23",
              borderBottom: active ? "1px solid #0c0c0f" : "1px solid #1f1f23",
              background: active ? "#171a20" : "#12151b",
              display: "flex",
              alignItems: "center",
            }}
          >
            <UnstyledButton
              onClick={() => setActiveTabId(tab.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                minWidth: 0,
                flex: 1,
                padding: "0 10px",
                height: "100%",
                color: active ? "#f4f4f5" : "#a1a1aa",
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
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ color: "#71717a", flexShrink: 0 }}>
                    <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                  </svg>
                )
              )}
              <Text size="sm" fw={active ? 600 : 500} truncate>
                {label}
              </Text>
            </UnstyledButton>
            <UnstyledButton
              onClick={() => closeTab(tab.id)}
              style={{
                width: 24,
                height: 24,
                marginRight: 8,
                borderRadius: 4,
                color: "#71717a",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
            >
              <Text size="sm" lh={1}>×</Text>
            </UnstyledButton>
          </Box>
        );
      })}
      <UnstyledButton
        onClick={() => {
          const id = createTabId();
          setTabs((prev) => [...prev, { id, kind: "home" }]);
          setActiveTabId(id);
        }}
        style={{
          width: 36,
          borderRight: "1px solid #1f1f23",
          color: "#a1a1aa",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
        title="New tab"
      >
        <Text size="lg" lh={1}>+</Text>
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
                t.id === activeTab.id ? { id: activeTab.id, kind: "home" } : t
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
        onOpenWorkspace={replaceActiveTabWithWorkspace}
        onCreateSession={(workspacePath) => void handleCreateSession(workspacePath, true)}
      />
    </Box>
  );
}
