//! 前端可调用的命令。
//!
//! 这一层是**主窗口**的能力（主窗口是自己人，可以信任）；
//! 插件 iframe 不绑定任何 Tauri capability，因此根本调不到这里 —— 插件的路
//! 只有 `plugin_call` 一条，且内部还会再做权限校验。

use crate::core::apps;
use crate::core::files;
use crate::core::matcher;
use crate::core::store::{self, GlobalSettings, HistoryEntry};
use crate::core::{AppEntry, ResultItem, Target};
use crate::plugins::{host, source, store as plugin_store};
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

/// 进程内共享的应用扫描结果。
#[derive(Default)]
pub struct AppCache(pub std::sync::Mutex<Option<Vec<AppEntry>>>);

/// 当前生效的全局快捷键。改设置时用它做回滚锚点。
pub struct Hotkey(pub std::sync::Mutex<String>);

impl Hotkey {
    pub fn new(hotkey: String) -> Self {
        Self(std::sync::Mutex::new(hotkey))
    }
}

const APP_CACHE_FILE: &str = "app-cache.json";
const RESULT_LIMIT: usize = 12;

// ————————————————————————————————————————————————
// 搜索
// ————————————————————————————————————————————————

#[tauri::command]
pub async fn search(
    query: String,
    cache: State<'_, AppCache>,
) -> Result<Vec<ResultItem>, String> {
    let settings = store::load_settings();
    let trimmed = query.trim().to_string();

    // 空查询：展示钉住的轻应用作为快捷列表 —— 「钉住」对用户来说就该是
    // "不敲字也摆在外面"的意思，而不是"敲对了关键词才出现"。
    if trimmed.is_empty() {
        let items: Vec<ResultItem> = plugin_candidates("", &plugin_store::list())
            .into_iter()
            .map(|(item, _)| item)
            .collect();
        return Ok(items);
    }

    let apps = get_apps(&cache);
    let history = if settings.use_history {
        store::load_history()
    } else {
        Vec::new()
    };

    // 文件搜索要 fork 子进程查系统索引，放到阻塞线程池里，别卡住 UI
    let file_query = trimmed.clone();
    let files = tauri::async_runtime::spawn_blocking(move || files::search(&file_query, RESULT_LIMIT * 2))
        .await
        .unwrap_or_default();

    let mut scored: Vec<matcher::Scored> = Vec::new();

    // —— 轻应用：关键词命中权重最高，直接置顶 ——
    scored.extend(plugin_candidates(&trimmed, &plugin_store::list()));

    // —— 应用 ——
    for app in &apps {
        if let Some(s) = matcher::score(&trimmed, &app.name) {
            scored.push((
                ResultItem {
                    id: format!("app:{}", app.path),
                    kind: "app".into(),
                    title: app.name.clone(),
                    subtitle: app.path.clone(),
                    icon: app.icon.clone(),
                    score: 0.0,
                    target: Target::App(app.path.clone()),
                },
                s,
            ));
        }
    }

    // —— 文件 ——
    for mut f in files {
        if let Some(s) = matcher::score(&trimmed, &f.title) {
            f.score = 0.0;
            scored.push((f, s * 0.9)); // 文件匹配略微降权，避免淹没应用
        }
    }

    // —— 网页搜索：永远作为最后一条兜底 ——
    if settings.web_search_enabled && !trimmed.is_empty() {
        let url = build_web_url(&settings.web_search_template, &trimmed);
        scored.push((
            ResultItem {
                id: format!("web:{url}"),
                kind: "web".into(),
                title: format!("在网络上搜索「{trimmed}」"),
                subtitle: url.clone(),
                icon: None,
                score: 0.0,
                target: Target::Url(url),
            },
            1.0,
        ));
    }

    // —— 历史加权：常用项往前排 ——
    if settings.use_history {
        let counts: std::collections::HashMap<&str, u32> =
            history.iter().map(|h| (h.id.as_str(), h.count)).collect();
        for (item, score) in scored.iter_mut() {
            if let Some(&c) = counts.get(item.id.as_str()) {
                // log 平滑：第 10 次使用的加成远小于第 1 次的 10 倍
                *score += (c as f64).ln() * 45.0;
            }
        }
    }

    let mut ranked = matcher::rank(scored, RESULT_LIMIT);
    ranked.iter_mut().for_each(|(item, s)| item.score = *s);
    Ok(ranked.into_iter().map(|(item, _)| item).collect())
}

