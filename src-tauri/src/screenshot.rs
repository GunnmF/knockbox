//! Snipaste 式截图会话：冻结帧 + 全屏覆盖层。
//!
//! 为什么不继续用 `screencapture -i`（系统自带选区界面）：它只给一个框，
//! 标记、放大镜取色、快捷键复制颜色都无从谈起 —— 而这些正是截图工具的
//! 日常高频动作。所以这里自绘覆盖层：
//!
//! 1. `run_region_session`（插件 `screen.capture` 的 region 分支）：
//!    藏主窗口 → 截全屏冻结帧到临时文件 → 建无边框置顶覆盖窗口
//!    （`index.html?overlay=1`，宿主自己的页面，不在插件沙箱里）→
//!    阻塞等覆盖层通过 mpsc 回结果 → 把结果作为插件调用的返回值。
//! 2. 覆盖层页面通过 `screenshot_begin / finish / cancel / copy_color`
//!    四个命令与这里通信。页面是宿主自己的代码，不走插件权限网关。
//!
//! 会话全程单例：同一时刻只允许一个截图会话，重复唤起直接拒绝。
//! 任何一条出路（完成/取消/窗口被销毁）都必须往 `reply` 发一次结果，
//! 否则 `plugin_call` 的阻塞线程会永远挂住 —— 加新出口时先看这条。

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use tauri::{AppHandle, Manager};

/// 诊断输出。与 host.rs 共用 KNOCKBOX_LOG_ASSETS 开关，一条命令看全链路。
macro_rules! trace {
    ($($arg:tt)*) => {
        if std::env::var_os("KNOCKBOX_LOG_ASSETS").is_some() {
            eprintln!("[shot] {}", format!($($arg)*));
        }
    };
}

/// 覆盖层窗口标签。`lib.rs` 的窗口事件处理按它区分主窗口。
pub const OVERLAY_LABEL: &str = "screencap-overlay";

/// 传给插件的最终结果超过这个体积就不带 dataUrl（与 host.rs 既有约定一致）。
const MAX_INLINE_BYTES: usize = 8 * 1024 * 1024;

/// 进行中的截图会话。`reply` 一拿就走（`Option` + take），
/// 保证"恰好回复一次"由类型系统兜底。
pub struct PendingSession {
    pub plugin_id: String,
    /// 冻结帧临时文件，begin 读一次，会话结束时删
    pub frame_png: PathBuf,
    /// 覆盖层页面是否已调过 begin。页面加载失败时它永远不来，
    /// 看门狗就靠这个区分"用户在慢慢标注"和"页面根本没起来"
    pub begun: bool,
    pub reply: Option<mpsc::Sender<Result<Value, String>>>,
}

#[derive(Default)]
pub struct ScreenSession(pub std::sync::Mutex<Option<PendingSession>>);

impl ScreenSession {
    /// 取出会话（每个出口都该走这里，保证只处理一次）。
    fn take(app: &AppHandle) -> Option<PendingSession> {
        app.state::<ScreenSession>().0.lock().unwrap().take()
    }

    fn is_active(app: &AppHandle) -> bool {
        app.state::<ScreenSession>().0.lock().unwrap().is_some()
    }
}

// ————————————————————————————————————————————————
// 会话主流程（插件调用的 region 分支，运行在 spawn_blocking 线程里）
// ————————————————————————————————————————————————

