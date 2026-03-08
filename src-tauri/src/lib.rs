use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter};
use base64::Engine;

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
pub struct SlashCommandInfo {
    pub name: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    pub source: String,
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
        });
    }
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

// ─── Send message ─────────────────────────────────────────────────────────────

#[tauri::command]
fn send_message(
    app: AppHandle,
    session_id: String,
    cwd: String,
    message: String,
    model: String,
    effort: String,
) -> Result<(), String> {
    std::thread::spawn(move || {
        let home = dirs_next::home_dir().unwrap_or_default();
        let full_path = format!(
            "{}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin",
            home.to_string_lossy()
        );

        // Find claude binary
        let candidates = [
            format!("{}/.local/bin/claude", home.to_string_lossy()),
            "/usr/local/bin/claude".to_string(),
            "/opt/homebrew/bin/claude".to_string(),
        ];
        let claude_bin = candidates
            .iter()
            .find(|p| std::path::Path::new(p.as_str()).exists())
            .cloned()
            .unwrap_or_else(|| "claude".to_string());

        eprintln!("[send_message] claude={} cwd={} session={}", claude_bin, cwd, session_id);

        let mut cmd = std::process::Command::new(&claude_bin);
        cmd.arg("-p").arg(&message)
           .arg("--resume").arg(&session_id)
           .arg("--output-format").arg("stream-json")
           .arg("--verbose")
           .arg("--include-partial-messages")
           .current_dir(&cwd)
           .stdout(std::process::Stdio::piped())
           .stderr(std::process::Stdio::piped())
           .env("PATH", &full_path);

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
                eprintln!("[claude stdout] {}", &trimmed[..trimmed.len().min(120)]);
                app.emit("claude-stream", trimmed).ok();
            }
        }

        child.wait().ok();
        app.emit("claude-done", ()).ok();
    });

    Ok(())
}

// ─── App entry ────────────────────────────────────────────────────────────────

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_existing_sessions,
            get_session_messages,
            get_claude_account_info,
            get_workspace_favicon,
            get_workspace_files,
            get_workspace_slash_commands,
            send_message
        ])
        .run(tauri::generate_context!())
        .expect("error while running Claudy");
}
