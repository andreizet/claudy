import { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, ScrollArea, UnstyledButton, Group, Skeleton, Tooltip } from "@mantine/core";
import {
  Check,
  ChevronDown,
  ChevronLeft as ChevronLeftIcon,
  Cog,
  Eye,
  Folder,
  LoaderCircle,
  Pen,
  Pin,
  Plus,
  Send,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ClaudeAccountInfo, ContentBlock, ContentBlockToolUse, DiscoveredWorkspace, DiscoveredSession, JsonlRecord } from "../types";
import MessageList from "../components/chat/MessageList";
import FileReferenceBadge from "../components/chat/FileReferenceBadge";
import { md5 } from "../shared/md5";
import { loadAppSettings } from "../shared/settings";
import {
  extractMcpServers,
  loadDefaultToolPolicy,
  loadSessionToolPolicy,
  loadToolInventoryCache,
  PersistedToolPolicy,
  saveDefaultToolPolicy,
  saveSessionToolPolicy,
  saveToolInventoryCache,
  SessionToolState,
  splitToolsBySource,
} from "../shared/toolPolicy";

const IS_MACOS = /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

interface Props {
  workspace: DiscoveredWorkspace;
  accountInfo: ClaudeAccountInfo | null;
  onBack: () => void;
  mainHeader?: React.ReactNode;
  onSessionTitleChange?: (title: string | null) => void;
  onWorkspaceChange?: (workspace: DiscoveredWorkspace) => void;
  selectedSessionId?: string | null;
  onActiveSessionChange?: (sessionId: string | null) => void;
}
const FAVICON_STORAGE_KEY = "claudy.workspaceFavicons";
const PINNED_SESSION_STORAGE_KEY = "claudy.pinnedSessions";
const SESSION_NAME_STORAGE_KEY = "claudy.sessionNames";
const BUILTIN_SLASH_COMMANDS: SlashCommandOption[] = [
  { name: "add-dir", description: "Add additional working directories.", source: "builtin", kind: "command" },
  { name: "agents", description: "Manage custom AI subagents.", source: "builtin", kind: "command" },
  { name: "bug", description: "Report bugs to Anthropic.", source: "builtin", kind: "command" },
  { name: "clear", description: "Clear conversation history.", source: "builtin", kind: "command" },
  { name: "compact", description: "Compact conversation with optional focus instructions.", argument_hint: "[instructions]", source: "builtin", kind: "command" },
  { name: "config", description: "View or modify Claude Code configuration.", source: "builtin", kind: "command" },
  { name: "cost", description: "Show token usage statistics.", source: "builtin", kind: "command" },
  { name: "doctor", description: "Check Claude Code installation health.", source: "builtin", kind: "command" },
  { name: "help", description: "Show usage help.", source: "builtin", kind: "command" },
  { name: "init", description: "Initialize project guidance with CLAUDE.md.", source: "builtin", kind: "command" },
  { name: "login", description: "Switch Anthropic accounts.", source: "builtin", kind: "command" },
  { name: "logout", description: "Sign out from your Anthropic account.", source: "builtin", kind: "command" },
  { name: "mcp", description: "Manage MCP server connections and OAuth auth.", source: "builtin", kind: "command" },
  { name: "memory", description: "Edit CLAUDE.md memory files.", source: "builtin", kind: "command" },
  { name: "model", description: "Select or change the AI model.", source: "builtin", kind: "command" },
  { name: "permissions", description: "View or update permissions.", source: "builtin", kind: "command" },
  { name: "pr_comments", description: "View pull request comments.", source: "builtin", kind: "command" },
  { name: "review", description: "Run a code review flow.", source: "builtin", kind: "command" },
  { name: "status", description: "Show session and environment status.", source: "builtin", kind: "command" },
  { name: "terminal-setup", description: "Install terminal key bindings and shell integration.", source: "builtin", kind: "command" },
  { name: "vim", description: "Toggle or configure Vim mode.", source: "builtin", kind: "command" },
];

interface SlashCommandOption {
  name: string;
  description?: string;
  argument_hint?: string;
  source: string;
  kind: "command" | "skill";
}

interface InteractiveEventPayload {
  session_id: string;
  data: string;
}

interface PendingSendContext {
  message: string;
  sessionId: string | null;
  allowedTools?: string[];
}

type SessionActivityState = "generating" | "completed";

interface ClaudeSessionInit {
  session_id: string | null;
  cwd: string | null;
  model: string | null;
  tools: string[];
  mcp_servers: unknown;
}

interface ClaudeMdDocument {
  exists: boolean;
  content: string;
}

type SessionSettingsTabKey = "settings" | "claude-md";
type ClaudeMdViewMode = "edit" | "preview";

function ensureStreamTextBlock(blocks: ContentBlock[], index: number): ContentBlock[] {
  const next = blocks.slice();
  if (!next[index] || next[index].type !== "text") {
    next[index] = { type: "text", text: "" };
  }
  return next;
}

function appendStreamTextDelta(blocks: ContentBlock[], index: number, text: string): ContentBlock[] {
  const next = ensureStreamTextBlock(blocks, index);
  const block = next[index];
  if (block.type !== "text") return next;
  next[index] = { ...block, text: block.text + text };
  return next;
}

function appendThinkingDelta(blocks: ContentBlock[], index: number, thinking: string): ContentBlock[] {
  const next = blocks.slice();
  const existing = next[index];
  if (!existing || existing.type !== "thinking") {
    next[index] = { type: "thinking", thinking };
    return next;
  }
  next[index] = { ...existing, thinking: `${existing.thinking}${thinking}` };
  return next;
}

function removeStreamBlock(blocks: ContentBlock[], index: number): ContentBlock[] {
  const next = blocks.slice();
  next.splice(index, 1);
  return next;
}

function updateStreamToolInputDelta(blocks: ContentBlock[], index: number, partialJson: string): ContentBlock[] {
  const next = blocks.slice();
  const block = next[index];
  if (!block || block.type !== "tool_use") return next;
  try {
    next[index] = {
      ...block,
      input: JSON.parse(partialJson) as Record<string, unknown>,
    };
  } catch {
    return next;
  }
  return next;
}

function mergeStreamBlocks(current: ContentBlock[], incoming: ContentBlock[]): ContentBlock[] {
  if (incoming.length === 0) return current;
  const next = current.slice();
  incoming.forEach((block, index) => {
    next[index] = block;
  });
  return next;
}

function shortenPath(fullPath: string): string {
  const home = fullPath.match(/^\/(?:Users|home)\/[^/]+/)?.[0];
  if (home) return "~" + fullPath.slice(home.length);
  return fullPath;
}

function projectColorFor(name: string): string {
  const colors = ["#2a3f5c", "#1e4d3a", "#4d2a2a", "#352a4d", "#4d3b1e", "#1e3d4d"];
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = name.charCodeAt(index) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}