/// 保存格式（png/jpg）不在这里用：覆盖层出图时按 begin 下发的设置编码。
pub fn run_region_session(app: &AppHandle, plugin_id: &str) -> Result<Value, String> {
    if ScreenSession::is_active(app) {
        return Err("已有截图会话进行中".into());
    }

    // 光标在哪块屏，就截哪块屏、在哪块屏开覆盖层。
    // 多显示器用户的"另一个屏幕"才是上下文所在 —— 写死主屏的话，
    // 他在副屏唤起，看到的是主屏的画面，完全对不上。
    let monitor = pick_monitor(app);
    let display_no = monitor.as_ref().map(|(_, n)| *n);
    if let Some((m, n)) = &monitor {
        let s = m.size();
        let p = m.position();
        trace!(
            "目标显示器 #{n}: {}x{} @{}x pos=({},{})",
            s.width,
            s.height,
            m.scale_factor(),
            p.x,
            p.y
        );
    }

    // 先把启动器藏起来再截帧 —— 冻结帧里不该有我们自己。
    // 直接调用的插件（截图就是）在唤起时已经藏过一次，这里再藏是幂等的。
    // 记下原状态：截图不是 direct 唤起时（比如别的插件也用这个能力），
    // 窗口之前是开着的，截完得还回去，否则用户凭空少一个窗口。
    let main_was_visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.hide();
    }
    // 窗口隐藏不是即时的，不等会拍到自己的残影
    std::thread::sleep(std::time::Duration::from_millis(250));

    let frame = match capture_frame(display_no) {
        Ok(path) => path,
        Err(e) => {
            // direct 型插件没有面板可以报错，错误只会变成一句静默失败 ——
            // 而「没给屏幕录制权限」恰恰是首次使用最常撞上的情况，
            // 必须当面告诉用户去哪里开，否则体验就是"点了没反应"。
            trace!("冻结帧失败: {e}");
            notify_error(app, &e);
            return Err(e);
        }
    };
    trace!("冻结帧就绪: {}", frame.to_string_lossy());
    let (tx, rx) = mpsc::channel();
    *app.state::<ScreenSession>().0.lock().unwrap() = Some(PendingSession {
        plugin_id: plugin_id.to_string(),
        frame_png: frame.clone(),
        begun: false,
        reply: Some(tx),
    });

    if let Err(e) = open_overlay_window(app, monitor.as_ref().map(|(m, _)| m)) {
        // 建窗口失败：把会话撤掉，别让下一次截图永远被拒
        trace!("创建覆盖层窗口失败: {e}");
        let _ = ScreenSession::take(app);
        let _ = std::fs::remove_file(&frame);
        restore_main_window(app, main_was_visible);
        return Err(format!("创建截图覆盖层失败: {e}"));
    }
    trace!("覆盖层窗口已创建（未显示，等 begin）");
    start_begin_watchdog(app);

    // 阻塞等覆盖层出结果。没有超时：用户可能慢慢标注。
    // 覆盖层窗口被销毁（崩溃等）时 lib.rs 的 Destroyed 钩子会补发取消，
    // 页面 30 秒不起来时看门狗会补发失败，所以这里不会永久挂住。
    let outcome = rx.recv().unwrap_or_else(|_| Err("截图会话异常结束".into()));
    trace!(
        "会话结束: {}",
        outcome.as_ref().map(|_| "ok").unwrap_or("err")
    );

    cleanup_overlay(app);
    let _ = std::fs::remove_file(&frame);
    restore_main_window(app, main_was_visible);
    outcome
}

/// begin 看门狗：覆盖层页面加载失败时 begin 永远不会来，插件线程不能永久挂住。
/// 30 秒内没等到 begin 就按失败结束会话，并当面告诉用户 ——
/// "点了截图毫无反应"是最难排查的症状。
fn start_begin_watchdog(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(30));
        let stuck = {
            let state = app.state::<ScreenSession>();
            let guard = state.0.lock().unwrap();
            guard.as_ref().is_some_and(|s| !s.begun)
        };
        if stuck {
            trace!("30 秒内 begin 未到，判定页面未起来");
            fail_session(&app, "截图界面未能打开（页面 30 秒无响应）");
            notify_error(&app, "截图界面未能打开，请重试。若反复出现请反馈给开发者。");
        }
    });
}

/// 所有出口的统一形状：撤掉会话、回复插件线程、销毁覆盖层窗口。
fn fail_session(app: &AppHandle, msg: &str) {
    if let Some(mut session) = ScreenSession::take(app) {
        if let Some(reply) = session.reply.take() {
            let _ = reply.send(Err(msg.to_string()));
        }
    }
    cleanup_overlay(app);
}

