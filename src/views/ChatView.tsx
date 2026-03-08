import { useState, useEffect, useRef, useMemo } from "react";
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
  mainHeader?: React.ReactNode;
}
const FAVICON_STORAGE_KEY = "claudy.workspaceFavicons";

interface SlashCommandOption {
  name: string;
  description?: string;
  argument_hint?: string;
  source: string;
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

function findActiveTrigger(value: string, caret: number) {
  const beforeCaret = value.slice(0, caret);
  const match = beforeCaret.match(/(^|\s)([@/])([^\s@/]*)$/);
  if (!match) return null;
  const query = match[3] ?? "";
  return {
    trigger: match[2] === "@" ? "file" as const : "command" as const,
    query,
    start: beforeCaret.length - query.length - 1,
    end: caret,
  };
}

export default function ChatView({ workspace, accountInfo, onBack, mainHeader }: Props) {
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
  const [projectIcon, setProjectIcon] = useState<string | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  const [slashCommands, setSlashCommands] = useState<SlashCommandOption[]>([]);
  const [selectedFileRefs, setSelectedFileRefs] = useState<string[]>([]);
  const [autocompleteMode, setAutocompleteMode] = useState<"file" | "command" | null>(null);
  const [autocompleteQuery, setAutocompleteQuery] = useState("");
  const [autocompleteOpen, setAutocompleteOpen] = useState(false);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [autocompleteRange, setAutocompleteRange] = useState<{ start: number; end: number } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const fileSuggestions = useMemo(() => {
    const normalized = autocompleteQuery.trim().toLowerCase();
    const pool = workspaceFiles.filter((file) => !selectedFileRefs.includes(file));
    const ranked = normalized
      ? pool.filter((file) => file.toLowerCase().includes(normalized))
      : pool;
    return ranked.slice(0, 8);
  }, [autocompleteQuery, selectedFileRefs, workspaceFiles]);

  const commandSuggestions = useMemo(() => {
    const normalized = autocompleteQuery.trim().toLowerCase();
    const deduped = Array.from(new Map(slashCommands.map((command) => [command.name, command])).values());
    const ranked = normalized
      ? deduped.filter((command) => (
          command.name.toLowerCase().includes(normalized)
          || command.description?.toLowerCase().includes(normalized)
        ))
      : deduped;
    return ranked.slice(0, 8);
  }, [autocompleteQuery, slashCommands]);

  const activeSuggestions = autocompleteMode === "command" ? commandSuggestions : fileSuggestions;

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

  useEffect(() => {
    let cancelled = false;
    setWorkspaceFiles([]);
    setSlashCommands([]);
    setSelectedFileRefs([]);
    setAutocompleteMode(null);
    setAutocompleteQuery("");
    setAutocompleteOpen(false);
    setAutocompleteIndex(0);
    setAutocompleteRange(null);

    invoke<string[]>("get_workspace_files", {
      workspacePath: workspace.decoded_path,
    })
      .then((files) => {
        if (!cancelled) setWorkspaceFiles(files);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceFiles([]);
      });

    invoke<SlashCommandOption[]>("get_workspace_slash_commands", {
      workspacePath: workspace.decoded_path,
    })
      .then((commands) => {
        if (!cancelled) setSlashCommands(commands);
      })
      .catch(() => {
        if (!cancelled) setSlashCommands([]);
      });

    return () => {
      cancelled = true;
    };
  }, [workspace.decoded_path]);

  useEffect(() => {
    let cancelled = false;
    const key = workspace.encoded_name;
    try {
      const raw = window.localStorage.getItem(FAVICON_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, string | null>;
        if (Object.prototype.hasOwnProperty.call(parsed, key)) {
          setProjectIcon(parsed[key] ?? null);
          return;
        }
      }
    } catch {
      // Ignore malformed cache values.
    }

    invoke<string | null>("get_workspace_favicon", {
      workspacePath: workspace.decoded_path,
    })
      .then((icon) => {
        if (cancelled) return;
        const value = icon ?? null;
        setProjectIcon(value);
        try {
          const raw = window.localStorage.getItem(FAVICON_STORAGE_KEY);
          const parsed = raw ? (JSON.parse(raw) as Record<string, string | null>) : {};
          parsed[key] = value;
          window.localStorage.setItem(FAVICON_STORAGE_KEY, JSON.stringify(parsed));
        } catch {
          // Ignore storage errors.
        }
      })
      .catch(() => {
        if (!cancelled) setProjectIcon(null);
      });

    return () => {
      cancelled = true;
    };
  }, [workspace.encoded_name, workspace.decoded_path]);

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

  useEffect(() => {
    if (!activeSuggestions.length) {
      setAutocompleteIndex(0);
      if (autocompleteOpen) setAutocompleteOpen(false);
      return;
    }
    setAutocompleteIndex((current) => Math.min(current, activeSuggestions.length - 1));
  }, [activeSuggestions.length, autocompleteOpen]);

  const syncAutocompleteState = (value: string, caret: number) => {
    const activeTrigger = findActiveTrigger(value, caret);
    if (!activeTrigger) {
      setAutocompleteMode(null);
      setAutocompleteQuery("");
      setAutocompleteOpen(false);
      setAutocompleteIndex(0);
      setAutocompleteRange(null);
      return;
    }
    setAutocompleteMode(activeTrigger.trigger);
    setAutocompleteQuery(activeTrigger.query);
    setAutocompleteOpen(true);
    setAutocompleteRange({ start: activeTrigger.start, end: activeTrigger.end });
  };

  const insertFileReference = (filePath: string) => {
    setSelectedFileRefs((current) => (
      current.includes(filePath) ? current : [...current, filePath]
    ));
    setInput((current) => {
      if (!autocompleteRange) return current;
      return `${current.slice(0, autocompleteRange.start)}${current.slice(autocompleteRange.end)}`;
    });
    setAutocompleteMode(null);
    setAutocompleteQuery("");
    setAutocompleteOpen(false);
    setAutocompleteIndex(0);
    setAutocompleteRange(null);

    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const nextCaret = autocompleteRange ? autocompleteRange.start : textarea.value.length;
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
    });
  };

  const insertSlashCommand = (command: SlashCommandOption) => {
    const insertion = `/${command.name} `;
    setInput((current) => {
      if (!autocompleteRange) return `${current}${insertion}`;
      return `${current.slice(0, autocompleteRange.start)}${insertion}${current.slice(autocompleteRange.end)}`;
    });
    setAutocompleteMode(null);
    setAutocompleteQuery("");
    setAutocompleteOpen(false);
    setAutocompleteIndex(0);
    setAutocompleteRange(null);

    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const nextCaret = (autocompleteRange ? autocompleteRange.start : textarea.value.length) + insertion.length;
      textarea.focus();
      textarea.setSelectionRange(nextCaret, nextCaret);
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
    });
  };

  const handleSend = () => {
    const text = input.trim();
    if ((!text && selectedFileRefs.length === 0) || !activeSession || streaming) return;
    const message = selectedFileRefs.length
      ? `${selectedFileRefs.map((file) => `@${file}`).join("\n")}${text ? `\n\n${text}` : ""}`
      : text;
    setInput("");
    setSelectedFileRefs([]);
    setAutocompleteMode(null);
    setAutocompleteQuery("");
    setAutocompleteOpen(false);
    setAutocompleteIndex(0);
    setAutocompleteRange(null);
    setStreaming(true);
    setStreamText("…");
    invoke("send_message", {
      sessionId: activeSession.id,
      cwd: workspace.decoded_path,
      message,
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
            {projectIcon ? (
              <Box
                component="img"
                src={projectIcon}
                alt={`${workspace.display_name} icon`}
                style={{
                  width: 14,
                  height: 14,
                  objectFit: "contain",
                  borderRadius: 3,
                  flexShrink: 0,
                }}
              />
            ) : (
              <FolderIcon />
            )}
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
        {mainHeader}
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
          <Box style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Box style={{ flex: 1, position: "relative" }}>
              <Box
                style={{
                  background: "#18181b",
                  border: "1px solid #27272a",
                  borderRadius: 10,
                  padding: "10px 14px",
                  opacity: streaming || loadingMessages ? 0.5 : 1,
                }}
              >
                {selectedFileRefs.length > 0 ? (
                  <Box style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                    {selectedFileRefs.map((file) => (
                      <Box
                        key={file}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 8,
                          maxWidth: "100%",
                          background: "#111115",
                          border: "1px solid #30303a",
                          borderRadius: 999,
                          padding: "5px 10px",
                        }}
                      >
                        <Text size="xs" c="#e4e4e7" style={{ lineHeight: 1.2 }}>
                          {file}
                        </Text>
                        <UnstyledButton
                          onClick={() => setSelectedFileRefs((current) => current.filter((item) => item !== file))}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 14,
                            height: 14,
                            color: "#a1a1aa",
                            flexShrink: 0,
                          }}
                        >
                          <CloseIcon />
                        </UnstyledButton>
                      </Box>
                    ))}
                  </Box>
                ) : null}
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    syncAutocompleteState(e.target.value, e.target.selectionStart ?? e.target.value.length);
                  }}
                  onClick={(e) => syncAutocompleteState(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
                  onKeyUp={(e) => syncAutocompleteState(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length)}
                  onKeyDown={(e) => {
                    if (autocompleteOpen && activeSuggestions.length > 0) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setAutocompleteIndex((current) => (current + 1) % activeSuggestions.length);
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setAutocompleteIndex((current) => (
                          current === 0 ? activeSuggestions.length - 1 : current - 1
                        ));
                        return;
                      }
                      if (e.key === "Enter" || e.key === "Tab") {
                        e.preventDefault();
                        if (autocompleteMode === "command") {
                          insertSlashCommand(commandSuggestions[autocompleteIndex]);
                          return;
                        }
                        insertFileReference(fileSuggestions[autocompleteIndex]);
                        return;
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setAutocompleteOpen(false);
                        return;
                      }
                    }

                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  placeholder="Ask for follow-up changes…"
                  rows={2}
                  disabled={streaming || loadingMessages}
                  style={{
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    color: "#e4e4e7",
                    fontSize: 13,
                    lineHeight: 1.6,
                    resize: "none",
                    outline: "none",
                    fontFamily: "inherit",
                    minHeight: 60,
                    maxHeight: 160,
                    overflowY: "auto",
                  }}
                  onInput={(e) => {
                    const el = e.currentTarget;
                    el.style.height = "auto";
                    el.style.height = Math.min(el.scrollHeight, 160) + "px";
                  }}
                />
              </Box>
              {autocompleteOpen && activeSuggestions.length > 0 ? (
                <Box
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: "calc(100% + 8px)",
                    background: "#111115",
                    border: "1px solid #27272a",
                    borderRadius: 10,
                    boxShadow: "0 12px 30px rgba(0, 0, 0, 0.35)",
                    overflow: "hidden",
                    zIndex: 20,
                  }}
                >
                  {(autocompleteMode === "command" ? commandSuggestions : fileSuggestions).map((item, index) => (
                    <UnstyledButton
                      key={autocompleteMode === "command" ? (item as SlashCommandOption).name : (item as string)}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        if (autocompleteMode === "command") {
                          insertSlashCommand(item as SlashCommandOption);
                          return;
                        }
                        insertFileReference(item as string);
                      }}
                      style={{
                        width: "100%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 12,
                        padding: "10px 12px",
                        background: index === autocompleteIndex ? "#1d1d24" : "transparent",
                        borderLeft: index === autocompleteIndex ? "2px solid #FFE100" : "2px solid transparent",
                      }}
                    >
                      <Box style={{ minWidth: 0 }}>
                        <Text size="sm" c="#e4e4e7" style={{ minWidth: 0 }}>
                          {autocompleteMode === "command" ? `/${(item as SlashCommandOption).name}` : (item as string)}
                        </Text>
                        {autocompleteMode === "command" && (item as SlashCommandOption).description ? (
                          <Text size="xs" c="#71717a" style={{ minWidth: 0, marginTop: 2 }}>
                            {(item as SlashCommandOption).description}
                          </Text>
                        ) : null}
                      </Box>
                      <Text size="xs" c="#71717a" style={{ flexShrink: 0 }}>
                        {autocompleteMode === "command" ? (item as SlashCommandOption).source : "File"}
                      </Text>
                    </UnstyledButton>
                  ))}
                </Box>
              ) : null}
            </Box>
            <UnstyledButton
              onClick={handleSend}
              disabled={streaming || loadingMessages || (!input.trim() && selectedFileRefs.length === 0)}
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: streaming || loadingMessages || (!input.trim() && selectedFileRefs.length === 0) ? "#27272a" : "#f4f4f5",
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
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  style={{ color: input.trim() || selectedFileRefs.length > 0 ? "#0c0c0f" : "#52525b" }}
                >
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

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
