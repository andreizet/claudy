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

export interface UsageSummary {
  total_sessions: number;
  total_messages: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  total_tool_calls: number;
  total_lines_added: number;
  total_lines_removed: number;
  total_files_modified: number;
  active_days: number;
  avg_messages_per_session: number;
}

export interface UsageDailyPoint {
  date: string;
  sessions: number;
  messages: number;
  total_tokens: number;
  cost_usd: number;
}

export interface UsageModelBreakdown {
  model: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  sessions: number;
}

export interface UsageProjectBreakdown {
  project_path: string;
  display_name: string;
  sessions: number;
  messages: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  lines_added: number;
  lines_removed: number;
  files_modified: number;
  last_active: string;
}

export interface UsageSessionBreakdown {
  session_id: string;
  project_path: string;
  display_name: string;
  start_time: string;
  duration_minutes: number;
  user_messages: number;
  assistant_messages: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  first_prompt: string;
}

export interface UsageDashboard {
  interval: string;
  summary: UsageSummary;
  daily: UsageDailyPoint[];
  models: UsageModelBreakdown[];
  projects: UsageProjectBreakdown[];
  sessions: UsageSessionBreakdown[];
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