/// 算出本次查询里该出现的轻应用。
///
/// 只考虑**启用且钉住**的：装了不等于都要占外面的位置，由用户在管理页里挑。
///
/// 两条入选路径，满足其一即可：
/// - **关键词命中**：`keywords` 里任意一项被查询包含，直接入选且权重最高。
///   不能反过来再要求应用名也匹配 —— 关键词和应用名本来就是两套语言
///   （比如输入 `lock` 命中「锁屏」的 keywords，应用名是中文对不上），
///   之前的要求导致关键词命中了却什么都不显示。
/// - **名称匹配**：和应用名做模糊匹配，命中关键词的额外加 1200。
///
/// 空查询时全部钉住的应用都入选（中性分），作为外面的快捷列表。
fn plugin_candidates(trimmed: &str, plugins: &[plugin_store::InstalledPlugin]) -> Vec<matcher::Scored> {
    let lower = trimmed.to_lowercase();
    let mut scored = Vec::new();
    for plugin in plugins {
        if !plugin.enabled || !plugin.pinned {
            continue;
        }
        let kw_hit = !lower.is_empty()
            && plugin
                .keywords
                .iter()
                .any(|k| !k.is_empty() && lower.contains(&k.to_lowercase()));
        let name_score = matcher::score(trimmed, &plugin.name);

        if !kw_hit && name_score.is_none() {
            continue;
        }

        let s = name_score.unwrap_or(0.0) + if kw_hit { 1200.0 } else { 0.0 };
        scored.push((
            ResultItem {
                id: format!("plugin:{}", plugin.id),
                kind: "plugin".into(),
                title: plugin.name.clone(),
                subtitle: plugin
                    .description
                    .clone()
                    .unwrap_or_else(|| plugin.id.clone()),
                // 轻应用的图标走 icon_url（knockbox-plugin: 协议），
                // 前端可直接 <img src>，不用经过 asset: 协议。
                icon: plugin.icon_url.clone().or_else(|| plugin.icon.clone()),
                score: 0.0,
                target: Target::Plugin(plugin.id.clone()),
            },
            s,
        ));
    }
    scored
}

fn build_web_url(template: &str, query: &str) -> String {
    // 手写 URL 编码，不引 percent-encoding 依赖 —— 启动器只会用到这几个字符
    let encoded: String = query
        .chars()
        .map(|c| match c {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            ' ' => "+".to_string(),
            other => other
                .to_string()
                .bytes()
                .map(|b| format!("%{b:02X}"))
                .collect(),
        })
        .collect();
    if template.contains("{query}") {
        template.replace("{query}", &encoded)
    } else {
        format!("{template}{encoded}")
    }
}

fn get_apps(cache: &AppCache) -> Vec<AppEntry> {
    let mut guard = cache.0.lock().unwrap();
    if let Some(apps) = guard.as_ref() {
        return apps.clone();
    }
    // 首次：优先用缓存（秒开），后台再刷新
    let apps = store::load_app_cache::<Vec<AppEntry>>(APP_CACHE_FILE)
        .unwrap_or_else(|| apps::fresh_scan());
    *guard = Some(apps.clone());
    apps
}

/// 后台刷新应用列表并落盘缓存。不阻塞任何用户可见操作。
#[tauri::command]
pub async fn rescan_apps(cache: State<'_, AppCache>) -> Result<usize, String> {
    let apps = tauri::async_runtime::spawn_blocking(apps::fresh_scan)
        .await
        .map_err(|e| e.to_string())?;
    let count = apps.len();
    store::save_app_cache(APP_CACHE_FILE, &apps);
    *cache.0.lock().unwrap() = Some(apps);
    Ok(count)
}

// ————————————————————————————————————————————————
// 执行
// ————————————————————————————————————————————————

#[tauri::command]
pub fn execute(app: AppHandle, item: ResultItem) -> Result<(), String> {
    let settings = store::load_settings();

    // 记历史（插件不进历史，避免污染）
    if item.kind != "plugin" {
        store::push_history(
            &HistoryEntry {
                id: item.id.clone(),
                kind: item.kind.clone(),
                title: item.title.clone(),
                count: 1,
                last_used: now_secs(),
            },
            settings.history_limit,
        );
    }

    match &item.target {
        Target::App(path) | Target::Path(path) => host::dispatch_open_path(path),
        Target::Url(url) => host::dispatch_open_url(url),
        Target::Plugin(_id) => {
            // 插件的唤起由前端负责（要建 iframe），这里只负责把窗口收起来
            hide_main_window(&app);
            Ok(())
        }
    }
}

