import { useState } from "react";
import { Box, Text, Stack, Tooltip, Badge } from "@mantine/core";
import { DiscoveredWorkspace } from "../types";

interface Props {
  workspace: DiscoveredWorkspace;
  onClick?: () => void;
}

// Muted, desaturated — distinct hues without neon brightness
const COLORS = [
  "#2a3f5c", // slate navy
  "#1e4d3a", // forest
  "#4d2a2a", // brick
  "#352a4d", // grape
  "#4d3b1e", // amber
  "#1e3d4d", // teal
  "#2a2a4d", // indigo
  "#4d2a3b", // rose
];

function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return COLORS[Math.abs(h) % COLORS.length];
}

function initials(name: string): string {
  const words = name.split(/[-_.\s]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  const camel = name.replace(/([A-Z])/g, " $1").trim().split(/\s+/);
  if (camel.length >= 2) return (camel[0][0] + camel[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

function shortenPath(fullPath: string): string {
  const home = fullPath.match(/^\/(?:Users|home)\/[^/]+/)?.[0];
  if (home) return "~" + fullPath.slice(home.length);
  return fullPath;
}

function relativeTime(secs: string): string {
  if (!secs) return "";
  const diff = Date.now() - Number(secs) * 1000;
  const m = Math.floor(diff / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ago`;
  if (h > 0) return `${h}h ago`;
  if (m > 0) return `${m}m ago`;
  return "just now";
}

export default function ProjectListItem({ workspace, onClick }: Props) {
  const [hovered, setHovered] = useState(false);
  const isMissing = !workspace.path_exists;
  const color = colorFor(workspace.display_name);
  const abbr = initials(workspace.display_name);
  const shortPath = shortenPath(workspace.decoded_path);
  const latestSession = workspace.sessions[0];
  const sessionCount = workspace.sessions.length;

  return (
    <Box
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "10px 20px",
        cursor: isMissing ? "default" : "pointer",
        background: hovered && !isMissing ? "#18181b" : "transparent",
        opacity: isMissing ? 0.4 : 1,
        transition: "background 100ms",
      }}
    >
      {/* Avatar */}
      <Box
        style={{
          width: 38,
          height: 38,
          borderRadius: 8,
          background: isMissing ? "#1e1e24" : color,
          border: "1px solid rgba(255,255,255,0.06)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: 600,
          fontSize: abbr.length === 1 ? 16 : 12,
          color: "rgba(255,255,255,0.85)",
          flexShrink: 0,
          letterSpacing: 0.5,
          fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
        }}
      >
        {abbr}
      </Box>

      {/* Info */}
      <Stack gap={3} style={{ flex: 1, minWidth: 0 }}>
        <Text
          size="sm"
          fw={500}
          truncate
          style={{ color: isMissing ? "#52525b" : "#e4e4e7" }}
        >
          {workspace.display_name}
        </Text>
        <Tooltip
          label={workspace.decoded_path}
          position="bottom-start"
          withArrow
          openDelay={600}
        >
          <Text
            size="xs"
            truncate
            style={{ color: "#8a8a94", cursor: "default" }}
          >
            {shortPath}
          </Text>
        </Tooltip>
      </Stack>

      {/* Meta */}
      <Stack gap={4} align="flex-end" style={{ flexShrink: 0 }}>
        {isMissing ? (
          <Text size="xs" style={{ color: "#7f1d1d" }}>not found</Text>
        ) : (
          <>
            {latestSession && (
              <Text size="xs" style={{ color: "#8a8a94" }}>
                {relativeTime(latestSession.modified_at)}
              </Text>
            )}
            <Badge
              size="sm"
              variant="filled"
              styles={{
                root: {
                  background: "#27272a",
                  color: "#a1a1aa",
                  border: "1px solid #3f3f46",
                  fontWeight: 500,
                  fontSize: 11,
                  textTransform: "none",
                  letterSpacing: 0,
                },
              }}
            >
              {sessionCount} {sessionCount === 1 ? "session" : "sessions"}
            </Badge>
          </>
        )}
      </Stack>
    </Box>
  );
}
