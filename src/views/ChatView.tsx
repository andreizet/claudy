import { useState, useEffect, useRef, useMemo } from "react";
import { Box, Text, ScrollArea, UnstyledButton, Group, Skeleton, Tooltip } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClaudeAccountInfo, DiscoveredWorkspace, DiscoveredSession, JsonlRecord } from "../types";
import MessageList from "../components/chat/MessageList";
import { md5 } from "../shared/md5";

interface Props {
  workspace: DiscoveredWorkspace;
  accountInfo: ClaudeAccountInfo | null;
  onBack: () => void;
  mainHeader?: React.ReactNode;
  onSessionTitleChange?: (title: string | null) => void;
}
const FAVICON_STORAGE_KEY = "claudy.workspaceFavicons";
const PINNED_SESSION_STORAGE_KEY = "claudy.pinnedSessions";
const TOOL_POLICY_STORAGE_KEY = "claudy.toolPolicies";
const SESSION_NAME_STORAGE_KEY = "claudy.sessionNames";
const BUILTIN_SLASH_COMMANDS: SlashCommandOption[] = [
  { name: "add-dir", description: "Add additional working directories.", source: "builtin" },
  { name: "agents", description: "Manage custom AI subagents.", source: "builtin" },
  { name: "bug", description: "Report bugs to Anthropic.", source: "builtin" },
  { name: "clear", description: "Clear conversation history.", source: "builtin" },
  { name: "compact", description: "Compact conversation with optional focus instructions.", argument_hint: "[instructions]", source: "builtin" },
  { name: "config", description: "View or modify Claude Code configuration.", source: "builtin" },
  { name: "cost", description: "Show token usage statistics.", source: "builtin" },
  { name: "doctor", description: "Check Claude Code installation health.", source: "builtin" },
  { name: "help", description: "Show usage help.", source: "builtin" },
  { name: "init", description: "Initialize project guidance with CLAUDE.md.", source: "builtin" },
  { name: "login", description: "Switch Anthropic accounts.", source: "builtin" },
  { name: "logout", description: "Sign out from your Anthropic account.", source: "builtin" },
  { name: "mcp", description: "Manage MCP server connections and OAuth auth.", source: "builtin" },
  { name: "memory", description: "Edit CLAUDE.md memory files.", source: "builtin" },
  { name: "model", description: "Select or change the AI model.", source: "builtin" },
  { name: "permissions", description: "View or update permissions.", source: "builtin" },
  { name: "pr_comments", description: "View pull request comments.", source: "builtin" },
  { name: "review", description: "Run a code review flow.", source: "builtin" },
  { name: "status", description: "Show session and environment status.", source: "builtin" },
  { name: "terminal-setup", description: "Install terminal key bindings and shell integration.", source: "builtin" },
  { name: "vim", description: "Toggle or configure Vim mode.", source: "builtin" },
];

interface SlashCommandOption {
  name: string;
  description?: string;
  argument_hint?: string;
  source: string;
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

interface SessionToolState {
  sessionId: string | null;
  model: string | null;
  cwd: string | null;
  availableTools: string[];
  selectedTools: string[];
  mcpServers: string[];
}

interface ClaudeSessionInit {
  session_id: string | null;
  cwd: string | null;
  model: string | null;
  tools: string[];
  mcp_servers: unknown;
}

interface PersistedToolPolicy {
  selectedTools: string[];
  availableTools?: string[];
  mcpServers?: string[];
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

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function prettifyMcpServerName(rawServer: string, mcpServers: string[]): string {
  const normalizedRaw = normalizeKey(rawServer);
  const matched = mcpServers.find((server) => normalizeKey(server) === normalizedRaw);
  if (matched) return matched;
  return rawServer.replace(/_/g, " ");
}

function extractMcpServers(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((server) => {
      if (typeof server === "string") return [server];
      if (!server || typeof server !== "object") return [];
      const candidate = server as Record<string, unknown>;
      const directName = [candidate.name, candidate.display_name, candidate.server_name, candidate.id]
        .find((item): item is string => typeof item === "string" && item.trim().length > 0);
      if (directName) return [directName];
      return [];
    });
  }

  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, server]) => {
      if (typeof server === "string") return [server];
      if (server && typeof server === "object") {
        const candidate = server as Record<string, unknown>;
        const directName = [candidate.name, candidate.display_name, candidate.server_name, candidate.id]
          .find((item): item is string => typeof item === "string" && item.trim().length > 0);
        if (directName) return [directName];
      }
      return [key];
    });
  }

  return [];
}

