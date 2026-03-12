export type McpServerStatus =
  | "connected"
  | "connecting"
  | "needs-auth"
  | "invalid-config"
  | "error"
  | "disabled"
  | "unknown";

export interface McpNameValue {
  name: string;
  value_preview: string;
}

export interface McpServerRecord {
  name: string;
  scope: "local" | "user" | "project" | "cloud";
  transport: "stdio" | "sse" | "http";
  status: McpServerStatus;
  command?: string | null;
  args: string[];
  url?: string | null;
  headers: McpNameValue[];
  env: McpNameValue[];
  auth_mode: "none" | "bearer" | "oauth" | "env";
  has_secret: boolean;
  workspace_path?: string | null;
  last_error?: string | null;
}

export interface McpServerMeta {
  key: string;
  disabled: boolean;
  authMode?: McpServerRecord["auth_mode"];
}

const MCP_META_STORAGE_KEY = "claudy.mcpServersMeta";

export function mcpMetaKey(server: Pick<McpServerRecord, "name" | "scope" | "workspace_path">): string {
  return [server.scope, server.workspace_path ?? "", server.name].join("::");
}

export function loadMcpServerMeta(): Record<string, McpServerMeta> {
  try {
    const raw = window.localStorage.getItem(MCP_META_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, McpServerMeta] => {
        const [, value] = entry;
        const candidate = value as Partial<McpServerMeta> | null;
        return !!candidate && typeof candidate === "object" && typeof candidate.key === "string" && typeof candidate.disabled === "boolean";
      })
    );
  } catch {
    return {};
  }
}

export function saveMcpServerMeta(meta: Record<string, McpServerMeta>) {
  try {
    window.localStorage.setItem(MCP_META_STORAGE_KEY, JSON.stringify(meta));
  } catch {
    // Ignore storage errors.
  }
}

export function applyMcpMeta(servers: McpServerRecord[], meta: Record<string, McpServerMeta>): McpServerRecord[] {
  return servers.map((server) => {
    const entry = meta[mcpMetaKey(server)];
    if (!entry) return server;
    return {
      ...server,
      auth_mode: entry.authMode ?? server.auth_mode,
      status: entry.disabled ? "disabled" : server.status,
    };
  });
}
