export interface DiscoveredSession {
  id: string;
  file_path: string;
  modified_at: string;
  first_message: string | null;
}

export interface DiscoveredWorkspace {
  encoded_name: string;
  decoded_path: string;
  display_name: string;
  path_exists: boolean;
  sessions: DiscoveredSession[];
}

export interface ClaudeAccountInfo {
  email: string | null;
  display_name: string | null;
  organization_name: string | null;
  organization_role: string | null;
}

// ─── JSONL message types ──────────────────────────────────────────────────────

export interface ContentBlockText {
  type: "text";
  text: string;
}

export interface ContentBlockThinking {
  type: "thinking";
  thinking: string;
}

export interface ContentBlockToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ContentBlockToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export type ContentBlock =
  | ContentBlockText
  | ContentBlockThinking
  | ContentBlockToolUse
  | ContentBlockToolResult;

export interface JsonlRecord {
  type: "user" | "assistant" | "summary" | "local-command-caveat" | string;
  message: {
    role: "user" | "assistant";
    content: string | ContentBlock[];
  };
  timestamp: string;
  costUSD?: number;
  durationMs?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}