function splitToolsBySource(availableTools: string[], mcpServers: string[]) {
  const builtinTools: string[] = [];
  const mcpGroups = new Map<string, { label: string; rawServer: string; tools: Array<{ raw: string; label: string }> }>();

  for (const tool of availableTools) {
    const match = tool.match(/^mcp__([^_].*?)__(.+)$/);
    if (!match) {
      builtinTools.push(tool);
      continue;
    }

    const rawServer = match[1];
    const rawTool = match[2];
    const group = mcpGroups.get(rawServer) ?? {
      label: prettifyMcpServerName(rawServer, mcpServers),
      rawServer,
      tools: [],
    };
    group.tools.push({ raw: tool, label: rawTool });
    mcpGroups.set(rawServer, group);
  }

  for (const server of mcpServers) {
    const existingGroup = Array.from(mcpGroups.values()).find((group) => (
      normalizeKey(group.rawServer) === normalizeKey(server)
      || normalizeKey(group.label) === normalizeKey(server)
    ));
    if (existingGroup) continue;
    const rawServer = server.replace(/\s+/g, "_");
    mcpGroups.set(rawServer, {
      label: server,
      rawServer,
      tools: [],
    });
  }

  return {
    builtinTools,
    mcpGroups: Array.from(mcpGroups.values()).sort((a, b) => a.label.localeCompare(b.label)),
  };
}

