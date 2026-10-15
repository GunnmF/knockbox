//! Knockbox 内核入口。
//!
//! 性能是这里的第一设计约束。uTool 一类 Electron 启动器"越用越卡"的根因通常是：
//! 常驻的渲染进程 + 一堆后台索引/同步任务 + 插件进程长期存活。
//! Knockbox 的对策是三件事：
//! 1. **不常驻重活**：没有索引器、没有文件 watcher、没有插件常驻进程
//! 2. **应用列表走缓存**：首次扫盘后落盘，之后启动只读 JSON
//! 3. **窗口默认隐藏**：进程常驻但窗口不占资源，快捷键唤起是纯 show + set_focus

mod commands;
mod core;
mod plugins;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单例插件必须**第一个**注册，否则第二个进程可能在它装好之前就起来了。
        //
        // 没有它会怎样：用户看到托盘里有两个 Knockbox、内存翻倍、快捷键互相抢，
        // 而且两份缓存各写各的 —— 这正是「轻量」最不能容忍的。
        // 第二次启动不该开出新进程，而应该把已有实例的窗口叫到前面。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.center();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(
            |app, _shortcut, event| {
                // 按下即唤起/收起。event.state() 区分按下与松开，这里只响应按下，
                // 避免长按快捷键时反复闪烁窗口。
                if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    toggle_window(app);
                }
            },
        ).build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::AppCache::default())
        .register_uri_scheme_protocol("knockbox-plugin", |_app, request| {
            serve_plugin_asset(request.uri().path())
        })
        .setup(|app| {
            let hotkey = core::store::load_settings().hotkey;
            // 启动时先把当前快捷键记进 state，之后设置里改失败才能回滚
            app.manage(commands::Hotkey::new(hotkey.clone()));
            if let Err(e) = register_hotkey(app.handle(), &hotkey) {
                eprintln!("[knockbox] {e}");
            }
            // 内置轻应用要在第一次搜索之前就位，否则用户第一次唤起时搜不到
            plugins::builtin::sync_all();
            build_tray(app.handle())?;
            warm_cache(app.handle());

            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // 点关闭按钮 = 收起，不是退出。真正的退出走托盘菜单。
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::search,
            commands::execute,
            commands::hide,
            commands::rescan_apps,
            commands::get_settings,
            commands::save_settings,
            commands::resize_window,
            commands::plugin_list,
            commands::plugin_install_dir,
            commands::plugin_install_zip,
            commands::plugin_install_git,
            commands::plugin_install_registry,
            commands::plugin_uninstall,
            commands::plugin_set_enabled,
            commands::plugin_set_pinned,
            commands::plugin_call,
            commands::plugin_entry_url,
            commands::plugin_meta,
            commands::plugin_setting_values,
            commands::plugin_save_setting_values,
            commands::read_selection,
            commands::app_info,
            commands::clear_history,
        ])
        .build(tauri::generate_context!())
        .expect("启动 Knockbox 失败")
        .run(|app_handle, event| {
            // Dock 图标点击（或再次 open）：macOS 把这个事件发给**已有实例**，
            // 根本不开新进程 —— 单例插件管不到这条路，必须在这里唤起窗口。
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(win) = app_handle.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.center();
                    let _ = win.set_focus();
                }
            }
        });
}

/// 快捷键唤起 / 收起主窗口。
fn toggle_window(app: &tauri::AppHandle) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    let visible = win.is_visible().unwrap_or(false);
    if visible {
        let _ = win.hide();
    } else {
        let _ = win.show();
        let _ = win.center();
        let _ = win.set_focus();
    }
}

/// 注册（或热替换）全局快捷键。
///
/// 用户的快捷键可能在设置里改，所以每次改完都要立刻生效，不能要求重启。
/// `unregister_all` 是安全的 —— 这里的快捷键池里只有我们这一条。
fn register_hotkey(app: &tauri::AppHandle, hotkey: &str) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let _ = app.global_shortcut().unregister_all();
    match app.global_shortcut().register(hotkey) {
        Ok(()) => {
            if let Some(state) = app.try_state::<commands::Hotkey>() {
                *state.0.lock().unwrap() = hotkey.to_string();
            }
            Ok(())
        }
        Err(e) => {
            // 快捷键被别的软件占用是常见情况，必须降级而不是崩溃。
            // 回滚到上一个能用的，否则用户改完快捷键就再也唤不出窗口了。
            let previous = app
                .try_state::<commands::Hotkey>()
                .map(|s| s.0.lock().unwrap().clone());
            if let Some(prev) = previous {
                let _ = app.global_shortcut().register(prev.as_str());
            }
            Err(format!("快捷键 {hotkey} 注册失败（可能已被其它软件占用）: {e}"))
        }
    }
}

fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Knockbox", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &settings, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Knockbox · 叩一叩，万物即出")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => toggle_window(app),
            "quit" => app.exit(0),
            "settings" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                    // 只显示窗口还不够，要告诉前端切到设置视图
                    let _ = win.emit("kb://open-settings", ());
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // macOS 左键点击托盘图标等同唤起
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                toggle_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// 后台预热：把应用列表扫进缓存。放在 spawn 里，绝不阻塞窗口显示。
fn warm_cache(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let scanned = tauri::async_runtime::spawn_blocking(core::apps::fresh_scan)
            .await
            .unwrap_or_default();
        core::store::save_app_cache("app-cache.json", &scanned);
        if let Some(state) = app.try_state::<commands::AppCache>() {
            *state.0.lock().unwrap() = Some(scanned);
        }
    });
}

/// 插件静态资源服务。
///
/// 请求路径形如 `/<pluginId>/index.html`。这里自己做三件事：
/// 1. 校验 `pluginId` 目录名合法（挡 `..`）
/// 2. 解析后的绝对路径必须仍在插件根目录内（纵深防御）
/// 3. 按扩展名给 Content-Type
fn serve_plugin_asset(uri_path: &str) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};

    // 状态码、header 名、mime 都是下面写死的常量，builder 不会失败；
    // 唯一可能 panic 的地方是 header 值非法，而那同样来自常量。
    let build = |status: StatusCode, mime: &str, body: Vec<u8>| {
        Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, mime)
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .body(body)
            .expect("常量构造的 HTTP 响应必然合法")
    };
    let not_found = || build(StatusCode::NOT_FOUND, "text/plain; charset=utf-8", Vec::new());

    // 去掉前导 `/`，切成 [pluginId, ...rest]
    let trimmed = uri_path.trim_start_matches('/');
    let mut parts = trimmed.splitn(2, '/');
    let plugin_id = parts.next().unwrap_or_default();
    let rest = parts.next().unwrap_or_default();

    // pluginId 必须是纯 id，不允许出现路径分隔符或 ..
    if plugin_id.is_empty()
        || plugin_id.contains('/')
        || plugin_id.contains('\\')
        || plugin_id.contains("..")
    {
        return not_found();
    }
    if rest.is_empty() || rest.contains("..") {
        return not_found();
    }

    let root = plugins::store::plugin_dir(plugin_id);
    let file = root.join(rest);
    if !file.is_file() {
        return not_found();
    }

    let Ok(bytes) = std::fs::read(&file) else {
        return not_found();
    };

    let mime = match file.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime)
        // 插件页面由 sandbox iframe 加载，禁止被当成文档直接导航
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .body(bytes)
        .expect("常量构造的 HTTP 响应必然合法")
}