fn restore_main_window(app: &AppHandle, was_visible: bool) {
    if !was_visible {
        return;
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}

/// 用系统原生对话框报错。截图是 direct 唤起的，插件没有界面可说这件事。
fn notify_error(app: &AppHandle, message: &str) {
    use tauri_plugin_dialog::DialogExt;
    // 注意顺序：message() 返回的才是消息框构造器，title() 得挂在它后面
    app.dialog().message(message).title("截图失败").blocking_show();
}

// ————————————————————————————————————————————————
// 覆盖层窗口
// ————————————————————————————————————————————————

/// 光标所在的显示器，返回 (monitor, 1-based 序号)。
/// 序号用于 `screencapture -D`（CG 显示列表顺序，与 NSScreen 顺序一致）。
/// 找不到光标位置时退回主屏（序号 1）。
#[cfg(target_os = "macos")]
fn pick_monitor(app: &AppHandle) -> Option<(tauri::Monitor, usize)> {
    let monitors = app.available_monitors().ok()?;
    if monitors.is_empty() {
        return None;
    }
    let cursor = app
        .get_webview_window("main")
        .and_then(|w| w.cursor_position().ok());
    let idx = cursor
        .and_then(|p| {
            monitors.iter().position(|m| {
                let mp = m.position();
                let ms = m.size();
                p.x >= mp.x as f64
                    && p.x < (mp.x + ms.width as i32) as f64
                    && p.y >= mp.y as f64
                    && p.y < (mp.y + ms.height as i32) as f64
            })
        })
        .unwrap_or(0);
    let n = idx + 1;
    monitors.into_iter().nth(idx).map(|m| (m, n))
}

/// Windows 的捕获只支持主屏（PowerShell CopyFromScreen 按 PrimaryScreen 取），
/// 所以覆盖层也必须开主屏，不然画面和窗口对不上。
#[cfg(not(target_os = "macos"))]
fn pick_monitor(app: &AppHandle) -> Option<(tauri::Monitor, usize)> {
    app.primary_monitor().ok()?.map(|m| (m, 1))
}

fn open_overlay_window(app: &AppHandle, monitor: Option<&tauri::Monitor>) -> Result<(), String> {
    // 上一次会话的窗口如果因故还活着，先销毁，同标签复建会直接报错
    if let Some(old) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = old.destroy();
    }

    let (log_size, log_pos) = monitor
        .map(|m| {
            let scale = m.scale_factor();
            let s = m.size();
            let p = m.position();
            (
                tauri::LogicalSize::new(s.width as f64 / scale, s.height as f64 / scale),
                tauri::LogicalPosition::new(p.x as f64 / scale, p.y as f64 / scale),
            )
        })
        .unwrap_or_else(|| {
            (
                tauri::LogicalSize::new(1280.0, 800.0),
                tauri::LogicalPosition::new(0.0, 0.0),
            )
        });

    // KNOCKBOX_PROBE=text：页面加载后自动进入文字输入自测（免点击复现焦点问题）
    let mut url = "index.html?overlay=1";
    if std::env::var_os("KNOCKBOX_PROBE").is_some() {
        url = "index.html?overlay=1&probe=text";
    }
    // mut 只有 macOS 分支（下面重新赋值 builder）用得上，
    // 其他平台会报 "variable does not need to be mutable"
    #[allow(unused_mut)]
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        OVERLAY_LABEL,
        tauri::WebviewUrl::App(url.into()),
    )
    .title("Knockbox 截图")
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .shadow(false)
    .focused(true)
    // 先藏着：尺寸位置就位、前端拿到冻结帧之后由 begin 命令再显示，
    // 避免在错误的位置/尺寸闪一帧
    .visible(false)
    // 必须用**逻辑**尺寸/位置：窗口跨屏移动时 macOS 保持逻辑尺寸不变
    // 只重算物理像素 —— 给物理值的话，窗口诞生在哪块屏的 scale 就
    // 决定它最终的逻辑大小，生在 1x 屏再移到 Retina 屏，尺寸直接翻倍，
    // 冻结帧被放大到屏幕外、右下永远框选不到。
    // Monitor::size/position 是 backing 物理像素，除以 scale_factor
    // 就是该屏精确的逻辑几何（NSScreen.frame）。
    .inner_size(log_size.width, log_size.height)
    .position(log_pos.x, log_pos.y);

    // 覆盖层要出现在当前 Space，而不是跳回主窗口所在的 Space
    #[cfg(target_os = "macos")]
    {
        builder = builder.visible_on_all_workspaces(true);
    }

    let win = builder.build().map_err(|e| e.to_string())?;

    // macOS 的两件事都只能在主线程做（AppKit 铁律，后台线程裸调会 SIGTRAP，
    // 而 release 是 panic=abort，崩了连日志都没有）：
    //
    // macOS 的菜单栏 level 比 alwaysOnTop（floating = 3）高，不抬 level 的话
    // 屏幕顶部菜单栏那一条永远盖在我们上面 —— 那片区域就选不中、也取不了色。
    // kCGMainMenuWindowLevel 是 24，抬到 25 刚好压过它。
    //
    // 必须经 run_on_main_thread 调：AppKit 的窗口操作只允许在主线程，
    // 这个函数跑在 spawn_blocking 线程里，裸 msg_send 会被 WindowManagement
    // 框架直接陷阱终止（release 是 panic=abort，连错误都留不下）。
    #[cfg(target_os = "macos")]
    if let Ok(ns_win) = win.ns_window() {
        let ptr = ns_win as usize; // 裸指针打包成 usize 过线程边界
        let (done_tx, done_rx) = mpsc::channel();
        let _ = app.run_on_main_thread(move || {
            // （objc 0.2 的 msg_send 宏里有个过时的 cfg(cargo-clippy)，警告来自它）
            #[allow(unexpected_cfgs)]
            unsafe {
                use objc::{msg_send, sel, sel_impl};
                let _: () = msg_send![ptr as *mut objc::runtime::Object, setLevel: 25_i64];
            }
            let _ = done_tx.send(());
        });
        // 等它真正落地：后面的 show 必须排在 level 之后，
        // 不然 menu bar 会闪在覆盖层上面一帧
        let _ = done_rx.recv();
    }

    trace!(
        "覆盖层窗口: scale={} 物理={:?}",
        win.scale_factor().unwrap_or(-1.0),
        win.outer_size().ok()
    );
    Ok(())
}