function projectInitials(name: string): string {
  const words = name.split(/[-_.\s]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
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

export default function ChatView({
  workspace,
  accountInfo,
  onBack,
  mainHeader,
  onSessionTitleChange,
  onWorkspaceChange,
  selectedSessionId,
  onActiveSessionChange,
}: Props) {
  const queryClient = useQueryClient();
  const [sessionItems, setSessionItems] = useState<DiscoveredSession[]>(workspace.sessions);
  const [activeSession, setActiveSession] = useState<DiscoveredSession | null>(workspace.sessions[0] ?? null);
  const [pinnedSessionId, setPinnedSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<JsonlRecord[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [pendingUserMessage, setPendingUserMessage] = useState("");
  const [model, setModel] = useState("default");
  const [effort, setEffort] = useState("default");
  const [streaming, setStreaming] = useState(false);
  const [streamMessages, setStreamMessages] = useState<JsonlRecord[]>([]);
  const [streamBlocks, setStreamBlocks] = useState<ContentBlock[]>([]);
  const [projectIcon, setProjectIcon] = useState<string | null>(null);
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([]);
  const [slashCommands, setSlashCommands] = useState<SlashCommandOption[]>([]);
  const [selectedFileRefs, setSelectedFileRefs] = useState<string[]>([]);
  const [selectedImages, setSelectedImages] = useState<{ name: string; path: string }[]>([]);
  const [autocompleteMode, setAutocompleteMode] = useState<"file" | "command" | null>(null);
  const [autocompleteQuery, setAutocompleteQuery] = useState("");
  const [autocompleteOpen, setAutocompleteOpen] = useState(false);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [autocompleteRange, setAutocompleteRange] = useState<{ start: number; end: number } | null>(null);
  const deferredAutocompleteQuery = useDeferredValue(autocompleteQuery);
  const [interactiveSessionId, setInteractiveSessionId] = useState<string | null>(null);
  const [interactiveVisible, setInteractiveVisible] = useState(false);
  const [interactiveOutput, setInteractiveOutput] = useState("");
  const [interactiveStarting, setInteractiveStarting] = useState(false);
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null);
  const [creatingInitialSession, setCreatingInitialSession] = useState(false);
  const [sessionToolState, setSessionToolState] = useState<SessionToolState | null>(null);
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false);
  const [sessionSettingsSnapshot, setSessionSettingsSnapshot] = useState<SessionToolState | null>(null);
  const [sessionSettingsTab, setSessionSettingsTab] = useState<SessionSettingsTabKey>("settings");
  const [claudeMdContent, setClaudeMdContent] = useState("");
  const [claudeMdExists, setClaudeMdExists] = useState(false);
  const [claudeMdLoading, setClaudeMdLoading] = useState(false);
  const [claudeMdLoadError, setClaudeMdLoadError] = useState<string | null>(null);
  const [claudeMdViewMode, setClaudeMdViewMode] = useState<ClaudeMdViewMode>("edit");
  const [savingSessionSettings, setSavingSessionSettings] = useState(false);
  const [mcpGroupsExpanded, setMcpGroupsExpanded] = useState(false);
  const [initializingNewSession, setInitializingNewSession] = useState(false);
  const [loadingSessionSettings, setLoadingSessionSettings] = useState(false);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [sessionActivityById, setSessionActivityById] = useState<Record<string, SessionActivityState>>({});
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const interactiveWrittenLengthRef = useRef(0);
  const activeSessionRef = useRef<DiscoveredSession | null>(activeSession);
  const creatingInitialSessionRef = useRef(creatingInitialSession);
  const pendingSendRef = useRef<PendingSendContext | null>(null);
  const streamBlocksRef = useRef<ContentBlock[]>([]);
  const configuringSession = !activeSession && initializingNewSession;

  useEffect(() => {
    streamBlocksRef.current = streamBlocks;
  }, [streamBlocks]);

  useEffect(() => {
    activeSessionRef.current = activeSession;
  }, [activeSession]);

  useEffect(() => {
    creatingInitialSessionRef.current = creatingInitialSession;
  }, [creatingInitialSession]);

  const loadSessionNames = () => {
    try {
      const raw = window.localStorage.getItem(SESSION_NAME_STORAGE_KEY);
      if (!raw) return {} as Record<string, string>;
      const parsed = JSON.parse(raw) as Record<string, Record<string, string>>;
      return parsed[workspace.encoded_name] ?? {};
    } catch {
      return {} as Record<string, string>;
    }
  };

  const persistSessionName = (sessionId: string, name: string | null) => {
    try {
      const raw = window.localStorage.getItem(SESSION_NAME_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as Record<string, Record<string, string>>) : {};
      const nextWorkspaceNames = { ...(parsed[workspace.encoded_name] ?? {}) };
      if (name && name.trim()) nextWorkspaceNames[sessionId] = name.trim();
      else delete nextWorkspaceNames[sessionId];
      parsed[workspace.encoded_name] = nextWorkspaceNames;
      window.localStorage.setItem(SESSION_NAME_STORAGE_KEY, JSON.stringify(parsed));
    } catch {
      // Ignore storage errors.
    }
  };

  const getSessionDisplayTitle = (session: DiscoveredSession | null) => {
    if (!session) return "No sessions";
    const customNames = loadSessionNames();
    return customNames[session.id]?.trim() || session.first_message || "Empty session";
  };

  const loadPersistedToolPolicy = (sessionId?: string | null) => {
    return loadSessionToolPolicy(sessionId ?? null) ?? loadDefaultToolPolicy();
  };

  const buildSessionToolState = ({
    sessionId,
    model,
    cwd,
    availableTools,
    mcpServers,
    preferredTools,
  }: {
    sessionId: string | null;
    model: string | null;
    cwd: string | null;
    availableTools: string[];
    mcpServers: string[];
    preferredTools?: string[] | null;
  }): SessionToolState => {
    const selectedTools = preferredTools
      ? availableTools.filter((tool) => preferredTools.includes(tool))
      : availableTools;
    return {
      sessionId,
      model,
      cwd,
      availableTools,
      selectedTools,
      mcpServers,
    };
  };

  const applySessionInit = (init: ClaudeSessionInit) => {
    const tools = Array.isArray(init.tools) ? init.tools : [];
    const mcpServers = extractMcpServers(init.mcp_servers);
    saveToolInventoryCache({
      availableTools: tools,
      mcpServers,
      workspacePath: workspace.decoded_path,
    });
    const persistedPolicy = loadPersistedToolPolicy(init.session_id);
    setSessionToolState(buildSessionToolState({
      sessionId: init.session_id,
      model: init.model,
      cwd: init.cwd ?? workspace.decoded_path,
      availableTools: tools,
      mcpServers,
      preferredTools: pendingSendRef.current?.allowedTools ?? persistedPolicy?.selectedTools ?? null,
    }));
  };

  const fetchSessionSettings = async (sessionId?: string | null) => {
    setLoadingSessionSettings(true);
    try {
      const cachedInventory = loadToolInventoryCache();
      if (cachedInventory) {
        const persistedPolicy = loadPersistedToolPolicy(sessionId ?? activeSession?.id ?? null);
        setSessionToolState(buildSessionToolState({
          sessionId: sessionId ?? activeSession?.id ?? null,
          model: sessionToolState?.model ?? null,
          cwd: workspace.decoded_path,
          availableTools: cachedInventory.availableTools,
          mcpServers: cachedInventory.mcpServers,
          preferredTools: persistedPolicy?.selectedTools ?? null,
        }));
        return;
      }
      const init = await invoke<ClaudeSessionInit>("get_claude_session_init", {
        workspacePath: workspace.decoded_path,
      });
      applySessionInit(init);
    } catch (error) {
      console.error(error);
    } finally {
      setLoadingSessionSettings(false);
    }
  };

  const persistPinnedSession = (sessionId: string | null) => {
    setPinnedSessionId(sessionId);
    try {
      const raw = window.localStorage.getItem(PINNED_SESSION_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as Record<string, string | null>) : {};
      parsed[workspace.encoded_name] = sessionId;
      window.localStorage.setItem(PINNED_SESSION_STORAGE_KEY, JSON.stringify(parsed));
    } catch {
      // Ignore storage errors.
    }
  };

  const handlePinSession = (session: DiscoveredSession) => {
    persistPinnedSession(pinnedSessionId === session.id ? null : session.id);
  };

  const clearCompletedSessionActivity = (sessionId: string) => {
    setSessionActivityById((current) => {
      if (current[sessionId] !== "completed") return current;
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  };

  const publishWorkspaceSessions = (sessions: DiscoveredSession[]) => {
    onWorkspaceChange?.({
      ...workspace,
      sessions,
    });
  };

  const updateSessionItems = (updater: (current: DiscoveredSession[]) => DiscoveredSession[]) => {
    setSessionItems((current) => {
      const next = updater(current);
      publishWorkspaceSessions(next);
      return next;
    });
  };

  const mergeSessionItem = (session: DiscoveredSession) => {
    let mergedSession = session;
    updateSessionItems((current) => {
      const index = current.findIndex((item) => item.id === session.id);
      const next = current.slice();
      if (index >= 0) {
        mergedSession = {
          ...next[index],
          ...session,
        };
        next[index] = mergedSession;
      } else {
        mergedSession = session;
        next.unshift(mergedSession);
      }
      next.sort((a, b) => Number(b.modified_at || 0) - Number(a.modified_at || 0));
      return next;
    });
    return mergedSession;
  };

  const handleStartNewSession = () => {
    setActiveSession(null);
    setMessages([]);
    setLoadingMessages(false);
    setLoadingSessionId(null);
    setInput("");
    setStreamMessages([]);
    setStreamBlocks([]);
    setStreaming(false);
    setSessionToolState(null);
    setSessionSettingsOpen(false);
    setMcpGroupsExpanded(false);
    setInitializingNewSession(true);
  };

  const handleDeleteSession = async (session: DiscoveredSession) => {
    try {
      await invoke("delete_session_file", { filePath: session.file_path });
      let nextSessions: DiscoveredSession[] = [];
      updateSessionItems((current) => {
        nextSessions = current.filter((item) => item.id !== session.id);
        return nextSessions;
      });
      if (pinnedSessionId === session.id) {
        persistPinnedSession(null);
      }
      setActiveSession((current) => {
        if (current?.id !== session.id) return current;
        const nextPinnedId = pinnedSessionId === session.id ? null : pinnedSessionId;
        const pinnedRemaining = nextPinnedId
          ? nextSessions.find((item) => item.id === nextPinnedId) ?? null
          : null;
        const nextActive = pinnedRemaining ?? nextSessions[0] ?? null;
        onActiveSessionChange?.(nextActive?.id ?? null);
        return nextActive;
      });
      setSessionActivityById((current) => {
        if (!current[session.id]) return current;
        const next = { ...current };
        delete next[session.id];
        return next;
      });
      queryClient.invalidateQueries({ queryKey: ["existing-sessions"] }).catch(console.error);
    } catch (error) {
      console.error(error);
      window.alert("Failed to delete session.");
    }
  };

  const requestDeleteSession = (session: DiscoveredSession) => {
    setPendingDeleteSessionId(session.id);
  };

  const cancelDeleteSession = () => {
    setPendingDeleteSessionId(null);
  };

  const confirmDeleteSession = async () => {
    const session = sessionItems.find((item) => item.id === pendingDeleteSessionId);
    if (!session) {
      setPendingDeleteSessionId(null);
      return;
    }
    setPendingDeleteSessionId(null);
    await handleDeleteSession(session);
  };

  useEffect(() => {
    const sessions = workspace.sessions;
    setSessionItems(sessions);
    let pinnedId: string | null = null;
    try {
      const raw = window.localStorage.getItem(PINNED_SESSION_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, string | null>;
        pinnedId = parsed[workspace.encoded_name] ?? null;
      }
    } catch {
      // Ignore malformed storage.
    }
    setPinnedSessionId(pinnedId);
    const pinnedSession = pinnedId ? sessions.find((session) => session.id === pinnedId) ?? null : null;
    const explicitSession = selectedSessionId
      ? sessions.find((session) => session.id === selectedSessionId) ?? null
      : null;
    setActiveSession(explicitSession ?? pinnedSession ?? sessions[0] ?? null);
    const persistedPolicy = loadPersistedToolPolicy();
    const cachedInventory = loadToolInventoryCache();
    const selectedSession = explicitSession ?? pinnedSession ?? sessions[0] ?? null;
    setSessionToolState(
      persistedPolicy || cachedInventory
        ? {
            sessionId: selectedSession?.id ?? null,
            model: null,
            cwd: workspace.decoded_path,
            availableTools: cachedInventory?.availableTools ?? persistedPolicy?.availableTools ?? persistedPolicy?.selectedTools ?? [],
            selectedTools: (() => {
              const availableTools = cachedInventory?.availableTools ?? persistedPolicy?.availableTools ?? persistedPolicy?.selectedTools ?? [];
              const preferredTools = loadPersistedToolPolicy(selectedSession?.id)?.selectedTools ?? persistedPolicy?.selectedTools ?? [];
              return availableTools.filter((tool) => preferredTools.includes(tool));
            })(),
            mcpServers: cachedInventory?.mcpServers ?? persistedPolicy?.mcpServers ?? [],
          }
        : null
    );
    setSessionSettingsOpen(false);
    setMcpGroupsExpanded(false);
    setInitializingNewSession(sessions.length === 0);
    setLoadingSessionSettings(false);
    setSessionActivityById((current) => {
      const validSessionIds = new Set(sessions.map((session) => session.id));
      const nextEntries = Object.entries(current).filter(([sessionId]) => validSessionIds.has(sessionId));
      return nextEntries.length === Object.keys(current).length ? current : Object.fromEntries(nextEntries);
    });
  }, [selectedSessionId, workspace.encoded_name, workspace.sessions]);

  const activeSessionDisplayTitle = activeSession ? getSessionDisplayTitle(activeSession) : null;

  useEffect(() => {
    onSessionTitleChange?.(activeSessionDisplayTitle);
  }, [activeSessionDisplayTitle, onSessionTitleChange]);

  useEffect(() => {
    if (activeSession || !initializingNewSession) return;
    let cancelled = false;

    setLoadingSessionSettings(true);
    invoke<ClaudeSessionInit>("get_claude_session_init", {
      workspacePath: workspace.decoded_path,
    })
      .then((init) => {
        if (cancelled) return;
        applySessionInit(init);
      })
      .catch((error) => {
        if (!cancelled) {
          console.error(error);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingSessionSettings(false);
          setInitializingNewSession(false);
          setSessionSettingsOpen(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeSession, initializingNewSession, workspace.decoded_path]);

  useEffect(() => {
    if (!sessionSettingsOpen) return;
    let cancelled = false;

    setClaudeMdLoading(true);
    setClaudeMdLoadError(null);

    invoke<ClaudeMdDocument>("get_workspace_claude_md", {
      workspacePath: workspace.decoded_path,
    })
      .then((document) => {
        if (cancelled) return;
        setClaudeMdExists(document.exists === true);
        setClaudeMdContent(typeof document.content === "string" ? document.content : "");
      })
      .catch((error) => {
        if (cancelled) return;
        console.error(error);
        setClaudeMdExists(false);
        setClaudeMdContent("");
        setClaudeMdLoadError("Unable to load CLAUDE.md.");
      })
      .finally(() => {
        if (!cancelled) {
          setClaudeMdLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sessionSettingsOpen, workspace.decoded_path]);

  useEffect(() => {
    if (!activeSession || sessionToolState || loadingSessionSettings || initializingNewSession) return;
    void fetchSessionSettings(activeSession.id);
  }, [activeSession, initializingNewSession, loadingSessionSettings, sessionToolState]);

  const fileSuggestions = useMemo(() => {
    const normalized = deferredAutocompleteQuery.trim().toLowerCase();
    const pool = workspaceFiles.filter((file) => !selectedFileRefs.includes(file));
    const ranked = normalized
      ? pool.filter((file) => file.toLowerCase().includes(normalized))
      : pool;
    return ranked.slice(0, 8);
  }, [deferredAutocompleteQuery, selectedFileRefs, workspaceFiles]);

  const commandSuggestions = useMemo(() => {
    const normalized = deferredAutocompleteQuery.trim().toLowerCase();
    const deduped = Array.from(
      new Map([...BUILTIN_SLASH_COMMANDS, ...slashCommands].map((command) => [command.name, command])).values()
    );
    const ranked = normalized
      ? deduped.filter((command) => (
          command.name.toLowerCase().includes(normalized)
          || command.description?.toLowerCase().includes(normalized)
        ))
      : deduped;
    return ranked.slice(0, 8);
  }, [deferredAutocompleteQuery, slashCommands]);
  const availableSlashCommands = useMemo(
    () => Array.from(new Map([...BUILTIN_SLASH_COMMANDS, ...slashCommands].map((command) => [command.name, command])).values()),
    [slashCommands]
  );
  const slashCommandKindByName = useMemo(
    () => new Map(availableSlashCommands.map((command) => [command.name, command.kind])),
    [availableSlashCommands]
  );

  const activeSuggestions = autocompleteMode === "command" ? commandSuggestions : fileSuggestions;

  useEffect(() => {
    const cachedInventory = loadToolInventoryCache();
    if (!cachedInventory || !activeSession) return;
    const persistedPolicy = loadPersistedToolPolicy(activeSession.id);
    setSessionToolState((current) => {
      if (current?.sessionId === activeSession.id && current.availableTools.join("|") === cachedInventory.availableTools.join("|")) {
        return current;
      }
      return buildSessionToolState({
        sessionId: activeSession.id,
        model: current?.model ?? null,
        cwd: workspace.decoded_path,
        availableTools: cachedInventory.availableTools,
        mcpServers: cachedInventory.mcpServers,
        preferredTools: persistedPolicy?.selectedTools ?? null,
      });
    });
  }, [activeSession?.id, workspace.decoded_path]);

  const openSessionSettings = () => {
    setSessionSettingsSnapshot(sessionToolState ? { ...sessionToolState, selectedTools: [...sessionToolState.selectedTools], availableTools: [...sessionToolState.availableTools], mcpServers: [...sessionToolState.mcpServers] } : null);
    setSessionSettingsTab("settings");
    setClaudeMdViewMode("edit");
    setSessionSettingsOpen(true);
    if (!sessionToolState && !loadingSessionSettings) {
      void fetchSessionSettings(activeSession?.id ?? null);
    }
  };

  const closeSessionSettings = () => {
    setSessionSettingsOpen(false);
    setSessionSettingsSnapshot(null);
    setSavingSessionSettings(false);
  };

  const cancelSessionSettings = () => {
    if (sessionSettingsSnapshot) {
      setSessionToolState(sessionSettingsSnapshot);
    }
    closeSessionSettings();
  };

  const saveSessionSettings = async () => {
    setSavingSessionSettings(true);
    try {
      if (sessionToolState && activeSession?.id) {
        saveSessionToolPolicy(activeSession.id, {
          selectedTools: sessionToolState.selectedTools,
          availableTools: sessionToolState.availableTools,
          mcpServers: sessionToolState.mcpServers,
        });
      }

      if (claudeMdLoadError === null && (claudeMdExists || claudeMdContent.trim().length > 0)) {
        await invoke("save_workspace_claude_md", {
          workspacePath: workspace.decoded_path,
          content: claudeMdContent,
        });
        setClaudeMdExists(true);
      }

      closeSessionSettings();
    } catch (error) {
      console.error(error);
      window.alert("Failed to save session settings.");
    } finally {
      setSavingSessionSettings(false);
    }
  };

  const syncInteractiveTerminalSize = (sessionId: string) => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    fitAddon.fit();
    invoke("resize_interactive_command", {
      sessionId,
      cols: terminal.cols,
      rows: terminal.rows,
    }).catch(console.error);
  };

  const sendClaudeMessage = (message: string, allowedTools?: string[]) => {
    const persistedPolicy = loadPersistedToolPolicy();
    const effectiveAllowedTools = allowedTools
      ?? sessionToolState?.selectedTools
      ?? persistedPolicy?.selectedTools;
    setStreaming(true);
    setStreamMessages([]);
    setStreamBlocks([]);
    setPendingUserMessage(message);
    pendingSendRef.current = {
      message,
      sessionId: activeSession?.id ?? null,
      allowedTools: effectiveAllowedTools,
    };
    if (activeSession?.id) {
      setSessionActivityById((current) => ({
        ...current,
        [activeSession.id]: "generating",
      }));
    }
    const yoloMode = loadAppSettings().yoloMode;
    const command = activeSession
      ? invoke("send_message", {
          sessionId: activeSession.id,
          cwd: workspace.decoded_path,
          message,
          model,
          effort,
          allowedTools: effectiveAllowedTools,
          yoloMode,
        })
      : (() => {
          setCreatingInitialSession(true);
          return invoke("send_new_message", {
            cwd: workspace.decoded_path,
            message,
            model,
            effort,
            allowedTools: effectiveAllowedTools,
            yoloMode,
          });
        })();
    command.catch((e) => {
      const failedSessionId = pendingSendRef.current?.sessionId;
      console.error(e);
      setStreaming(false);
      setStreamMessages([]);
      setStreamBlocks([]);
      setPendingUserMessage("");
      setCreatingInitialSession(false);
      if (failedSessionId) {
        setSessionActivityById((current) => {
          if (!current[failedSessionId]) return current;
          const next = { ...current };
          delete next[failedSessionId];
          return next;
        });
      }
      pendingSendRef.current = null;
    });
  };

  const loadMessages = (filePath: string) => {
    if (!filePath) {
      setMessages([]);
      return;
    }
    invoke<unknown[]>("get_session_messages", { filePath })
      .then((raw) => setMessages(raw as JsonlRecord[]))
      .catch(console.error);
  };

  useEffect(() => {
    if (!activeSession?.file_path) {
      setMessages([]);
      return;
    }
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
  }, [activeSession?.file_path, activeSession?.id]);

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
        if (rec.type === "stream_event" && rec.event?.type === "message_start") {
          if (streamBlocksRef.current.length > 0) {
            const completedMessage: JsonlRecord = {
              type: "assistant",
              message: {
                role: "assistant",
                content: streamBlocksRef.current,
              },
              timestamp: new Date().toISOString(),
            };
            setStreamMessages((current) => [...current, completedMessage]);
            setStreamBlocks([]);
          }
          return;
        }
        if (
          rec.type === "stream_event"
          && rec.event?.type === "content_block_start"
          && typeof rec.event?.index === "number"
          && rec.event?.content_block
        ) {
          setStreamBlocks((current) => {
            const next = current.slice();
            next[rec.event.index] = rec.event.content_block as ContentBlock;
            return next;
          });
          return;
        }
        if (
          rec.type === "stream_event"
          && rec.event?.type === "content_block_delta"
          && rec.event?.delta?.type === "thinking_delta"
          && typeof rec.event?.delta?.thinking === "string"
        ) {
          setStreamBlocks((current) => appendThinkingDelta(current, rec.event?.index ?? 0, rec.event.delta.thinking));
          return;
        }
        if (
          rec.type === "stream_event"
          && rec.event?.type === "content_block_delta"
          && rec.event?.delta?.type === "text_delta"
          && typeof rec.event?.delta?.text === "string"
        ) {
          setStreamBlocks((current) => appendStreamTextDelta(current, rec.event?.index ?? 0, rec.event.delta.text));
          return;
        }
        if (
          rec.type === "stream_event"
          && rec.event?.type === "content_block_delta"
          && rec.event?.delta?.type === "input_json_delta"
          && typeof rec.event?.delta?.partial_json === "string"
        ) {
          setStreamBlocks((current) => updateStreamToolInputDelta(current, rec.event?.index ?? 0, rec.event.delta.partial_json));
          return;
        }
        if (rec.type === "assistant") {
          const content = rec.message?.content;
          const blocks = Array.isArray(content)
            ? content as ContentBlock[]
            : typeof content === "string"
              ? [{ type: "text" as const, text: content }]
              : [];
          setStreamBlocks((current) => mergeStreamBlocks(current, blocks));
          return;
        }
        if (rec.type === "system" && rec.subtype === "init") {
          const availableTools = Array.isArray(rec.tools)
            ? rec.tools.filter((tool: unknown): tool is string => typeof tool === "string")
            : [];
          const mcpServers = extractMcpServers(rec.mcp_servers);
          saveToolInventoryCache({
            availableTools,
            mcpServers,
            workspacePath: workspace.decoded_path,
          });
          const sessionId = typeof rec.session_id === "string" ? rec.session_id : activeSessionRef.current?.id ?? null;
          if (sessionId) {
            const currentActiveSession = activeSessionRef.current;
            pendingSendRef.current = pendingSendRef.current
              ? { ...pendingSendRef.current, sessionId }
              : null;
            const optimisticSession = mergeSessionItem({
              id: sessionId,
              file_path: currentActiveSession && currentActiveSession.id === sessionId
                ? currentActiveSession.file_path
                : "",
              modified_at: `${Math.floor(Date.now() / 1000)}`,
              first_message: pendingSendRef.current?.message ?? currentActiveSession?.first_message ?? "New session",
            });
            if (creatingInitialSessionRef.current || !currentActiveSession || currentActiveSession.id !== sessionId) {
              activeSessionRef.current = optimisticSession;
              setActiveSession(optimisticSession);
              onActiveSessionChange?.(optimisticSession.id);
            }
            setSessionActivityById((current) => ({
              ...current,
              [sessionId]: "generating",
            }));
            invoke<DiscoveredWorkspace>("describe_workspace", {
              workspacePath: workspace.decoded_path,
            })
              .then((refreshed) => {
                if (!refreshed || !Array.isArray(refreshed.sessions)) return;
                if (!refreshed.sessions.some((item) => item.id === sessionId)) return;
                publishWorkspaceSessions(refreshed.sessions);
                setSessionItems(refreshed.sessions);
                const refreshedSession = refreshed.sessions.find((item) => item.id === sessionId) ?? null;
                if (refreshedSession && activeSessionRef.current?.id === sessionId) {
                  activeSessionRef.current = refreshedSession;
                  setActiveSession(refreshedSession);
                  onActiveSessionChange?.(refreshedSession.id);
                }
              })
              .catch(console.error);
          }
          const sessionPolicy = loadSessionToolPolicy(sessionId);
          const defaultPolicy = loadDefaultToolPolicy();
          const nextState = {
            sessionId,
            model: typeof rec.model === "string" ? rec.model : null,
            cwd: typeof rec.cwd === "string" ? rec.cwd : null,
            availableTools,
            selectedTools: availableTools.filter((tool: string) => (
              (sessionPolicy?.selectedTools ?? pendingSendRef.current?.allowedTools ?? defaultPolicy?.selectedTools ?? availableTools)
                .includes(tool)
            )),
            mcpServers,
          };
          setSessionToolState((current) => {
            if (
              current
              && current.sessionId === nextState.sessionId
              && current.availableTools.join("|") === nextState.availableTools.join("|")
              && current.selectedTools.join("|") === nextState.selectedTools.join("|")
              && current.mcpServers.join("|") === nextState.mcpServers.join("|")
            ) {
              return current;
            }
            return nextState;
          });
          return;
        }
      } catch {}
    });
    const unlistenDone = listen("claude-done", async () => {
      const completedSessionId = pendingSendRef.current?.sessionId ?? null;
      const currentActiveSession = activeSessionRef.current;
      setStreaming(false);
      setStreamMessages([]);
      setStreamBlocks([]);
      setPendingUserMessage("");
      // Clear all "generating" activity — handles both the sending tab and
      // other tabs that picked up "generating" via the claude-init event.
      setSessionActivityById((current) => {
        const next: Record<string, SessionActivityState> = {};
        for (const [id, state] of Object.entries(current)) {
          if (state === "generating") {
            // Mark as "completed" only if this isn't the active session
            if (id !== currentActiveSession?.id) next[id] = "completed";
            // else: drop it (active session doesn't need the indicator)
          } else {
            next[id] = state;
          }
        }
        return Object.keys(next).length === Object.keys(current).length &&
          Object.entries(next).every(([k, v]) => current[k] === v)
          ? current
          : next;
      });
      pendingSendRef.current = null;
      if (creatingInitialSessionRef.current || !currentActiveSession) {
        try {
          const refreshed = await invoke<DiscoveredWorkspace>("describe_workspace", {
            workspacePath: workspace.decoded_path,
          });
          publishWorkspaceSessions(refreshed.sessions);
          setSessionItems(refreshed.sessions);
          const nextActive = refreshed.sessions[0] ?? null;
          setActiveSession(nextActive);
          onActiveSessionChange?.(nextActive?.id ?? null);
          if (nextActive) {
            loadMessages(nextActive.file_path);
          }
          queryClient.invalidateQueries({ queryKey: ["existing-sessions"] }).catch(console.error);
        } catch (error) {
          console.error(error);
        } finally {
          setCreatingInitialSession(false);
        }
        return;
      }
      loadMessages(currentActiveSession.file_path);
    });
    const unlistenError = listen<string>("claude-error", (e) => {
      console.error("claude error:", e.payload);
      setStreamBlocks((current) => appendStreamTextDelta(current, current.length, `\n[error] ${e.payload}`));
    });
    return () => {
      unlistenStream.then(f => f());
      unlistenDone.then(f => f());
      unlistenError.then(f => f());
    };
  }, [queryClient, workspace.decoded_path]);

  useEffect(() => {
    const unlistenOutput = listen<InteractiveEventPayload>("claudy://interactive-output", (event) => {
      if (event.payload.session_id !== interactiveSessionId) return;
      setInteractiveOutput((current) => current + event.payload.data);
    });
    const unlistenExit = listen<{ session_id: string }>("claudy://interactive-exit", (event) => {
      if (event.payload.session_id !== interactiveSessionId) return;
      setInteractiveSessionId(null);
      setInteractiveStarting(false);
      setInteractiveOutput((current) => current.endsWith("\n") ? `${current}[session closed]\n` : `${current}\n[session closed]\n`);
    });

    return () => {
      unlistenOutput.then((fn) => fn());
      unlistenExit.then((fn) => fn());
    };
  }, [interactiveSessionId]);

  // Listen for native drag-and-drop of image files
  useEffect(() => {
    const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"];
    const unlisten = getCurrentWebviewWindow().onDragDropEvent(async (event) => {
      if (event.payload.type !== "drop") return;
      const paths = event.payload.paths.filter((p) =>
        IMAGE_EXTENSIONS.some((ext) => p.toLowerCase().endsWith(ext))
      );
      for (const sourcePath of paths) {
        try {
          const saved = await invoke<{ name: string; path: string }>("save_temp_image", {
            cwd: workspace.decoded_path,
            sourcePath,
          });
          setSelectedImages((current) => [...current, saved]);
        } catch (err) {
          console.error("Failed to save dropped image:", err);
        }
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [workspace.decoded_path]);

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
    if ((!text && selectedFileRefs.length === 0 && selectedImages.length === 0) || streaming || configuringSession || (!activeSession && !sessionToolState)) return;
    if (text.startsWith("/") && selectedFileRefs.length === 0) {
      const commandName = text.slice(1).trim().split(/\s+/, 1)[0] ?? "";
      const commandKind = slashCommandKindByName.get(commandName);
      if (commandKind === "skill") {
        setInput("");
        setAutocompleteMode(null);
        setAutocompleteQuery("");
        setAutocompleteOpen(false);
        setAutocompleteIndex(0);
        setAutocompleteRange(null);
        sendClaudeMessage(text);
        return;
      }
      setInput("");
      setAutocompleteMode(null);
      setAutocompleteQuery("");
      setAutocompleteOpen(false);
      setAutocompleteIndex(0);
      setAutocompleteRange(null);
      void startInteractiveOverlay(text);
      return;
    }
    const allRefs = [
      ...selectedFileRefs.map((file) => `@${file}`),
      ...selectedImages.map((img) => `@${img.path}`),
    ];
    const message = allRefs.length
      ? `${allRefs.join("\n")}${text ? `\n\n${text}` : ""}`
      : text;
    setInput("");
    setSelectedFileRefs([]);
    setSelectedImages([]);
    setAutocompleteMode(null);
    setAutocompleteQuery("");
    setAutocompleteOpen(false);
    setAutocompleteIndex(0);
    setAutocompleteRange(null);
    sendClaudeMessage(message);
  };

  useEffect(() => {
    if (!interactiveVisible || !terminalContainerRef.current || terminalRef.current) return;

    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.35,
      theme: {
        background: "#0b0c10",
        foreground: "#e4e4e7",
        cursor: "#FFE100",
        selectionBackground: "rgba(255, 225, 0, 0.22)",
        black: "#0b0c10",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#FFE100",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#f4f4f5",
        brightBlack: "#52525b",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fde047",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#ffffff",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalContainerRef.current);
    fitAddon.fit();
    terminal.focus();
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type === "keydown" && event.key === "Escape") {
        void closeInteractiveOverlay();
        return false;
      }
      return true;
    });
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    interactiveWrittenLengthRef.current = 0;

    const disposable = terminal.onData((data) => {
      if (!interactiveSessionId) return;
      invoke("write_interactive_command", {
        sessionId: interactiveSessionId,
        input: data,
      }).catch(console.error);
    });

    if (interactiveOutput) {
      terminal.write(interactiveOutput);
      interactiveWrittenLengthRef.current = interactiveOutput.length;
    }

    if (interactiveSessionId) {
      syncInteractiveTerminalSize(interactiveSessionId);
    }

    const onResize = () => {
      if (!interactiveSessionId) return;
      syncInteractiveTerminalSize(interactiveSessionId);
    };
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      disposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      interactiveWrittenLengthRef.current = 0;
    };
  }, [interactiveVisible, interactiveSessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const nextChunk = interactiveOutput.slice(interactiveWrittenLengthRef.current);
    if (!nextChunk) return;
    terminal.write(nextChunk);
    interactiveWrittenLengthRef.current = interactiveOutput.length;
  }, [interactiveOutput]);

  useEffect(() => {
    if (!interactiveVisible) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void closeInteractiveOverlay();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [interactiveVisible, interactiveSessionId]);

  const closeInteractiveOverlay = async () => {
    const sessionId = interactiveSessionId;
    setInteractiveVisible(false);
    setInteractiveStarting(false);
    setInteractiveSessionId(null);
    if (!sessionId) return;
    try {
      await invoke("close_interactive_command", { sessionId });
    } catch (error) {
      console.error(error);
    }
  };

  const startInteractiveOverlay = async (commandText: string) => {
    setInteractiveVisible(true);
    setInteractiveStarting(true);
    setInteractiveOutput("");
    try {
      const yoloMode = loadAppSettings().yoloMode;
      const sessionId = await invoke<string>("start_interactive_command", {
        workspacePath: workspace.decoded_path,
        initialInput: commandText,
        yoloMode,
      });
      setInteractiveSessionId(sessionId);
    } catch (error) {
      console.error(error);
      setInteractiveOutput("[error] Failed to start interactive Claude session.\r\n");
      setInteractiveVisible(true);
    } finally {
      setInteractiveStarting(false);
    }
  };

  const handleToggleTool = (tool: string) => {
    setSessionToolState((current) => {
      if (!current) return current;
      const selectedTools = current.selectedTools.includes(tool)
        ? current.selectedTools.filter((item) => item !== tool)
        : [...current.selectedTools, tool].sort((a, b) => current.availableTools.indexOf(a) - current.availableTools.indexOf(b));
      return { ...current, selectedTools };
    });
  };

  const handleEnableAllTools = () => {
    setSessionToolState((current) => {
      if (!current) return current;
      return { ...current, selectedTools: current.availableTools };
    });
  };

  const handleDisableAllTools = () => {
    setSessionToolState((current) => {
      if (!current) return current;
      return { ...current, selectedTools: [] };
    });
  };
  const email = accountInfo?.email?.trim().toLowerCase() ?? "";
  const userAvatarUrl = email
    ? `https://www.gravatar.com/avatar/${md5(email)}?s=80&d=identicon`
    : "https://www.gravatar.com/avatar/?s=80&d=mp";

  return (
    <Box style={{ display: "flex", height: "100vh", background: "#0c0c0f" }}>
      {/* ── Sidebar ── */}
      <Box
        style={{
          width: 276,
          flexShrink: 0,
          background: "linear-gradient(180deg, #11141b 0%, #0f1218 100%)",
          borderRight: "1px solid #1f1f23",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Back button */}
        <Box px={12} pt={12} pb={10} style={{ borderBottom: "1px solid #1c212b" }}>
          <UnstyledButton
            onClick={onBack}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              color: "#7f8aa0",
              fontSize: 12,
              padding: "3px 0",
            }}
            onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "#c8d0dd")}
            onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "#7f8aa0")}
          >
            <ChevronLeft />
            <Text size="xs" inherit>Home</Text>
          </UnstyledButton>
        </Box>

        {/* Project name */}
        <Box px={12} py={12}>
          <Group gap={10} align="center" wrap="nowrap">
            {projectIcon ? (
              <Box
                component="img"
                src={projectIcon}
                alt={`${workspace.display_name} icon`}
                style={{
                  width: 28,
                  height: 28,
                  objectFit: "contain",
                  borderRadius: 7,
                  flexShrink: 0,
                  background: "#181c25",
                  padding: 6,
                }}
              />
            ) : (
              <Box
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 7,
                  background: projectColorFor(workspace.display_name),
                  border: "1px solid rgba(255,255,255,0.05)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#f4f4f5",
                  fontSize: 11,
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {projectInitials(workspace.display_name)}
              </Box>
            )}
            <Text size="sm" fw={600} c="#e4e4e7" truncate style={{ flex: 1, minWidth: 0 }}>
              {workspace.display_name}
            </Text>
          </Group>
        </Box>

        <Box px={12} pb={8}>
          <Text size="10px" fw={700} c="#5f6b85" tt="uppercase" style={{ letterSpacing: 1.2 }}>
            Sessions
          </Text>
        </Box>

        {/* Session list */}
        <ScrollArea type="always" style={{ flex: 1 }}>
          <Box pb={12}>
            {sessionItems.length === 0 ? (
              <Text size="xs" c="#52525b" px={14} pt={8}>No sessions yet</Text>
            ) : (
              sessionItems.map((s) => (
                <SessionItem
                  key={s.id}
                  session={s}
                  title={getSessionDisplayTitle(s)}
                  active={activeSession?.id === s.id}
                  activity={sessionActivityById[s.id]}
                  pinned={pinnedSessionId === s.id}
                  confirmingDelete={pendingDeleteSessionId === s.id}
                  renaming={renamingSessionId === s.id}
                  renameValue={renamingSessionId === s.id ? renameValue : ""}
                  loading={loadingSessionId === s.id}
                  onClick={() => {
                    activeSessionRef.current = s;
                    setActiveSession(s);
                    onActiveSessionChange?.(s.id);
                    clearCompletedSessionActivity(s.id);
                  }}
                  onPin={() => handlePinSession(s)}
                  onRename={() => {
                    setRenamingSessionId(s.id);
                    setRenameValue(getSessionDisplayTitle(s));
                  }}
                  onRenameChange={setRenameValue}
                  onRenameCommit={() => {
                    persistSessionName(s.id, renameValue);
                    setRenamingSessionId(null);
                    setRenameValue("");
                  }}
                  onRenameCancel={() => {
                    setRenamingSessionId(null);
                    setRenameValue("");
                  }}
                  onDelete={() => requestDeleteSession(s)}
                  onConfirmDelete={() => void confirmDeleteSession()}
                  onCancelDelete={cancelDeleteSession}
                />
              ))
            )}
          </Box>
        </ScrollArea>

        <Box px={12} pb={12} pt={8} style={{ borderTop: "1px solid #1c212b" }}>
          <UnstyledButton
            onClick={handleStartNewSession}
            style={{
              width: "100%",
              height: 30,
              borderRadius: 9,
              border: "1px solid #e5be48",
              background: "#f3c63b",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              color: "#0c0c0f",
              fontSize: 12,
              fontWeight: 600,
              boxShadow: "0 8px 24px rgba(243,198,59,0.16)",
            }}
            onMouseEnter={(event) => {
              event.currentTarget.style.background = "#f7d14e";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.background = "#f3c63b";
            }}
          >
            <Plus size={12} strokeWidth={2.2} />
            <Text size="xs" inherit>New Session</Text>
          </UnstyledButton>
        </Box>
      </Box>

      {/* ── Main panel ── */}
      <Box style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, position: "relative", background: "#0c0c0f" }}>
        {mainHeader}

        {/* Messages */}
        {loadingMessages ? (
          <MessagesSkeleton />
        ) : !activeSession && initializingNewSession ? (
          <ConfiguringSessionState />
        ) : !activeSession && !streaming && !pendingUserMessage ? (
          <EmptyMessages />
        ) : (
          <MessageList
            messages={messages}
            streamMessages={streaming ? streamMessages : []}
            streamBlocks={streaming ? streamBlocks : []}
            showGenerating={streaming}
            pendingUserText={streaming ? pendingUserMessage : ""}
            sessionId={activeSession?.id}
            userAvatarUrl={userAvatarUrl}
            workspacePath={workspace.decoded_path}
          />
        )}

        {/* Input area */}
        <Box style={{ borderTop: "1px solid #171c24", background: "#0c0c0f", flexShrink: 0, padding: "10px 24px 16px" }}>
          {/* Toolbar */}
          <Box style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, maxWidth: 820, width: "100%", marginInline: "auto" }}>
            <ModelSelect value={model} onChange={setModel} />
            <EffortSelect value={effort} onChange={setEffort} />
            <Box style={{ marginLeft: "auto" }}>
              <Tooltip label="Session settings" position="top" withArrow>
                <UnstyledButton
                  onClick={openSessionSettings}
                  title="Session settings"
                  aria-label="Session settings"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    border: "1px solid #34343d",
                    background: "#17181d",
                    color: "#d4d4d8",
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
                  }}
                >
                  <SettingsIcon />
                </UnstyledButton>
              </Tooltip>
            </Box>
          </Box>
          {/* Textarea row */}
          <Box style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 40px", alignItems: "center", gap: 8, maxWidth: 820, width: "100%", marginInline: "auto" }}>
            <Box style={{ flex: 1, position: "relative" }}>
              <Box
                style={{
                  background: "#11151c",
                  border: "1px solid #2a3243",
                  borderRadius: 14,
                  padding: "10px 14px",
                  opacity: streaming || loadingMessages || configuringSession ? 0.5 : 1,
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
                }}
              >
                {(selectedFileRefs.length > 0 || selectedImages.length > 0) ? (
                  <Box style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
                    {selectedFileRefs.map((file) => (
                      <FileReferenceBadge
                        key={file}
                        file={file}
                        onRemove={() => setSelectedFileRefs((current) => current.filter((item) => item !== file))}
                      />
                    ))}
                    {selectedImages.map((img) => (
                      <FileReferenceBadge
                        key={img.path}
                        file={img.name}
                        onRemove={() => setSelectedImages((current) => current.filter((item) => item.path !== img.path))}
                      />
                    ))}
                  </Box>
                ) : null}
                <textarea
                  ref={textareaRef}
                  value={input}
                  disabled={streaming || loadingMessages || configuringSession}
                  onChange={(e) => {
                    setInput(e.target.value);
                    startTransition(() => {
                      syncAutocompleteState(e.target.value, e.target.selectionStart ?? e.target.value.length);
                    });
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
                  style={{
                    width: "100%",
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    color: "#e4e4e7",
                    caretColor: "#e4e4e7",
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
                      <Box style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                        {autocompleteMode === "command" ? (
                          <Box
                            style={{
                              padding: "3px 7px",
                              borderRadius: 999,
                              border: "1px solid #34343d",
                              background: (item as SlashCommandOption).kind === "skill" ? "#1f1a12" : "#14161b",
                            }}
                          >
                            <Text
                              size="10px"
                              fw={700}
                              tt="uppercase"
                              c={(item as SlashCommandOption).kind === "skill" ? "#facc15" : "#93c5fd"}
                              style={{ lineHeight: 1 }}
                            >
                              {(item as SlashCommandOption).kind}
                            </Text>
                          </Box>
                        ) : null}
                        <Text size="xs" c="#71717a">
                          {autocompleteMode === "command" ? (item as SlashCommandOption).source : "File"}
                        </Text>
                      </Box>
                    </UnstyledButton>
                  ))}
                </Box>
              ) : null}
            </Box>
            <Box style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
              {streaming ? (
                <UnstyledButton
                  onClick={() => invoke("stop_message").catch(() => {})}
                  aria-label="Stop generation"
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 8,
                    background: "#27272a",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    transition: "background 120ms",
                  }}
                >
                  <Square size={14} fill="currentColor" strokeWidth={0} style={{ color: "#e4e4e7" }} />
                </UnstyledButton>
              ) : (
                <UnstyledButton
                  onClick={handleSend}
                  aria-label="Send message"
                  disabled={loadingMessages || sessionSettingsOpen || configuringSession || (!input.trim() && selectedFileRefs.length === 0 && selectedImages.length === 0)}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 8,
                    background: loadingMessages || sessionSettingsOpen || configuringSession || (!input.trim() && selectedFileRefs.length === 0 && selectedImages.length === 0) ? "#27272a" : "#f4f4f5",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                    transition: "background 120ms",
                  }}
                >
                  <Send size={14} strokeWidth={2} style={{ color: input.trim() || selectedFileRefs.length > 0 || selectedImages.length > 0 ? "#0c0c0f" : "#52525b" }} />
                </UnstyledButton>
              )}
            </Box>
          </Box>
        </Box>

        {interactiveVisible ? (
          <Box
            style={{
              position: "absolute",
              inset: mainHeader ? "40px 0 0 0" : 0,
              background: "rgba(8, 8, 11, 0.92)",
              backdropFilter: "blur(4px)",
              display: "flex",
              flexDirection: "column",
              zIndex: 30,
            }}
          >
            <Box
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                padding: "10px 12px",
                borderBottom: "1px solid #27272a",
                background: "#111115",
              }}
            >
              <UnstyledButton
                onClick={() => void closeInteractiveOverlay()}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  border: "1px solid #30303a",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "#a1a1aa",
                }}
              >
                <CloseIcon />
              </UnstyledButton>
            </Box>

            <Box
              style={{
                flex: 1,
                minHeight: 0,
                padding: "16px 18px 18px",
                background: "#0b0c10",
              }}
            >
              <Box
                ref={terminalContainerRef}
                style={{
                  height: "100%",
                  border: "1px solid #27272a",
                  borderRadius: 10,
                  overflow: "hidden",
                }}
              />
            </Box>

            <Box
              style={{
                padding: "10px 20px 14px",
                borderTop: "1px solid #27272a",
                background: "#111115",
              }}
            >
              <Text size="xs" c="#71717a">
                {interactiveStarting
                  ? "Starting interactive Claude session..."
                  : "Type directly in the terminal. Press Esc or use close to return to chat."}
              </Text>
            </Box>
          </Box>
        ) : null}
        {sessionSettingsOpen ? (
          <SessionSettingsOverlay
            state={sessionToolState}
            loading={loadingSessionSettings || (initializingNewSession && !sessionToolState)}
            activeTab={sessionSettingsTab}
            onTabChange={setSessionSettingsTab}
            claudeMdContent={claudeMdContent}
            claudeMdExists={claudeMdExists}
            claudeMdLoading={claudeMdLoading}
            claudeMdLoadError={claudeMdLoadError}
            claudeMdViewMode={claudeMdViewMode}
            onClaudeMdChange={setClaudeMdContent}
            onClaudeMdViewModeChange={setClaudeMdViewMode}
            required={!activeSession}
            mcpExpanded={mcpGroupsExpanded}
            onToggleMcpExpanded={() => setMcpGroupsExpanded((current) => !current)}
            onToggleTool={handleToggleTool}
            onEnableAll={handleEnableAllTools}
            onDisableAll={handleDisableAllTools}
            onCancel={!activeSession ? undefined : cancelSessionSettings}
            onSave={() => void saveSessionSettings()}
            saving={savingSessionSettings}
          />
        ) : null}
      </Box>
    </Box>
  );
}

