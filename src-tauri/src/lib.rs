use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use base64::Engine;
use time::format_description::well_known::Rfc3339;
use time::{Duration as TimeDuration, OffsetDateTime};

// ─── Data types ───────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone)]
pub struct DiscoveredSession {
    pub id: String,
    pub file_path: String,
    pub modified_at: String,
    pub first_message: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct DiscoveredWorkspace {
    pub encoded_name: String,
    pub decoded_path: String,
    pub display_name: String,
    pub path_exists: bool,
    pub sessions: Vec<DiscoveredSession>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ClaudeAccountInfo {
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub organization_name: Option<String>,
    pub organization_role: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ClaudeInstallation {
    pub label: String,
    pub path: String,
    pub is_available: bool,
    pub is_selected: bool,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ClaudePlanUsageBucket {
    pub percent_used: Option<f64>,
    pub reset_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ClaudePlanUsage {
    pub current_session: ClaudePlanUsageBucket,
    pub weekly_limits: ClaudePlanUsageBucket,
    pub fetched_at_ms: u64,
    pub is_live: bool,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct UsageSummary {
    pub total_sessions: usize,
    pub total_messages: u64,
    pub total_input_tokens: u64,
    pub total_output_tokens: u64,
    pub total_tokens: u64,
    pub total_cost_usd: f64,
    pub total_tool_calls: u64,
    pub total_lines_added: u64,
    pub total_lines_removed: u64,
    pub total_files_modified: u64,
    pub active_days: usize,
    pub avg_messages_per_session: f64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct UsageDailyPoint {
    pub date: String,
    pub sessions: u64,
    pub messages: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct UsageModelBreakdown {
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
    pub sessions: u64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct UsageProjectBreakdown {
    pub project_path: String,
    pub display_name: String,
    pub sessions: u64,
    pub messages: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
    pub lines_added: u64,
    pub lines_removed: u64,
    pub files_modified: u64,
    pub last_active: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct UsageSessionBreakdown {
    pub session_id: String,
    pub project_path: String,
    pub display_name: String,
    pub start_time: String,
    pub duration_minutes: u64,
    pub user_messages: u64,
    pub assistant_messages: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
    pub first_prompt: String,
}

fn truncate_for_log(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn escape_for_log(value: &str, max_chars: usize) -> String {
    truncate_for_log(
        &value.chars().flat_map(|ch| ch.escape_default()).collect::<String>(),
        max_chars,
    )
}

#[derive(Serialize, Deserialize, Clone)]
pub struct UsageDashboard {
    pub interval: String,
    pub summary: UsageSummary,
    pub daily: Vec<UsageDailyPoint>,
    pub models: Vec<UsageModelBreakdown>,
    pub projects: Vec<UsageProjectBreakdown>,
    pub sessions: Vec<UsageSessionBreakdown>,
}

#[derive(Deserialize, Clone, Default)]
struct SessionMetaFile {
    session_id: String,
    project_path: String,
    start_time: String,
    duration_minutes: u64,
    user_message_count: u64,
    assistant_message_count: u64,
    tool_counts: HashMap<String, u64>,
    input_tokens: u64,
    output_tokens: u64,
    first_prompt: String,
    lines_added: u64,
    lines_removed: u64,
    files_modified: u64,
}

#[derive(Default, Clone)]
struct SessionJsonMetrics {
    cost_usd: f64,
    input_tokens: u64,
    output_tokens: u64,
    messages: u64,
    daily: HashMap<String, (u64, f64)>,
    models: HashMap<String, (u64, u64, f64)>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SlashCommandInfo {
    pub name: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    pub source: String,
    pub kind: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct InstalledSkill {
    pub folder_name: String,
    pub display_name: String,
    pub description: Option<String>,
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct SkillCatalogEntry {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub repo_label: String,
    pub repo_url: String,
    pub github_repo: String,
    pub github_ref: String,
    pub github_path: String,
    pub destination_name: String,
}

#[derive(Serialize, Deserialize, Clone, Default)]
pub struct ClaudeSessionInit {
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub model: Option<String>,
    pub tools: Vec<String>,
    pub mcp_servers: Vec<String>,
}

fn extract_mcp_server_names(value: Option<&serde_json::Value>) -> Vec<String> {
    let Some(value) = value else {
        return Vec::new();
    };

    match value {
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(|item| {
                item.as_str()
                    .map(|s| s.to_string())
                    .or_else(|| {
                        item.as_object().and_then(|object| {
                            ["name", "display_name", "server_name", "id"]
                                .iter()
                                .find_map(|key| object.get(*key).and_then(|v| v.as_str()).map(|s| s.to_string()))
                        })
                    })
            })
            .collect(),
        serde_json::Value::Object(map) => map
            .iter()
            .map(|(key, item)| {
                item.as_str()
                    .map(|s| s.to_string())
                    .or_else(|| {
                        item.as_object().and_then(|object| {
                            ["name", "display_name", "server_name", "id"]
                                .iter()
                                .find_map(|field| object.get(*field).and_then(|v| v.as_str()).map(|s| s.to_string()))
                        })
                    })
                    .unwrap_or_else(|| key.to_string())
            })
            .collect(),
        _ => Vec::new(),
    }
}

#[derive(Serialize, Clone)]
struct InteractiveOutputPayload {
    session_id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct InteractiveExitPayload {
    session_id: String,
}

struct InteractiveSession {
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Arc<Mutex<Box<dyn portable_pty::MasterPty + Send>>>,
}

#[derive(Default)]
struct InteractiveSessionStore {
    sessions: Mutex<HashMap<String, InteractiveSession>>,
}

#[derive(Default)]
struct PlanUsageCache {
    entries: Mutex<HashMap<String, CachedPlanUsage>>,
}

#[derive(Clone)]
struct CachedPlanUsage {
    usage: ClaudePlanUsage,
    fetched_at: Instant,
}

static NEXT_INTERACTIVE_ID: AtomicU64 = AtomicU64::new(1);

fn interactive_pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows: rows.max(10),
        cols: cols.max(20),
        pixel_width: 0,
        pixel_height: 0,
    }
}

// ─── Path decoding ────────────────────────────────────────────────────────────

/// Claude Code encodes a project path by replacing ALL non-alphanumeric characters
/// (including `/`, `_`, `-`, `.`, spaces, etc.) with `-`.
/// Example: `/Users/alice/_work/my-app` → `-Users-alice--work-my-app`
///
/// Decoding is lossy (we can't distinguish `-` from `_` from `/`), so we use a
/// fuzzy filesystem walk: extract the alphanumeric tokens from the encoded name
/// and walk the real filesystem matching directory names token-by-token.
fn claude_encode(s: &str) -> String {
    s.chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect()
}

fn alphanumeric_tokens(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
        .collect()
}

/// Walk the filesystem from `base`, consuming `tokens` one segment at a time.
/// A directory matches the next N tokens if encoding its name produces exactly
/// those N tokens.
fn fuzzy_find(base: &Path, tokens: &[String]) -> Option<PathBuf> {
    if tokens.is_empty() {
        return Some(base.to_path_buf());
    }

    let entries = fs::read_dir(base).ok()?;

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let dir_name = entry.file_name();
        let dir_name_str = dir_name.to_string_lossy();

        let dir_tokens = alphanumeric_tokens(&dir_name_str);
        let n = dir_tokens.len();

        if n == 0 || tokens.len() < n {
            continue;
        }

        if dir_tokens == tokens[..n] {
            if let Some(found) = fuzzy_find(&path, &tokens[n..]) {
                return Some(found);
            }
        }
    }

    None
}

fn decode_project_path_fallback(encoded_dir_name: &str) -> PathBuf {
    let naive = encoded_dir_name.trim_start_matches('-').replace('-', "/");

    #[cfg(windows)]
    {
        let mut parts = naive.split('/').filter(|part| !part.is_empty());
        if let Some(drive) = parts.next() {
            if drive.len() == 1 && drive.chars().all(|c| c.is_ascii_alphabetic()) {
                let rest = parts.collect::<Vec<_>>().join("\\");
                if rest.is_empty() {
                    return PathBuf::from(format!("{}:\\", drive.to_ascii_uppercase()));
                }
                return PathBuf::from(format!("{}:\\{}", drive.to_ascii_uppercase(), rest));
            }
        }
    }

    PathBuf::from(format!("/{}", naive))
}

fn decode_project_path_with_home(encoded_dir_name: &str, home: &Path) -> (PathBuf, bool) {
    let home_str = home.to_string_lossy();
    let home_encoded = claude_encode(&home_str);

    // Encoded dir name should start with the encoded home prefix
    if encoded_dir_name.starts_with(&home_encoded) {
        let suffix = &encoded_dir_name[home_encoded.len()..];
        // suffix is something like "--work-claudy-claudy"
        // Extract alphanumeric tokens from the suffix
        let tokens = alphanumeric_tokens(suffix);

        if let Some(real_path) = fuzzy_find(&home, &tokens) {
            return (real_path, true);
        }
    }

    #[cfg(windows)]
    {
        let tokens = alphanumeric_tokens(encoded_dir_name);
        if let Some(drive) = tokens.first() {
            if drive.len() == 1 && drive.chars().all(|c| c.is_ascii_alphabetic()) {
                let drive_root = PathBuf::from(format!("{}:\\", drive.to_ascii_uppercase()));
                if let Some(real_path) = fuzzy_find(&drive_root, &tokens[1..]) {
                    return (real_path, true);
                }
            }
        }
    }

    // Fallback: naive replace (works for paths without special chars)
    let naive_path = decode_project_path_fallback(encoded_dir_name);
    let exists = naive_path.exists();
    (naive_path, exists)
}

fn decode_project_path(encoded_dir_name: &str) -> (PathBuf, bool) {
    let home = match dirs_next::home_dir() {
        Some(h) => h,
        None => return (PathBuf::from(encoded_dir_name), false),
    };

    decode_project_path_with_home(encoded_dir_name, &home)
}

fn path_contains_component(path: &Path, component: &str) -> bool {
    path.components().any(|part| part.as_os_str().to_string_lossy().eq_ignore_ascii_case(component))
}

// ─── Session reading ──────────────────────────────────────────────────────────

fn read_first_message(file_path: &Path) -> Option<String> {
    let file = fs::File::open(file_path).ok()?;
    let reader = BufReader::new(file);

    for line in reader.lines().flatten() {
        let trimmed = line.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(record) = serde_json::from_str::<serde_json::Value>(&trimmed) {
            if record["type"].as_str() != Some("user") {
                continue;
            }
            let content = &record["message"]["content"];
            let text = if content.is_string() {
                content.as_str().unwrap_or("").to_string()
            } else if let Some(arr) = content.as_array() {
                arr.iter()
                    .filter(|b| b["type"] == "text")
                    .filter_map(|b| b["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("")
            } else {
                continue
            };

            let trimmed_text = text.trim().to_string();
            if trimmed_text.is_empty() {
                continue;
            }
            // Skip system/automated messages
            if trimmed_text.starts_with('[')
                || trimmed_text.starts_with('<')
            {
                continue;
            }
            return Some(trimmed_text.chars().take(120).collect());
        }
    }
    None
}

fn modified_at_secs(path: &Path) -> String {
    path.metadata()
        .and_then(|m| m.modified())
        .map(|t| t.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs().to_string())
        .unwrap_or_default()
}

fn collect_workspace_from_project_dir(
    claude_project_dir: &Path,
    dir_name: String,
    real_path: PathBuf,
    path_exists: bool,
) -> DiscoveredWorkspace {
    let decoded_path = real_path.to_string_lossy().to_string();
    let display_name = real_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&decoded_path)
        .to_string();

    let mut sessions: Vec<DiscoveredSession> = fs::read_dir(claude_project_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|f| {
            let fp = f.path();
            if fp.extension()?.to_str()? != "jsonl" {
                return None;
            }
            Some(DiscoveredSession {
                id: fp.file_stem()?.to_str()?.to_string(),
                file_path: fp.to_string_lossy().to_string(),
                modified_at: modified_at_secs(&fp),
                first_message: read_first_message(&fp),
            })
        })
        .collect();

    sessions.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));

    DiscoveredWorkspace {
        encoded_name: dir_name,
        decoded_path,
        display_name,
        path_exists,
        sessions,
    }
}

fn claude_binary_and_path() -> (String, String) {
    let home = dirs_next::home_dir().unwrap_or_default();
    let path_separator = if cfg!(windows) { ";" } else { ":" };
    let mut path_entries = Vec::<String>::new();

    if let Ok(existing_path) = std::env::var("PATH") {
        path_entries.push(existing_path);
    }

    #[cfg(windows)]
    {
        path_entries.push(home.join("AppData").join("Roaming").join("npm").to_string_lossy().to_string());
        path_entries.push(home.join(".local").join("bin").to_string_lossy().to_string());
        path_entries.push(home.join(".cargo").join("bin").to_string_lossy().to_string());
    }

    #[cfg(not(windows))]
    {
        path_entries.push(home.join(".local").join("bin").to_string_lossy().to_string());
        path_entries.push("/usr/local/bin".to_string());
        path_entries.push("/opt/homebrew/bin".to_string());
        path_entries.push("/usr/bin".to_string());
        path_entries.push("/bin".to_string());
    }

    let full_path = path_entries
        .into_iter()
        .filter(|entry| !entry.is_empty())
        .collect::<Vec<_>>()
        .join(path_separator);

    #[cfg(windows)]
    let candidates = [
        home.join(".local").join("bin").join("claude.exe").to_string_lossy().to_string(),
        home.join(".local").join("bin").join("claude.cmd").to_string_lossy().to_string(),
        home.join(".local").join("bin").join("claude").to_string_lossy().to_string(),
        home.join("AppData").join("Roaming").join("npm").join("claude.cmd").to_string_lossy().to_string(),
        home.join("AppData").join("Roaming").join("npm").join("claude.exe").to_string_lossy().to_string(),
        home.join("AppData").join("Roaming").join("npm").join("claude").to_string_lossy().to_string(),
        "claude.cmd".to_string(),
        "claude.exe".to_string(),
        "claude".to_string(),
    ];

    #[cfg(not(windows))]
    let candidates = [
        home.join(".local").join("bin").join("claude").to_string_lossy().to_string(),
        "/usr/local/bin/claude".to_string(),
        "/opt/homebrew/bin/claude".to_string(),
        "claude".to_string(),
    ];

    let claude_bin = candidates
        .iter()
        .find(|p| Path::new(p.as_str()).exists())
        .cloned()
        .unwrap_or_else(|| {
            if cfg!(windows) {
                "claude.cmd".to_string()
            } else {
                "claude".to_string()
            }
        });

    (claude_bin, full_path)
}

fn claude_candidates() -> Vec<String> {
    let home = dirs_next::home_dir().unwrap_or_default();

    #[cfg(windows)]
    let candidates = vec![
        home.join(".local").join("bin").join("claude.exe").to_string_lossy().to_string(),
        home.join(".local").join("bin").join("claude.cmd").to_string_lossy().to_string(),
        home.join(".local").join("bin").join("claude").to_string_lossy().to_string(),
        home.join("AppData").join("Roaming").join("npm").join("claude.cmd").to_string_lossy().to_string(),
        home.join("AppData").join("Roaming").join("npm").join("claude.exe").to_string_lossy().to_string(),
        home.join("AppData").join("Roaming").join("npm").join("claude").to_string_lossy().to_string(),
        "claude.cmd".to_string(),
        "claude.exe".to_string(),
        "claude".to_string(),
    ];

    #[cfg(not(windows))]
    let candidates = vec![
        home.join(".local").join("bin").join("claude").to_string_lossy().to_string(),
        "/usr/local/bin/claude".to_string(),
        "/opt/homebrew/bin/claude".to_string(),
        "claude".to_string(),
    ];

    candidates
}

#[tauri::command]
fn list_claude_installations() -> Vec<ClaudeInstallation> {
    let (selected_bin, _) = claude_binary_and_path();
    let mut seen = std::collections::HashSet::<String>::new();

    claude_candidates()
        .into_iter()
        .filter(|candidate| seen.insert(candidate.clone()))
        .map(|candidate| {
            let is_lookup = !candidate.contains(std::path::MAIN_SEPARATOR) && !candidate.contains('/');
            let is_available = if is_lookup {
                true
            } else {
                Path::new(&candidate).exists()
            };
            ClaudeInstallation {
                label: if is_lookup { format!("PATH lookup ({candidate})") } else { candidate.clone() },
                path: candidate.clone(),
                is_available,
                is_selected: candidate == selected_bin,
            }
        })
        .collect()
}

fn parse_interval_cutoff(interval: &str) -> Option<String> {
    if interval == "all" {
        return None;
    }

    let days = match interval {
        "7d" => 7,
        "30d" => 30,
        "90d" => 90,
        _ => 30,
    };

    let now = OffsetDateTime::now_utc();
    let cutoff = now - TimeDuration::days((days - 1) as i64);
    Some(format!("{:04}-{:02}-{:02}", cutoff.year(), u8::from(cutoff.month()), cutoff.day()))
}

fn iso_date_prefix(value: &str) -> Option<String> {
    value.get(0..10).map(|date| date.to_string())
}

fn extract_message_text(content: &serde_json::Value) -> String {
    if let Some(text) = content.as_str() {
        return text.trim().to_string();
    }

    content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|block| block.get("type").and_then(|value| value.as_str()) == Some("text"))
        .filter_map(|block| block.get("text").and_then(|value| value.as_str()))
        .collect::<Vec<_>>()
        .join("")
        .trim()
        .to_string()
}

fn parse_rfc3339_timestamp(value: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(value, &Rfc3339).ok()
}

fn load_session_meta_files_from(root: &Path) -> Vec<SessionMetaFile> {
    if !root.exists() {
        return vec![];
    }

    let mut items = Vec::new();
    for entry in walkdir::WalkDir::new(root).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(raw) = fs::read_to_string(entry.path()) else {
            continue;
        };
        let Ok(meta) = serde_json::from_str::<SessionMetaFile>(&raw) else {
            continue;
        };
        items.push(meta);
    }
    items
}

fn synthesize_session_meta_files_from(root: &Path) -> Vec<SessionMetaFile> {
    if !root.exists() {
        return vec![];
    }

    let mut items = Vec::new();
    for entry in walkdir::WalkDir::new(root).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        if path_contains_component(path, "subagents") {
            continue;
        }

        let Some(session_id) = path.file_stem().and_then(|value| value.to_str()).map(|value| value.to_string()) else {
            continue;
        };

        let Ok(file) = fs::File::open(path) else {
            continue;
        };

        let mut meta = SessionMetaFile {
            session_id,
            ..SessionMetaFile::default()
        };
        let mut first_seen = Option::<OffsetDateTime>::None;
        let mut last_seen = Option::<OffsetDateTime>::None;

        for line in BufReader::new(file).lines().flatten() {
            if line.trim().is_empty() {
                continue;
            }

            let Ok(record) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };

            if meta.project_path.is_empty() {
                if let Some(cwd) = record.get("cwd").and_then(|value| value.as_str()) {
                    meta.project_path = cwd.to_string();
                }
            }

            if let Some(timestamp) = record.get("timestamp").and_then(|value| value.as_str()) {
                if meta.start_time.is_empty() {
                    meta.start_time = timestamp.to_string();
                }
                if let Some(parsed) = parse_rfc3339_timestamp(timestamp) {
                    first_seen = Some(first_seen.map_or(parsed, |current| current.min(parsed)));
                    last_seen = Some(last_seen.map_or(parsed, |current| current.max(parsed)));
                }
            }

            match record.get("type").and_then(|value| value.as_str()) {
                Some("user") => {
                    meta.user_message_count += 1;
                    if meta.first_prompt.is_empty() {
                        let text = extract_message_text(&record["message"]["content"]);
                        if !text.is_empty() {
                            meta.first_prompt = text;
                        }
                    }
                }
                Some("assistant") => {
                    meta.assistant_message_count += 1;
                    if let Some(blocks) = record
                        .get("message")
                        .and_then(|message| message.get("content"))
                        .and_then(|value| value.as_array())
                    {
                        for block in blocks {
                            if block.get("type").and_then(|value| value.as_str()) != Some("tool_use") {
                                continue;
                            }
                            let Some(name) = block.get("name").and_then(|value| value.as_str()) else {
                                continue;
                            };
                            *meta.tool_counts.entry(name.to_string()).or_insert(0) += 1;
                        }
                    }
                }
                _ => {}
            }
        }

        if meta.project_path.is_empty() {
            if let Some(encoded_dir_name) = path
                .parent()
                .and_then(|parent| parent.file_name())
                .and_then(|name| name.to_str())
            {
                meta.project_path = decode_project_path(encoded_dir_name).0.to_string_lossy().to_string();
            }
        }

        if meta.start_time.is_empty() || meta.project_path.is_empty() {
            continue;
        }

        if let (Some(first_seen), Some(last_seen)) = (first_seen, last_seen) {
            let duration = (last_seen - first_seen).whole_minutes();
            meta.duration_minutes = duration.max(0) as u64;
        }

        items.push(meta);
    }

    items
}

fn load_session_meta_files() -> Vec<SessionMetaFile> {
    let Some(home) = dirs_next::home_dir() else {
        return vec![];
    };
    let session_meta_root = home.join(".claude").join("usage-data").join("session-meta");
    let items = load_session_meta_files_from(&session_meta_root);
    if !items.is_empty() {
        return items;
    }

    synthesize_session_meta_files_from(&home.join(".claude").join("projects"))
}

fn load_session_json_metrics_from(root: &Path) -> HashMap<String, SessionJsonMetrics> {
    if !root.exists() {
        return HashMap::new();
    }

    let mut metrics = HashMap::<String, SessionJsonMetrics>::new();
    for entry in walkdir::WalkDir::new(root).into_iter().flatten() {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("jsonl") {
            continue;
        }
        if path_contains_component(path, "subagents") {
            continue;
        }

        let Some(session_id) = path.file_stem().and_then(|value| value.to_str()).map(|v| v.to_string()) else {
            continue;
        };
        let entry_metrics = metrics.entry(session_id).or_default();
        let Ok(file) = fs::File::open(path) else {
            continue;
        };

        for line in BufReader::new(file).lines().flatten() {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(record) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if record.get("type").and_then(|value| value.as_str()) != Some("assistant") {
                continue;
            }

            entry_metrics.messages += 1;
            let cost = record.get("costUSD").and_then(|value| value.as_f64()).unwrap_or(0.0);
            entry_metrics.cost_usd += cost;

            let input = record
                .get("usage")
                .and_then(|usage| usage.get("input_tokens"))
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            let output = record
                .get("usage")
                .and_then(|usage| usage.get("output_tokens"))
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            entry_metrics.input_tokens += input;
            entry_metrics.output_tokens += output;

            if let Some(timestamp) = record.get("timestamp").and_then(|value| value.as_str()) {
                if let Some(date) = iso_date_prefix(timestamp) {
                    let daily = entry_metrics.daily.entry(date).or_insert((0, 0.0));
                    daily.0 += input + output;
                    daily.1 += cost;
                }
            }

            if let Some(model) = record
                .get("message")
                .and_then(|message| message.get("model"))
                .and_then(|value| value.as_str())
            {
                let model_entry = entry_metrics
                    .models
                    .entry(model.to_string())
                    .or_insert((0, 0, 0.0));
                model_entry.0 += input;
                model_entry.1 += output;
                model_entry.2 += cost;
            }
        }
    }

    metrics
}

fn load_session_json_metrics() -> HashMap<String, SessionJsonMetrics> {
    let Some(home) = dirs_next::home_dir() else {
        return HashMap::new();
    };
    load_session_json_metrics_from(&home.join(".claude").join("projects"))
}

fn build_usage_dashboard(
    interval: String,
    session_meta: Vec<SessionMetaFile>,
    json_metrics: HashMap<String, SessionJsonMetrics>,
) -> UsageDashboard {
    let cutoff = parse_interval_cutoff(&interval);

    let filtered_meta: Vec<SessionMetaFile> = session_meta
        .into_iter()
        .filter(|meta| {
            if meta.first_prompt == "Unknown skill: usage" {
                return false;
            }
            match (&cutoff, iso_date_prefix(&meta.start_time)) {
                (Some(cutoff), Some(date)) => date >= *cutoff,
                (Some(_), None) => false,
                (None, _) => true,
            }
        })
        .collect();

    let mut daily_map = HashMap::<String, UsageDailyPoint>::new();
    let mut model_map = HashMap::<String, UsageModelBreakdown>::new();
    let mut project_map = HashMap::<String, UsageProjectBreakdown>::new();
    let mut sessions = Vec::<UsageSessionBreakdown>::new();
    let mut total_messages = 0u64;
    let mut total_input_tokens = 0u64;
    let mut total_output_tokens = 0u64;
    let mut total_cost_usd = 0.0f64;
    let mut total_tool_calls = 0u64;
    let mut total_lines_added = 0u64;
    let mut total_lines_removed = 0u64;
    let mut total_files_modified = 0u64;
    let mut active_days = std::collections::BTreeSet::<String>::new();

    for meta in &filtered_meta {
        let json = json_metrics.get(&meta.session_id).cloned().unwrap_or_default();
        let input_tokens = if json.input_tokens > 0 { json.input_tokens } else { meta.input_tokens };
        let output_tokens = if json.output_tokens > 0 { json.output_tokens } else { meta.output_tokens };
        let total_tokens = input_tokens + output_tokens;
        let messages = meta.user_message_count + meta.assistant_message_count;
        let cost_usd = json.cost_usd;
        let display_name = Path::new(&meta.project_path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&meta.project_path)
            .to_string();

        total_messages += messages;
        total_input_tokens += input_tokens;
        total_output_tokens += output_tokens;
        total_cost_usd += cost_usd;
        total_lines_added += meta.lines_added;
        total_lines_removed += meta.lines_removed;
        total_files_modified += meta.files_modified;
        total_tool_calls += meta.tool_counts.values().sum::<u64>();

        if let Some(date) = iso_date_prefix(&meta.start_time) {
            active_days.insert(date.clone());
            let entry = daily_map.entry(date.clone()).or_insert(UsageDailyPoint {
                date,
                sessions: 0,
                messages: 0,
                total_tokens: 0,
                cost_usd: 0.0,
            });
            entry.sessions += 1;
            entry.messages += messages;
            entry.total_tokens += total_tokens;
            entry.cost_usd += cost_usd;
        }

        for (date, (tokens, cost)) in json.daily {
            if let Some(cutoff) = cutoff.as_ref() {
                if date < *cutoff {
                    continue;
                }
            }
            active_days.insert(date.clone());
            let entry = daily_map.entry(date.clone()).or_insert(UsageDailyPoint {
                date,
                sessions: 0,
                messages: 0,
                total_tokens: 0,
                cost_usd: 0.0,
            });
            entry.total_tokens += tokens;
            entry.cost_usd += cost;
        }

        for (model, (input, output, cost)) in json.models {
            let entry = model_map.entry(model.clone()).or_insert(UsageModelBreakdown {
                model,
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
                cost_usd: 0.0,
                sessions: 0,
            });
            entry.input_tokens += input;
            entry.output_tokens += output;
            entry.total_tokens += input + output;
            entry.cost_usd += cost;
            entry.sessions += 1;
        }

        let project_entry = project_map
            .entry(meta.project_path.clone())
            .or_insert(UsageProjectBreakdown {
                project_path: meta.project_path.clone(),
                display_name: display_name.clone(),
                sessions: 0,
                messages: 0,
                input_tokens: 0,
                output_tokens: 0,
                total_tokens: 0,
                cost_usd: 0.0,
                lines_added: 0,
                lines_removed: 0,
                files_modified: 0,
                last_active: meta.start_time.clone(),
            });
        project_entry.sessions += 1;
        project_entry.messages += messages;
        project_entry.input_tokens += input_tokens;
        project_entry.output_tokens += output_tokens;
        project_entry.total_tokens += total_tokens;
        project_entry.cost_usd += cost_usd;
        project_entry.lines_added += meta.lines_added;
        project_entry.lines_removed += meta.lines_removed;
        project_entry.files_modified += meta.files_modified;
        if meta.start_time > project_entry.last_active {
            project_entry.last_active = meta.start_time.clone();
        }

        sessions.push(UsageSessionBreakdown {
            session_id: meta.session_id.clone(),
            project_path: meta.project_path.clone(),
            display_name,
            start_time: meta.start_time.clone(),
            duration_minutes: meta.duration_minutes,
            user_messages: meta.user_message_count,
            assistant_messages: meta.assistant_message_count,
            input_tokens,
            output_tokens,
            total_tokens,
            cost_usd,
            first_prompt: meta.first_prompt.clone(),
        });
    }

    let mut daily: Vec<UsageDailyPoint> = daily_map.into_values().collect();
    daily.sort_by(|a, b| a.date.cmp(&b.date));

    let mut models: Vec<UsageModelBreakdown> = model_map.into_values().collect();
    models.sort_by(|a, b| b.total_tokens.cmp(&a.total_tokens));

    let mut projects: Vec<UsageProjectBreakdown> = project_map.into_values().collect();
    projects.sort_by(|a, b| b.total_tokens.cmp(&a.total_tokens));

    sessions.sort_by(|a, b| b.start_time.cmp(&a.start_time));

    let total_sessions = sessions.len();
    let summary = UsageSummary {
        total_sessions,
        total_messages,
        total_input_tokens,
        total_output_tokens,
        total_tokens: total_input_tokens + total_output_tokens,
        total_cost_usd,
        total_tool_calls,
        total_lines_added,
        total_lines_removed,
        total_files_modified,
        active_days: active_days.len(),
        avg_messages_per_session: if total_sessions == 0 {
            0.0
        } else {
            total_messages as f64 / total_sessions as f64
        },
    };

    UsageDashboard {
        interval,
        summary,
        daily,
        models,
        projects,
        sessions,
    }
}

#[tauri::command]
fn get_usage_dashboard(interval: String) -> Result<UsageDashboard, String> {
    Ok(build_usage_dashboard(
        interval,
        load_session_meta_files(),
        load_session_json_metrics(),
    ))
}

fn sanitize_terminal_output(raw: &str) -> String {
    let ansi_re = Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").expect("ansi regex");
    let osc_re = Regex::new(r"\x1b\][^\x07]*(?:\x07|\x1b\\)").expect("osc regex");
    let mut text = osc_re.replace_all(raw, "").to_string();
    text = ansi_re.replace_all(&text, "").to_string();
    text = text
        .chars()
        .filter(|ch| *ch == '\n' || *ch == '\r' || *ch == '\t' || !ch.is_control())
        .collect();
    text = text.replace('\r', "");
    text
}

fn extract_percent_and_reset(lines: &[String], label_patterns: &[&str]) -> ClaudePlanUsageBucket {
    let percent_re = Regex::new(r"(?i)(\d{1,3}(?:\.\d+)?)\s*%").expect("percent regex");
    let reset_re = Regex::new(r"(?i)reset(?:s|ting)?(?:\s+(?:in|at|on))?\s*[:\-]?\s*(.+)$")
        .expect("reset regex");

    for index in 0..lines.len() {
        let line = &lines[index];
        let normalized = line.to_lowercase();
        if !label_patterns.iter().any(|pattern| normalized.contains(pattern)) {
            continue;
        }

        let section_end = (index + 5).min(lines.len().saturating_sub(1));
        let section = lines[index..=section_end].join(" ");
        let percent_used = percent_re
            .captures(&section)
            .and_then(|captures| captures.get(1))
            .and_then(|capture| capture.as_str().parse::<f64>().ok());

        let reset_at = lines[index..=section_end]
            .iter()
            .find_map(|candidate| {
                reset_re
                    .captures(candidate)
                    .and_then(|captures| captures.get(1))
                    .map(|capture| capture.as_str().trim().trim_matches('.').to_string())
            });

        if percent_used.is_some() || reset_at.is_some() {
            return ClaudePlanUsageBucket {
                percent_used,
                reset_at,
            };
        }
    }

    ClaudePlanUsageBucket::default()
}

fn parse_plan_usage(raw: &str) -> ClaudePlanUsage {
    let sanitized = sanitize_terminal_output(raw);
    let lines: Vec<String> = sanitized
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .collect();

    ClaudePlanUsage {
        current_session: extract_percent_and_reset(&lines, &["current session"]),
        weekly_limits: extract_percent_and_reset(&lines, &["weekly limits", "weekly limit"]),
        fetched_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64,
        is_live: true,
    }
}

fn fetch_plan_usage(workspace_path: String, session_id: Option<String>) -> Result<ClaudePlanUsage, String> {
    let cwd = PathBuf::from(&workspace_path);
    if !cwd.exists() || !cwd.is_dir() {
        return Err("Workspace path does not exist".to_string());
    }

    let (claude_bin, full_path) = claude_binary_and_path();
    let mut cmd = std::process::Command::new(&claude_bin);
    cmd.current_dir(&cwd);
    cmd.env("PATH", &full_path);
    cmd.arg("--output-format").arg("json");
    cmd.arg("-p").arg("/usage");
    if let Some(session_id) = session_id.as_ref().filter(|value| !value.trim().is_empty()) {
        cmd.arg("--resume");
        cmd.arg(session_id);
    }
    let output = cmd.output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let payload = serde_json::from_str::<serde_json::Value>(&stdout)
        .map_err(|_| "Unable to parse Claude /usage JSON response.".to_string())?;
    let result_text = payload
        .get("result")
        .and_then(|value| value.as_str())
        .unwrap_or("");
    let usage = parse_plan_usage(result_text);
    if usage.current_session.percent_used.is_none()
        && usage.current_session.reset_at.is_none()
        && usage.weekly_limits.percent_used.is_none()
        && usage.weekly_limits.reset_at.is_none()
    {
        return Err("Unable to parse Claude plan usage.".to_string());
    }

    Ok(usage)
}

fn parse_claude_session_init(stdout: &str) -> Option<ClaudeSessionInit> {
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        if value.get("type").and_then(|v| v.as_str()) != Some("system")
            || value.get("subtype").and_then(|v| v.as_str()) != Some("init")
        {
            continue;
        }

        let tools = value
            .get("tools")
            .and_then(|v| v.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let mcp_servers = extract_mcp_server_names(value.get("mcp_servers"));

        return Some(ClaudeSessionInit {
            session_id: value.get("session_id").and_then(|v| v.as_str()).map(|s| s.to_string()),
            cwd: value.get("cwd").and_then(|v| v.as_str()).map(|s| s.to_string()),
            model: value.get("model").and_then(|v| v.as_str()).map(|s| s.to_string()),
            tools,
            mcp_servers,
        });
    }

    None
}

fn run_claude_session_init_probe(
    claude_bin: &str,
    full_path: &str,
    cwd: &Path,
    use_no_session_persistence: bool,
) -> Result<std::process::Output, String> {
    let mut cmd = std::process::Command::new(claude_bin);
    cmd.current_dir(cwd);
    cmd.env("PATH", full_path);
    cmd.arg("-p")
        .arg("--verbose")
        .arg("--output-format")
        .arg("stream-json");

    if use_no_session_persistence {
        cmd.arg("--no-session-persistence");
    }

    cmd.arg("--permission-mode")
        .arg("dontAsk")
        .arg("/status")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    cmd.output().map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_claude_session_init(workspace_path: String) -> Result<ClaudeSessionInit, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cwd = PathBuf::from(&workspace_path);
        if !cwd.exists() || !cwd.is_dir() {
            return Err("Workspace path does not exist".to_string());
        }

        let (claude_bin, full_path) = claude_binary_and_path();
        let first_output = run_claude_session_init_probe(&claude_bin, &full_path, &cwd, true)?;
        let first_stdout = String::from_utf8_lossy(&first_output.stdout);
        if let Some(init) = parse_claude_session_init(&first_stdout) {
            return Ok(init);
        }

        let first_stderr = String::from_utf8_lossy(&first_output.stderr);
        if first_stderr.contains("unknown option '--no-session-persistence'") {
            let fallback_output = run_claude_session_init_probe(&claude_bin, &full_path, &cwd, false)?;
            let fallback_stdout = String::from_utf8_lossy(&fallback_output.stdout);
            if let Some(init) = parse_claude_session_init(&fallback_stdout) {
                return Ok(init);
            }

            let fallback_stderr = String::from_utf8_lossy(&fallback_output.stderr);
            return Err(if fallback_stderr.trim().is_empty() {
                "Unable to fetch Claude session initialization metadata.".to_string()
            } else {
                fallback_stderr.trim().to_string()
            });
        }

        Err(if first_stderr.trim().is_empty() {
            "Unable to fetch Claude session initialization metadata.".to_string()
        } else {
            first_stderr.trim().to_string()
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
fn get_session_messages(file_path: String) -> Vec<serde_json::Value> {
    eprintln!("[get_session_messages] file_path={:?}", file_path);
    let file = match fs::File::open(&file_path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[get_session_messages] open error: {}", e);
            return vec![];
        }
    };
    let records: Vec<serde_json::Value> = BufReader::new(file)
        .lines()
        .flatten()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(&l).ok())
        .collect();
    eprintln!("[get_session_messages] parsed {} records", records.len());
    records
}

fn delete_session_files_for_path(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Invalid session path".to_string())?
        .to_path_buf();
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid session filename".to_string())?
        .to_string();

    let mut removed_any = false;
    for entry in fs::read_dir(&parent).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let entry_path = entry.path();
        let entry_stem = entry_path.file_stem().and_then(|value| value.to_str());
        if entry_stem != Some(stem.as_str()) {
            continue;
        }

        if entry_path.is_file() {
            fs::remove_file(&entry_path).map_err(|e| e.to_string())?;
            removed_any = true;
        }
    }

    if !removed_any && path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn delete_session_file(file_path: String) -> Result<(), String> {
    delete_session_files_for_path(&PathBuf::from(file_path))
}

fn scan_existing_sessions_in(claude_projects_dir: &Path, home: &Path) -> Vec<DiscoveredWorkspace> {
    if !claude_projects_dir.exists() {
        return vec![];
    }

    let mut workspaces: Vec<DiscoveredWorkspace> = fs::read_dir(&claude_projects_dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            if !path.is_dir() {
                return None;
            }
            let dir_name = path.file_name()?.to_str()?.to_string();
            let (real_path, path_exists) = decode_project_path_with_home(&dir_name, home);
            Some(collect_workspace_from_project_dir(&path, dir_name, real_path, path_exists))
        })
        .collect();

    workspaces.sort_by(|a, b| {
        b.path_exists.cmp(&a.path_exists).then_with(|| {
            let a_t = a.sessions.first().map(|s| s.modified_at.as_str()).unwrap_or("");
            let b_t = b.sessions.first().map(|s| s.modified_at.as_str()).unwrap_or("");
            b_t.cmp(a_t)
        })
    });

    workspaces
}

#[tauri::command]
fn scan_existing_sessions() -> Vec<DiscoveredWorkspace> {
    let home = dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let claude_projects_dir = home.join(".claude").join("projects");
    scan_existing_sessions_in(&claude_projects_dir, &home)
}

#[tauri::command]
fn describe_workspace(workspace_path: String) -> DiscoveredWorkspace {
    let real_path = PathBuf::from(&workspace_path);
    let encoded_name = claude_encode(&workspace_path);
    let project_dir = dirs_next::home_dir()
        .unwrap_or_else(|| PathBuf::from("/"))
        .join(".claude")
        .join("projects")
        .join(&encoded_name);

    if project_dir.exists() && project_dir.is_dir() {
        return collect_workspace_from_project_dir(&project_dir, encoded_name, real_path.clone(), real_path.exists());
    }

    let decoded_path = real_path.to_string_lossy().to_string();
    let display_name = real_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&decoded_path)
        .to_string();

    DiscoveredWorkspace {
        encoded_name,
        decoded_path,
        display_name,
        path_exists: real_path.exists(),
        sessions: vec![],
    }
}

#[tauri::command]
fn get_claude_account_info() -> ClaudeAccountInfo {
    let home = match dirs_next::home_dir() {
        Some(h) => h,
        None => return ClaudeAccountInfo::default(),
    };

    let path = home.join(".claude.json");
    let raw = match fs::read_to_string(path) {
        Ok(v) => v,
        Err(_) => return ClaudeAccountInfo::default(),
    };

    let json: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return ClaudeAccountInfo::default(),
    };

    let oauth = match json.get("oauthAccount") {
        Some(v) => v,
        None => return ClaudeAccountInfo::default(),
    };

    let get_str = |k: &str| -> Option<String> {
        oauth
            .get(k)
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };

    ClaudeAccountInfo {
        email: get_str("emailAddress"),
        display_name: get_str("displayName"),
        organization_name: get_str("organizationName"),
        organization_role: get_str("organizationRole"),
    }
}

#[tauri::command]
fn get_claude_plan_usage(
    cache: State<PlanUsageCache>,
    workspace_path: String,
    session_id: Option<String>,
) -> Result<ClaudePlanUsage, String> {
    let cache_key = format!(
        "{}::{}",
        workspace_path,
        session_id.as_deref().unwrap_or("")
    );
    {
        let cache_guard = cache
            .entries
            .lock()
            .map_err(|_| "Plan usage cache lock poisoned".to_string())?;
        if let Some(entry) = cache_guard.get(&cache_key) {
            if entry.fetched_at.elapsed() < Duration::from_secs(60) {
                return Ok(entry.usage.clone());
            }
        }
    }

    let usage = fetch_plan_usage(workspace_path.clone(), session_id)?;
    let mut cache_guard = cache
        .entries
        .lock()
        .map_err(|_| "Plan usage cache lock poisoned".to_string())?;
    cache_guard.insert(cache_key, CachedPlanUsage {
        usage: usage.clone(),
        fetched_at: Instant::now(),
    });
    Ok(usage)
}

#[tauri::command]
fn get_workspace_favicon(workspace_path: String) -> Option<String> {
    let workspace = PathBuf::from(workspace_path);
    if !workspace.exists() || !workspace.is_dir() {
        return None;
    }

    let candidates = [
        "favicon.ico",
        "favicon.png",
        "favicon.svg",
        "icon.png",
        "icon.svg",
        "public/favicon.ico",
        "public/favicon.png",
        "public/favicon.svg",
        "public/icon.png",
        "public/icon.svg",
        "static/favicon.ico",
        "static/favicon.png",
        "static/favicon.svg",
        "src/assets/favicon.ico",
        "src/assets/favicon.png",
        "src/assets/favicon.svg",
        "app/favicon.ico",
        "app/favicon.png",
        "apple-touch-icon.png",
    ];

    for rel in candidates {
        let p = workspace.join(rel);
        if p.exists() && p.is_file() {
            if let Some(data_url) = file_to_data_url(&p) {
                return Some(data_url);
            }
        }
    }

    for entry in walkdir::WalkDir::new(&workspace)
        .max_depth(3)
        .follow_links(false)
        .into_iter()
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let file_name = match path.file_name().and_then(|n| n.to_str()) {
            Some(v) => v.to_lowercase(),
            None => continue,
        };
        let ext = match path.extension().and_then(|e| e.to_str()) {
            Some(v) => v.to_lowercase(),
            None => continue,
        };
        if !["ico", "png", "svg", "jpg", "jpeg", "webp"].contains(&ext.as_str()) {
            continue;
        }
        if !(file_name.contains("favicon") || file_name == "icon.png" || file_name == "icon.svg") {
            continue;
        }
        if let Some(data_url) = file_to_data_url(path) {
            return Some(data_url);
        }
    }

    None
}

fn file_to_data_url(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if metadata.len() > 2 * 1024 * 1024 {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    let ext = path.extension()?.to_str()?.to_lowercase();
    let mime = match ext.as_str() {
        "ico" => "image/x-icon",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => return None,
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Some(format!("data:{};base64,{}", mime, encoded))
}

fn should_skip_dir_name(name: &str) -> bool {
    matches!(
        name,
        ".git"
            | "node_modules"
            | "dist"
            | "build"
            | "target"
            | ".next"
            | ".nuxt"
            | ".turbo"
            | ".cache"
            | ".claude"
            | ".codex"
            | ".idea"
            | ".vscode"
            | "coverage"
    )
}

fn extract_frontmatter(raw: &str) -> Option<&str> {
    let mut lines = raw.lines();
    if lines.next()?.trim() != "---" {
        return None;
    }

    let mut end_offset: usize = 4;
    for line in lines {
        if line.trim() == "---" {
            return raw.get(4..end_offset.saturating_sub(1));
        }
        end_offset += line.len() + 1;
    }

    None
}

fn parse_frontmatter_value(frontmatter: &str, key: &str) -> Option<String> {
    frontmatter.lines().find_map(|line| {
        let trimmed = line.trim();
        let (raw_key, raw_value) = trimmed.split_once(':')?;
        if raw_key.trim() != key {
            return None;
        }
        let value = raw_value.trim().trim_matches('"').trim_matches('\'').trim();
        if value.is_empty() {
            None
        } else {
            Some(value.to_string())
        }
    })
}

fn frontmatter_flag(frontmatter: &str, key: &str) -> Option<bool> {
    parse_frontmatter_value(frontmatter, key).and_then(|value| match value.as_str() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    })
}

fn collect_custom_slash_commands(
    root: &Path,
    source: &str,
    is_skill_dir: bool,
    commands: &mut Vec<SlashCommandInfo>,
) {
    if !root.exists() || !root.is_dir() {
        return;
    }

    for entry in walkdir::WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }

        let path = entry.path();
        let is_match = if is_skill_dir {
            path.file_name().and_then(|name| name.to_str()) == Some("SKILL.md")
        } else {
            path.extension().and_then(|ext| ext.to_str()) == Some("md")
        };
        if !is_match {
            continue;
        }

        let raw = match fs::read_to_string(path) {
            Ok(value) => value,
            Err(_) => continue,
        };

        let frontmatter = extract_frontmatter(&raw).unwrap_or("");
        if frontmatter_flag(frontmatter, "user-invocable") == Some(false) {
            continue;
        }

        let fallback_name = if is_skill_dir {
            path.parent()
                .and_then(|parent| parent.file_name())
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_string()
        } else {
            path.file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or_default()
                .to_string()
        };

        let name = parse_frontmatter_value(frontmatter, "name").unwrap_or(fallback_name);
        if name.is_empty() {
            continue;
        }

        commands.push(SlashCommandInfo {
            name,
            description: parse_frontmatter_value(frontmatter, "description"),
            argument_hint: parse_frontmatter_value(frontmatter, "argument-hint"),
            source: source.to_string(),
            kind: if is_skill_dir { "skill".to_string() } else { "command".to_string() },
        });
    }
}

fn claude_skills_dir() -> Result<PathBuf, String> {
    let home = dirs_next::home_dir().ok_or_else(|| "Home directory is not available".to_string())?;
    Ok(home.join(".claude").join("skills"))
}

fn inspect_skill_dir(path: &Path) -> Result<InstalledSkill, String> {
    let folder_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid skill directory name".to_string())?
        .to_string();
    let skill_file = path.join("SKILL.md");
    let raw = fs::read_to_string(&skill_file)
        .map_err(|_| format!("{} is missing SKILL.md", path.display()))?;
    let frontmatter = extract_frontmatter(&raw).unwrap_or("");
    let display_name = parse_frontmatter_value(frontmatter, "name").unwrap_or_else(|| folder_name.clone());
    Ok(InstalledSkill {
        folder_name,
        display_name,
        description: parse_frontmatter_value(frontmatter, "description"),
        path: path.to_string_lossy().to_string(),
    })
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination).map_err(|e| e.to_string())?;

    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let file_type = entry.file_type().map_err(|e| e.to_string())?;

        if file_type.is_dir() {
            if entry.file_name().to_str() == Some(".git") {
                continue;
            }
            copy_dir_recursive(&source_path, &destination_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &destination_path).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

fn run_command(program: &str, args: &[&str], cwd: Option<&Path>) -> Result<(), String> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }

    let output = cmd.output().map_err(|e| format!("Failed to run {program}: {e}"))?;
    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let detail = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("{program} exited with {}", output.status)
    };
    Err(detail)
}

fn copy_skill_into_claude_dir(source_dir: &Path, destination_name: &str) -> Result<InstalledSkill, String> {
    let skill_file = source_dir.join("SKILL.md");
    if !skill_file.exists() {
        return Err("Selected folder does not contain SKILL.md".to_string());
    }

    let skills_root = claude_skills_dir()?;
    fs::create_dir_all(&skills_root).map_err(|e| e.to_string())?;
    let destination = skills_root.join(destination_name);
    if destination.exists() {
        return Err(format!("Skill \"{destination_name}\" is already installed"));
    }

    copy_dir_recursive(source_dir, &destination)?;
    inspect_skill_dir(&destination)
}

fn install_catalog_skill_into_claude_dir(entry: &SkillCatalogEntry) -> Result<InstalledSkill, String> {
    let temp_root = std::env::temp_dir().join(format!(
        "claudy-skill-{}-{}",
        entry.id,
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    ));

    let result = (|| {
        let repo_url = format!("https://github.com/{}.git", entry.github_repo);
        let temp_root_str = temp_root.to_string_lossy().to_string();
        run_command(
            "git",
            &["clone", "--depth", "1", "--branch", &entry.github_ref, "--filter=blob:none", "--sparse", &repo_url, &temp_root_str],
            None,
        )?;

        let source_dir = if entry.github_path.trim().is_empty() {
            temp_root.clone()
        } else {
            run_command("git", &["sparse-checkout", "set", "--no-cone", &entry.github_path], Some(&temp_root))?;
            temp_root.join(&entry.github_path)
        };

        if !source_dir.exists() {
            return Err(format!("Skill source {} was not found in {}", entry.github_path, entry.github_repo));
        }

        copy_skill_into_claude_dir(&source_dir, &entry.destination_name)
    })();

    if temp_root.exists() {
        let _ = fs::remove_dir_all(&temp_root);
    }

    result
}

fn skill_catalog() -> Vec<SkillCatalogEntry> {
    vec![
        SkillCatalogEntry {
            id: "anthropics-algorithmic-art".to_string(),
            name: "algorithmic-art".to_string(),
            description: Some("Generative and algorithmic art workflows.".to_string()),
            repo_label: "anthropics/skills".to_string(),
            repo_url: "https://github.com/anthropics/skills/tree/main/skills".to_string(),
            github_repo: "anthropics/skills".to_string(),
            github_ref: "main".to_string(),
            github_path: "skills/algorithmic-art".to_string(),
            destination_name: "algorithmic-art".to_string(),
        },
        SkillCatalogEntry {
            id: "anthropics-frontend-design".to_string(),
            name: "frontend-design".to_string(),
            description: Some("UI and interaction design guidance.".to_string()),
            repo_label: "anthropics/skills".to_string(),
            repo_url: "https://github.com/anthropics/skills/tree/main/skills".to_string(),
            github_repo: "anthropics/skills".to_string(),
            github_ref: "main".to_string(),
            github_path: "skills/frontend-design".to_string(),
            destination_name: "frontend-design".to_string(),
        },
        SkillCatalogEntry {
            id: "anthropics-mcp-builder".to_string(),
            name: "mcp-builder".to_string(),
            description: Some("Build and package MCP servers.".to_string()),
            repo_label: "anthropics/skills".to_string(),
            repo_url: "https://github.com/anthropics/skills/tree/main/skills".to_string(),
            github_repo: "anthropics/skills".to_string(),
            github_ref: "main".to_string(),
            github_path: "skills/mcp-builder".to_string(),
            destination_name: "mcp-builder".to_string(),
        },
        SkillCatalogEntry {
            id: "anthropics-web-artifacts-builder".to_string(),
            name: "web-artifacts-builder".to_string(),
            description: Some("Create standalone HTML artifacts.".to_string()),
            repo_label: "anthropics/skills".to_string(),
            repo_url: "https://github.com/anthropics/skills/tree/main/skills".to_string(),
            github_repo: "anthropics/skills".to_string(),
            github_ref: "main".to_string(),
            github_path: "skills/web-artifacts-builder".to_string(),
            destination_name: "web-artifacts-builder".to_string(),
        },
        SkillCatalogEntry {
            id: "anthropics-webapp-testing".to_string(),
            name: "webapp-testing".to_string(),
            description: Some("Test browser workflows and regressions.".to_string()),
            repo_label: "anthropics/skills".to_string(),
            repo_url: "https://github.com/anthropics/skills/tree/main/skills".to_string(),
            github_repo: "anthropics/skills".to_string(),
            github_ref: "main".to_string(),
            github_path: "skills/webapp-testing".to_string(),
            destination_name: "webapp-testing".to_string(),
        },
        SkillCatalogEntry {
            id: "obra-brainstorming".to_string(),
            name: "brainstorming".to_string(),
            description: Some("Generate and refine solution options.".to_string()),
            repo_label: "obra/superpowers".to_string(),
            repo_url: "https://github.com/obra/superpowers/tree/main/skills".to_string(),
            github_repo: "obra/superpowers".to_string(),
            github_ref: "main".to_string(),
            github_path: "skills/brainstorming".to_string(),
            destination_name: "brainstorming".to_string(),
        },
        SkillCatalogEntry {
            id: "obra-complex-problem-solving".to_string(),
            name: "complex-problem-solving".to_string(),
            description: Some("Structure and solve harder engineering tasks.".to_string()),
            repo_label: "obra/superpowers".to_string(),
            repo_url: "https://github.com/obra/superpowers/tree/main/skills".to_string(),
            github_repo: "obra/superpowers".to_string(),
            github_ref: "main".to_string(),
            github_path: "skills/complex-problem-solving".to_string(),
            destination_name: "complex-problem-solving".to_string(),
        },
        SkillCatalogEntry {
            id: "obra-systematic-debugging".to_string(),
            name: "systematic-debugging".to_string(),
            description: Some("Debug issues with repeatable investigation steps.".to_string()),
            repo_label: "obra/superpowers".to_string(),
            repo_url: "https://github.com/obra/superpowers/tree/main/skills".to_string(),
            github_repo: "obra/superpowers".to_string(),
            github_ref: "main".to_string(),
            github_path: "skills/systematic-debugging".to_string(),
            destination_name: "systematic-debugging".to_string(),
        },
        SkillCatalogEntry {
            id: "obra-test-driven-development".to_string(),
            name: "test-driven-development".to_string(),
            description: Some("Drive implementation from tests.".to_string()),
            repo_label: "obra/superpowers".to_string(),
            repo_url: "https://github.com/obra/superpowers/tree/main/skills".to_string(),
            github_repo: "obra/superpowers".to_string(),
            github_ref: "main".to_string(),
            github_path: "skills/test-driven-development".to_string(),
            destination_name: "test-driven-development".to_string(),
        },
        SkillCatalogEntry {
            id: "obra-verification-before-completion".to_string(),
            name: "verification-before-completion".to_string(),
            description: Some("Validate changes before marking work done.".to_string()),
            repo_label: "obra/superpowers".to_string(),
            repo_url: "https://github.com/obra/superpowers/tree/main/skills".to_string(),
            github_repo: "obra/superpowers".to_string(),
            github_ref: "main".to_string(),
            github_path: "skills/verification-before-completion".to_string(),
            destination_name: "verification-before-completion".to_string(),
        },
        SkillCatalogEntry {
            id: "kdense-astropy".to_string(),
            name: "astropy".to_string(),
            description: Some("Astropy-based astronomy workflows.".to_string()),
            repo_label: "K-Dense-AI/claude-scientific-skills".to_string(),
            repo_url: "https://github.com/K-Dense-AI/claude-scientific-skills/tree/main/scientific-skills".to_string(),
            github_repo: "K-Dense-AI/claude-scientific-skills".to_string(),
            github_ref: "main".to_string(),
            github_path: "scientific-skills/astropy".to_string(),
            destination_name: "astropy".to_string(),
        },
        SkillCatalogEntry {
            id: "kdense-biopython".to_string(),
            name: "biopython".to_string(),
            description: Some("Bioinformatics workflows with Biopython.".to_string()),
            repo_label: "K-Dense-AI/claude-scientific-skills".to_string(),
            repo_url: "https://github.com/K-Dense-AI/claude-scientific-skills/tree/main/scientific-skills".to_string(),
            github_repo: "K-Dense-AI/claude-scientific-skills".to_string(),
            github_ref: "main".to_string(),
            github_path: "scientific-skills/biopython".to_string(),
            destination_name: "biopython".to_string(),
        },
        SkillCatalogEntry {
            id: "kdense-deepchem".to_string(),
            name: "deepchem".to_string(),
            description: Some("DeepChem workflows for cheminformatics.".to_string()),
            repo_label: "K-Dense-AI/claude-scientific-skills".to_string(),
            repo_url: "https://github.com/K-Dense-AI/claude-scientific-skills/tree/main/scientific-skills".to_string(),
            github_repo: "K-Dense-AI/claude-scientific-skills".to_string(),
            github_ref: "main".to_string(),
            github_path: "scientific-skills/deepchem".to_string(),
            destination_name: "deepchem".to_string(),
        },
        SkillCatalogEntry {
            id: "kdense-exploratory-data-analysis".to_string(),
            name: "exploratory-data-analysis".to_string(),
            description: Some("Explore and summarize scientific data.".to_string()),
            repo_label: "K-Dense-AI/claude-scientific-skills".to_string(),
            repo_url: "https://github.com/K-Dense-AI/claude-scientific-skills/tree/main/scientific-skills".to_string(),
            github_repo: "K-Dense-AI/claude-scientific-skills".to_string(),
            github_ref: "main".to_string(),
            github_path: "scientific-skills/exploratory-data-analysis".to_string(),
            destination_name: "exploratory-data-analysis".to_string(),
        },
        SkillCatalogEntry {
            id: "kdense-fred-economic-data".to_string(),
            name: "fred-economic-data".to_string(),
            description: Some("Analyze FRED economic series.".to_string()),
            repo_label: "K-Dense-AI/claude-scientific-skills".to_string(),
            repo_url: "https://github.com/K-Dense-AI/claude-scientific-skills/tree/main/scientific-skills".to_string(),
            github_repo: "K-Dense-AI/claude-scientific-skills".to_string(),
            github_ref: "main".to_string(),
            github_path: "scientific-skills/fred-economic-data".to_string(),
            destination_name: "fred-economic-data".to_string(),
        },
        SkillCatalogEntry {
            id: "chrisvoncsefalvay-claude-d3js-skill".to_string(),
            name: "claude-d3js-skill".to_string(),
            description: Some("D3.js charting and visualization workflows.".to_string()),
            repo_label: "chrisvoncsefalvay/claude-d3js-skill".to_string(),
            repo_url: "https://github.com/chrisvoncsefalvay/claude-d3js-skill".to_string(),
            github_repo: "chrisvoncsefalvay/claude-d3js-skill".to_string(),
            github_ref: "main".to_string(),
            github_path: "".to_string(),
            destination_name: "claude-d3js-skill".to_string(),
        },
        SkillCatalogEntry {
            id: "lackeyjb-playwright-skill".to_string(),
            name: "playwright-skill".to_string(),
            description: Some("Playwright testing workflows for Claude.".to_string()),
            repo_label: "lackeyjb/playwright-skill".to_string(),
            repo_url: "https://github.com/lackeyjb/playwright-skill/tree/main/skills/playwright-skill".to_string(),
            github_repo: "lackeyjb/playwright-skill".to_string(),
            github_ref: "main".to_string(),
            github_path: "skills/playwright-skill".to_string(),
            destination_name: "playwright-skill".to_string(),
        },
        SkillCatalogEntry {
            id: "alonw0-web-asset-generator".to_string(),
            name: "web-asset-generator".to_string(),
            description: Some("Generate production-ready web assets.".to_string()),
            repo_label: "alonw0/web-asset-generator".to_string(),
            repo_url: "https://github.com/alonw0/web-asset-generator/tree/main/skills/web-asset-generator".to_string(),
            github_repo: "alonw0/web-asset-generator".to_string(),
            github_ref: "main".to_string(),
            github_path: "skills/web-asset-generator".to_string(),
            destination_name: "web-asset-generator".to_string(),
        },
    ]
}

#[tauri::command]
fn list_installed_skills() -> Result<Vec<InstalledSkill>, String> {
    let skills_root = claude_skills_dir()?;
    if !skills_root.exists() {
        return Ok(Vec::new());
    }

    let mut skills = Vec::new();
    for entry in fs::read_dir(&skills_root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() || !path.join("SKILL.md").exists() {
            continue;
        }
        if let Ok(skill) = inspect_skill_dir(&path) {
            skills.push(skill);
        }
    }

    skills.sort_by(|a, b| a.display_name.to_lowercase().cmp(&b.display_name.to_lowercase()));
    Ok(skills)
}

#[tauri::command]
fn get_skill_catalog() -> Vec<SkillCatalogEntry> {
    skill_catalog()
}

#[tauri::command]
fn install_skill_from_folder(folder_path: String) -> Result<InstalledSkill, String> {
    let source_dir = PathBuf::from(&folder_path);
    copy_skill_into_claude_dir(&source_dir, Path::new(&folder_path)
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Invalid skill folder".to_string())?)
}

#[tauri::command]
fn install_catalog_skill(skill_id: String) -> Result<InstalledSkill, String> {
    let entry = skill_catalog()
        .into_iter()
        .find(|item| item.id == skill_id)
        .ok_or_else(|| "Unknown catalog skill".to_string())?;
    install_catalog_skill_into_claude_dir(&entry)
}

#[tauri::command]
fn delete_installed_skill(folder_name: String) -> Result<(), String> {
    if folder_name.trim().is_empty() || folder_name.contains('/') || folder_name.contains('\\') {
        return Err("Invalid skill name".to_string());
    }

    let path = claude_skills_dir()?.join(folder_name);
    if !path.exists() {
        return Ok(());
    }
    fs::remove_dir_all(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_workspace_files(workspace_path: String) -> Vec<String> {
    let workspace = PathBuf::from(workspace_path);
    if !workspace.exists() || !workspace.is_dir() {
        return vec![];
    }

    let mut files = Vec::new();

    for entry in walkdir::WalkDir::new(&workspace)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            if !entry.file_type().is_dir() {
                return true;
            }
            entry
                .file_name()
                .to_str()
                .map(|name| !should_skip_dir_name(name))
                .unwrap_or(false)
        })
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }

        let Ok(relative) = entry.path().strip_prefix(&workspace) else {
            continue;
        };

        let Some(relative_str) = relative.to_str() else {
            continue;
        };

        if relative_str.is_empty() {
            continue;
        }

        files.push(relative_str.replace('\\', "/"));

        if files.len() >= 3_000 {
            break;
        }
    }

