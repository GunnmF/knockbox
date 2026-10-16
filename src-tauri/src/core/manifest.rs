//! `plugin.json` 的解析与校验。规范见 `docs/PLUGIN_SPEC.md` §2。
//!
//! 这里是**信任边界的第一道闸**：安装时严格校验，运行时不再信任插件的任何自述。

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub const MANIFEST_FILE: &str = "plugin.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: Option<String>,
    pub entry: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub homepage: Option<String>,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default)]
    pub activation: Activation,
    /// 被唤起后怎么呈现。`panel`（默认）弹出面板让用户操作；`direct` 静默执行，
    /// 用于"锁屏""截图"这类一步就能做完、不需要界面的应用。
    #[serde(default)]
    pub invocation: Invocation,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default, rename = "web:allowed-domains")]
    pub web_allowed_domains: Vec<String>,
    /// 全局快捷键。宿主负责监听（插件声明、宿主注册），按下时按 `mode` 分发。
    /// 声明了快捷键就必须有 `system:hotkey` 权限（见 validate）。
    #[serde(default)]
    pub shortcuts: Vec<ShortcutDef>,
    /// 要不要常驻后台（持续监听快捷键 / 剪贴板等事件）。需 `app:background` 权限。
    #[serde(default)]
    pub background: bool,
    #[serde(default)]
    pub settings: Vec<SettingDef>,
    #[serde(default, rename = "minKnockboxVersion")]
    pub min_knockbox_version: Option<String>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Activation {
    /// 关键词命中即接管面板（默认）
    #[default]
    Keyword,
    /// 仅用户主动点开
    Manual,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Invocation {
    /// 弹出面板，用户在插件自己的界面里操作
    #[default]
    Panel,
    /// 静默执行，不显示任何界面。插件做完应当调用 `kb.close()`；
    /// 需要反馈时调用 `kb.setPanel()`，面板才会出现。
    Direct,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutDef {
    pub key: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub mode: ShortcutMode,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShortcutMode {
    /// 唤醒主窗口并打开插件面板（默认）
    #[default]
    Panel,
    /// 静默执行，不显示主窗口。截图、锁屏这类一步做完的用它
    Silent,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingDef {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: SettingType,
    #[serde(default)]
    pub default: Option<serde_json::Value>,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub secret: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SettingType {
    String,
    Number,
    Boolean,
    Select,
    Text,
}

/// 宿主已知的权限全集。未在此表中的权限一律拒绝安装 —— 宁可报错，也不让插件
/// 声明一个我们其实没实现、却给了它虚假安全感的能力。
pub const KNOWN_PERMISSIONS: &[&str] = &[
    "clipboard:read",
    "clipboard:write",
    "shell:open-url",
    "shell:open-path",
    "shell:open-app",
    "notification",
    "system:selection",
    "web:fetch",
    "storage:local",
    "history:read",
    "window:resize",
    // 内置轻应用需要的能力。锁屏和截屏都是"高影响、不可撤销"的操作，
    // 所以各自独立成权限而不是塞进 shell:* 里 —— 用户能分别授予/拒绝。
    "system:lock-screen",
    "screen:capture",
    // 生命周期与监听类能力。都不是默认给的：声明了就必须在安装时逐条向用户确认。
    "system:hotkey",        // 允许在 manifest 里声明全局快捷键（宿主监听）
    "system:clipboard-watch", // 允许声明剪贴板触发条件（宿主监听、命中时推送）
    "window:overlay",       // 允许开全屏覆盖层窗口承载自己的 UI
    "app:background",       // 允许常驻后台
];

/// 读取并校验插件根目录下的 `plugin.json`。
pub fn load(root: &Path) -> Result<Manifest, String> {
    let manifest_path = root.join(MANIFEST_FILE);
    let raw = std::fs::read_to_string(&manifest_path)
        .map_err(|e| format!("找不到 {}: {e}", MANIFEST_FILE))?;

    let manifest: Manifest = serde_json::from_str(&raw)
        .map_err(|e| format!("plugin.json 格式错误: {e}"))?;

    validate(&manifest, root)?;
    Ok(manifest)
}

pub fn validate(m: &Manifest, root: &Path) -> Result<(), String> {
    // —— id：反向域名，至少两段 ——
    if !is_valid_plugin_id(&m.id) {
        return Err(format!(
            "id \"{}\" 不合法：需为反向域名格式，如 com.example.hello",
            m.id
        ));
    }

    // —— version：严格 semver 三段式 ——
    if !is_valid_version(&m.version) {
        return Err(format!(
            "version \"{}\" 不合法：需形如 x.y.z",
            m.version
        ));
    }

    // —— name 长度 ——
    if m.name.trim().is_empty() || m.name.chars().count() > 32 {
        return Err("name 必须为 1~32 个字符".into());
    }

    // —— entry：本地 html，且不得逃出插件目录 ——
    if !has_html_ext(&m.entry) {
        return Err(format!(
            "entry \"{}\" 必须是 .html 或 .htm 文件",
            m.entry
        ));
    }
    let entry_path = resolve_inside(root, &m.entry)
        .ok_or_else(|| format!("entry \"{}\" 逃出了插件目录，已拒绝", m.entry))?;
    if !entry_path.is_file() {
        return Err(format!("entry \"{}\" 指向的文件不存在", m.entry));
    }

    // —— icon 同样不得逃出目录 ——
    if let Some(icon) = &m.icon {
        resolve_inside(root, icon)
            .ok_or_else(|| format!("icon \"{}\" 逃出了插件目录，已拒绝", icon))?;
    }

    // —— permissions 必须全部已知 ——
    let known: HashSet<&str> = KNOWN_PERMISSIONS.iter().copied().collect();
    for p in &m.permissions {
        if !known.contains(p.as_str()) {
            return Err(format!("未知权限 \"{p}\"，请检查拼写或宿主版本"));
        }
    }

    // —— web:fetch 必须配套域名白名单，否则等于开放全网 ——
    if m.permissions.iter().any(|p| p == "web:fetch") && m.web_allowed_domains.is_empty() {
        return Err("声明了 web:fetch 权限，但 web:allowed-domains 为空".into());
    }

    // —— setting key 唯一 ——
    let mut keys = HashSet::new();
    for s in &m.settings {
        if !keys.insert(&s.key) {
            return Err(format!("settings 中 key \"{}\" 重复", s.key));
        }
        if s.kind == SettingType::Select && s.options.is_empty() {
            return Err(format!("设置项 \"{}\" 是 select 但没有 options", s.key));
        }
    }

    // —— shortcuts：声明就必须有 system:hotkey 权限，且不能有裸按键、不能重复 ——
    if !m.shortcuts.is_empty() && !m.permissions.iter().any(|p| p == "system:hotkey") {
        return Err("声明了 shortcuts，但 permissions 里没有 system:hotkey".into());
    }
    let mut seen_keys = HashSet::new();
    for s in &m.shortcuts {
        if s.key.trim().is_empty() {
            return Err("shortcut 的 key 不能为空".into());
        }
        // 必须有修饰键：裸按键（如 "S"）会抢走用户的正常打字。
        // 主快捷键录制器里就有这条（Settings.tsx::HotkeyRecorder），插件同样适用。
        let has_modifier = ["CmdOrCtrl", "Ctrl", "Alt", "Shift", "Super", "Meta"]
            .iter()
            .any(|m| s.key.contains(m));
        if !has_modifier {
            return Err(format!(
                "shortcut \"{}\" 没有修饰键，裸按键会劫走用户的正常输入",
                s.key
            ));
        }
        if s.key.chars().count() > 64 {
            return Err(format!("shortcut \"{}\" 过长", s.key));
        }
        if !seen_keys.insert(s.key.to_lowercase()) {
            return Err(format!("shortcut \"{}\" 在同一个插件里重复了", s.key));
        }
    }

    // —— background 必须配套 app:background 权限 ——
    if m.background && !m.permissions.iter().any(|p| p == "app:background") {
        return Err("声明了 background: true，但 permissions 里没有 app:background".into());
    }

    // —— 最低宿主版本（规范 §2.1 / §10）——
    // 字段一直在解析却从没人读它，等于这条兼容性约定是空的。
    if let Some(min) = &m.min_knockbox_version {
        if !is_valid_version(min) {
            return Err(format!("minKnockboxVersion \"{min}\" 不是合法的三段式版本号"));
        }
        let host = env!("CARGO_PKG_VERSION");
        if compare_semver(host, min) == std::cmp::Ordering::Less {
            return Err(format!(
                "该轻应用要求 Knockbox ≥ {min}，当前宿主版本是 {host}"
            ));
        }
    }

    Ok(())
}

/// 比较两个三段式版本号。无法解析的段一律当 0 处理（调用前 `min` 已过格式校验）。
fn compare_semver(a: &str, b: &str) -> std::cmp::Ordering {
    let parse = |v: &str| -> (u64, u64, u64) {
        let mut it = v.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
        (
            it.next().unwrap_or(0),
            it.next().unwrap_or(0),
            it.next().unwrap_or(0),
        )
    };
    parse(a).cmp(&parse(b))
}

fn is_valid_plugin_id(id: &str) -> bool {
    // 至少两段，形如 com.example.hello；段内只允许小写字母、数字、连字符
    let segments: Vec<&str> = id.split('.').collect();
    if segments.len() < 2 {
        return false;
    }
    segments.iter().all(|seg| {
        !seg.is_empty()
            && seg.chars().next().is_some_and(|c| c.is_ascii_lowercase())
            && seg.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    })
}

fn is_valid_version(v: &str) -> bool {
    let parts: Vec<&str> = v.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

fn has_html_ext(entry: &str) -> bool {
    entry.to_ascii_lowercase().ends_with(".html") || entry.to_ascii_lowercase().ends_with(".htm")
}

/// 把插件内的相对路径解析成绝对路径，并阻断 `../` 穿越。
fn resolve_inside(root: &Path, relative: &str) -> Option<PathBuf> {
    let rel = Path::new(relative);

    // 不做 canonicalize 后比较（macOS 上 /tmp 是 /private/tmp 的符号链接，会误判），
    // 改为逐段检查**相对路径自身**：只要出现 `..`、绝对路径根或盘符前缀，
    // 一律拒绝。因为清单里的路径本来就只该是插件目录内的普通相对路径，
    // 不存在"先往上再折回来"的合法用法。
    for comp in rel.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::Normal(_) => {}
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => return None,
        }
    }
    Some(root.join(rel))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 拒绝反向域名之外的id() {
        assert!(is_valid_plugin_id("com.example.hello"));
        assert!(!is_valid_plugin_id("hello"));
        assert!(!is_valid_plugin_id("Com.Example.Hello"));
        assert!(!is_valid_plugin_id("com..hello"));
        assert!(!is_valid_plugin_id("com.example.hello!"));
    }

    #[test]
    fn 版本号必须三段() {
        assert!(is_valid_version("1.0.0"));
        assert!(!is_valid_version("1.0"));
        assert!(!is_valid_version("1.0.0-beta"));
    }

    #[test]
    fn 拒绝路径穿越() {
        let root = Path::new("/tmp/plugin");
        assert!(resolve_inside(root, "index.html").is_some());
        assert!(resolve_inside(root, "assets/app.js").is_some());
        assert!(resolve_inside(root, "../etc/passwd").is_none());
        assert!(resolve_inside(root, "a/../../etc/passwd").is_none());
        // 绝对路径同样会逃出插件目录
        assert!(resolve_inside(root, "/etc/passwd").is_none());
    }

    /// 在临时目录里写一份最小可用的 plugin.json，跑完整 validate。
    /// validate 要查 entry 文件是否真实存在，所以得真的落盘。
    fn validate_with(entry_json: &str) -> Result<(), String> {
        // 目录名必须每个测试唯一：同进程的测试是**并行**跑的，
        // 共用同一个目录会互相把 index.html 删掉 —— 单独跑能过、全量跑挂
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!("kb-manifest-test-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "<html></html>").unwrap();
        let m: Manifest = serde_json::from_str(entry_json).expect("测试清单本身必须可解析");
        let result = validate(&m, &dir);
        let _ = std::fs::remove_dir_all(&dir);
        result
    }

    #[test]
    fn 快捷键必须配套权限() {
        // 声明了 shortcuts 却没有 system:hotkey 权限 → 拒装
        let no_perm = r#"{
            "id": "com.a.b", "name": "t", "version": "1.0.0", "entry": "index.html",
            "permissions": [],
            "shortcuts": [{ "key": "CmdOrCtrl+Shift+S" }]
        }"#;
        assert!(validate_with(no_perm).is_err());

        // 有权限 → 过
        let ok = r#"{
            "id": "com.a.b", "name": "t", "version": "1.0.0", "entry": "index.html",
            "permissions": ["system:hotkey"],
            "shortcuts": [{ "key": "CmdOrCtrl+Shift+S" }]
        }"#;
        assert!(validate_with(ok).is_ok());
    }

    #[test]
    fn 快捷键不能是裸按键() {
        // 裸按键（没有修饰键）会抢走用户的正常打字，必须拒绝
        let bare = r#"{
            "id": "com.a.b", "name": "t", "version": "1.0.0", "entry": "index.html",
            "permissions": ["system:hotkey"],
            "shortcuts": [{ "key": "S" }]
        }"#;
        assert!(validate_with(bare).is_err());
    }

    #[test]
    fn 快捷键在同一插件内不能重复() {
        let dup = r#"{
            "id": "com.a.b", "name": "t", "version": "1.0.0", "entry": "index.html",
            "permissions": ["system:hotkey"],
            "shortcuts": [
                { "key": "CmdOrCtrl+Shift+S" },
                { "key": "CmdOrCtrl+Shift+S" }
            ]
        }"#;
        assert!(validate_with(dup).is_err());
    }

    #[test]
    fn 后台常驻必须配套权限() {
        let no_perm = r#"{
            "id": "com.a.b", "name": "t", "version": "1.0.0", "entry": "index.html",
            "permissions": [],
            "background": true
        }"#;
        assert!(validate_with(no_perm).is_err());

        let ok = r#"{
            "id": "com.a.b", "name": "t", "version": "1.0.0", "entry": "index.html",
            "permissions": ["app:background"],
            "background": true
        }"#;
        assert!(validate_with(ok).is_ok());
    }

    /// 内置轻应用随源码走，没有任何安装时校验兜底 —— 清单写错一个拼写
    /// （未知权限、重复 setting key），要等到用户唤起插件才暴露。
    /// 这里把它变成编译期就会红的单测。
    #[test]
    fn 内置轻应用清单全部合法() {
        for id in crate::plugins::builtin::BUILTIN_IDS {
            let root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("builtins")
                .join(id);
            let m = load(&root).unwrap_or_else(|e| panic!("内置轻应用 {id} 清单非法: {e}"));
            assert_eq!(m.id.as_str(), *id, "目录名与清单 id 不一致");
        }
    }
}