use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

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

fn decode_project_path(encoded_dir_name: &str) -> (PathBuf, bool) {
    let home = match dirs_next::home_dir() {
        Some(h) => h,
        None => return (PathBuf::from(encoded_dir_name), false),
    };

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

    // Fallback: naive replace (works for paths without special chars)
    let naive = encoded_dir_name.trim_start_matches('-').replace('-', "/");
    let naive_path = PathBuf::from(format!("/{}", naive));
    let exists = naive_path.exists();
    (naive_path, exists)
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

#[tauri::command]
fn scan_existing_sessions() -> Vec<DiscoveredWorkspace> {
    let claude_projects_dir = {
        let home = dirs_next::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        home.join(".claude").join("projects")
    };

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
            let (real_path, path_exists) = decode_project_path(&dir_name);

            let decoded_path = real_path.to_string_lossy().to_string();
            let display_name = real_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&decoded_path)
                .to_string();

            let mut sessions: Vec<DiscoveredSession> = fs::read_dir(&path)
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

            Some(DiscoveredWorkspace {
                encoded_name: dir_name,
                decoded_path,
                display_name,
                path_exists,
                sessions,
            })
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

// ─── App entry ────────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![scan_existing_sessions, get_session_messages])
        .run(tauri::generate_context!())
        .expect("error while running Claudy");
}