export default function ChatView({ workspace, accountInfo, onBack, mainHeader, onSessionTitleChange }: Props) {
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
  const [interactiveSessionId, setInteractiveSessionId] = useState<string | null>(null);
  const [interactiveVisible, setInteractiveVisible] = useState(false);
  const [interactiveOutput, setInteractiveOutput] = useState("");
  const [interactiveStarting, setInteractiveStarting] = useState(false);
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = useState<string | null>(null);
  const [creatingInitialSession, setCreatingInitialSession] = useState(false);
  const [sessionToolState, setSessionToolState] = useState<SessionToolState | null>(null);
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false);
  const [sessionSettingsSnapshot, setSessionSettingsSnapshot] = useState<SessionToolState | null>(null);
  const [mcpGroupsExpanded, setMcpGroupsExpanded] = useState(false);
  const [initializingNewSession, setInitializingNewSession] = useState(false);
  const [loadingSessionSettings, setLoadingSessionSettings] = useState(false);
  const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const terminalContainerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const interactiveWrittenLengthRef = useRef(0);
  const pendingSendRef = useRef<PendingSendContext | null>(null);

  const persistToolPolicy = (policy: PersistedToolPolicy) => {
    try {
      const raw = window.localStorage.getItem(TOOL_POLICY_STORAGE_KEY);
      const parsed = raw ? (JSON.parse(raw) as Record<string, PersistedToolPolicy>) : {};
      parsed[workspace.encoded_name] = policy;
      window.localStorage.setItem(TOOL_POLICY_STORAGE_KEY, JSON.stringify(parsed));
    } catch {
      // Ignore storage errors.
    }
  };

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

  const loadPersistedToolPolicy = () => {
    try {
      const raw = window.localStorage.getItem(TOOL_POLICY_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Record<string, PersistedToolPolicy>;
      const value = parsed[workspace.encoded_name];
      if (!value || !Array.isArray(value.selectedTools)) return null;
      return value;
    } catch {
      return null;
    }
  };

  const applySessionInit = (init: ClaudeSessionInit) => {
    const tools = Array.isArray(init.tools) ? init.tools : [];
    const mcpServers = extractMcpServers(init.mcp_servers);
    const persistedPolicy = loadPersistedToolPolicy();
    const selectedTools = persistedPolicy
      ? tools.filter((tool) => persistedPolicy.selectedTools.includes(tool))
      : tools;
    persistToolPolicy({
      selectedTools,
      availableTools: tools,
      mcpServers,
    });
    setSessionToolState({
      sessionId: init.session_id,
      model: init.model,
      cwd: init.cwd ?? workspace.decoded_path,
      availableTools: tools,
      selectedTools,
      mcpServers,
    });
  };

  const fetchSessionSettings = async () => {
    setLoadingSessionSettings(true);
    try {
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

  const handleStartNewSession = () => {
    setActiveSession(null);
    setMessages([]);
    setLoadingMessages(false);
    setLoadingSessionId(null);
    setInput("");
    setStreamText("");
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
      setSessionItems((current) => {
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
        return pinnedRemaining ?? nextSessions[0] ?? null;
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
    setActiveSession(pinnedSession ?? sessions[0] ?? null);
    const persistedPolicy = loadPersistedToolPolicy();
    setSessionToolState(
      persistedPolicy
        ? {
            sessionId: pinnedSession?.id ?? sessions[0]?.id ?? null,
            model: null,
            cwd: workspace.decoded_path,
            availableTools: persistedPolicy.availableTools ?? persistedPolicy.selectedTools,
            selectedTools: persistedPolicy.selectedTools,
            mcpServers: persistedPolicy.mcpServers ?? [],
          }
        : null
    );
    setSessionSettingsOpen(false);
    setMcpGroupsExpanded(false);
    setInitializingNewSession(sessions.length === 0);
    setLoadingSessionSettings(false);
  }, [workspace.encoded_name, workspace.sessions]);

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
    if (!activeSession || sessionToolState || loadingSessionSettings || initializingNewSession) return;
    void fetchSessionSettings();
  }, [activeSession, initializingNewSession, loadingSessionSettings, sessionToolState]);

  const openSessionSettings = () => {
    setSessionSettingsSnapshot(sessionToolState ? { ...sessionToolState, selectedTools: [...sessionToolState.selectedTools], availableTools: [...sessionToolState.availableTools], mcpServers: [...sessionToolState.mcpServers] } : null);
    setSessionSettingsOpen(true);
    if (!sessionToolState && !loadingSessionSettings) {
      void fetchSessionSettings();
    }
  };

  const closeSessionSettings = () => {
    setSessionSettingsOpen(false);
    setSessionSettingsSnapshot(null);
  };

  const cancelSessionSettings = () => {
    if (sessionSettingsSnapshot) {
      setSessionToolState(sessionSettingsSnapshot);
    }
    closeSessionSettings();
  };

  const saveSessionSettings = () => {
    if (sessionToolState) {
      persistToolPolicy({
        selectedTools: sessionToolState.selectedTools,
        availableTools: sessionToolState.availableTools,
        mcpServers: sessionToolState.mcpServers,
      });
    }
    closeSessionSettings();
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
  }, [autocompleteQuery, slashCommands]);

  const activeSuggestions = autocompleteMode === "command" ? commandSuggestions : fileSuggestions;

  const sendClaudeMessage = (message: string, allowedTools?: string[]) => {
    const persistedPolicy = loadPersistedToolPolicy();
    const effectiveAllowedTools = allowedTools
      ?? sessionToolState?.selectedTools
      ?? persistedPolicy?.selectedTools;
    setStreaming(true);
    setStreamText("");
    setPendingUserMessage(message);
    pendingSendRef.current = {
      message,
      sessionId: activeSession?.id ?? null,
      allowedTools: effectiveAllowedTools,
    };
    const command = activeSession
      ? invoke("send_message", {
          sessionId: activeSession.id,
          cwd: workspace.decoded_path,
          message,
          model,
          effort,
          allowedTools: effectiveAllowedTools,
        })
      : (() => {
          setCreatingInitialSession(true);
          return invoke("send_new_message", {
            cwd: workspace.decoded_path,
            message,
            model,
            effort,
            allowedTools: effectiveAllowedTools,
          });
        })();
    command.catch((e) => {
      console.error(e);
      setStreaming(false);
      setStreamText("");
      setPendingUserMessage("");
      setCreatingInitialSession(false);
      pendingSendRef.current = null;
    });
  };

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
          return;
        }
        if (rec.type === "system" && rec.subtype === "init") {
          const availableTools = Array.isArray(rec.tools)
            ? rec.tools.filter((tool: unknown): tool is string => typeof tool === "string")
            : [];
          const mcpServers = extractMcpServers(rec.mcp_servers);
          const persistedPolicy = loadPersistedToolPolicy();
          const selectedTools = persistedPolicy
            ? availableTools.filter((tool) => persistedPolicy.selectedTools.includes(tool))
            : availableTools;
          persistToolPolicy({
            selectedTools,
            availableTools,
            mcpServers,
          });
          const nextState = {
            sessionId: typeof rec.session_id === "string" ? rec.session_id : activeSession?.id ?? null,
            model: typeof rec.model === "string" ? rec.model : null,
            cwd: typeof rec.cwd === "string" ? rec.cwd : null,
            availableTools,
            selectedTools,
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
      setStreaming(false);
      setStreamText("");
      setPendingUserMessage("");
      pendingSendRef.current = null;
      if (creatingInitialSession || !activeSession) {
        try {
          const refreshed = await invoke<DiscoveredWorkspace>("describe_workspace", {
            workspacePath: workspace.decoded_path,
          });
          setSessionItems(refreshed.sessions);
          const nextActive = refreshed.sessions[0] ?? null;
          setActiveSession(nextActive);
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
      loadMessages(activeSession.file_path);
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
  }, [activeSession, creatingInitialSession, queryClient, workspace.decoded_path]);

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
      const sessionId = await invoke<string>("start_interactive_command", {
        workspacePath: workspace.decoded_path,
        initialInput: commandText,
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

  const handleSend = () => {
    const text = input.trim();
    if ((!text && selectedFileRefs.length === 0) || streaming || (!activeSession && (!sessionToolState || initializingNewSession))) return;
    if (text.startsWith("/") && selectedFileRefs.length === 0) {
      setInput("");
      setAutocompleteMode(null);
      setAutocompleteQuery("");
      setAutocompleteOpen(false);
      setAutocompleteIndex(0);
      setAutocompleteRange(null);
      void startInteractiveOverlay(text);
      return;
    }
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
    sendClaudeMessage(message);
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
            {sessionItems.length === 0 ? (
              <Text size="xs" c="#52525b" px={14} pt={8}>No sessions yet</Text>
            ) : (
              sessionItems.map((s) => (
                <SessionItem
                  key={s.id}
                  session={s}
                  title={getSessionDisplayTitle(s)}
                  active={activeSession?.id === s.id}
                  pinned={pinnedSessionId === s.id}
                  confirmingDelete={pendingDeleteSessionId === s.id}
                  renaming={renamingSessionId === s.id}
                  renameValue={renamingSessionId === s.id ? renameValue : ""}
                  loading={loadingSessionId === s.id}
                  onClick={() => setActiveSession(s)}
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

        <Box px={14} pb={14} pt={8} style={{ borderTop: "1px solid #1f1f23" }}>
          <UnstyledButton
            onClick={handleStartNewSession}
            style={{
              width: "100%",
              height: 32,
              borderRadius: 8,
              border: "1px solid transparent",
              background: "#f4f4f5",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              color: "#0c0c0f",
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
            <Text size="xs" inherit>New Session</Text>
          </UnstyledButton>
        </Box>
      </Box>

      {/* ── Main panel ── */}
      <Box style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, position: "relative" }}>
        {mainHeader}

        {/* Messages */}
        {loadingMessages ? (
          <MessagesSkeleton />
        ) : !activeSession && !streaming && !pendingUserMessage ? (
          <EmptyMessages />
        ) : (
          <MessageList
            messages={messages}
            streamText={streaming ? streamText : ""}
            showGenerating={streaming}
            pendingUserText={streaming ? pendingUserMessage : ""}
            sessionId={activeSession?.id}
            userAvatarUrl={userAvatarUrl}
          />
        )}

        {/* Input area */}
        <Box style={{ borderTop: "1px solid #1f1f23", background: "#0e0e12", flexShrink: 0, padding: "12px 20px" }}>
          {/* Toolbar */}
          <Box style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
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
          <Box style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 40px", alignItems: "center", gap: 8 }}>
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
                  disabled={streaming || loadingMessages}
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
            <Box style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%" }}>
              <UnstyledButton
                onClick={handleSend}
                disabled={streaming || loadingMessages || sessionSettingsOpen || (!activeSession && initializingNewSession) || (!input.trim() && selectedFileRefs.length === 0)}
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: streaming || loadingMessages || sessionSettingsOpen || (!activeSession && initializingNewSession) || (!input.trim() && selectedFileRefs.length === 0) ? "#27272a" : "#f4f4f5",
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
            required={!activeSession}
            mcpExpanded={mcpGroupsExpanded}
            onToggleMcpExpanded={() => setMcpGroupsExpanded((current) => !current)}
            onToggleTool={handleToggleTool}
            onEnableAll={handleEnableAllTools}
            onDisableAll={handleDisableAllTools}
            onCancel={!activeSession ? undefined : cancelSessionSettings}
            onSave={saveSessionSettings}
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
        width: "calc(100% - 8px)",
        marginLeft: 8,
        padding: "7px 14px",
        borderLeft: active ? "2px solid #FFE100" : "2px solid transparent",
        borderTop: active ? "1px solid #2a2a32" : "1px solid transparent",
        borderRight: active ? "1px solid #2a2a32" : "1px solid transparent",
        borderBottom: active ? "1px solid #2a2a32" : "1px solid transparent",
        background: active ? "#1e1e24" : hovered ? "#18181b" : "transparent",
        textAlign: "left",
        display: "flex",
        alignItems: "center",
        gap: 8,
        cursor: "pointer",
      }}
    >
      {confirmingDelete ? (
        <>
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
          <ActionIconButton
            visible={hovered || pinned}
            active={pinned}
            title={pinned ? "Unpin session" : "Pin session"}
            onClick={onPin}
          >
            <PinIcon />
          </ActionIconButton>
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
            <Text
              size="xs"
              fw={active ? 500 : 400}
              c={active ? "#f4f4f5" : hovered ? "#d4d4d8" : "#b4b4bd"}
              style={{ flex: 1, minWidth: 0, lineHeight: 1.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {title}
            </Text>
          )}
          <Text size="xs" c="#3f3f46" style={{ flexShrink: 0, fontSize: 11 }}>
            {loading ? "Loading..." : relativeTime(session.modified_at)}
          </Text>
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
        transition: "opacity 120ms, color 120ms",
      }}
    >
      {children}
    </UnstyledButton>
  );
}

function SessionSettingsOverlay({
  state,
  loading,
  required,
  mcpExpanded,
  onToggleMcpExpanded,
  onToggleTool,
  onEnableAll,
  onDisableAll,
  onCancel,
  onSave,
}: {
  state: SessionToolState | null;
  loading: boolean;
  required: boolean;
  mcpExpanded: boolean;
  onToggleMcpExpanded: () => void;
  onToggleTool: (tool: string) => void;
  onEnableAll: () => void;
  onDisableAll: () => void;
  onCancel?: () => void;
  onSave: () => void;
}) {
  const { builtinTools, mcpGroups } = splitToolsBySource(state?.availableTools ?? [], state?.mcpServers ?? []);
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
              {loading || !state
                ? "Loading Claude tool permissions"
                : `${state.selectedTools.length}/${state.availableTools.length} tools allowed`}
            </Text>
          </Box>
          <Box style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
          </Box>
        </Box>
        {loading || !state ? (
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
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ transform: mcpExpanded ? "rotate(180deg)" : "none" }}>
                  <path d="M6 9l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <Text size="xs" fw={600} c="#a1a1aa">
                  MCP Servers ({mcpGroups.length})
                </Text>
              </UnstyledButton>
              {mcpExpanded ? (
                <Box style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 8 }}>
                  {mcpGroups.map((group) => (
                    <Box key={group.rawServer}>
                      <Text size="xs" c="#a1a1aa" mb={6}>{group.label}</Text>
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
        )}
        <Box style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
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
            disabled={required && loading}
            style={{
              minWidth: 96,
              height: 34,
              borderRadius: 8,
              background: required && loading ? "#27272a" : "#f4f4f5",
              color: required && loading ? "#52525b" : "#0c0c0f",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            Save
          </UnstyledButton>
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

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 8.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7zm8 3.5l-1.8-.5a6.8 6.8 0 00-.5-1.2l1-1.6-1.8-1.8-1.6 1a6.8 6.8 0 00-1.2-.5L14 4h-4l-.5 1.8a6.8 6.8 0 00-1.2.5l-1.6-1-1.8 1.8 1 1.6a6.8 6.8 0 00-.5 1.2L4 12l.5 1.8a6.8 6.8 0 00.5 1.2l-1 1.6 1.8 1.8 1.6-1a6.8 6.8 0 001.2.5L10 20h4l.5-1.8a6.8 6.8 0 001.2-.5l1.6 1 1.8-1.8-1-1.6a6.8 6.8 0 00.5-1.2L20 12z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 20h4l10-10-4-4L4 16v4zM13 7l4 4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
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

function PinIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path d="M9 3h6l-1 5 3 3v2H7v-2l3-3-1-5z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M12 13v8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
      <path d="M4 7h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M7 7l1 12a2 2 0 002 2h4a2 2 0 002-2l1-12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 11v5M14 11v5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
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