// ── Session sidebar item ──────────────────────────────────────────────────────

export function SessionItem({
  session,
  title,
  active,
  activity,
  pinned,
  confirmingDelete,
  renaming,
  renameValue,
  loading,
  onClick,
  onPin,
  onRename,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  session: DiscoveredSession;
  title: string;
  active: boolean;
  activity?: SessionActivityState;
  pinned: boolean;
  confirmingDelete: boolean;
  renaming: boolean;
  renameValue: string;
  loading: boolean;
  onClick: () => void;
  onPin: () => void;
  onRename: () => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <Box
      onClick={onClick}
      onMouseDown={(event) => {
        if (event.button !== 1 || renaming || confirmingDelete) return;
        event.preventDefault();
        event.stopPropagation();
        onDelete();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        width: "100%",
        marginLeft: 0,
        padding: "8px 8px",
        borderLeft: active ? "2px solid #FFE100" : "2px solid transparent",
        borderTop: active ? "1px solid #2a2a32" : "1px solid transparent",
        borderRight: active ? "1px solid #2a2a32" : "1px solid transparent",
        borderBottom: active ? "1px solid #2a2a32" : "1px solid transparent",
        borderRadius: 0,
        background: active ? "#1e1e24" : hovered ? "#18181b" : "transparent",
        boxShadow: "none",
        textAlign: "left",
        display: "flex",
        alignItems: "center",
        gap: 8,
        cursor: "pointer",
        transition: "background 180ms ease, border-color 180ms ease",
      }}
    >
      {confirmingDelete ? (
        <>
          <SessionActivityIndicator />
          <Text size="xs" c="#e4e4e7" style={{ flex: 1, minWidth: 0 }}>
            Delete session?
          </Text>
          <ActionIconButton visible active={false} title="Cancel" onClick={onCancelDelete}>
            <CloseIcon />
          </ActionIconButton>
          <ActionIconButton visible active={false} title="Confirm delete" onClick={onConfirmDelete}>
            <TrashIcon />
          </ActionIconButton>
        </>
      ) : (
        <>
          {loading || activity ? (
            <SessionActivityIndicator activity={activity} />
          ) : (
            <ActionIconButton
              visible={hovered || pinned}
              active={pinned}
              title={pinned ? "Unpin session" : "Pin session"}
              onClick={onPin}
            >
              <PinIcon />
            </ActionIconButton>
          )}
          {renaming ? (
            <input
              aria-label="Session name"
              autoFocus
              value={renameValue}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => onRenameChange(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  onRenameCommit();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  onRenameCancel();
                }
              }}
              onBlur={onRenameCommit}
              style={{
                flex: 1,
                minWidth: 0,
                background: "#111115",
                border: "1px solid #30303a",
                borderRadius: 6,
                color: "#e4e4e7",
                fontSize: 12,
                lineHeight: 1.5,
                padding: "4px 8px",
                outline: "none",
              }}
            />
          ) : (
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Text
                size="xs"
                fw={active ? 600 : 500}
                c={active ? "#f0f0f2" : hovered ? "#a1a1aa" : "#71717a"}
                style={{ lineHeight: 1.35, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", transition: "color 180ms ease" }}
              >
                {title}
              </Text>
              <Text size="11px" c={active ? "#a1a1aa" : "#71717a"} mt={3}>
                {relativeTime(session.modified_at)}
              </Text>
            </Box>
          )}
          <ActionIconButton
            visible={hovered && !renaming}
            active={false}
            title="Rename session"
            onClick={onRename}
          >
            <EditIcon />
          </ActionIconButton>
          <ActionIconButton
            visible={hovered && !renaming}
            active={false}
            title="Delete session"
            onClick={onDelete}
          >
            <TrashIcon />
          </ActionIconButton>
        </>
      )}
    </Box>
  );
}