    files.sort();
    files
}

#[tauri::command]
fn get_workspace_slash_commands(workspace_path: String) -> Vec<SlashCommandInfo> {
    let workspace = PathBuf::from(workspace_path);
    let mut commands = Vec::new();

    if let Some(home) = dirs_next::home_dir() {
        collect_custom_slash_commands(
            &home.join(".claude").join("commands"),
            "user",
            false,
            &mut commands,
        );
        collect_custom_slash_commands(
            &home.join(".claude").join("skills"),
            "user",
            true,
            &mut commands,
        );
    }

    collect_custom_slash_commands(
        &workspace.join(".claude").join("commands"),
        "project",
        false,
        &mut commands,
    );
    collect_custom_slash_commands(
        &workspace.join(".claude").join("skills"),
        "project",
        true,
        &mut commands,
    );

    commands.sort_by(|a, b| a.name.cmp(&b.name));
    commands.dedup_by(|a, b| a.name == b.name);
    commands
}

#[tauri::command]
fn start_interactive_command(
    app: AppHandle,
    store: State<InteractiveSessionStore>,
    workspace_path: String,
    initial_input: Option<String>,
) -> Result<String, String> {
    let cwd = PathBuf::from(&workspace_path);
    if !cwd.exists() || !cwd.is_dir() {
        return Err("Workspace path does not exist".to_string());
    }

    let (claude_bin, full_path) = claude_binary_and_path();
    let session_id = format!("interactive-{}", NEXT_INTERACTIVE_ID.fetch_add(1, Ordering::Relaxed));
    let pty_system = native_pty_system();
    let pty_pair = pty_system
        .openpty(interactive_pty_size(140, 40))
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&claude_bin);
    cmd.cwd(&cwd);
    cmd.env("PATH", &full_path);

    let child = pty_pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;
    let writer = pty_pair
        .master
        .take_writer()
        .map_err(|e| e.to_string())?;
    let stdout = pty_pair
        .master
        .try_clone_reader()
        .map_err(|e| e.to_string())?;

    drop(pty_pair.slave);

    let child = Arc::new(Mutex::new(child));
    let writer = Arc::new(Mutex::new(writer));
    let master = Arc::new(Mutex::new(pty_pair.master));

    {
        let mut sessions = store.sessions.lock().map_err(|_| "Interactive session lock poisoned".to_string())?;
        sessions.insert(
            session_id.clone(),
            InteractiveSession {
                child: Arc::clone(&child),
                writer: Arc::clone(&writer),
                master: Arc::clone(&master),
            },
        );
    }

    if let Some(initial_input) = initial_input
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        eprintln!(
            "[claude interactive input] {}",
            escape_for_log(&initial_input, 500)
        );
        let initial_writer = Arc::clone(&writer);
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1200));
            if let Ok(mut writer) = initial_writer.lock() {
                let _ = writer.write_all(initial_input.as_bytes());
                let _ = writer.flush();
                std::thread::sleep(std::time::Duration::from_millis(120));
                let _ = writer.write_all(b"\r");
                let _ = writer.flush();
            }
        });
    }

    let stdout_session_id = session_id.clone();
    let stdout_app = app.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buffer = [0u8; 4096];
        loop {
            let Ok(read) = reader.read(&mut buffer) else {
                break;
            };
            if read == 0 {
                break;
            }
            let chunk = String::from_utf8_lossy(&buffer[..read]).to_string();
            let _ = stdout_app.emit(
                "claudy://interactive-output",
                InteractiveOutputPayload {
                    session_id: stdout_session_id.clone(),
                    data: chunk,
                },
            );
        }
    });

    let wait_session_id = session_id.clone();
    let wait_app = app.clone();
    let wait_child = Arc::clone(&child);
    std::thread::spawn(move || {
        if let Ok(mut child) = wait_child.lock() {
            let _ = child.wait();
        }
        let state = wait_app.state::<InteractiveSessionStore>();
        if let Ok(mut sessions) = state.sessions.lock() {
            sessions.remove(&wait_session_id);
        }
        let _ = wait_app.emit(
            "claudy://interactive-exit",
            InteractiveExitPayload {
                session_id: wait_session_id,
            },
        );
    });

    Ok(session_id)
}

