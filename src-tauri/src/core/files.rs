//! 文件搜索。
//!
//! 关键取舍：**不自建文件索引**。
//!
//! 自建索引意味着要常驻一个 watcher、吃掉几百 MB 内存、并且在用户改硬盘后索引会腐烂 ——
//! 这正是 uTool 一类启动器越用越卡的典型原因。
//! 这里直接借用操作系统已有的索引：
//! - macOS：Spotlight（`mdfind`），由系统维护，零成本
//! - Windows：Everything 的 `es.exe`（若装了），否则退化为目录遍历（较慢，见下）
//!
//! 结果：Knockbox 自身**没有任何常驻索引进程**，关掉即彻底释放内存。

use super::ResultItem;
use super::Target;
use std::path::PathBuf;

/// 按查询串搜索文件，返回最多 `limit` 条。
pub fn search(query: &str, limit: usize) -> Vec<ResultItem> {
    if query.trim().len() < 2 {
        return Vec::new(); // 单字符查询会命中全盘，没有意义还慢
    }
    let raw = query.trim();

    #[cfg(target_os = "macos")]
    {
        search_spotlight(raw, limit)
    }
    #[cfg(target_os = "windows")]
    {
        search_everything(raw, limit)
            .unwrap_or_else(|| search_walk(raw, limit))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (raw, limit);
        Vec::new()
    }
}

#[cfg(target_os = "macos")]
fn search_spotlight(query: &str, limit: usize) -> Vec<ResultItem> {
    // 走 Spotlight 的属性查询语法，而不是把用户输入直接拼进 shell —— 参数是分离传递的，
    // 但仍需转义查询里的双引号，否则 `foo" || kMDItemKind ==` 之类的输入会改变查询语义。
    let escaped = query.replace('"', "");
    let expression = format!(
        "kMDItemDisplayName == '*{escaped}*'cd || kMDItemFSName == '*{escaped}*'cd"
    );

    let Ok(output) = std::process::Command::new("mdfind")
        .args(["-limit", &(limit * 3).to_string(), &expression])
        .output()
    else {
        return Vec::new();
    };

    let mut out = Vec::with_capacity(limit);
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let path = line.trim();
        if path.is_empty() {
            continue;
        }
        let pb = PathBuf::from(path);
        let Some(name) = pb.file_name().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        let dir = pb
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();

        out.push(ResultItem {
            id: format!("file:{path}"),
            kind: "file".into(),
            title: name,
            subtitle: dir,
            icon: None,
            // 文件搜索的排序交给 matcher 在上层统一做，这里给个中性分
            score: 0.0,
            target: Target::Path(path.to_string()),
        });
        if out.len() >= limit {
            break;
        }
    }
    out
}

/// 通过 Everything 的命令行客户端搜索（需用户自行安装 Everything）。
/// 没装就返回 `None`，让调用方退化为目录遍历。
#[cfg(target_os = "windows")]
fn search_everything(query: &str, limit: usize) -> Option<Vec<ResultItem>> {
    let es = locate_everything_cli()?;
    let output = std::process::Command::new(es)
        .args(["-limit", &limit.to_string(), query])
        .output()
        .ok()?;

    let mut out = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let path = line.trim();
        if path.is_empty() {
            continue;
        }
        let pb = PathBuf::from(path);
        let Some(name) = pb.file_name().map(|s| s.to_string_lossy().to_string()) else {
            continue;
        };
        let dir = pb
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        out.push(ResultItem {
            id: format!("file:{path}"),
            kind: "file".into(),
            title: name,
            subtitle: dir,
            icon: None,
            score: 0.0,
            target: Target::Path(path.to_string()),
        });
    }
    Some(out)
}

#[cfg(target_os = "windows")]
fn locate_everything_cli() -> Option<PathBuf> {
    let candidates = [
        r"C:\Program Files\Everything\es.exe",
        r"C:\Program Files (x86)\Everything\es.exe",
    ];
    for c in candidates {
        let p = PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    // 也支持用户在设置里通过环境变量 KNOCKBOX_ES_PATH 指定
    std::env::var_os("KNOCKBOX_ES_PATH").map(PathBuf::from)
}

/// Everything 缺席时的兜底：限制深度的目录遍历。
/// 明确慢于索引方案，所以只在小范围内遍历并尽早返回。
#[cfg(target_os = "windows")]
fn search_walk(query: &str, limit: usize) -> Vec<ResultItem> {
    let needle = query.to_lowercase();
    let mut out = Vec::new();

    let roots: Vec<PathBuf> = [
        dirs::home_dir(),
        dirs::desktop_dir(),
        dirs::download_dir(),
        dirs::document_dir(),
    ]
    .into_iter()
    .flatten()
    .collect();

    for root in roots {
        for entry in walkdir::WalkDir::new(&root)
            .max_depth(4)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
                continue;
            };
            if !name.to_lowercase().contains(&needle) {
                continue;
            }
            let dir = path
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            out.push(ResultItem {
                id: format!("file:{}", path.to_string_lossy()),
                kind: "file".into(),
                title: name.to_string(),
                subtitle: dir,
                icon: None,
                score: 0.0,
                target: Target::Path(path.to_string_lossy().to_string()),
            });
            if out.len() >= limit {
                return out;
            }
        }
    }
    out
}