import { useState, useEffect } from "react";
import { Box, Text, ScrollArea, UnstyledButton, Group, Skeleton } from "@mantine/core";
import { invoke } from "@tauri-apps/api/core";
import { DiscoveredWorkspace, DiscoveredSession, JsonlRecord } from "../types";
import MessageList from "../components/chat/MessageList";

interface Props {
  workspace: DiscoveredWorkspace;
  onBack: () => void;
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

export default function ChatView({ workspace, onBack }: Props) {
  const sessions = workspace.sessions;
  const [activeSession, setActiveSession] = useState<DiscoveredSession | null>(
    sessions[0] ?? null
  );
  const [messages, setMessages] = useState<JsonlRecord[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);

  useEffect(() => {
    if (!activeSession) return;
    setLoadingMessages(true);
    console.log("Loading messages for:", activeSession.file_path);
    invoke<unknown[]>("get_session_messages", { filePath: activeSession.file_path })
      .then((raw) => {
        console.log("Got messages:", raw.length, raw[0]);
        setMessages(raw as JsonlRecord[]);
      })
      .catch((e) => console.error("invoke error:", e))
      .finally(() => setLoadingMessages(false));
  }, [activeSession?.file_path]);

  const sessionTitle =
    activeSession?.first_message ??
    (activeSession ? "Session" : "No sessions");

  return (
    <Box style={{ display: "flex", height: "100vh", background: "#0c0c0f" }}>
      {/* ── Sidebar ── */}
      <Box
        style={{
          width: 320,
          flexShrink: 0,
          background: "#131316",
          borderRight: "1px solid #1f1f23",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* macOS traffic light spacer */}
        <Box style={{ height: 52 }} />

        {/* Back button */}
        <Box px={14} pb={8}>
          <UnstyledButton
            onClick={onBack}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              color: "#52525b",
              fontSize: 12,
              padding: "3px 0",
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "#a1a1aa")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "#52525b")}
          >
            <ChevronLeft />
            <Text size="xs" inherit>All projects</Text>
          </UnstyledButton>
        </Box>

        {/* Project name */}
        <Box px={14} pb={12}>
          <Group gap={8} align="center">
            <FolderIcon />
            <Text size="sm" fw={600} c="#e4e4e7" truncate style={{ flex: 1, minWidth: 0 }}>
              {workspace.display_name}
            </Text>
          </Group>
        </Box>

        {/* Session list */}
        <ScrollArea style={{ flex: 1 }}>
          <Box pb={12}>
            {sessions.length === 0 ? (
              <Text size="xs" c="#52525b" px={14} pt={8}>No sessions yet</Text>
            ) : (
              sessions.map((s) => (
                <SessionItem
                  key={s.id}
                  session={s}
                  active={activeSession?.id === s.id}
                  onClick={() => setActiveSession(s)}
                />
              ))
            )}
          </Box>
        </ScrollArea>
      </Box>

      {/* ── Main panel ── */}
      <Box style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        {/* Top bar */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", alignItems: "center", gap: 12, padding: "0 24px", height: 52, borderBottom: "1px solid #1f1f23", flexShrink: 0 }}>
          <div style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", fontSize: 14, fontWeight: 500, color: "#e4e4e7", maxWidth: 500 }}>
            {sessionTitle}
          </div>
          <div style={{ fontSize: 12, fontWeight: 500, color: "#71717a", whiteSpace: "nowrap" }}>
            {workspace.display_name}
          </div>
        </div>

        {/* Messages */}
        {loadingMessages ? (
          <MessagesSkeleton />
        ) : !activeSession ? (
          <EmptyMessages />
        ) : (
          <MessageList messages={messages} />
        )}

        {/* Input placeholder */}
        <Box
          px={24}
          py={16}
          style={{
            borderTop: "1px solid #1f1f23",
            background: "#0e0e12",
            flexShrink: 0,
          }}
        >
          <Box
            style={{
              borderRadius: 10,
              border: "1px solid #27272a",
              padding: "12px 16px",
              color: "#3f3f46",
              fontSize: 13,
              cursor: "default",
            }}
          >
            Ask for follow-up changes...
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

// ── Session sidebar item ──────────────────────────────────────────────────────

function SessionItem({
  session,
  active,
  onClick,
}: {
  session: DiscoveredSession;
  active: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <UnstyledButton
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: "100%",
        padding: "7px 14px 7px 28px",
        background: active ? "#1e1e24" : hovered ? "#18181b" : "transparent",
        textAlign: "left",
        display: "flex",
        alignItems: "baseline",
        gap: 8,
      }}
    >
      <Text
        size="xs"
        fw={active ? 500 : 400}
        c={active ? "#e4e4e7" : hovered ? "#a1a1aa" : "#71717a"}
        style={{ flex: 1, minWidth: 0, lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        {session.first_message ?? "Empty session"}
      </Text>
      <Text size="xs" c="#3f3f46" style={{ flexShrink: 0, fontSize: 11 }}>
        {relativeTime(session.modified_at)}
      </Text>
    </UnstyledButton>
  );
}

// ── Skeletons & empty states ──────────────────────────────────────────────────

function MessagesSkeleton() {
  return (
    <Box style={{ flex: 1, padding: "24px", display: "flex", flexDirection: "column", gap: 24 }}>
      {[70, 90, 50, 80].map((w, i) => (
        <Box key={i} style={{ display: "flex", justifyContent: i % 2 === 0 ? "flex-start" : "flex-end" }}>
          <Skeleton height={36} width={`${w}%`} radius={10} />
        </Box>
      ))}
    </Box>
  );
}

function EmptyMessages() {
  return (
    <Box style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <Text size="sm" c="#3f3f46">Select a session to view the conversation</Text>
    </Box>
  );
}

function ChevronLeft() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M15 18l-6-6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ color: "#52525b", flexShrink: 0 }}>
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