#[tauri::command]
fn write_interactive_command(
    store: State<InteractiveSessionStore>,
    session_id: String,
    input: String,
) -> Result<(), String> {
    eprintln!(
        "[claude interactive input] session={} input={}",
        session_id,
        escape_for_log(&input, 500)
    );
    let sessions = store.sessions.lock().map_err(|_| "Interactive session lock poisoned".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Interactive session not found".to_string())?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "Interactive stdin lock poisoned".to_string())?;
    writer
        .write_all(input.as_bytes())
        .map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn resize_interactive_command(
    store: State<InteractiveSessionStore>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = store
        .sessions
        .lock()
        .map_err(|_| "Interactive session lock poisoned".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "Interactive session not found".to_string())?;
    let master = session
        .master
        .lock()
        .map_err(|_| "Interactive master lock poisoned".to_string())?;
    master
        .resize(interactive_pty_size(cols, rows))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn close_interactive_command(
    store: State<InteractiveSessionStore>,
    session_id: String,
) -> Result<(), String> {
    let session = {
        let mut sessions = store.sessions.lock().map_err(|_| "Interactive session lock poisoned".to_string())?;
        sessions.remove(&session_id)
    };

    let Some(session) = session else {
        return Ok(());
    };

    std::thread::spawn(move || {
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
        }
    });

    Ok(())
}

// ─── Send message ─────────────────────────────────────────────────────────────

fn spawn_claude_message(
    app: AppHandle,
    session_id: Option<String>,
    cwd: String,
    message: String,
    model: String,
    effort: String,
    allowed_tools: Option<Vec<String>>,
) -> Result<(), String> {
    std::thread::spawn(move || {
        let (claude_bin, full_path) = claude_binary_and_path();

        eprintln!("[send_message] claude={} cwd={} session={:?}", claude_bin, cwd, session_id);
        eprintln!(
            "[claude command] {} -p \"{}\" --output-format stream-json --verbose --include-partial-messages --permission-mode dontAsk{}{}{}{}",
            claude_bin,
            escape_for_log(&message, 500),
            allowed_tools
                .as_ref()
                .filter(|tools| !tools.is_empty())
                .map(|tools| format!(" --allowedTools {}", escape_for_log(&tools.join(","), 300)))
                .unwrap_or_default(),
            session_id
                .as_ref()
                .map(|id| format!(" --resume {}", escape_for_log(id, 120)))
                .unwrap_or_default(),
            if !model.is_empty() && model != "default" {
                format!(" --model {}", escape_for_log(&model, 120))
            } else {
                String::new()
            },
            if !effort.is_empty() && effort != "default" {
                format!(" --effort {}", escape_for_log(&effort, 120))
            } else {
                String::new()
            },
        );

        let mut cmd = std::process::Command::new(&claude_bin);
        cmd.arg("-p").arg(&message)
           .arg("--output-format").arg("stream-json")
           .arg("--verbose")
           .arg("--include-partial-messages")
           .arg("--permission-mode").arg("dontAsk")
           .current_dir(&cwd)
           .stdout(std::process::Stdio::piped())
           .stderr(std::process::Stdio::piped())
           .env("PATH", &full_path);

        if let Some(tools) = allowed_tools.as_ref().filter(|tools| !tools.is_empty()) {
            cmd.arg("--allowedTools").arg(tools.join(","));
        }

        if let Some(session_id) = session_id.as_ref() {
            cmd.arg("--resume").arg(session_id);
        }

        if !model.is_empty() && model != "default" {
            cmd.arg("--model").arg(&model);
        }
        if !effort.is_empty() && effort != "default" {
            cmd.arg("--effort").arg(&effort);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                app.emit("claude-error", e.to_string()).ok();
                return;
            }
        };

        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();

        // Emit stderr in background thread (skip bun/AVX warnings)
        let app2 = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().flatten() {
                eprintln!("[claude stderr] {}", line);
                if line.contains("AVX") || line.contains("bun-darwin") || line.starts_with("warn:") {
                    continue;
                }
                app2.emit("claude-error", line).ok();
            }
        });

        for line in BufReader::new(stdout).lines().flatten() {
            let trimmed = line.trim().to_string();
            if !trimmed.is_empty() {
                eprintln!("[claude stdout] {}", truncate_for_log(&trimmed, 120));
                app.emit("claude-stream", trimmed).ok();
            }
        }

        child.wait().ok();
        app.emit("claude-done", ()).ok();
    });

    Ok(())
}

