import { useState, useMemo } from "react";
import { Box, Text, TextInput, Button, Group, Stack, ScrollArea, UnstyledButton, Skeleton } from "@mantine/core";
import { DiscoveredWorkspace } from "../types";
import ProjectListItem from "../components/ProjectListItem";

type NavItem = "projects" | "favorites";

interface Props {
  workspaces: DiscoveredWorkspace[];
  isLoading: boolean;
  onOpenWorkspace: (workspace: DiscoveredWorkspace) => void;
}

export default function HomeView({ workspaces, isLoading, onOpenWorkspace }: Props) {
  const [activeNav, setActiveNav] = useState<NavItem>("projects");
  const [search, setSearch] = useState("");

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
      ? filtered.filter((w) => w.path_exists)
      : filtered;

  return (
    <Box
      style={{
        display: "flex",
        height: "100vh",
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
          <Group gap={10} align="center">
            <Box
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                background: "#1e1e24",
                border: "1px solid #2a2a32",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontWeight: 800,
                fontSize: 15,
                color: "#f4f4f5",
                flexShrink: 0,
                letterSpacing: -1,
                fontFamily: "monospace",
              }}
            >
              C
            </Box>
            <Stack gap={1}>
              <Text fw={600} size="sm" c="#f4f4f5" lh={1.2}>Claudy</Text>
              <Text size="xs" c="#52525b" lh={1.2}>0.1.0</Text>
            </Stack>
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
        </Stack>

        {/* Settings */}
        <Box px={14} pb={18}>
          <UnstyledButton
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
        {/* Top bar */}
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

        {/* Project list */}
        <ScrollArea style={{ flex: 1 }}>
          {isLoading ? (
            <LoadingSkeleton />
          ) : listed.length === 0 ? (
            <EmptyState activeNav={activeNav} hasSearch={!!search} />
          ) : (
            <Box>
              {listed.map((w) => (
                <ProjectListItem key={w.encoded_name} workspace={w} onClick={() => w.path_exists && onOpenWorkspace(w)} />
              ))}
            </Box>
          )}
        </ScrollArea>
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
        borderRadius: 7,
        fontSize: 13,
        fontWeight: active ? 500 : 400,
        color: active ? "#f0f0f2" : hovered ? "#a1a1aa" : "#71717a",
        transition: "background 100ms, color 100ms, box-shadow 100ms",
        // 3D raised effect when active
        background: active
          ? "linear-gradient(180deg, #28282f 0%, #1e1e25 100%)"
          : hovered
          ? "rgba(255,255,255,0.03)"
          : "transparent",
        border: active ? "1px solid" : "1px solid transparent",
        borderColor: active
          ? "rgba(255,255,255,0.13) rgba(255,255,255,0.07) rgba(0,0,0,0.45) rgba(255,255,255,0.07)"
          : "transparent",
        boxShadow: active
          ? "0 2px 6px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.07)"
          : "none",
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
