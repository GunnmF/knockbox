//! 已安装应用扫描。
//!
//! 刻意 **不** 读取系统注册表 / LaunchServices 数据库：那会引入平台依赖且启动要几百毫秒。
//! 直接遍历几个约定目录，200~400 个应用在 10ms 内扫完，且结果可缓存。
//! `mdfind` 兜底用于应对用户把应用装在非常规位置的情况。

use super::AppEntry;
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
pub fn scan_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        roots.push(home.join("Applications"));
        roots.push(home.join("Desktop")); // 用户直接拖在桌面的 .app
    }
    roots.push(PathBuf::from("/Applications"));
    roots.push(PathBuf::from("/System/Applications"));
    roots.push(PathBuf::from("/System/Applications/Utilities"));
    roots
}

#[cfg(target_os = "windows")]
pub fn scan_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(appdata) = dirs::data_dir() {
        // Roaming
        roots.push(appdata.join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Some(local) = dirs::data_local_dir() {
        // Local
        roots.push(local.join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    if let Some(program_data) = std::env::var_os("PROGRAMDATA") {
        roots.push(PathBuf::from(program_data).join(r"Microsoft\Windows\Start Menu\Programs"));
    }
    roots
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
pub fn scan_roots() -> Vec<PathBuf> {
    Vec::new()
}

/// 扫描全部应用。`depth` 控制递归层数，避免钻进深层目录拖慢启动。
pub fn scan() -> Vec<AppEntry> {
    let mut out: Vec<AppEntry> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for root in scan_roots() {
        collect_dir(&root, 0, &mut out, &mut seen);
    }

    // 常规目录没扫到时，用系统索引兜底（macOS）
    if out.is_empty() {
        out = scan_via_system_index();
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

const MAX_DEPTH: usize = 4;

/// 绕过缓存的强制扫描。名字与 `scan` 分开，是为了在调用处一眼看出
/// "这次是实打实扫盘"而非读缓存。
pub fn fresh_scan() -> Vec<AppEntry> {
    scan()
}

fn collect_dir(
    dir: &Path,
    depth: usize,
    out: &mut Vec<AppEntry>,
    seen: &mut std::collections::HashSet<String>,
) {
    if depth > MAX_DEPTH {
        return;
    }
    // 只 read_dir 一次：既用于找应用，也用于决定要不要下钻。
    // 早期版本调了两次，在 /Applications 这种目录上是白白的双倍 IO。
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_symlink() {
            continue; // 不跟随符号链接，避免环
        }

        // `.app` / `.lnk` 本身是目录，里面是 Contents/Resources/... 之类的资源，
        // 绝不是应用。钻进它们会白扫成千上万个文件，把首次启动拖到分钟级 ——
        // 这正是「轻量」要守住的东西。
        let ext_lower = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase());
        let is_app = match (cfg!(target_os = "macos"), ext_lower.as_deref()) {
            (true, Some("app")) => true,
            (false, Some("lnk" | "url" | "exe")) => true,
            _ => false,
        };

        let is_dir = path.is_dir();

        if is_app {
            let key = path.to_string_lossy().to_lowercase();
            if seen.insert(key) {
                let name = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_default();
                if !name.is_empty() {
                    let icon = resolve_icon(&path);
                    out.push(AppEntry {
                        name,
                        path: path.to_string_lossy().to_string(),
                        icon,
                    });
                }
            }
            // 应用包内部不下钻
            continue;
        }

        // 继续下钻（Windows 开始菜单是有层级的）
        if is_dir {
            collect_dir(&path, depth + 1, out, seen);
        }
    }
}

/// 找应用的图标文件路径。
#[cfg(target_os = "macos")]
fn resolve_icon(app_path: &Path) -> Option<String> {
    let resources = app_path.join("Contents/Resources");
    // 优先读 Info.plist 里的 CFBundleIconFile
    if let Some(plist) = read_plist_string(&resources.join("Info.plist"), "CFBundleIconFile") {
        let candidate = resources.join(format!("{plist}.icns"));
        if candidate.exists() {
            return Some(candidate.to_string_lossy().to_string());
        }
    }
    let direct = resources.join("AppIcon.icns");
    if direct.exists() {
        return Some(direct.to_string_lossy().to_string());
    }
    None
}

#[cfg(not(target_os = "macos"))]
fn resolve_icon(_app_path: &Path) -> Option<String> {
    // Windows 上取 .lnk/.exe 的图标需要 COM（多几十行依赖），v0.1 先走图标字母兜底
    None
}

/// 极简 plist 解析：只取 `<key>KEY</key>` 紧跟的 `<string>VALUE</string>`。
///
/// 不引入 plist crate 是为了守住二进制体积；这个键值对的需求用 20 行足够。
#[cfg(target_os = "macos")]
fn read_plist_string(plist: &Path, key: &str) -> Option<String> {
    let content = std::fs::read_to_string(plist).ok()?;

    // 二进制 plist 直接放弃，调用方会退回到目录名
    if !content.starts_with("<?xml") && !content.trim_start().starts_with("<!DOCTYPE") {
        return None;
    }

    let needle = format!("<key>{key}</key>");
    let pos = content.find(&needle)? + needle.len();
    let rest = &content[pos..];
    let open = rest.find("<string>")? + "<string>".len();
    let close = rest[open..].find("</string>")?;
    Some(
        rest[open..open + close]
            .trim()
            .trim_end_matches(';')
            .to_string(),
    )
}

/// Spotlight 兜底扫描。仅在常规目录一无所获时调用（通常是首次安装、或用户装在 U 盘/外接卷）。
#[cfg(target_os = "macos")]
fn scan_via_system_index() -> Vec<AppEntry> {
    let output = std::process::Command::new("mdfind")
        .args(["kMDItemContentType", "==", "\"com.apple.application-bundle\""])
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|line| line.ends_with(".app"))
        .take(500)
        .map(|line| {
            let path = PathBuf::from(line);
            let name = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            let icon = resolve_icon(&path);
            AppEntry { name, path: line.to_string(), icon }
        })
        .collect()
}

#[cfg(not(target_os = "macos"))]
fn scan_via_system_index() -> Vec<AppEntry> {
    Vec::new()
}