#[tauri::command]
fn send_message(
    app: AppHandle,
    session_id: String,
    cwd: String,
    message: String,
    model: String,
    effort: String,
    allowed_tools: Option<Vec<String>>,
) -> Result<(), String> {
    spawn_claude_message(
        app,
        Some(session_id),
        cwd,
        message,
        model,
        effort,
        allowed_tools,
    )
}

#[tauri::command]
fn send_new_message(
    app: AppHandle,
    cwd: String,
    message: String,
    model: String,
    effort: String,
    allowed_tools: Option<Vec<String>>,
) -> Result<(), String> {
    spawn_claude_message(
        app,
        None,
        cwd,
        message,
        model,
        effort,
        allowed_tools,
    )
}

// ─── App entry ────────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(InteractiveSessionStore::default())
        .manage(PlanUsageCache::default())
        .invoke_handler(tauri::generate_handler![
            scan_existing_sessions,
            describe_workspace,
            delete_session_file,
            get_session_messages,
            get_claude_account_info,
            list_claude_installations,
            get_claude_session_init,
            get_claude_plan_usage,
            get_usage_dashboard,
            list_installed_skills,
            get_skill_catalog,
            install_skill_from_folder,
            install_catalog_skill,
            delete_installed_skill,
            get_workspace_favicon,
            get_workspace_files,
            get_workspace_slash_commands,
            start_interactive_command,
            write_interactive_command,
            resize_interactive_command,
            close_interactive_command,
            send_new_message,
            send_message
        ])
        .run(tauri::generate_context!())
        .expect("error while running Claudy");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST_DIR: AtomicU64 = AtomicU64::new(1);

    fn temp_test_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "claudy-tests-{}-{}",
            std::process::id(),
            NEXT_TEST_DIR.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn decode_project_path_uses_fuzzy_matching_from_home() {
        let home = temp_test_dir();
        let project = home.join("_work").join("claudy").join("claudy");
        fs::create_dir_all(&project).unwrap();

        let encoded = claude_encode(&project.to_string_lossy());
        let (decoded, exists) = decode_project_path_with_home(&encoded, &home);

        assert!(exists);
        assert_eq!(decoded, project);

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn scan_existing_sessions_discovers_projects_and_first_messages() {
        let home = temp_test_dir();
        let project = home.join("_work").join("claudy").join("claudy");
        fs::create_dir_all(&project).unwrap();

        let projects_dir = home.join(".claude").join("projects");
        let encoded = claude_encode(&project.to_string_lossy());
        let project_dir = projects_dir.join(&encoded);
        fs::create_dir_all(&project_dir).unwrap();
        fs::write(
            project_dir.join("session-a.jsonl"),
            r#"{"type":"user","message":{"role":"user","content":"Hello Claudy"},"timestamp":"2026-03-08T10:00:00Z"}"#,
        )
        .unwrap();

        let workspaces = scan_existing_sessions_in(&projects_dir, &home);
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0].display_name, "claudy");
        assert_eq!(workspaces[0].sessions.len(), 1);
        assert_eq!(workspaces[0].sessions[0].first_message.as_deref(), Some("Hello Claudy"));

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn fallback_decoder_preserves_windows_drive_paths() {
        let decoded = decode_project_path_fallback("-E--chatbot-projects-insights");
        let decoded_str = decoded.to_string_lossy().to_string();

        #[cfg(windows)]
        assert_eq!(decoded_str, r"E:\chatbot\projects\insights");

        #[cfg(not(windows))]
        assert_eq!(decoded_str, "/E//chatbot/projects/insights");
    }

    #[test]
    fn path_component_match_is_separator_agnostic() {
        assert!(path_contains_component(Path::new("/tmp/subagents/session.jsonl"), "subagents"));
        assert!(path_contains_component(Path::new(r"C:\tmp\subagents\session.jsonl"), "subagents"));
        assert!(!path_contains_component(Path::new(r"C:\tmp\agents\session.jsonl"), "subagents"));
    }

    #[test]
    fn decode_project_path_uses_windows_drive_root_fuzzy_matching() {
        let drive_root = temp_test_dir();
        let drive_name = drive_root.file_name().and_then(|name| name.to_str()).unwrap().to_string();
        let project = drive_root
            .join("chatbot-projects")
            .join("insights")
            .join("tmp")
            .join("cd44e875-4020-48d1-9e8e-47920f972ca8");
        fs::create_dir_all(&project).unwrap();

        let encoded = format!(
            "{}-chatbot-projects-insights-tmp-cd44e875-4020-48d1-9e8e-47920f972ca8",
            drive_name
        );
        let (decoded, exists) = decode_project_path_with_home(&encoded, Path::new(r"C:\Users\tester"));

        if cfg!(windows) {
            assert!(exists);
            assert_eq!(decoded, project);
        } else {
            assert!(!exists);
        }

        let _ = fs::remove_dir_all(drive_root);
    }

    #[test]
    fn synthesize_session_meta_files_from_jsonl_when_usage_data_is_missing() {
        let root = temp_test_dir();
        let project = root.join("_work").join("claudy");
        fs::create_dir_all(&project).unwrap();

        let projects_dir = root.join(".claude").join("projects");
        let encoded = claude_encode(&project.to_string_lossy());
        let session_dir = projects_dir.join(encoded);
        fs::create_dir_all(&session_dir).unwrap();
        fs::write(
            session_dir.join("session-a.jsonl"),
            concat!(
                "{\"type\":\"user\",\"cwd\":\"",
                "C:\\\\work\\\\claudy",
                "\",\"sessionId\":\"session-a\",\"message\":{\"role\":\"user\",\"content\":\"Build the dashboard\"},\"timestamp\":\"2026-03-08T10:00:00Z\"}\n",
                "{\"type\":\"assistant\",\"cwd\":\"",
                "C:\\\\work\\\\claudy",
                "\",\"sessionId\":\"session-a\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"tool_use\",\"name\":\"Read\"}],\"usage\":{\"input_tokens\":12,\"output_tokens\":8}},\"timestamp\":\"2026-03-08T10:05:00Z\"}\n"
            ),
        )
        .unwrap();

        let items = synthesize_session_meta_files_from(&projects_dir);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].session_id, "session-a");
        assert_eq!(items[0].project_path, r"C:\work\claudy");
        assert_eq!(items[0].user_message_count, 1);
        assert_eq!(items[0].assistant_message_count, 1);
        assert_eq!(items[0].first_prompt, "Build the dashboard");
        assert_eq!(items[0].tool_counts.get("Read"), Some(&1));
        assert_eq!(items[0].duration_minutes, 5);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn delete_session_file_removes_all_related_files() {
        let dir = temp_test_dir();
        let session = dir.join("session-a.jsonl");
        let companion = dir.join("session-a.txt");
        let other = dir.join("session-b.jsonl");
        fs::write(&session, "[]").unwrap();
        fs::write(&companion, "companion").unwrap();
        fs::write(&other, "[]").unwrap();

        delete_session_files_for_path(&session).unwrap();

        assert!(!session.exists());
        assert!(!companion.exists());
        assert!(other.exists());

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn usage_dashboard_aggregates_local_claude_data() {
        let project = "/Users/tester/_work/claudy";
        let meta = vec![SessionMetaFile {
            session_id: "session-a".to_string(),
            project_path: project.to_string(),
            start_time: "2026-03-08T10:00:00Z".to_string(),
            duration_minutes: 15,
            user_message_count: 2,
            assistant_message_count: 3,
            tool_counts: HashMap::from([("Read".to_string(), 2)]),
            input_tokens: 100,
            output_tokens: 50,
            first_prompt: "Build the dashboard".to_string(),
            lines_added: 12,
            lines_removed: 4,
            files_modified: 2,
        }];

        let metrics = HashMap::from([(
            "session-a".to_string(),
            SessionJsonMetrics {
                cost_usd: 1.5,
                input_tokens: 120,
                output_tokens: 80,
                messages: 3,
                daily: HashMap::from([("2026-03-08".to_string(), (200, 1.5))]),
                models: HashMap::from([("claude-sonnet-4-6".to_string(), (120, 80, 1.5))]),
            },
        )]);

        let dashboard = build_usage_dashboard("all".to_string(), meta, metrics);

        assert_eq!(dashboard.summary.total_sessions, 1);
        assert_eq!(dashboard.summary.total_tokens, 200);
        assert_eq!(dashboard.summary.total_tool_calls, 2);
        assert_eq!(dashboard.summary.total_cost_usd, 1.5);
        assert_eq!(dashboard.projects.len(), 1);
        assert_eq!(dashboard.projects[0].display_name, "claudy");
        assert_eq!(dashboard.models[0].model, "claude-sonnet-4-6");
        assert_eq!(dashboard.daily[0].date, "2026-03-08");
    }
}