fn cleanup_overlay(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        // destroy 而不是 close：close 会触发 CloseRequested，被全局钩子拦成 hide，
        // 覆盖层藏起来不销毁等于白占一个 webview
        let _ = win.destroy();
    }
}

/// 窗口事件钩子用：覆盖层被销毁（包括崩溃）时，若会话还挂着就补发取消。
/// 这是"reply 恰好发一次"的兜底出口。不销毁窗口 —— 调用方就是被销毁事件触发的。
pub fn cancel_if_active(app: &AppHandle) {
    if let Some(mut session) = ScreenSession::take(app) {
        trace!("会话被取消（窗口销毁）");
        if let Some(reply) = session.reply.take() {
            let _ = reply.send(Err("已取消截图".into()));
        }
    }
}

// ————————————————————————————————————————————————
// 覆盖层页面调用的四个命令（宿主自有页面，不过插件权限网关）
// ————————————————————————————————————————————————

/// 页面加载后第一件事：拿冻结帧 + 插件设置。
/// 顺带把窗口显示出来 —— 此时内容马上就能渲染，闪空窗的时间最短。
pub fn begin(app: &AppHandle) -> Result<Value, String> {
    let (plugin_id, frame) = {
        let state = app.state::<ScreenSession>();
        let mut guard = state.0.lock().unwrap();
        let Some(session) = guard.as_mut() else {
            trace!("begin 到了但没有会话");
            return Err("没有进行中的截图会话".into());
        };
        session.begun = true;
        (session.plugin_id.clone(), session.frame_png.clone())
    };
    trace!("begin：页面就绪，显示覆盖层");

    let bytes = std::fs::read(&frame).map_err(|e| format!("读取冻结帧失败: {e}"))?;
    let data_url = format!("data:image/png;base64,{}", base64_encode(&bytes));

    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        // 键盘焦点是覆盖层的命门：焦点进不来，文字输入/C 取色/Esc 全死。
        // 无边框 + 高 level + Accessory 的组合下这个值必须实测。
        trace!("begin: 覆盖层已显示 is_focused={:?}", win.is_focused().ok());
    } else {
        trace!("begin：覆盖层窗口已不存在");
    }

    Ok(serde_json::json!({
        "dataUrl": data_url,
        "settings": merged_settings(&plugin_id),
        "saveDir": screenshots_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
    }))
}

