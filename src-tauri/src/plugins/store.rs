//! 已安装插件的注册表。
//!
//! 只做一件事：把磁盘上的 `plugins/<id>/` 目录和 manifest 汇总成一份列表，
//! 并管理启用状态。插件本体不常驻内存 —— 唤起时才从磁盘读。

use crate::core::manifest::{self, Activation, Manifest};
use crate::core::store::{self, plugins_dir};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub author: Option<String>,
    pub keywords: Vec<String>,
    pub activation: Activation,
    /// `direct` 的应用被唤起后静默执行，不弹界面
    pub invocation: crate::core::manifest::Invocation,
    pub permissions: Vec<String>,
    pub enabled: bool,
    /// 是否声明了 settings。管理页据此决定要不要显示「设置」按钮 ——
    /// 没声明的应用摆一个点开只会提示"没有设置项"的按钮是纯噪音。
    pub has_settings: bool,
    /// 是否"钉"在启动器里。**只有钉住的轻应用才会出现在搜索结果中** ——
    /// 装了一堆不等于都要出现在外面，管理页里自己挑。
    pub pinned: bool,
    /// 图标在本机的绝对路径（调试用）
    pub icon: Option<String>,
    /// 前端直接可用的图标 URL（knockbox-plugin: 协议）
    pub icon_url: Option<String>,
    pub dir: String,
}

/// 列出全部已安装插件。损坏的插件目录跳过而非整体失败 ——
/// 一个坏插件不该让所有其他插件都打不开。
pub fn list() -> Vec<InstalledPlugin> {
    let root = plugins_dir();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };

    let disabled = load_disabled();
    let pinned = load_pinned();
    let mut out = Vec::new();

    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let id = dir
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if id.starts_with('.') {
            continue; // 临时目录
        }

        let Ok(m) = manifest::load(&dir) else {
            continue;
        };

        // 目录名与 manifest 的 id 不一致说明安装过程出过问题，信任 manifest
        let icon = m
            .icon
            .as_ref()
            .map(|rel| dir.join(rel).to_string_lossy().to_string());
        // 前端直接可用的图标 URL，走我们自己的 knockbox-plugin: 协议。
        // 不用 asset: 协议：它的 scope 行为在应用外没法验证，
        // 而这条协议的处理器本来就在给插件页服务，MIME、路径穿越都有保证。
        let icon_url = m
            .icon
            .as_ref()
            .map(|rel| format!("{}/{}/{}", scheme_base(), m.id, rel.replace('\\', "/")));

        out.push(InstalledPlugin {
            id: m.id.clone(),
            name: m.name,
            version: m.version,
            description: m.description,
            author: m.author,
            keywords: m.keywords,
            activation: m.activation,
            invocation: m.invocation,
            permissions: m.permissions,
            enabled: !disabled.contains(&m.id),
            pinned: pinned.contains(&m.id),
            has_settings: !m.settings.is_empty(),
            icon,
            icon_url,
            dir: dir.to_string_lossy().to_string(),
        });
    }

    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

pub fn get(id: &str) -> Option<InstalledPlugin> {
    list().into_iter().find(|p| p.id == id)
}

/// 读回某个插件的完整 manifest（宿主调用 SDK 前需要 web:allowed-domains 等细节）。
pub fn load_manifest(id: &str) -> Result<Manifest, String> {
    manifest::load(&plugin_dir(id))
}

pub fn plugin_dir(id: &str) -> PathBuf {
    plugins_dir().join(id)
}

/// knockbox-plugin: 协议在当前平台下的 URL 前缀。
/// 与 commands::plugin_entry_url 保持同一条规则。
pub fn scheme_base() -> &'static str {
    if cfg!(windows) {
        "http://knockbox-plugin.localhost"
    } else {
        "knockbox-plugin://localhost"
    }
}

pub fn set_enabled(id: &str, enabled: bool) -> Result<(), String> {
    let mut disabled = load_disabled();
    if enabled {
        disabled.retain(|d| d != id);
    } else if !disabled.iter().any(|d| d == id) {
        disabled.push(id.to_string());
    }
    save_disabled(&disabled)
}

/// 钉住 = 让它出现在启动器搜索结果里。与"启用"是两件事：
/// 启用是允许它运行，钉住是决定它是否占外面的位置。
pub fn set_pinned(id: &str, pinned: bool) -> Result<(), String> {
    let mut list = load_pinned();
    if pinned {
        if !list.iter().any(|p| p == id) {
            list.push(id.to_string());
        }
    } else {
        list.retain(|p| p != id);
    }
    save_id_list("plugins-pinned.json", &list)
}

fn disabled_path() -> PathBuf {
    store::data_dir().join("plugins-disabled.json")
}

fn load_disabled() -> Vec<String> {
    load_id_list("plugins-disabled.json")
}

fn save_disabled(list: &[String]) -> Result<(), String> {
    save_id_list("plugins-disabled.json", list)
}

fn load_pinned() -> Vec<String> {
    load_id_list("plugins-pinned.json")
}

/// 读一个"插件 id 列表"的 JSON 数组。文件不存在或损坏都当作空列表 ——
/// 这类状态文件坏了最多让插件回到默认值，不该让启动器打不开。
fn load_id_list(file: &str) -> Vec<String> {
    std::fs::read_to_string(store::data_dir().join(file))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_id_list(file: &str, list: &[String]) -> Result<(), String> {
    std::fs::create_dir_all(store::data_dir()).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(store::data_dir().join(file), json).map_err(|e| e.to_string())
}

/// 卸载：删目录 + 清启用状态。用户设置**保留**，重装可恢复。
pub fn uninstall(id: &str) -> Result<(), String> {
    let dir = plugin_dir(id);
    if !dir.exists() {
        return Err(format!("插件 {id} 未安装"));
    }
    std::fs::remove_dir_all(&dir).map_err(|e| format!("删除插件目录失败: {e}"))?;
    set_enabled(id, true)?; // 从 disabled 列表里移除
    set_pinned(id, false)?; // 钉住状态也要清掉，否则 id 复用时会莫名复活
    Ok(())
}