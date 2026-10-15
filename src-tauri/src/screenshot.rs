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

    let frame = match capture_frame() {
        Ok(path) => path,
        Err(e) => {
            // direct 型插件没有面板可以报错，错误只会变成一句静默失败 ——
            // 而「没给屏幕录制权限」恰恰是首次使用最常撞上的情况，
            // 必须当面告诉用户去哪里开，否则体验就是"点了没反应"。
            notify_error(app, &e);
            return Err(e);
        }
    };
    let (tx, rx) = mpsc::channel();
    *app.state::<ScreenSession>().0.lock().unwrap() = Some(PendingSession {
        plugin_id: plugin_id.to_string(),
        frame_png: frame.clone(),
        reply: Some(tx),
    });

    if let Err(e) = open_overlay_window(app) {
        // 建窗口失败：把会话撤掉，别让下一次截图永远被拒
        let _ = ScreenSession::take(app);
        let _ = std::fs::remove_file(&frame);
        restore_main_window(app, main_was_visible);
        return Err(format!("创建截图覆盖层失败: {e}"));
    }

    // 阻塞等覆盖层出结果。没有超时：用户可能慢慢标注。
    // 覆盖层窗口被销毁（崩溃等）时 lib.rs 的 Destroyed 钩子会补发取消，
    // 所以这里不会永久挂住。
    let outcome = rx.recv().unwrap_or_else(|_| Err("截图会话异常结束".into()));

    cleanup_overlay(app);
    let _ = std::fs::remove_file(&frame);
    restore_main_window(app, main_was_visible);
    outcome
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

fn open_overlay_window(app: &AppHandle) -> Result<(), String> {
    // 上一次会话的窗口如果因故还活着，先销毁，同标签复建会直接报错
    if let Some(old) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = old.destroy();
    }

    let monitor = app
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .or_else(|| app.available_monitors().ok()?.into_iter().next())
        .ok_or_else(|| "找不到可用的显示器".to_string())?;
    let size = monitor.size();
    let pos = monitor.position();

    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        OVERLAY_LABEL,
        tauri::WebviewUrl::App("index.html?overlay=1".into()),
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
    .visible(false);

    // 覆盖层要出现在当前 Space，而不是跳回主窗口所在的 Space
    #[cfg(target_os = "macos")]
    {
        builder = builder.visible_on_all_workspaces(true);
    }

    let win = builder.build().map_err(|e| e.to_string())?;
    // builder 的尺寸是逻辑值，直接按物理像素贴满整个显示器
    let _ = win.set_size(tauri::PhysicalSize::new(size.width, size.height));
    let _ = win.set_position(tauri::PhysicalPosition::new(pos.x, pos.y));

    // macOS 的菜单栏 level 比 alwaysOnTop（floating = 3）高，不抬 level 的话
    // 屏幕顶部菜单栏那一条永远盖在我们上面 —— 那片区域就选不中、也取不了色。
    // kCGMainMenuWindowLevel 是 24，抬到 25 刚好压过它。
    // （objc 0.2 的 msg_send 宏里有个过时的 cfg(cargo-clippy)，警告来自它）
    #[cfg(target_os = "macos")]
    #[allow(unexpected_cfgs)]
    unsafe {
        use objc::{msg_send, sel, sel_impl};
        if let Ok(ns_win) = win.ns_window() {
            let _: () = msg_send![ns_win as *mut objc::runtime::Object, setLevel: 25_i64];
        }
    }

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
/// 这是"reply 恰好发一次"的兜底出口。
pub fn cancel_if_active(app: &AppHandle) {
    if let Some(mut session) = ScreenSession::take(app) {
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
        let guard = state.0.lock().unwrap();
        let Some(session) = guard.as_ref() else {
            return Err("没有进行中的截图会话".into());
        };
        (session.plugin_id.clone(), session.frame_png.clone())
    };

    let bytes = std::fs::read(&frame).map_err(|e| format!("读取冻结帧失败: {e}"))?;
    let data_url = format!("data:image/png;base64,{}", base64_encode(&bytes));

    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
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
        return Err("未选择任何输出（保存或复制）".into());
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

fn capture_frame() -> Result<PathBuf, String> {
    let path = frames_dir()?.join(format!("frame-{}.png", now_millis()));
    capture_frame_impl(&path)?;
    if !path.exists() {
        return Err("截屏失败。请到「系统设置 → 隐私与安全性 → 屏幕录制」里允许 Knockbox".into());
    }
    Ok(path)
}

#[cfg(target_os = "macos")]
fn capture_frame_impl(path: &Path) -> Result<(), String> {
    // -x 静音。不带 -i：选区由覆盖层做，这里只要一张全屏冻结帧
    std::process::Command::new("screencapture")
        .args(["-x", "-t", "png"])
        .arg(path)
        .output()
        .map_err(|e| format!("调用 screencapture 失败: {e}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn capture_frame_impl(path: &Path) -> Result<(), String> {
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
fn capture_frame_impl(_path: &Path) -> Result<(), String> {
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