/// 完成：保存图片和/或复制到剪贴板，然后结束会话。
///
/// 前端按设置决定传哪份数据：`saveDataUrl` 用用户选的格式编码（要落盘），
/// `copyDataUrl` 一律 PNG（进剪贴板）。两个都空等于什么都没做，视为取消。
pub fn finish(
    app: &AppHandle,
    save_data_url: Option<String>,
    copy_data_url: Option<String>,
) -> Result<Value, String> {
    let Some(mut session) = ScreenSession::take(app) else {
        return Err("没有进行中的截图会话".into());
    };
    trace!("finish：保存={} 复制={}", save_data_url.is_some(), copy_data_url.is_some());

    // 无论成败都要回复插件线程，然后关掉覆盖层 —— 这是出口的义务
    let outcome = finish_inner(&session.plugin_id, save_data_url, copy_data_url);
    if let Some(reply) = session.reply.take() {
        let _ = reply.send(outcome.clone());
    }
    cleanup_overlay(app);
    outcome
}

fn finish_inner(
    plugin_id: &str,
    save_data_url: Option<String>,
    copy_data_url: Option<String>,
) -> Result<Value, String> {
    let mut result = Map::new();
    let mut saved_path: Option<PathBuf> = None;

    if let Some(du) = save_data_url.as_deref() {
        let (mime, bytes) = decode_data_url(du)?;
        let ext = match mime.as_str() {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            other => return Err(format!("不支持的图片格式 {other}")),
        };
        let path = screenshots_dir()?.join(format!("截屏-{}.{ext}", now_millis()));
        std::fs::write(&path, &bytes).map_err(|e| format!("写入截图失败: {e}"))?;
        result.insert("path".into(), Value::String(path.to_string_lossy().to_string()));
        result.insert("bytes".into(), serde_json::json!(bytes.len()));
        if bytes.len() <= MAX_INLINE_BYTES {
            result.insert("dataUrl".into(), Value::String(du.to_string()));
        }
        saved_path = Some(path);
    }

    let mut copied = false;
    if let Some(du) = copy_data_url.as_deref() {
        let (_, bytes) = decode_data_url(du)?;
        // 剪贴板只认 PNG：写临时文件 → 系统命令进剪贴板 → 删
        let tmp = frames_dir()?.join(format!("clipboard-{}.png", now_millis()));
        std::fs::write(&tmp, &bytes).map_err(|e| format!("写入临时文件失败: {e}"))?;
        let r = copy_image_to_clipboard(&tmp);
        let _ = std::fs::remove_file(&tmp);
        r?;
        copied = true;
    }
    result.insert("copied".into(), Value::Bool(copied));

    if !copied && saved_path.is_none() {
        // 只取色退出：按 C 复制完颜色就结束会话，不落盘也不进图片剪贴板
        result.insert("colorOnly".into(), Value::Bool(true));
        return Ok(Value::Object(result));
    }

    // 「保存后自动打开」是插件设置，以 Rust 侧读到的为准
    let settings = merged_settings(plugin_id);
    if settings.get("autoOpen").and_then(|v| v.as_bool()).unwrap_or(false) {
        if let Some(path) = &saved_path {
            let _ = crate::plugins::host::dispatch_open_path(&path.to_string_lossy());
        }
    }

    Ok(Value::Object(result))
}

/// 取消：插件线程收到「已取消截图」错误（插件把这当正常路径，静默关闭）。
pub fn cancel_session(app: &AppHandle) {
    cancel_if_active(app);
    cleanup_overlay(app);
}