/// 回车后收起窗口。轻应用接管面板时除外（由前端决定何时收起）。
#[tauri::command]
pub fn hide(app: AppHandle) {
    hide_main_window(&app);
}

fn hide_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.hide();
    }
}

// ————————————————————————————————————————————————
// 设置
// ————————————————————————————————————————————————

#[tauri::command]
pub fn get_settings() -> GlobalSettings {
    store::load_settings()
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: GlobalSettings) -> Result<(), String> {
    let old_hotkey = app
        .try_state::<Hotkey>()
        .map(|h| h.0.lock().unwrap().clone());
    store::save_settings(&settings)?;

    // 快捷键要**立刻**生效，且失败要回滚。
    // 顺序很重要：先落盘再注册 —— 万一注册失败，磁盘上留下的还是能用的那个。
    if let Some(old) = old_hotkey {
        if old != settings.hotkey {
            if let Err(e) = crate::register_hotkey(&app, &settings.hotkey) {
                let _ = crate::register_hotkey(&app, &old);
                return Err(e);
            }
        }
    }
    Ok(())
}

/// 让窗口高度跟着结果条数走。
///
/// 前端算出「内容比当前视口多/少了多少像素」传进来，这里只负责夹在
/// 合理范围内 —— 上限跟着**当前屏幕**的高度走，不能写死：小屏笔记本上
/// 塞满 520px 会直接顶出屏幕。
///
/// 返回实际生效的高度，前端拿它去判断"已经到顶了没有"，避免反复调用。
#[tauri::command]
pub fn resize_window(app: AppHandle, delta: f64) -> Result<f64, String> {
    let Some(win) = app.get_webview_window("main") else {
        return Err("找不到主窗口".into());
    };
    let scale = win.scale_factor().map_err(|e| e.to_string())?;

    // 屏幕高度的 70%：够放下十来条结果，又保证下沿不会掉到屏幕外
    let screen_h = win
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.size().height as f64 / scale)
        .unwrap_or(1000.0);
    let max_h = (screen_h * 0.8).round().clamp(220.0, 720.0);
    // 最小只留「输入条 + 底栏」。之前下限是 160px，结果空状态下输入框
    // 下面永远挂着一块空盒子 —— 前端明明量出只要 90px，却被这里挡回去了。
    let min_h = 88.0;

    let current = win
        .outer_size()
        .map_err(|e| e.to_string())?
        .height as f64
        / scale;

    let target = (current + delta).clamp(min_h, max_h);
    if (target - current).abs() < 0.5 {
        return Ok(current);
    }

    win.set_size(tauri::LogicalSize::new(
        win.outer_size().map_err(|e| e.to_string())?.width as f64 / scale,
        target,
    ))
    .map_err(|e| e.to_string())?;
    Ok(target)
}