function SessionActivityIndicator({ activity }: { activity?: SessionActivityState }) {
  return (
    <Box
      aria-label={activity ? `Session ${activity}` : undefined}
      title={activity === "generating" ? "Generating response" : activity === "completed" ? "Response completed" : undefined}
      style={{
        width: 24,
        height: 24,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: activity === "completed" ? "#4ade80" : "#FFE100",
      }}
    >
      {activity === "completed" ? (
        <Check size={10} strokeWidth={2.4} />
      ) : (
        <>
          <LoaderCircle size={10} strokeWidth={2} style={{ animation: "claudySessionSpin 1s linear infinite" }} />
          <style>{`
            @keyframes claudySessionSpin {
              from { transform: rotate(0deg); }
              to { transform: rotate(360deg); }
            }
          `}</style>
        </>
      )}
    </Box>
  );
}

function SidebarLoadingIndicator() {
  return (
    <Box
      aria-label="Session loading"
      title="Loading session"
      style={{
        width: 42,
        height: 24,
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        flexShrink: 0,
        color: "#8d99ad",
      }}
    >
      <LoaderCircle size={13} strokeWidth={1.9} style={{ animation: "claudySessionSpin 1s linear infinite" }} />
    </Box>
  );
}

function ActionIconButton({
  visible,
  active,
  title,
  onClick,
  children,
}: {
  visible: boolean;
  active: boolean;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <UnstyledButton
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      style={{
        width: 24,
        height: 24,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: active ? "#FFE100" : visible ? "#71717a" : "transparent",
        opacity: visible ? 1 : 0,
        transition: "opacity 180ms ease, color 180ms ease, transform 180ms ease",
      }}
    >
      {children}
    </UnstyledButton>
  );
}

