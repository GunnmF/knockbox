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
mod screenshot;

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
                position_main_window(&win);
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(
            |app, shortcut, event| {
                // 按下即唤起/收起。event.state() 区分按下与松开，这里只响应按下，
                // 避免长按快捷键时反复闪烁窗口。
                if event.state() != tauri_plugin_global_shortcut::ShortcutState::Pressed {
                    return;
                }
                // 先问插件快捷键：不是插件的就走主快捷键的唤起/收起。
                // 同一个 handler 里路由，是因为 global-shortcut 插件只有一个回调
                if !plugins::shortcuts::dispatch(app, *shortcut) {
                    toggle_window(app);
                }
            },
        ).build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(commands::AppCache::default())
        .manage(screenshot::ScreenSession::default())
        .manage(plugins::shortcuts::PluginHotkeys::default())
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
            plugins::builtin::sync_all(app.handle());
            // 插件声明的全局快捷键要在内置应用就位之后再注册
            plugins::shortcuts::resync(app.handle());
            build_tray(app.handle())?;
            warm_cache(app.handle());

            // 诊断开关：KNOCKBOX_AUTOLAUNCH=<pluginId> 时启动即唤起该轻应用。
            // 用它可以在没有 GUI 的情况下端到端验证插件链路（无头环境下
            // 点不了界面，而插件是否加载只能这样观测）。
            //
            // 必须延迟发：setup() 跑的时候前端页面还没加载完，
            // 监听器尚未注册，立刻 emit 会被无声丢掉。
            if let Some(id) = std::env::var("KNOCKBOX_AUTOLAUNCH").ok().filter(|s| !s.is_empty())
            {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    let _ = handle.emit("kb://autolaunch", id);
                });
            }

            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            Ok(())
        })
        .on_window_event(|window, event| {
            // 截图覆盖层和主窗口的生命周期完全不同，先分叉：
            // 覆盖层被销毁（含 webview 崩溃）时必须给还在等待的插件线程
            // 补发一次取消，否则 plugin_call 会永远挂住。
            if window.label() == screenshot::OVERLAY_LABEL {
                if let WindowEvent::Destroyed = event {
                    screenshot::cancel_if_active(window.app_handle());
                }
                return;
            }
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
            commands::show,
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
            commands::screenshot_begin,
            commands::screenshot_finish,
            commands::screenshot_cancel,
            commands::screenshot_copy_color,
            commands::overlay_log,
            commands::read_selection,
            commands::app_info,
            commands::clear_history,
        ])
        .build(tauri::generate_context!())
        .expect("启动 Knockbox 失败")
        .run(|app_handle, event| {
            // Dock 图标点击（或再次 open）：macOS 把这个事件发给**已有实例**，
            // 根本不开新进程 —— 单例插件管不到这条路，必须在这里唤起窗口。
            //
            // Reopen 变体只在 macOS/iOS 上存在，Windows/Linux 的 RunEvent
            // 里没有它 —— 不加 cfg 的话 Windows 编译直接报 E0599。
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(win) = app_handle.get_webview_window("main") {
                    let _ = win.show();
                    position_main_window(&win);
                    let _ = win.set_focus();
                }
            }
            // 上面 cfg 掉之后 event 在 Windows 上没人用，显式吃掉免得告警
            #[cfg(not(any(target_os = "macos", target_os = "ios")))]
            let _ = event;
            let _ = app_handle;
        });
}

/// 顶部留白占屏幕高度的比例。剩下的高度留给往下展开的结果列表。
const TOP_MARGIN_RATIO: f64 = 0.12;

/// 算主窗口该摆在哪（纯函数，方便单测）。
///
/// 输入输出都是**物理**像素，算完再除以 scale 变成逻辑坐标。必须这么算：
/// 跨不同缩放的屏幕时直接拿物理像素当逻辑坐标用，位置会偏掉一整个缩放倍数。
fn main_window_position(
    monitor_pos: (f64, f64),
    monitor_size: (f64, f64),
    win_size: (f64, f64),
    scale: f64,
) -> tauri::LogicalPosition<f64> {
    let (mx, my) = monitor_pos;
    let (mw, mh) = monitor_size;
    let (ww, wh) = win_size;

    // 窗口比屏幕还高时（矮屏 + 管理页 600px）贴顶，(mh - wh) 已是负数，
    // 乘完必须夹住，否则会算出屏幕上方的一个位置
    let x = mx + (mw - ww) / 2.0;
    let y = my + ((mh - wh) * TOP_MARGIN_RATIO).max(0.0);
    tauri::LogicalPosition::new(x / scale, y / scale)
}

