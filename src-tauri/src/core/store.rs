//! 本地状态持久化。
//!
//! 目录布局（`dirs::data_dir()/Knockbox`）：
//! ```text
//! settings.json            全局设置
//! app-cache.json           应用扫描缓存（避免每次启动都扫盘）
//! plugins/<pluginId>/      已安装插件本体
//! plugin-settings.json     各插件的用户设置值
//! ```
//!
//! 所有写入走"临时文件 + rename"，避免断电/崩溃时留下半截 JSON 把配置写坏。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub fn data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("Knockbox")
}

pub fn plugins_dir() -> PathBuf {
    data_dir().join("plugins")
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GlobalSettings {
    pub hotkey: String,
    /// 是否记住最近使用并提升其排名
    pub use_history: bool,
    pub history_limit: usize,
    pub web_search_enabled: bool,
    pub web_search_template: String,
    /// 索引包含的目录（为空则用系统默认）
    pub file_search_dirs: Vec<String>,
    /// 远程插件市场索引地址，空 = 不启用
    pub registry_url: String,
}

impl Default for GlobalSettings {
    fn default() -> Self {
        Self {
            hotkey: "CommandOrControl+Shift+K".into(),
            use_history: true,
            history_limit: 200,
            web_search_enabled: true,
            web_search_template: "https://www.google.com/search?q={query}".into(),
            file_search_dirs: Vec::new(),
            registry_url: String::new(),
        }
    }
}

/// 读全局设置；文件不存在或损坏时回落到默认值。
/// 损坏的配置不该让启动器打不开 —— 这是启动器最不该出现的失败模式。
pub fn load_settings() -> GlobalSettings {
    let path = data_dir().join("settings.json");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn save_settings(settings: &GlobalSettings) -> Result<(), String> {
    let dir = data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    write_atomic(&dir.join("settings.json"), json.as_bytes())
}

/// 原子写：先写同目录下的临时文件，再 rename 覆盖。
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path
        .parent()
        .ok_or_else(|| "路径没有父目录".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败: {e}"))?;

    let tmp = dir.join(format!(
        ".{}.tmp",
        path.file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("knockbox")
    ));
    std::fs::write(&tmp, bytes).map_err(|e| format!("写入临时文件失败: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换目标文件失败: {e}"))?;
    Ok(())
}

/// 插件的用户设置值。`secret` 项在磁盘上以 0600 权限隔离，
/// v0.2 计划接入系统钥匙串（macOS Keychain / Windows DPAPI）。
pub fn load_plugin_settings() -> serde_json::Value {
    let path = data_dir().join("plugin-settings.json");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| serde_json::Value::Object(Default::default()))
}

pub fn save_plugin_settings(value: &serde_json::Value) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let path = data_dir().join("plugin-settings.json");
    write_atomic(&path, json.as_bytes())?;
    restrict_permissions(&path)?;
    Ok(())
}

/// 尽力把权限收紧到仅当前用户可读写。失败不致命 —— 只是个纵深防御。
#[cfg(unix)]
fn restrict_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|e| format!("收紧权限失败: {e}"))
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

/// 最近使用记录：用于把常用项往前排。
pub fn load_history() -> Vec<HistoryEntry> {
    let path = data_dir().join("history.json");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn push_history(entry: &HistoryEntry, limit: usize) {
    let mut items = load_history();
    items.retain(|e| e.id != entry.id);
    items.insert(0, entry.clone());
    items.truncate(limit);
    if let Ok(json) = serde_json::to_string(&items) {
        let _ = write_atomic(&data_dir().join("history.json"), json.as_bytes());
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub count: u32,
    pub last_used: i64,
}

/// 应用扫描缓存。
pub fn load_app_cache<T: for<'de> Deserialize<'de>>(path: &str) -> Option<T> {
    let raw = std::fs::read_to_string(data_dir().join(path)).ok()?;
    serde_json::from_str(&raw).ok()
}

pub fn save_app_cache<T: Serialize>(path: &str, value: &T) {
    if let Ok(json) = serde_json::to_string(value) {
        let _ = write_atomic(&data_dir().join(path), json.as_bytes());
    }
}