function SessionSettingsOverlay({
  state,
  loading,
  activeTab,
  onTabChange,
  claudeMdContent,
  claudeMdExists,
  claudeMdLoading,
  claudeMdLoadError,
  claudeMdViewMode,
  onClaudeMdChange,
  onClaudeMdViewModeChange,
  required,
  mcpExpanded,
  onToggleMcpExpanded,
  onToggleTool,
  onEnableAll,
  onDisableAll,
  onCancel,
  onSave,
  saving,
}: {
  state: SessionToolState | null;
  loading: boolean;
  activeTab: SessionSettingsTabKey;
  onTabChange: (tab: SessionSettingsTabKey) => void;
  claudeMdContent: string;
  claudeMdExists: boolean;
  claudeMdLoading: boolean;
  claudeMdLoadError: string | null;
  claudeMdViewMode: ClaudeMdViewMode;
  onClaudeMdChange: (value: string) => void;
  onClaudeMdViewModeChange: (mode: ClaudeMdViewMode) => void;
  required: boolean;
  mcpExpanded: boolean;
  onToggleMcpExpanded: () => void;
  onToggleTool: (tool: string) => void;
  onEnableAll: () => void;
  onDisableAll: () => void;
  onCancel?: () => void;
  onSave: () => void;
  saving: boolean;
}) {
  const { builtinTools, mcpGroups } = splitToolsBySource(state?.availableTools ?? [], state?.mcpServers ?? []);
  const toggleGroupTools = (tools: string[], checked: boolean) => {
    tools.forEach((tool) => {
      const isSelected = state?.selectedTools.includes(tool) ?? false;
      if (checked && !isSelected) onToggleTool(tool);
      if (!checked && isSelected) onToggleTool(tool);
    });
  };
  return (
    <Box
      style={{
        position: "absolute",
        inset: 0,
        background: "rgba(8, 8, 11, 0.84)",
        backdropFilter: "blur(6px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        zIndex: 25,
      }}
    >
      <Box
        style={{
          width: "min(900px, 100%)",
          maxHeight: "100%",
          overflowY: "auto",
          background: "#111115",
          border: "1px solid #2a2a32",
          borderRadius: 16,
          padding: 20,
          boxShadow: "0 28px 80px rgba(0, 0, 0, 0.45)",
        }}
      >
        <Box style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <Box style={{ minWidth: 0 }}>
            <Text size="lg" fw={600} c="#f4f4f5">Session settings</Text>
            <Text size="xs" c="#71717a" mt={2}>
              {activeTab === "settings"
                ? (loading || !state
                ? "Loading Claude tool permissions"
                : `${state.selectedTools.length}/${state.availableTools.length} tools allowed`)
                : (claudeMdLoading
                ? "Loading workspace CLAUDE.md"
                : claudeMdExists
                ? "Workspace instructions loaded"
                : "No CLAUDE.md found yet")}
            </Text>
          </Box>
          <Box style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {activeTab === "settings" ? (
              <>
                <UnstyledButton
                  onClick={onEnableAll}
                  disabled={!state}
                  style={{ fontSize: 11, color: state ? "#a1a1aa" : "#52525b", padding: "4px 6px" }}
                >
                  Enable all
                </UnstyledButton>
                <UnstyledButton
                  onClick={onDisableAll}
                  disabled={!state}
                  style={{ fontSize: 11, color: state ? "#a1a1aa" : "#52525b", padding: "4px 6px" }}
                >
                  Disable all
                </UnstyledButton>
              </>
            ) : null}
          </Box>
        </Box>
        <Box style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <SessionSettingsTabButton active={activeTab === "settings"} onClick={() => onTabChange("settings")}>
            Settings
          </SessionSettingsTabButton>
          <SessionSettingsTabButton active={activeTab === "claude-md"} onClick={() => onTabChange("claude-md")}>
            CLAUDE.md
          </SessionSettingsTabButton>
        </Box>
        {activeTab === "settings" ? (
          loading || !state ? (
            <Box style={{ padding: "28px 0 8px" }}>
              <Text size="sm" c="#a1a1aa">
                {loading
                  ? "Preparing Claude tool permissions before the session starts."
                  : "Session settings could not be loaded. You can close this and try again."}
              </Text>
            </Box>
          ) : (
            <>
            <Box style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginTop: 12 }}>
              <MetaField label="Session ID" value={state.sessionId ?? "Unknown"} mono />
              <MetaField label="Model" value={state.model ?? "Unknown"} mono />
              <MetaField label="Working Directory" value={state.cwd ?? "Unknown"} mono />
            </Box>
            <Text size="xs" fw={600} c="#a1a1aa" mt={14} mb={8}>
              Built-in Tools ({builtinTools.length})
            </Text>
            <Box style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {builtinTools.map((tool) => {
                const checked = state.selectedTools.includes(tool);
                return (
                  <label
                    key={tool}
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
                      aria-label={tool}
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggleTool(tool)}
                      style={{ margin: 0 }}
                    />
                    <Text size="xs" c={checked ? "#ffffff" : "#e4e4e7"}>{tool}</Text>
                  </label>
                );
              })}
            </Box>
            {mcpGroups.length > 0 ? (
              <>
                <UnstyledButton
                  onClick={onToggleMcpExpanded}
                  style={{
                    marginTop: 14,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    color: "#a1a1aa",
                  }}
                >
                  <ChevronDown size={12} strokeWidth={2} style={{ transform: mcpExpanded ? "rotate(180deg)" : "none" }} />
                  <Text size="xs" fw={600} c="#a1a1aa">
                    MCP Servers ({mcpGroups.length})
                  </Text>
                </UnstyledButton>
                {mcpExpanded ? (
                  <Box style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
                    {mcpGroups.map((group) => (
                      <Box key={group.rawServer}>
                        <Box style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                          <GroupToggleCheckbox
                            label={group.label}
                            checked={group.tools.length > 0 && group.tools.every((tool) => state.selectedTools.includes(tool.raw))}
                            indeterminate={group.tools.some((tool) => state.selectedTools.includes(tool.raw)) && !group.tools.every((tool) => state.selectedTools.includes(tool.raw))}
                            onChange={(checked) => toggleGroupTools(group.tools.map((tool) => tool.raw), checked)}
                          />
                        </Box>
                        {group.tools.length > 0 ? (
                          <Box style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                            {group.tools.map((tool) => {
                              const checked = state.selectedTools.includes(tool.raw);
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
                                    onChange={() => onToggleTool(tool.raw)}
                                    style={{ margin: 0 }}
                                  />
                                  <Text size="xs" c={checked ? "#ffffff" : "#e4e4e7"}>{tool.label}</Text>
                                </label>
                              );
                            })}
                          </Box>
                        ) : (
                          <Text size="xs" c="#52525b">No tools exposed for this MCP in the current Claude session.</Text>
                        )}
                      </Box>
                    ))}
                  </Box>
                ) : null}
              </>
            ) : null}
            </>
          )
        ) : (
          <>
            <Box style={{ marginTop: 14 }}>
              {claudeMdLoading ? (
                <Text size="sm" c="#a1a1aa">Loading CLAUDE.md…</Text>
              ) : claudeMdLoadError ? (
                <Text size="sm" c="#fda4af">{claudeMdLoadError}</Text>
              ) : claudeMdViewMode === "edit" ? (
                <>
                  <Box style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 8 }}>
                    <Text size="xs" c="#71717a">
                      {claudeMdExists
                        ? "Edit the workspace CLAUDE.md file."
                        : "No CLAUDE.md file exists yet. Start typing and save to create it."}
                    </Text>
                    <Box style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                      <ModeIconButton
                        active
                        label="Edit mode"
                        onClick={() => onClaudeMdViewModeChange("edit")}
                      >
                        <Pen size={14} strokeWidth={1.8} />
                      </ModeIconButton>
                      <ModeIconButton
                        active={false}
                        label="Preview"
                        onClick={() => onClaudeMdViewModeChange("preview")}
                      >
                        <Eye size={14} strokeWidth={1.8} />
                      </ModeIconButton>
                    </Box>
                  </Box>
                  <textarea
                    aria-label="CLAUDE.md editor"
                    value={claudeMdContent}
                    onChange={(event) => onClaudeMdChange(event.currentTarget.value)}
                    placeholder="Write workspace instructions for Claude here..."
                    style={{
                      width: "100%",
                      minHeight: 340,
                      background: "#0b0d12",
                      border: "1px solid #2a3243",
                      borderRadius: 12,
                      color: "#e4e4e7",
                      padding: 14,
                      resize: "vertical",
                      outline: "none",
                      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace",
                      fontSize: 13,
                      lineHeight: 1.6,
                    }}
                  />
                </>
              ) : (
                <>
                  <Box style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
                    <Box style={{ display: "flex", gap: 8 }}>
                      <ModeIconButton
                        active={false}
                        label="Edit mode"
                        onClick={() => onClaudeMdViewModeChange("edit")}
                      >
                        <Pen size={14} strokeWidth={1.8} />
                      </ModeIconButton>
                      <ModeIconButton
                        active
                        label="Preview"
                        onClick={() => onClaudeMdViewModeChange("preview")}
                      >
                        <Eye size={14} strokeWidth={1.8} />
                      </ModeIconButton>
                    </Box>
                  </Box>
                  <Box
                    style={{
                      minHeight: 340,
                      border: "1px solid #2a3243",
                      borderRadius: 12,
                      background: "#0b0d12",
                      padding: 18,
                      overflow: "auto",
                    }}
                  >
                    {claudeMdContent.trim() ? (
                      <Box className="claude-md-preview">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {claudeMdContent}
                        </ReactMarkdown>
                      </Box>
                    ) : (
                      <Text size="sm" c="#71717a">Nothing to preview yet.</Text>
                    )}
                  </Box>
                </>
              )}
            </Box>
          </>
        )}
        <Box style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 16 }}>
          <Box />
          <Box style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {onCancel ? (
            <UnstyledButton
              onClick={onCancel}
              style={{
                minWidth: 96,
                height: 34,
                borderRadius: 8,
                border: "1px solid #30303a",
                background: "#111115",
                color: "#a1a1aa",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 12,
                fontWeight: 600,
              }}
            >
              Cancel
            </UnstyledButton>
          ) : null}
          <UnstyledButton
            onClick={onSave}
            disabled={(required && loading) || saving}
            style={{
              minWidth: 96,
              height: 34,
              borderRadius: 8,
              background: (required && loading) || saving ? "#27272a" : "#f4f4f5",
              color: (required && loading) || saving ? "#52525b" : "#0c0c0f",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            {saving ? "Saving..." : "Save"}
          </UnstyledButton>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}

function MetaField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <Box>
      <Text size="xs" c="#71717a">{label}</Text>
      <Text size="xs" c="#e4e4e7" ff={mono ? "monospace" : undefined} style={{ marginTop: 4, wordBreak: "break-all" }}>
        {value}
      </Text>
    </Box>
  );
}