/// 截图中按快捷键复制光标处颜色。只在会话进行中可用 ——
/// 这是 `screen:capture` 权限派生的行为，不能变成一个随时可写的剪贴板后门。
pub fn copy_color(app: &AppHandle, text: &str) -> Result<(), String> {
    if !ScreenSession::is_active(app) {
        return Err("没有进行中的截图会话".into());
    }
    if text.len() > 64 {
        return Err("颜色文本过长".into());
    }
    crate::plugins::host::clipboard_write_text(text)
}

// ————————————————————————————————————————————————
// 冻结帧捕获
// ————————————————————————————————————————————————

fn capture_frame(display_no: Option<usize>) -> Result<PathBuf, String> {
    let path = frames_dir()?.join(format!("frame-{}.png", now_millis()));

    // 诊断开关：跳过 screencapture 用一张假图当冻结帧。
    // 排查"覆盖层出不来"时屏幕录制权限是干扰项，拿它先隔离掉。
    if std::env::var_os("KNOCKBOX_FAKE_FRAME").is_some() {
        let icon = Path::new(env!("CARGO_MANIFEST_DIR")).join("icons/128x128@2x.png");
        std::fs::copy(&icon, &path).map_err(|e| format!("假冻结帧生成失败: {e}"))?;
        return Ok(path);
    }

    capture_frame_impl(&path, display_no)?;
    if !path.exists() && display_no.is_some() {
        // -D 序号和 CG 显示列表对不上时（极少见），退回主屏而不是直接失败
        trace!("-D {:?} 未产出，退回主屏捕获", display_no);
        capture_frame_impl(&path, None)?;
    }
    if !path.exists() {
        return Err("截屏失败。请到「系统设置 → 隐私与安全性 → 屏幕录制」里允许 Knockbox".into());
    }
    if let Ok(bytes) = std::fs::read(&path) {
        if let Some((w, h)) = png_dimensions(&bytes) {
            trace!("冻结帧像素: {w}x{h}");
        }
    }
    Ok(path)
}

/// 从 PNG 头（IHDR）读宽高，诊断用：验证冻结帧像素和目标显示器的几何关系。
fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || &bytes[0..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((w, h))
}

