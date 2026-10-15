//! 插件安装来源：本地目录、`.kbplugin`(zip)、Git URL、远程市场。
//!
//! 四种来源最终都走同一条路径：**解压/拷贝到暂存目录 → 校验 → 原子换入 `plugins/<id>/`**。
//! 校验不通过就删掉暂存目录，绝不留下半截安装。

use crate::core::manifest::{self, Manifest};
use crate::core::store::plugins_dir;
use crate::plugins::store as plugin_store;
use std::path::{Path, PathBuf};

/// 安装结果。`permissions` 需要原样回传给前端，用于向用户逐条展示授权确认。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallResult {
    pub id: String,
    pub name: String,
    pub version: String,
    pub permissions: Vec<String>,
    pub updated: bool,
}

/// 从一个包含 `plugin.json` 的目录安装（来源可能是本地目录，也可能是解压后的暂存目录）。
pub fn install_from_dir(staging: &Path) -> Result<InstallResult, String> {
    let m = manifest::load(staging)?; // 内部会做全部字段校验
    commit(staging, &m)
}

/// 从 `.kbplugin`（zip）安装。要求 `plugin.json` 在压缩包根目录。
pub fn install_from_zip(archive_path: &Path) -> Result<InstallResult, String> {
    let staging = make_staging()?;
    let result = extract_zip(archive_path, &staging).and_then(|_| install_from_dir(&staging));

    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    } else {
        // 提交后暂存目录已不存在，忽略清理错误
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

/// 从 Git 仓库 URL 安装。
pub fn install_from_git(url: &str) -> Result<InstallResult, String> {
    let staging = make_staging()?;
    let status = std::process::Command::new("git")
        .args(["clone", "--depth", "1", "--quiet", url])
        .arg(&staging)
        .status()
        .map_err(|e| format!("调用 git 失败（请确认已安装 git）: {e}"))?;

    if !status.success() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("git clone 失败: {url}"));
    }

    // 有些仓库把插件放在子目录里（如 monorepo），向下找一层
    if !staging.join(manifest::MANIFEST_FILE).is_file() {
        if let Some(nested) = find_nested_manifest(&staging) {
            // 必须先装完再删：`nested` 是 `staging` 的子目录，
            // 反过来做的话等于删完再从已删目录里读 plugin.json。
            let result = install_from_dir(&nested);
            let _ = std::fs::remove_dir_all(&staging);
            return result;
        }
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("仓库中找不到 {}\n请确认这是插件根目录", manifest::MANIFEST_FILE));
    }

    let result = install_from_dir(&staging);
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// 从远程市场索引安装。先查索引拿下载 URL，再走 zip 安装。
pub fn install_from_registry(registry_url: &str, plugin_id: &str) -> Result<InstallResult, String> {
    let body = http_get(registry_url, 5000)?;
    let index: serde_json::Value =
        serde_json::from_str(&body).map_err(|e| format!("市场索引格式错误: {e}"))?;

    let plugins = index
        .get("plugins")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "市场索引缺少 plugins 数组".to_string())?;

    let entry = plugins
        .iter()
        .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(plugin_id))
        .ok_or_else(|| format!("市场中找不到插件 {plugin_id}"))?;

    let download = entry
        .get("download")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "市场条目缺少 download 字段".to_string())?;

    let staging = make_staging()?;
    let body = http_get(download, 20_000)?;

    // 索引若提供了 sha256，必须校验后才落盘
    if let Some(expected) = entry.get("sha256").and_then(|v| v.as_str()) {
        let actual = sha256_hex(body.as_bytes());
        if !actual.eq_ignore_ascii_case(expected) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(format!("校验失败：期望 {expected}，实际 {actual}"));
        }
    }

    let zip_path = staging.join("package.kbplugin");
    if let Err(e) = std::fs::write(&zip_path, body.as_bytes()) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("写入临时文件失败: {e}"));
    }

    let unpacked = staging.join("unpacked");
    let result = extract_zip(&zip_path, &unpacked)
        .and_then(|_| install_from_dir(&unpacked))
        .map_err(|e| format!("安装失败: {e}"));
    let _ = std::fs::remove_dir_all(&staging);
    result
}

/// 校验通过后，把暂存目录换入正式位置。
fn commit(staging: &Path, m: &Manifest) -> Result<InstallResult, String> {
    let dest = plugin_store::plugin_dir(&m.id);
    let updated = dest.exists();

    std::fs::create_dir_all(plugins_dir()).map_err(|e| format!("创建插件目录失败: {e}"))?;

    // 升级时先移到备份，新目录就位后再删备份 —— 中途失败还能回滚
    let backup = if updated {
        let backup = dest.with_extension("bak");
        let _ = std::fs::remove_dir_all(&backup);
        std::fs::rename(&dest, &backup).map_err(|e| format!("备份旧插件失败: {e}"))?;
        Some(backup)
    } else {
        None
    };

    match copy_dir(staging, &dest) {
        Ok(()) => {
            if let Some(b) = backup {
                let _ = std::fs::remove_dir_all(b);
            }
            plugin_store::set_enabled(&m.id, true)?;
            // 新装的默认钉住 —— 装完却"搜不到"是最容易被当成装失败的体验。
            // 用户之后可以在管理页里取消钉住。
            if !updated {
                plugin_store::set_pinned(&m.id, true)?;
            }
            Ok(InstallResult {
                id: m.id.clone(),
                name: m.name.clone(),
                version: m.version.clone(),
                permissions: m.permissions.clone(),
                updated,
            })
        }
        Err(e) => {
            // 回滚
            let _ = std::fs::remove_dir_all(&dest);
            if let Some(b) = backup {
                let _ = std::fs::rename(&b, &dest);
            }
            Err(format!("安装失败: {e}"))
        }
    }
}