function SessionSettingsTabButton({
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
        minWidth: 110,
        height: 34,
        padding: "0 12px",
        borderRadius: 9,
        border: `1px solid ${active ? "#3a3a45" : "#27272a"}`,
        background: active ? "#1a1b21" : "#111115",
        color: active ? "#f4f4f5" : "#a1a1aa",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 12,
        fontWeight: 600,
      }}
    >
      {children}
    </UnstyledButton>
  );
}

function ModeIconButton({
  active,
  label,
  onClick,
  children,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <UnstyledButton
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        width: 34,
        height: 34,
        borderRadius: 8,
        border: `1px solid ${active ? "#44444f" : "#30303a"}`,
        background: active ? "#1a1b21" : "#111115",
        color: active ? "#f4f4f5" : "#a1a1aa",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {children}
    </UnstyledButton>
  );
}

function SettingsIcon() {
  return <Cog size={16} strokeWidth={1.8} aria-hidden="true" />;
}

function EditIcon() {
  return <Pen size={14} strokeWidth={1.8} aria-hidden="true" />;
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

function ConfiguringSessionState() {
  return (
    <Box style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
      <Box
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 12,
          padding: "22px 26px",
          borderRadius: 14,
          border: "1px solid #23232a",
          background: "#121217",
        }}
      >
        <Box
          style={{
            width: 20,
            height: 20,
            borderRadius: "50%",
            border: "2px solid #34343d",
            borderTopColor: "#f3c63b",
            animation: "claudyConfiguringSpin 0.9s linear infinite",
          }}
        />
        <Text size="sm" fw={600} c="#e4e4e7">Configuring Claude Code</Text>
        <Text size="xs" c="#71717a">Preparing permissions and session settings for this folder.</Text>
        <style>{`
          @keyframes claudyConfiguringSpin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
        `}</style>
      </Box>
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
      <ChevronDown
        size={10}
        strokeWidth={2}
        style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: "#52525b" }}
      />
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
  return <ChevronLeftIcon size={14} strokeWidth={2} />;
}

function FolderIcon() {
  return <Folder size={14} strokeWidth={1.7} style={{ color: "#52525b", flexShrink: 0 }} />;
}

function PinIcon() {
  return <Pin size={15} strokeWidth={1.8} />;
}

function TrashIcon() {
  return <Trash2 size={15} strokeWidth={1.8} />;
}

function CloseIcon() {
  return <X size={12} strokeWidth={2} />;
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
      <Text size="xs" c="#a1a1aa">{label}</Text>
    </label>
  );
}