/// 把主窗口摆到「水平居中、垂直靠上」的位置。
///
/// 为什么不用 `center()`：启动器是随手唤起、随手关掉的工具，垂直居中时
/// 输入框正对屏幕中央，而结果列表是从它**往下**展开的 —— 列表一多就顶到
/// 屏幕下沿，看起来像被裁掉一块，管理页固定 600px 高时尤其明显。抬到
/// 屏幕上部之后，输入框和它下面展开的内容都留在视线里。
///
/// 每次唤起都重算：换显示器、拔外接屏之后位置仍然对。
pub(crate) fn position_main_window(win: &tauri::WebviewWindow) {
    let Ok(scale) = win.scale_factor() else { return };
    let Ok(Some(monitor)) = win.current_monitor() else { return };
    let Ok(win_size) = win.outer_size() else { return };

    let pos = main_window_position(
        (monitor.position().x as f64, monitor.position().y as f64),
        (monitor.size().width as f64, monitor.size().height as f64),
        (win_size.width as f64, win_size.height as f64),
        scale,
    );
    let _ = win.set_position(pos);
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
        position_main_window(&win);
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
            // unregister_all 把插件快捷键也一起删了，重新注册回来
            plugins::shortcuts::resync(app);
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
            // 必须发 CORS 头。插件页面跑在 `sandbox` 不含 allow-same-origin 的
            // iframe 里，origin 是 `null`；而 ES module 一律按 CORS 模式请求，
            // 没有这个头，`<script type="module">` 会被浏览器直接拦掉 ——
            // 表现为"点了插件毫无反应"，因为插件的 JS 压根没跑起来。
            //
            // 用 `*` 而不是精确 origin：插件页永远处于 opaque origin，没有可
            // 填的固定 origin。暴露面是插件自身的静态文件（不是用户数据），
            // 且宿主 CSP 已限定只有主窗口能加载这个协议。
            .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
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
        // 诊断开关：KNOCKBOX_LOG_ASSETS=1 时把每次请求打出来，
        // 用来确认"插件到底有没有被加载"。
        if std::env::var_os("KNOCKBOX_LOG_ASSETS").is_some() {
            eprintln!("[assets] 404 {plugin_id}/{rest}");
        }
        return not_found();
    }

    if std::env::var_os("KNOCKBOX_LOG_ASSETS").is_some() {
        eprintln!("[assets] 200 {plugin_id}/{rest}");
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

    // 必须走上面那个 build 闭包 —— 它带 CORS 头。
    // 之前这里自己建 Response，把 CORS 头整个绕过去了：文件确实返回了 200，
    // 但浏览器按 CORS 规则把 module 丢弃，于是插件的 import 链在第一环就断了。
    build(StatusCode::OK, mime, bytes)
}
#[cfg(test)]
mod window_position_tests {
    use super::*;

    /// 1080p 屏幕 + 520px 高的启动器：水平居中，距顶部 12%
    #[test]
    fn 水平居中且距顶部百分之十二() {
        let p = main_window_position((0.0, 0.0), (1920.0, 1080.0), (760.0, 520.0), 1.0);
        assert_eq!((p.x, p.y), ((1920.0 - 760.0) / 2.0, (1080.0 - 520.0) * 0.12));
    }

    /// Retina 屏 scale=2：物理像素算完要折回逻辑坐标，否则位置偏一倍
    #[test]
    fn 视网膜屏按比例折算() {
        let p = main_window_position((0.0, 0.0), (2880.0, 1800.0), (1520.0, 1040.0), 2.0);
        assert_eq!((p.x, p.y), (((2880.0 - 1520.0) / 2.0) / 2.0, ((1800.0 - 1040.0) * 0.12) / 2.0));
    }

    /// 窗口比屏幕还高（矮屏 + 管理页 600px）：贴顶，不能算出屏幕上方的位置
    #[test]
    fn 窗口比屏幕高时贴顶() {
        let p = main_window_position((0.0, 0.0), (1366.0, 500.0), (760.0, 600.0), 1.0);
        assert_eq!(p.y, 0.0);
    }

    /// 副屏在主屏右边时，x 要跟着副屏的起点走，不能贴到主屏上
    #[test]
    fn 多显示器用当前屏幕的原点() {
        let p = main_window_position((1920.0, -200.0), (1920.0, 1080.0), (760.0, 520.0), 1.0);
        assert_eq!(p.x, 1920.0 + (1920.0 - 760.0) / 2.0);
        assert_eq!(p.y, -200.0 + (1080.0 - 520.0) * 0.12);
    }
}
