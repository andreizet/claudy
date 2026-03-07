import { useState, useEffect, useRef } from "react";
import { Box, Text, ScrollArea, UnstyledButton, Group, Skeleton } from "@mantine/core";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ClaudeAccountInfo, DiscoveredWorkspace, DiscoveredSession, JsonlRecord } from "../types";
import MessageList from "../components/chat/MessageList";
import { md5 } from "../shared/md5";

interface Props {
  workspace: DiscoveredWorkspace;
  accountInfo: ClaudeAccountInfo | null;
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

function modelFromHistory(records: JsonlRecord[]): string {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const raw = (records[i] as unknown as { message?: { model?: unknown } })?.message?.model;
    if (typeof raw !== "string") continue;
    const model = raw.toLowerCase();
    if (model.includes("sonnet") || model === "sonnet") return "sonnet";
    if (model.includes("opus") || model === "opus") return "opus";
    if (model.includes("haiku") || model === "haiku") return "haiku";
  }
  return "default";
}

export default function ChatView({ workspace, accountInfo, onBack }: Props) {
  const sessions = workspace.sessions;
  const [activeSession, setActiveSession] = useState<DiscoveredSession | null>(
    sessions[0] ?? null
  );
  const [messages, setMessages] = useState<JsonlRecord[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [model, setModel] = useState("default");
  const [effort, setEffort] = useState("default");
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const loadMessages = (filePath: string) => {
    invoke<unknown[]>("get_session_messages", { filePath })
      .then((raw) => setMessages(raw as JsonlRecord[]))
      .catch(console.error);
  };

  useEffect(() => {
    if (!activeSession) return;
    const sessionId = activeSession.id;
    setLoadingMessages(true);
    setLoadingSessionId(sessionId);
    invoke<unknown[]>("get_session_messages", { filePath: activeSession.file_path })
      .then((raw) => {
        const parsed = raw as JsonlRecord[];
        setMessages(parsed);
        setModel(modelFromHistory(parsed));
      })
      .catch(console.error)
      .finally(() => {
        setLoadingMessages(false);
        setLoadingSessionId((current) => (current === sessionId ? null : current));
      });
  }, [activeSession?.file_path]);

  // Stream listener
  useEffect(() => {
    const unlistenStream = listen<string>("claude-stream", (e) => {
      try {
        const rec = JSON.parse(e.payload);
        if (rec.type === "assistant") {
          const content = rec.message?.content;
          const text = Array.isArray(content)
            ? content.filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("")
            : typeof content === "string" ? content : "";
          if (text) setStreamText(text);
        }
      } catch {}
    });
    const unlistenDone = listen("claude-done", () => {
      setStreaming(false);
      setStreamText("");
      if (activeSession) loadMessages(activeSession.file_path);
    });
    const unlistenError = listen<string>("claude-error", (e) => {
      console.error("claude error:", e.payload);
      setStreamText(prev => prev + "\n[error] " + e.payload);
    });
    return () => {
      unlistenStream.then(f => f());
      unlistenDone.then(f => f());
      unlistenError.then(f => f());
    };
  }, [activeSession?.file_path]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || !activeSession || streaming) return;
    setInput("");
    setStreaming(true);
    setStreamText("…");
    invoke("send_message", {
      sessionId: activeSession.id,
      cwd: workspace.decoded_path,
      message: text,
      model,
      effort,
    }).catch((e) => {
      console.error(e);
      setStreaming(false);
      setStreamText("");
    });
  };

  const sessionTitle =
    activeSession?.first_message ??
    (activeSession ? "Session" : "No sessions");
  const email = accountInfo?.email?.trim().toLowerCase() ?? "";
  const userAvatarUrl = email
    ? `https://www.gravatar.com/avatar/${md5(email)}?s=80&d=identicon`
    : "https://www.gravatar.com/avatar/?s=80&d=mp";

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
                  loading={loadingSessionId === s.id}
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
          <MessageList
            messages={messages}
            streamText={streaming ? streamText : ""}
            sessionId={activeSession.id}
            userAvatarUrl={userAvatarUrl}
          />
        )}

        {/* Input area */}
        <Box style={{ borderTop: "1px solid #1f1f23", background: "#0e0e12", flexShrink: 0, padding: "12px 20px" }}>
          {/* Toolbar */}
          <Box style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
            <ModelSelect value={model} onChange={setModel} />
            <EffortSelect value={effort} onChange={setEffort} />
          </Box>
          {/* Textarea row */}
          <Box style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Ask for follow-up changes…"
              rows={2}
              disabled={streaming || loadingMessages}
              style={{
                flex: 1,
                background: "#18181b",
                border: "1px solid #27272a",
                borderRadius: 10,
                padding: "10px 14px",
                color: "#e4e4e7",
                fontSize: 13,
                lineHeight: 1.6,
                resize: "none",
                outline: "none",
                fontFamily: "inherit",
                minHeight: 60,
                maxHeight: 160,
                overflowY: "auto",
                opacity: streaming || loadingMessages ? 0.5 : 1,
              }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = Math.min(el.scrollHeight, 160) + "px";
              }}
            />
            <UnstyledButton
              onClick={handleSend}
              disabled={streaming || loadingMessages || !input.trim()}
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: streaming || loadingMessages || !input.trim() ? "#27272a" : "#f4f4f5",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
                transition: "background 120ms",
              }}
            >
              {streaming ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ color: "#52525b" }}>
                  <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" style={{ color: input.trim() ? "#0c0c0f" : "#52525b" }}>
                  <path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </UnstyledButton>
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
  loading,
  onClick,
}: {
  session: DiscoveredSession;
  active: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <UnstyledButton
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: "calc(100% - 8px)",
        marginLeft: 8,
        padding: "7px 14px 7px 28px",
        borderLeft: active ? "2px solid #FFE100" : "2px solid transparent",
        borderTop: active ? "1px solid #2a2a32" : "1px solid transparent",
        borderRight: active ? "1px solid #2a2a32" : "1px solid transparent",
        borderBottom: active ? "1px solid #2a2a32" : "1px solid transparent",
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
        {loading ? "Loading..." : relativeTime(session.modified_at)}
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

// ── Model / Effort selectors ──────────────────────────────────────────────────

function CompactSelect({ value, onChange, options }: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  const current = options.find(o => o.value === value)?.label ?? value;
  return (
    <Box style={{ position: "relative", display: "inline-block" }}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          appearance: "none",
          background: "#18181b",
          border: "1px solid #27272a",
          borderRadius: 6,
          padding: "3px 22px 3px 8px",
          fontSize: 11,
          fontWeight: 500,
          color: "#a1a1aa",
          cursor: "pointer",
          outline: "none",
          fontFamily: "inherit",
        }}
      >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
        style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: "#52525b" }}>
        <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </Box>
  );
}

function ModelSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <CompactSelect
      value={value}
      onChange={onChange}
      options={[
        { value: "default", label: "Default model" },
        { value: "sonnet", label: "Claude Sonnet" },
        { value: "opus", label: "Claude Opus" },
        { value: "haiku", label: "Claude Haiku" },
      ]}
    />
  );
}

function EffortSelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <CompactSelect
      value={value}
      onChange={onChange}
      options={[
        { value: "default", label: "Auto effort" },
        { value: "low", label: "Low effort" },
        { value: "medium", label: "Medium effort" },
        { value: "high", label: "High effort" },
      ]}
    />
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