// ————————————————————————————————————————————————
// 插件
// ————————————————————————————————————————————————

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdArg {
    pub id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnableArg {
    pub id: String,
    pub enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinArg {
    pub id: String,
    pub pinned: bool,
}

#[tauri::command]
pub fn plugin_list() -> Vec<plugin_store::InstalledPlugin> {
    plugin_store::list()
}

#[tauri::command]
pub fn plugin_install_dir(path: String) -> Result<source::InstallResult, String> {
    source::install_from_dir(std::path::Path::new(&path))
}

#[tauri::command]
pub fn plugin_install_zip(path: String) -> Result<source::InstallResult, String> {
    source::install_from_zip(std::path::Path::new(&path))
}

#[tauri::command]
pub fn plugin_install_git(url: String) -> Result<source::InstallResult, String> {
    source::install_from_git(&url)
}

#[tauri::command]
pub fn plugin_install_registry(url: String, id: String) -> Result<source::InstallResult, String> {
    source::install_from_registry(&url, &id)
}

#[tauri::command]
pub fn plugin_uninstall(args: IdArg) -> Result<(), String> {
    plugin_store::uninstall(&args.id)
}

#[tauri::command]
pub fn plugin_set_enabled(args: EnableArg) -> Result<(), String> {
    plugin_store::set_enabled(&args.id, args.enabled)
}

/// 钉住/取消钉住。钉住的轻应用才会出现在启动器搜索结果里。
#[tauri::command]
pub fn plugin_set_pinned(args: PinArg) -> Result<(), String> {
    plugin_store::set_pinned(&args.id, args.pinned)
}

/// 插件 SDK 的唯一入口。权限校验在 `host::dispatch` 内部完成。
///
/// 必须是 async + spawn_blocking：底层能力全是阻塞 IO —— curl 最长 15 秒、
/// pbcopy fork、扫盘。放在同步命令里会让一个卡住的插件**冻住整个启动器**，
/// 而窗口是 alwaysOnTop 的，用户连关都关不掉。
#[tauri::command]
pub async fn plugin_call(
    app: AppHandle,
    id: String,
    method: String,
    params: Option<serde_json::Value>,
) -> Result<serde_json::Value, PluginCallError> {
    let params = params.unwrap_or(serde_json::Value::Object(Default::default()));
    let dispatched = tauri::async_runtime::spawn_blocking(move || {
        host::dispatch(&app, &id, &method, params)
    })
    .await
    .map_err(|e| PluginCallError {
        code: "INTERNAL".into(),
        message: format!("内核线程异常: {e}"),
    })?;

    dispatched.map_err(|e| PluginCallError {
        code: e.code().to_string(),
        message: e.to_string(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCallError {
    pub code: String,
    pub message: String,
}

/// 插件页面的 iframe 地址。走自定义 scheme，与宿主不同源。
#[tauri::command]
pub fn plugin_entry_url(id: String) -> Result<String, String> {
    let manifest = plugin_store::load_manifest(&id)?;
    let entry = plugin_store::plugin_dir(&id).join(&manifest.entry);
    if !entry.is_file() {
        return Err(format!("插件入口文件丢失: {}", manifest.entry));
    }
    // 不要无脑拼 `knockbox-plugin://localhost/...`：Tauri 在 Windows 上会把自定义
    // 协议映射成 `http://knockbox-plugin.localhost`（wry 的 HTTP 规避方案，
    // 自定义 scheme 在 Windows WebView2 上不可用）。硬拼的地址在 Windows 上是白屏。
    let base = if cfg!(windows) {
        "http://knockbox-plugin.localhost"
    } else {
        "knockbox-plugin://localhost"
    };
    Ok(format!(
        "{base}/{id}/{}",
        manifest.entry.replace('\\', "/")
    ))
}

/// 插件清单里 `settings` 的声明，供前端自动生成设置界面。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMeta {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub version: String,
    pub keywords: Vec<String>,
    pub activation: crate::core::manifest::Activation,
    pub permissions: Vec<String>,
    /// 被唤起后怎么呈现：panel = 弹界面，direct = 静默执行
    pub invocation: crate::core::manifest::Invocation,
    /// `plugin.json` 里 `settings` 的声明，宿主据此自动生成设置界面
    pub settings: Vec<crate::core::manifest::SettingDef>,
}

#[tauri::command]
pub fn plugin_meta(id: String) -> Result<PluginMeta, String> {
    let m = plugin_store::load_manifest(&id)?;
    Ok(PluginMeta {
        id: m.id.clone(),
        name: m.name,
        description: m.description,
        version: m.version,
        keywords: m.keywords,
        activation: m.activation,
        permissions: m.permissions,
        invocation: m.invocation,
        settings: m.settings,
    })
}

#[tauri::command]
pub fn plugin_setting_values(id: String) -> Result<serde_json::Value, String> {
    Ok(store::load_plugin_settings()
        .get(&id)
        .cloned()
        .unwrap_or(serde_json::Value::Object(Default::default())))
}

#[tauri::command]
pub fn plugin_save_setting_values(id: String, values: serde_json::Value) -> Result<(), String> {
    let mut all = store::load_plugin_settings();
    let obj = all
        .as_object_mut()
        .ok_or_else(|| "plugin-settings.json 结构异常".to_string())?;
    obj.insert(id, values);
    store::save_plugin_settings(&all)
}

// ————————————————————————————————————————————————
// 截图覆盖层（宿主自有页面 screencap-overlay 调用，不过插件权限网关）
// ————————————————————————————————————————————————

/// 覆盖层页面加载后取冻结帧 + 插件设置，并显示窗口。
#[tauri::command]
pub fn screenshot_begin(app: AppHandle) -> Result<serde_json::Value, String> {
    crate::screenshot::begin(&app)
}

/// 完成截图：保存文件和/或复制到剪贴板，随后结束会话。
#[tauri::command]
pub fn screenshot_finish(
    app: AppHandle,
    save_data_url: Option<String>,
    copy_data_url: Option<String>,
) -> Result<serde_json::Value, String> {
    crate::screenshot::finish(&app, save_data_url, copy_data_url)
}

/// 取消截图（Esc / 右键）。
#[tauri::command]
pub fn screenshot_cancel(app: AppHandle) {
    crate::screenshot::cancel_session(&app)
}

/// 截图中按快捷键复制光标处颜色。
#[tauri::command]
pub fn screenshot_copy_color(app: AppHandle, text: String) -> Result<(), String> {
    crate::screenshot::copy_color(&app, &text)
}

// ————————————————————————————————————————————————
// 杂项
// ————————————————————————————————————————————————

/// 读取前台窗口的选中文本（系统分享面板的替代实现）。
#[tauri::command]
pub fn read_selection() -> Result<serde_json::Value, String> {
    host::dispatch_selection()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub data_dir: String,
    pub plugin_count: usize,
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        data_dir: store::data_dir().to_string_lossy().to_string(),
        plugin_count: plugin_store::list().len(),
    }
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::manifest::Activation;
    use crate::plugins::store::InstalledPlugin;

    fn plugin(id: &str, name: &str, keywords: &[&str], pinned: bool, enabled: bool) -> InstalledPlugin {
        InstalledPlugin {
            id: id.into(),
            name: name.into(),
            version: "1.0.0".into(),
            description: None,
            author: None,
            keywords: keywords.iter().map(|s| s.to_string()).collect(),
            activation: Activation::default(),
            invocation: Default::default(),
            permissions: vec![],
            enabled,
            pinned,
            has_settings: false,
            icon: None,
            icon_url: None,
            dir: String::new(),
        }
    }

    fn ids(scored: &[matcher::Scored]) -> Vec<String> {
        scored.iter().map(|(item, _)| item.id.clone()).collect()
    }

    #[test]
    fn 空查询返回全部钉住的轻应用() {
        let plugins = vec![
            plugin("a.lock", "锁屏", &["lock"], true, true),
            plugin("b.cap", "截图", &["screenshot"], true, true),
            plugin("c.off", "待办", &["todo"], false, true), // 没钉住 → 不出现
            plugin("d.dis", "记事", &["note"], true, false), // 被禁用 → 不出现
        ];
        let got = ids(&plugin_candidates("", &plugins));
        assert_eq!(got.len(), 2);
        assert!(got.contains(&"plugin:a.lock".to_string()));
        assert!(got.contains(&"plugin:b.cap".to_string()));
    }

    #[test]
    fn 关键词命中就够了不要求名称也匹配() {
        // 输入 lock 命中 keywords，但应用名是中文"锁屏" —— 之前会什么都不显示
        let plugins = vec![plugin("a.lock", "锁屏", &["lock", "锁屏"], true, true)];
        let got = ids(&plugin_candidates("lock", &plugins));
        assert_eq!(got, vec!["plugin:a.lock"]);
    }

    #[test]
    fn 名称匹配也能入选() {
        let plugins = vec![plugin("a.lock", "锁屏", &["xyz"], true, true)];
        let got = ids(&plugin_candidates("锁屏", &plugins));
        assert_eq!(got, vec!["plugin:a.lock"]);
        // 不相关的查询不出现
        assert!(plugin_candidates("待办", &plugins).is_empty());
    }

    #[test]
    fn 关键词命中的分数高于纯名称匹配() {
        let plugins = vec![
            plugin("a", "锁屏", &["lock"], true, true),
            plugin("b", "录音机", &[], true, true),
        ];
        let scored = plugin_candidates("lock", &plugins);
        assert_eq!(scored.len(), 1);
        assert!(scored[0].1 >= 1200.0, "关键词命中应带 1200 权重: {}", scored[0].1);
    }
}

/// 重新扫描已安装应用（设置页手动触发）。
#[tauri::command]
pub fn clear_history() {
    let path = store::data_dir().join("history.json");
    let _ = std::fs::remove_file(path);
}