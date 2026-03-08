import { useState, useMemo, useEffect } from "react";
import { Box, Text, TextInput, Button, Group, Stack, ScrollArea, UnstyledButton, Skeleton } from "@mantine/core";
import { ClaudeAccountInfo, DiscoveredWorkspace } from "../types";
import ProjectListItem from "../components/ProjectListItem";
import sidebarTitle from "../assets/sidebar-title.svg";
import { md5 } from "../shared/md5";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import UsageDashboardView from "./UsageDashboardView";

type NavItem = "projects" | "favorites" | "usage";
const FAVORITES_STORAGE_KEY = "claudy.favoriteWorkspaces";
const FAVICON_STORAGE_KEY = "claudy.workspaceFavicons";

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
  const [search, setSearch] = useState("");
  const [favorites, setFavorites] = useState<Set<string>>(loadFavoriteWorkspaces);
  const [favicons, setFavicons] = useState<Record<string, string | null>>({});

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
            onClick={() => setActiveNav("usage")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "6px 6px",
              borderRadius: 6,
              color: "#52525b",
              width: "100%",
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
        {activeNav !== "usage" ? (
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
              leftSection={<svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></svg>}
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
            <Text size="sm" fw={600} c="#e4e4e7">Claude Usage</Text>
          </Box>
        )}

        {/* Project list */}
        {activeNav === "usage" ? (
          <UsageDashboardView />
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
        transition: "background 100ms, color 100ms",
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
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      style={{ color: "#52525b", flexShrink: 0 }}
    >
      <circle cx="6.5" cy="6.5" r="5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M10.5 10.5L14 14"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