#[cfg(target_os = "macos")]
fn capture_frame_impl(path: &Path, display_no: Option<usize>) -> Result<(), String> {
    // -x 静音。不带 -i：选区由覆盖层做，这里只要一张全屏冻结帧。
    // display_no 是 1-based 的 CG 显示器序号（多屏时截光标所在那块）。
    let mut cmd = std::process::Command::new("screencapture");
    cmd.args(["-x", "-t", "png"]);
    if let Some(n) = display_no {
        cmd.arg("-D").arg(n.to_string());
    }
    cmd.arg(path);
    cmd.output().map_err(|e| format!("调用 screencapture 失败: {e}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn capture_frame_impl(path: &Path, _display_no: Option<usize>) -> Result<(), String> {
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;\
         $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;\
         $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;\
         $g=[System.Drawing.Graphics]::FromImage($bmp);\
         $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);\
         $bmp.Save('{}',[System.Drawing.Imaging.ImageFormat]::Png)",
        path.to_string_lossy().replace('\\', "\\\\")
    );
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .output()
        .map_err(|e| format!("截屏失败: {e}"))?;
    if !out.status.success() {
        return Err("截屏失败".into());
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn capture_frame_impl(_path: &Path, _display_no: Option<usize>) -> Result<(), String> {
    Err("当前平台不支持截屏".into())
}

// ————————————————————————————————————————————————
// 剪贴板写图片（系统命令，不引新依赖）
// ————————————————————————————————————————————————

#[cfg(target_os = "macos")]
fn copy_image_to_clipboard(path: &Path) -> Result<(), String> {
    // osascript 的 «class PNGf» 是 PNG 数据的剪贴板类型
    let script = format!(
        "set the clipboard to (read (POSIX file \"{}\") as «class PNGf»)",
        path.to_string_lossy()
    );
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("调用 osascript 失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "复制图片到剪贴板失败: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn copy_image_to_clipboard(path: &Path) -> Result<(), String> {
    // SetImage 必须在 STA 线程跑，powershell 默认 STA 但显式声明更稳
    let script = format!(
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;\
         $i=[System.Drawing.Image]::FromFile('{}');\
         [System.Windows.Forms.Clipboard]::SetImage($i);\
         $i.Dispose()",
        path.to_string_lossy().replace('\'', "''")
    );
    let out = std::process::Command::new("powershell")
        .args(["-STA", "-NoProfile", "-Command", &script])
        .output()
        .map_err(|e| format!("复制图片到剪贴板失败: {e}"))?;
    if !out.status.success() {
        return Err("复制图片到剪贴板失败".into());
    }
    Ok(())
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn copy_image_to_clipboard(_path: &Path) -> Result<(), String> {
    Err("当前平台不支持复制图片".into())
}

// ————————————————————————————————————————————————
// 小工具
// ————————————————————————————————————————————————

/// 截图保存目录：桌面/Knockbox 截图。与 host.rs 的 full 模式截图保持一致。
pub fn screenshots_dir() -> Result<PathBuf, String> {
    let dir = dirs::desktop_dir()
        .ok_or_else(|| "找不到桌面目录".to_string())?
        .join("Knockbox 截图");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建截图目录失败: {e}"))?;
    Ok(dir)
}

/// 冻结帧/剪贴板临时文件的存放处。在应用数据目录下，不进用户的桌面。
fn frames_dir() -> Result<PathBuf, String> {
    let dir = crate::core::store::data_dir().join("frames");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败: {e}"))?;
    Ok(dir)
}

/// 设置合并：manifest 声明的 default 垫底，用户填的值盖在上面。
fn merged_settings(plugin_id: &str) -> Value {
    let mut map = Map::new();
    if let Ok(m) = crate::plugins::store::load_manifest(plugin_id) {
        for def in m.settings {
            if let Some(d) = def.default {
                map.insert(def.key, d);
            }
        }
    }
    if let Some(stored) = crate::core::store::load_plugin_settings()
        .get(plugin_id)
        .and_then(|v| v.as_object())
    {
        for (k, v) in stored {
            map.insert(k.clone(), v.clone());
        }
    }
    Value::Object(map)
}

pub fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 解析 `data:<mime>;base64,<data>`。只允许图片 mime（png/jpeg 由调用方再细分）。
pub fn decode_data_url(du: &str) -> Result<(String, Vec<u8>), String> {
    let (head, data) = du.split_once(',').ok_or_else(|| "data URL 格式错误".to_string())?;
    let mime = head
        .strip_prefix("data:")
        .and_then(|h| h.strip_suffix(";base64"))
        .ok_or_else(|| "data URL 缺少 base64 头".to_string())?
        .to_string();
    if !mime.starts_with("image/") {
        return Err(format!("不允许的 MIME 类型 {mime}"));
    }
    Ok((mime, base64_decode(data)?))
}

pub fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Result<u32, String> {
        match c {
            b'A'..=b'Z' => Ok((c - b'A') as u32),
            b'a'..=b'z' => Ok((c - b'a' + 26) as u32),
            b'0'..=b'9' => Ok((c - b'0' + 52) as u32),
            b'+' => Ok(62),
            b'/' => Ok(63),
            _ => Err(format!("非法 base64 字符: {}", c as char)),
        }
    }
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let bytes: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    for chunk in bytes.chunks(4) {
        let pad = chunk.iter().filter(|&&c| c == b'=').count();
        let mut n: u32 = 0;
        for (i, &c) in chunk.iter().enumerate() {
            let v = if c == b'=' { 0 } else { val(c)? };
            n |= v << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_往返一致() {
        let cases: Vec<Vec<u8>> = vec![
            vec![],
            vec![1],
            vec![1, 2],
            vec![1, 2, 3],
            (0u8..=255).collect(),
            b"hello knockbox screenshot".to_vec(),
        ];
        for c in cases {
            assert_eq!(base64_decode(&base64_encode(&c)).unwrap(), c);
        }
    }

    #[test]
    fn data_url_解析() {
        let (mime, bytes) = decode_data_url("data:image/png;base64,aGk=").unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, b"hi");
        assert!(decode_data_url("data:text/html;base64,aGk=").is_err());
        assert!(decode_data_url("不是dataurl").is_err());
    }
}