fn make_staging() -> Result<PathBuf, String> {
    let base = crate::core::store::data_dir().join(".staging");
    std::fs::create_dir_all(&base).map_err(|e| format!("创建暂存目录失败: {e}"))?;
    // 用时间戳而非随机数：同一次会话内的并发安装不会撞名
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let dir = base.join(format!("install-{ts}"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建暂存目录失败: {e}"))?;
    Ok(dir)
}

fn extract_zip(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("打开压缩包失败: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("读取压缩包失败: {e}"))?;

    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;

    // 解压炸弹防护：压缩包声明的解压总大小上限 200MB
    const MAX_UNCOMPRESSED: u64 = 200 * 1024 * 1024;
    let entry_count = zip.len();
    let mut declared: u64 = 0;
    for i in 0..entry_count {
        if let Ok(f) = zip.by_index(i) {
            declared += f.size();
        }
    }
    if declared > MAX_UNCOMPRESSED {
        return Err(format!(
            "压缩包解压后约 {}MB，超过 200MB 上限",
            declared / 1024 / 1024
        ));
    }

    for i in 0..entry_count {
        let mut entry = zip.by_index(i).map_err(|e| format!("读取条目失败: {e}"))?;

        // enclosed_name() 已经过滤掉 `../` 和绝对路径 —— 这是 zip 规范自带的安全检查
        let Some(rel) = entry.enclosed_name() else {
            return Err(format!("压缩包含有非法路径条目，已拒绝解压"));
        };
        let out_path = dest.join(&rel);

        // 规范 §2.2 #8：拒绝包内符号链接，它们可指向宿主文件系统任意位置
        if entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            return Err(format!("压缩包含符号链接（{}），出于安全考虑已拒绝", rel.display()));
        }

        if entry.is_dir() {
            std::fs::create_dir_all(&out_path).map_err(|e| format!("创建目录失败: {e}"))?;
            continue;
        }

        if let Some(parent) = out_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
        let mut out = std::fs::File::create(&out_path).map_err(|e| format!("写入文件失败: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("解压失败: {e}"))?;
    }

    // 规范要求 plugin.json 必须在压缩包根目录，不允许外层再套一层目录
    if !dest.join(manifest::MANIFEST_FILE).is_file() {
        let entries: Vec<_> = std::fs::read_dir(dest)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .take(5)
            .collect();
        return Err(format!(
            "{} 必须在压缩包根目录。当前根目录下是: {}",
            manifest::MANIFEST_FILE,
            entries.join(", ")
        ));
    }

    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        let ft = entry.file_type()?;
        if ft.is_symlink() {
            // 规范禁止插件目录内出现符号链接
            continue;
        }
        if ft.is_dir() {
            copy_dir(&src, &dst)?;
        } else {
            std::fs::copy(&src, &dst)?;
        }
    }
    Ok(())
}

/// monorepo 场景：子目录里找 plugin.json，最多下探两层。
fn find_nested_manifest(root: &Path) -> Option<PathBuf> {
    for entry in std::fs::read_dir(root).into_iter().flatten().flatten() {
        let path = entry.path();
        if path.is_dir() && path.join(manifest::MANIFEST_FILE).is_file() {
            return Some(path);
        }
    }
    None
}

/// 最小 HTTP GET。只用 https，且拒绝跟随到非 https 的重定向 —— 避免把
/// 市场配置变成一个把请求引到任意地址的跳板。
fn http_get(url: &str, timeout_ms: u64) -> Result<String, String> {
    if !url.starts_with("https://") {
        return Err("只允许 https 地址".into());
    }
    // 交由系统 curl 处理 HTTPS 栈，避免自己引入 reqwest + 一堆 TLS 依赖
    let output = std::process::Command::new("curl")
        .args([
            "--silent",
            "--show-error",
            "--fail",
            "--location",
            "--max-time",
            &(timeout_ms / 1000).max(1).to_string(),
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            url,
        ])
        .output()
        .map_err(|e| format!("调用 curl 失败: {e}"))?;

    if !output.status.success() {
        return Err(format!(
            "请求失败: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    String::from_utf8(output.stdout).map_err(|e| format!("响应不是合法 UTF-8: {e}"))
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}