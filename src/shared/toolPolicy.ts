export const DEFAULT_TOOL_POLICY_STORAGE_KEY = "claudy.defaultToolPolicy";
export const SESSION_TOOL_POLICY_STORAGE_KEY = "claudy.sessionToolPolicies";
export const TOOL_INVENTORY_CACHE_STORAGE_KEY = "claudy.toolInventoryCache";
export const TOOL_INVENTORY_CACHE_TTL_MS = 4 * 60 * 60 * 1000;

export interface PersistedToolPolicy {
  selectedTools: string[];
  availableTools?: string[];
  mcpServers?: string[];
}

export interface SessionToolState {
  sessionId: string | null;
  model: string | null;
  cwd: string | null;
  availableTools: string[];
  selectedTools: string[];
  mcpServers: string[];
}

export interface ToolInventoryCache {
  availableTools: string[];
  mcpServers: string[];
  workspacePath: string | null;
  cachedAt: number;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function extractMcpServers(value: unknown): string[] {
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

function prettifyMcpServerName(rawServer: string, mcpServers: string[]): string {
  const normalizedRaw = normalizeKey(rawServer);
  const matched = mcpServers.find((server) => normalizeKey(server) === normalizedRaw);
  if (matched) return matched;
  return rawServer.replace(/_/g, " ");
}

export function splitToolsBySource(availableTools: string[], mcpServers: string[]) {
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

export function loadDefaultToolPolicy(): PersistedToolPolicy | null {
  try {
    const raw = window.localStorage.getItem(DEFAULT_TOOL_POLICY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedToolPolicy;
    if (!Array.isArray(parsed.selectedTools)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveDefaultToolPolicy(policy: PersistedToolPolicy) {
  try {
    window.localStorage.setItem(DEFAULT_TOOL_POLICY_STORAGE_KEY, JSON.stringify(policy));
  } catch {
    // Ignore storage errors.
  }
}

export function loadSessionToolPolicy(sessionId: string | null | undefined): PersistedToolPolicy | null {
  if (!sessionId) return null;
  try {
    const raw = window.localStorage.getItem(SESSION_TOOL_POLICY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, PersistedToolPolicy>;
    const value = parsed[sessionId];
    if (!value || !Array.isArray(value.selectedTools)) return null;
    return value;
  } catch {
    return null;
  }
}

export function saveSessionToolPolicy(sessionId: string, policy: PersistedToolPolicy) {
  try {
    const raw = window.localStorage.getItem(SESSION_TOOL_POLICY_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, PersistedToolPolicy>) : {};
    parsed[sessionId] = policy;
    window.localStorage.setItem(SESSION_TOOL_POLICY_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // Ignore storage errors.
  }
}

export function clearToolInventoryCache() {
  try {
    window.localStorage.removeItem(TOOL_INVENTORY_CACHE_STORAGE_KEY);
  } catch {
    // Ignore storage errors.
  }
}

export function loadToolInventoryCache(): ToolInventoryCache | null {
  try {
    const raw = window.localStorage.getItem(TOOL_INVENTORY_CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ToolInventoryCache;
    if (
      !Array.isArray(parsed.availableTools)
      || !Array.isArray(parsed.mcpServers)
      || typeof parsed.cachedAt !== "number"
    ) {
      return null;
    }
    if (Date.now() - parsed.cachedAt > TOOL_INVENTORY_CACHE_TTL_MS) {
      clearToolInventoryCache();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveToolInventoryCache(cache: Omit<ToolInventoryCache, "cachedAt">) {
  try {
    window.localStorage.setItem(
      TOOL_INVENTORY_CACHE_STORAGE_KEY,
      JSON.stringify({
        ...cache,
        cachedAt: Date.now(),
      } satisfies ToolInventoryCache)
    );
  } catch {
    // Ignore storage errors.
  }
}
