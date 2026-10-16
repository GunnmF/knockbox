//! 插件声明的全局快捷键：收集、注册、分发。
//!
//! 设计原则（PLUGIN_ECOSYSTEM §4.1）：**宿主负责监听，插件只声明**。
//! 插件在 `plugin.json` 的 `shortcuts` 里写出要监听的组合键，这里负责把它
//! 注册进系统；按下时按 `mode` 分发，插件自己碰不到任何监听 API。
//!
//! 分发走前端事件 `kb://hotkey-run`：插件页面永远跑在主窗口的 iframe 里
//! （沙箱模型），所以"静默执行"的真实含义是**主窗口保持隐藏**，只有插件
//! 需要的界面（比如截图覆盖层）出现。

use crate::core::manifest::{ShortcutMode, MANIFEST_FILE};
use crate::plugins::store as plugin_store;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

/// 按下某个插件快捷键后往哪送。
#[derive(Debug, Clone)]
pub struct HotkeyTarget {
    pub plugin_id: String,
    pub mode: ShortcutMode,
}

/// 当前已注册的插件快捷键表。Key 是解析后的 Shortcut（它是 Copy + Eq + Hash）。
#[derive(Default)]
pub struct PluginHotkeys(pub Mutex<HashMap<Shortcut, HotkeyTarget>>);

/// 前端监听的事件名。
pub const HOTKEY_EVENT: &str = "kb://hotkey-run";

/// 从已安装且启用的插件里收集快捷键并重新注册。
///
/// 幂等：安装/启用/禁用/卸载任何插件之后都重跑一遍，先把旧的全删掉再按
/// 当前的清单注册。失败（比如键位被系统或其它应用占用）只记日志、跳过那一条，
/// 不影响其它快捷键，也不影响宿主自己的主快捷键。
pub fn resync(app: &AppHandle) {
    // 1. 收集
    let mut wanted: Vec<(String, crate::core::manifest::ShortcutDef)> = Vec::new();
    for p in plugin_store::list() {
        if !p.enabled {
            continue;
        }
        let manifest_path = plugin_store::plugin_dir(&p.id).join(MANIFEST_FILE);
        let Ok(raw) = std::fs::read_to_string(&manifest_path) else { continue };
        let Ok(manifest) = serde_json::from_str::<crate::core::manifest::Manifest>(&raw) else {
            continue;
        };
        // manifest 校验过了，这里再兜一次：没声明 system:hotkey 却带快捷键的
        // 一律不注册 —— 不信任清单自述是这条边界的基本功
        if !manifest.permissions.iter().any(|p| p == "system:hotkey") {
            continue;
        }
        for s in manifest.shortcuts {
            wanted.push((p.id.clone(), s));
        }
    }

    // 2. 解析 + 去重。规则：主快捷键优先；插件间先到先得，后到的记日志。
    let main_key = crate::core::store::load_settings().hotkey;
    let main_shortcut = Shortcut::from_str(&main_key).ok();

    let mut map: HashMap<Shortcut, HotkeyTarget> = HashMap::new();
    for (plugin_id, s) in wanted {
        let shortcut = match Shortcut::from_str(&s.key) {
            Ok(sc) => sc,
            Err(e) => {
                eprintln!("[knockbox] 快捷键 \"{}\"（{plugin_id}）解析失败: {e}", s.key);
                continue;
            }
        };
        if Some(shortcut) == main_shortcut {
            eprintln!(
                "[knockbox] {plugin_id} 的快捷键 \"{}\" 与主快捷键冲突，已跳过",
                s.key
            );
            continue;
        }
        if let Some(exist) = map.get(&shortcut) {
            eprintln!(
                "[knockbox] 快捷键 \"{}\" 已被 {} 占用，{plugin_id} 的未注册",
                s.key, exist.plugin_id
            );
            continue;
        }
        map.insert(
            shortcut,
            HotkeyTarget {
                plugin_id,
                mode: s.mode,
            },
        );
    }

    // 3. 先把旧的插件快捷键全部注销，再注册新的。绝不用 unregister_all ——
    // 那会把主快捷键一起干掉（register_hotkey 里就是 unregister_all，所以
    // 改完主快捷键必须再调一次本函数）
    {
        let state = app.state::<PluginHotkeys>();
        let mut cur = state.0.lock().unwrap_or_else(|e| e.into_inner());
        for sc in cur.keys() {
            let _ = app.global_shortcut().unregister(*sc);
        }
        for (sc, target) in &map {
            match app.global_shortcut().register(*sc) {
                Ok(()) => {}
                Err(e) => eprintln!(
                    "[knockbox] 注册快捷键失败（{}）：{e} —— 可能被其它应用占用",
                    target.plugin_id
                ),
            }
        }
        *cur = map;
    }
}

/// 快捷键按下时分发。返回 true 表示这条是插件快捷键（已消费），
/// false 表示不是（调用方继续走自己的主快捷键逻辑）。
pub fn dispatch(app: &AppHandle, shortcut: Shortcut) -> bool {
    let state = app.state::<PluginHotkeys>();
    let target = {
        let cur = state.0.lock().unwrap_or_else(|e| e.into_inner());
        cur.get(&shortcut).cloned()
    };
    let Some(target) = target else { return false };

    let payload = serde_json::json!({
        "id": target.plugin_id,
        "mode": match target.mode {
            ShortcutMode::Silent => "silent",
            ShortcutMode::Panel => "panel",
        },
    });
    // silent 模式绝不让主窗口现身：emit 只是发事件，前端收到后决定要不要
    // 显示窗口（panel 模式才显示）
    let _ = app.emit_to("main", HOTKEY_EVENT, payload);
    true
}
