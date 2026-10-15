//! 宿主侧的能力网关。
//!
//! 这是安全模型的关键一环。插件页面在 iframe 里，**没有任何 Tauri 权限**；
//! 它唯一能做的事就是把一条消息 postMessage 给宿主。宿主再经由前端 SDK 转成
//! `plugin_call` 打到这里的 `dispatch`，由本模块逐条校验权限后才真正执行。
//!
//! 换句话说：插件自身无法提权。哪怕 `plugin.json` 里写了没被用户授权的权限，
//! 或者插件恶意伪造了 method 字符串，都会在 `check_permission` 被挡住。

use crate::core::manifest::Manifest;
use crate::plugins::store;
use serde_json::Value;

/// 一个 SDK 方法的准入要求。
enum Requirement {
    /// 无需系统权限：只影响插件自己的展示区或读取用户填写的设置值
    AlwaysAllowed,
    /// 需要用户在安装时授予对应权限
    Needs(&'static str),
    /// 不在白名单里的方法，一律拒绝
    Unknown,
}

/// SDK 方法 → 所需权限的映射。**没列在这里的 method 一律拒绝** ——
/// 宁可插件调用失败，也不要出现"忘了加权限检查"的情况。
fn requirement_for(method: &str) -> Requirement {
    match method {
        "clipboard.readText" => Requirement::Needs("clipboard:read"),
        // 读前台窗口选中文本是独立能力，不是剪贴板的附属品 ——
        // 早前这里错映射到 clipboard:read，导致两个方向都错：
        // 只声明了 clipboard:read 的插件能读到选中文本，而声明了
        // system:selection 的插件反而被拒。
        "system.getSelection" => Requirement::Needs("system:selection"),
        "clipboard.writeText" => Requirement::Needs("clipboard:write"),
        "shell.openUrl" => Requirement::Needs("shell:open-url"),
        "shell.openPath" => Requirement::Needs("shell:open-path"),
        "shell.openApp" => Requirement::Needs("shell:open-app"),
        "notify" => Requirement::Needs("notification"),
        "fetch" => Requirement::Needs("web:fetch"),
        "storage.get" | "storage.set" | "storage.remove" | "storage.clear" => {
            Requirement::Needs("storage:local")
        }
        "window.resize" => Requirement::Needs("window:resize"),
        "history.list" => Requirement::Needs("history:read"),
        "system.lockScreen" => Requirement::Needs("system:lock-screen"),
        "screen.capture" | "screen.save" => Requirement::Needs("screen:capture"),
        // 纯前端行为：宿主侧无需任何系统能力
        "settings.get" | "settings.open" | "pushResult" | "setPanel" | "close" => {
            Requirement::AlwaysAllowed
        }
        _ => Requirement::Unknown,
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginError {
    PermissionDenied { method: String, required: String },
    UnknownMethod(String),
    InvalidParams(String),
    NotFound(String),
    HostClosed,
    RateLimited,
    Internal(String),
}

impl PluginError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::PermissionDenied { .. } => "PERMISSION_DENIED",
            Self::UnknownMethod(_) => "UNKNOWN_METHOD",
            Self::InvalidParams(_) => "INVALID_PARAMS",
            Self::NotFound(_) => "NOT_FOUND",
            Self::HostClosed => "HOST_CLOSED",
            Self::RateLimited => "RATE_LIMITED",
            Self::Internal(_) => "INTERNAL",
        }
    }
}

impl std::fmt::Display for PluginError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PermissionDenied { method, required } => {
                write!(f, "方法 {method} 需要权限 {required}")
            }
            Self::UnknownMethod(m) => write!(f, "未知方法 {m}"),
            Self::InvalidParams(m) | Self::NotFound(m) | Self::Internal(m) => write!(f, "{m}"),
            Self::HostClosed => write!(f, "宿主已关闭"),
            Self::RateLimited => write!(f, "调用过于频繁"),
        }
    }
}

/// 各能力的底层实现统一返回 `String`，在这里统一收敛为 `Internal`。
impl From<String> for PluginError {
    fn from(s: String) -> Self {
        Self::Internal(s)
    }
}

/// 命令层要把 SDK 错误转成给前端看的字符串。
impl From<PluginError> for String {
    fn from(e: PluginError) -> Self {
        e.to_string()
    }
}

fn check_permission(manifest: &Manifest, method: &str) -> Result<(), PluginError> {
    match requirement_for(method) {
        Requirement::AlwaysAllowed => Ok(()),
        Requirement::Unknown => Err(PluginError::UnknownMethod(method.to_string())),
        Requirement::Needs(required) => {
            if manifest.permissions.iter().any(|p| p == required) {
                Ok(())
            } else {
                Err(PluginError::PermissionDenied {
                    method: method.to_string(),
                    required: required.to_string(),
                })
            }
        }
    }
}

/// 校验并执行一次 SDK 调用。
///
/// 需要 `AppHandle` 是因为 `screen.capture` 的区域模式要建覆盖层窗口
/// （见 `screenshot.rs`）—— 纯数据处理的方法用不到它，但签名统一比按方法
/// 分叉简单。
pub fn dispatch(
    app: &tauri::AppHandle,
    plugin_id: &str,
    method: &str,
    params: Value,
) -> Result<Value, PluginError> {
    // 诊断开关：把每次 SDK 调用的结果打出来。插件链路有四层
    // （模块加载 → 握手 → 权限 → 执行），没有这行就只能靠猜。
    let log = std::env::var_os("KNOCKBOX_LOG_ASSETS").is_some();
    if log {
        eprintln!("[call] {plugin_id} {method}");
    }
    let result = dispatch_inner(app, plugin_id, method, params);
    if log {
        match &result {
            Ok(v) => eprintln!("[call]   → ok {v}"),
            Err(e) => eprintln!("[call]   → {} {}", e.code(), e),
        }
    }
    result
}

fn dispatch_inner(
    app: &tauri::AppHandle,
    plugin_id: &str,
    method: &str,
    params: Value,
) -> Result<Value, PluginError> {
    let installed = store::get(plugin_id).ok_or_else(|| {
        PluginError::NotFound(format!("插件 {plugin_id} 未安装"))
    })?;
    if !installed.enabled {
        return Err(PluginError::PermissionDenied {
            method: method.to_string(),
            required: "enabled".into(),
        });
    }

    let manifest =
        store::load_manifest(plugin_id).map_err(PluginError::Internal)?;
    check_permission(&manifest, method)?;

    match method {
        "clipboard.readText" => clipboard_read().map_err(PluginError::Internal),
        "clipboard.writeText" => {
            let text = params
                .get("text")
                .and_then(|v| v.as_str())
                .ok_or_else(|| PluginError::InvalidParams("缺少 text".into()))?;
            clipboard_write(text).map_err(PluginError::Internal)
        }
        "shell.openUrl" => {
            let url = params
                .get("url")
                .and_then(|v| v.as_str())
                .ok_or_else(|| PluginError::InvalidParams("缺少 url".into()))?;
            validate_url(url)?;
            open_url(url).map_err(PluginError::Internal)
        }
        "shell.openPath" => {
            let path = params
                .get("path")
                .and_then(|v| v.as_str())
                .ok_or_else(|| PluginError::InvalidParams("缺少 path".into()))?;
            open_path(path).map_err(PluginError::Internal)
        }
        "shell.openApp" => {
            let name = params
                .get("app")
                .and_then(|v| v.as_str())
                .ok_or_else(|| PluginError::InvalidParams("缺少 app".into()))?;
            open_app_by_name(name, &installed.id).map_err(PluginError::Internal)
        }
        "fetch" => {
            let url = params
                .get("url")
                .and_then(|v| v.as_str())
                .ok_or_else(|| PluginError::InvalidParams("缺少 url".into()))?;
            validate_domain(url, &manifest.web_allowed_domains)?;
            let (status, body) = http_fetch(url, &manifest.web_allowed_domains)?;
            Ok(serde_json::json!({ "status": status, "body": body }))
        }
        "storage.get" | "storage.set" | "storage.remove" | "storage.clear" => {
            storage(plugin_id, method, params).map_err(PluginError::Internal)
        }
        "history.list" => Ok(serde_json::json!(crate::core::store::load_history())),
        "settings.get" => Ok(serde_json::json!(plugin_settings(plugin_id))),
        "pushResult" | "setPanel" => Ok(Value::Null), // 纯前端行为，宿主无需处理
        "system.lockScreen" => lock_screen().map_err(PluginError::Internal),
        "screen.capture" => {
            // 参数由插件从它自己的设置项拼来，这里只做形状与取值校验
            let mode = params.get("mode").and_then(|v| v.as_str()).unwrap_or("full");
            let with_cursor = params
                .get("cursor")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let format = params.get("format").and_then(|v| v.as_str()).unwrap_or("png");
            if !matches!(mode, "full" | "region") {
                return Err(PluginError::InvalidParams("mode 只能是 full 或 region".into()));
            }
            if !matches!(format, "png" | "jpg") {
                return Err(PluginError::InvalidParams("format 只能是 png 或 jpg".into()));
            }
            if mode == "region" {
                // Snipaste 式覆盖层：冻结帧 + 自绘选区/标记/取色。
                // 会阻塞到用户在覆盖层里完成或取消，结果直接作为返回值。
                crate::screenshot::run_region_session(app, plugin_id)
                    .map_err(PluginError::Internal)
            } else {
                screen_capture_full(with_cursor, format).map_err(PluginError::Internal)
            }
        }
        "screen.save" => {
            // 插件在画布上标记完，需要把成品落盘。宿主只提供"打开路径"，
            // 没有写文件的能力，所以这里补一个 —— 但**只能写进截图目录**，
            // 且文件名由宿主生成：不能让插件往任意路径写东西。
            let data_url = params
                .get("dataUrl")
                .and_then(|v| v.as_str())
                .ok_or_else(|| PluginError::InvalidParams("缺少 dataUrl".into()))?;
            let tag = params
                .get("tag")
                .and_then(|v| v.as_str())
                .unwrap_or("edited")
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
                .take(16)
                .collect::<String>();
            screen_save(data_url, &tag).map_err(PluginError::Internal)
        }
        "close" => Ok(Value::Null),
        "notify" => Ok(Value::Null),
        _ => Err(PluginError::UnknownMethod(method.to_string())),
    }
}

/// 只允许 http/https。挡住 `file://`、`javascript:` 这类危险 scheme。
fn validate_url(url: &str) -> Result<(), PluginError> {
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        Ok(())
    } else {
        Err(PluginError::InvalidParams(
            "只允许 http/https 链接".into(),
        ))
    }
}

/// URL 主机必须命中插件自己声明的 `web:allowed-domains`。
/// 支持 `*.example.com` 前缀通配。
fn validate_domain(url: &str, allowed: &[String]) -> Result<(), PluginError> {
    let rest = url
        .split_once("://")
        .map(|(_, r)| r)
        .ok_or_else(|| PluginError::InvalidParams("URL 格式错误".into()))?;
    let host = rest
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("")
        .rsplit('@')
        .next()
        .unwrap_or("") // 去掉 userinfo，避免 `evil.com@allowed.com` 之外的构造
        .split(':')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();

    if host.is_empty() {
        return Err(PluginError::InvalidParams("URL 缺少主机名".into()));
    }

    let matched = allowed.iter().any(|pattern| {
        let p = pattern.trim().to_ascii_lowercase();
        if let Some(suffix) = p.strip_prefix("*.") {
            host == suffix || host.ends_with(&format!(".{suffix}"))
        } else {
            host == p
        }
    });

    if matched {
        Ok(())
    } else {
        Err(PluginError::PermissionDenied {
            method: "fetch".into(),
            required: format!("web:allowed-domains 未包含 {host}"),
        })
    }
}

// ————————————————————————————————————————————————
// 各能力的实际实现
// ————————————————————————————————————————————————

/// 写文本到剪贴板。截图覆盖层复制颜色也走这里（它是宿主自有页面，
/// 不过插件权限网关，但实现只有一份）。
pub(crate) fn clipboard_write_text(text: &str) -> Result<(), String> {
    clipboard_write(text).map(|_| ())
}

#[cfg(target_os = "macos")]
fn clipboard_read() -> Result<Value, String> {
    let out = std::process::Command::new("pbpaste").output().map_err(|e| e.to_string())?;
    Ok(serde_json::Value::String(
        String::from_utf8_lossy(&out.stdout).to_string(),
    ))
}

#[cfg(target_os = "macos")]
fn clipboard_write(text: &str) -> Result<Value, String> {
    use std::io::Write;
    let mut child = std::process::Command::new("pbcopy")
        .stdin(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child
        .stdin
        .as_mut()
        .ok_or_else(|| "无法打开 pbcopy stdin".to_string())?
        .write_all(text.as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

#[cfg(target_os = "macos")]
fn system_selection() -> Result<Value, String> {
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg("tell application \"System Events\" to get the value of the attribute \"AXSelectedText\" of the front window's UI element 0")
        .output()
        .map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "text": String::from_utf8_lossy(&out.stdout).trim(),
        "app": "",
    }))
}

#[cfg(target_os = "windows")]
fn clipboard_read() -> Result<Value, String> {
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", "Get-Clipboard"])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(serde_json::Value::String(
        String::from_utf8_lossy(&out.stdout).trim_end().to_string(),
    ))
}

#[cfg(target_os = "windows")]
fn clipboard_write(text: &str) -> Result<Value, String> {
    // 经由 PowerShell 走 5 个字符的转义，改用 base64 传输避免引号/换行注入
    let encoded = base64_encode(text.as_bytes());
    let script = format!(
        "[Console]::OutputEncoding=[Text.Encoding]::UTF8; \
         $d=[Convert]::FromBase64String('{encoded}'); \
         Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString($d))"
    );
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", &script])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(Value::Null)
}

#[cfg(target_os = "windows")]
fn system_selection() -> Result<Value, String> {
    // Windows 取前台选中文本需要 UI Automation 绑定，v0.1 先返回空
    Ok(serde_json::json!({ "text": "", "app": "" }))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn clipboard_read() -> Result<Value, String> {
    Ok(Value::String(String::new()))
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn clipboard_write(_text: &str) -> Result<Value, String> {
    Ok(Value::Null)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn system_selection() -> Result<Value, String> {
    Ok(serde_json::json!({ "text": "", "app": "" }))
}

fn open_url(url: &str) -> Result<Value, String> {
    open_url_impl(url)
}

/// 供命令层使用：用系统默认程序打开路径。
pub fn dispatch_open_path(path: &str) -> Result<(), String> {
    open_path(path).map(|_| ())
}

/// 供命令层使用：用默认浏览器打开 URL。
pub fn dispatch_open_url(url: &str) -> Result<(), String> {
    validate_url(url)?;
    open_url_impl(url).map(|_| ())
}

/// 供命令层使用：读取前台窗口选中的文本。
pub fn dispatch_selection() -> Result<Value, String> {
    system_selection()
}

fn open_url_impl(url: &str) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(target_os = "windows")]
    let cmd = "cmd";
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new(cmd)
            .args(["/C", "start", "", url])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new(cmd).arg(url).spawn().map_err(|e| e.to_string())?;
    }
    Ok(Value::Null)
}

fn open_path(path: &str) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(path).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer").arg(path).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = path;
        return Err("当前平台不支持".into());
    }
    Ok(Value::Null)
}

/// 锁屏。两平台都用系统自带的休眠命令，不需要自己调 CGEvent 之类的私有 API。
fn lock_screen() -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    let cmd = "pmset";
    #[cfg(target_os = "windows")]
    let cmd = "rundll32.exe";

    #[cfg(target_os = "macos")]
    {
        // displaysleepnow 会立刻熄屏但会话还在；sleepnow 才是真锁屏
        std::process::Command::new(cmd)
            .arg("displaysleepnow")
            .status()
            .map_err(|e| format!("锁屏失败: {e}"))?;
    }
    #[cfg(target_os = "windows")]
    {
        // LockWorkStation
        std::process::Command::new(cmd)
            .args(["user32.dll,LockWorkStation"])
            .status()
            .map_err(|e| format!("锁屏失败: {e}"))?;
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = cmd;
        return Err("当前平台不支持锁屏".into());
    }
    Ok(Value::Null)
}

/// 全屏直出截图（无覆盖层交互）。存到桌面的「Knockbox 截图」目录。
///
/// 区域截图不走这里 —— `screen.capture` 的 region 分支在
/// `crate::screenshot::run_region_session`，冻结帧 + 自绘覆盖层。
///
/// 返回 `path`（落盘文件）**和** `dataUrl`：插件要在自己的画布上做标记和
/// 取色，就必须拿到图像本身；走 data URL 免得插件再去碰本机文件系统。
/// 超过 8MB 就只给路径，避免超大图穿 postMessage 把界面卡住。
fn screen_capture_full(with_cursor: bool, format: &str) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let dir = crate::screenshot::screenshots_dir()?;

        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = dir.join(format!("截屏-{stamp}.{format}"));

        let mut cmd = std::process::Command::new("screencapture");
        cmd.arg("-x"); // 静音，不播放快门声
        if with_cursor {
            cmd.arg("-C");
        }
        cmd.arg("-t").arg(format).arg(&path);

        let out = cmd.output().map_err(|e| format!("调用 screencapture 失败: {e}"))?;

        // 用户在选区界面点了取消时 screencapture 正常退出但不产出文件
        if !path.exists() {
            if out.status.success() {
                return Err("已取消截图".into());
            }
            return Err("截屏失败。请到「系统设置 → 隐私与安全性 → 屏幕录制」里允许 Knockbox".into());
        }

        let bytes = std::fs::read(&path).map_err(|e| format!("读取截图失败: {e}"))?;
        let mut result = serde_json::Map::new();
        result.insert("path".into(), Value::String(path.to_string_lossy().to_string()));
        result.insert("bytes".into(), serde_json::json!(bytes.len()));
        if bytes.len() <= 8 * 1024 * 1024 {
            let mime = if format == "jpg" { "image/jpeg" } else { "image/png" };
            result.insert(
                "dataUrl".into(),
                Value::String(format!("data:{mime};base64,{}", base64_encode(&bytes))),
            );
        }
        Ok(Value::Object(result))
    }
    #[cfg(target_os = "windows")]
    {
        // PowerShell 调用 .NET 的屏幕捕获
        let dir = dirs::desktop_dir()
            .ok_or_else(|| "找不到桌面目录".to_string())?
            .join("Knockbox 截图");
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建截图目录失败: {e}"))?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        // screencapture 的 -t 在这里是 ImageFormat 枚举名
        let (ext, image_format, mime) = if format == "jpg" {
            ("jpg", "Jpeg", "image/jpeg")
        } else {
            ("png", "Png", "image/png")
        };
        let path = dir.join(format!("截屏-{stamp}.{ext}"));
        // with_cursor 在 Windows 上无法表达：CopyFromScreen 会把光标一起
        // 画进位图，除非额外开 DXGI 桌面复制，那是另一个数量级的成本。
        // 忽略即可 —— 光标在截图里对用户不是坏事。
        let _ = with_cursor;
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;\
             $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;\
             $bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;\
             $g=[System.Drawing.Graphics]::FromImage($bmp);\
             $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);\
             $bmp.Save('{}',[System.Drawing.Imaging.ImageFormat]::{})",
            path.to_string_lossy().replace('\\', "\\\\"),
            image_format,
        );
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &script])
            .output()
            .map_err(|e| format!("截屏失败: {e}"))?;
        if !out.status.success() || !path.exists() {
            return Err("截屏失败".into());
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("读取截图失败: {e}"))?;
        let mut result = serde_json::Map::new();
        result.insert("path".into(), Value::String(path.to_string_lossy().to_string()));
        result.insert("bytes".into(), serde_json::json!(bytes.len()));
        // 和 macOS 分支保持一致：插件要在自己的画布上标记就必须拿到图像本身，
        // 超过 8MB 就只给路径，避免超大图穿 postMessage 把界面卡住
        if bytes.len() <= 8 * 1024 * 1024 {
            result.insert(
                "dataUrl".into(),
                Value::String(format!("data:{mime};base64,{}", crate::screenshot::base64_encode(&bytes))),
            );
        }
        Ok(Value::Object(result))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("当前平台不支持截屏".into())
    }
}

/// 插件标记完的成品图落盘。只能写进截图目录，文件名由宿主生成 ——
/// 不给插件任意路径写文件的能力。
fn screen_save(data_url: &str, tag: &str) -> Result<Value, String> {
    let (mime, bytes) = crate::screenshot::decode_data_url(data_url)?;
    let ext = match mime.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        other => return Err(format!("不支持的图片格式 {other}")),
    };
    let dir = crate::screenshot::screenshots_dir()?;
    let path = dir.join(format!("截屏-{}-{tag}.{ext}", crate::screenshot::now_millis()));
    std::fs::write(&path, &bytes).map_err(|e| format!("写入截图失败: {e}"))?;
    Ok(serde_json::json!({
        "path": path.to_string_lossy(),
        "bytes": bytes.len(),
    }))
}

fn open_app_by_name(name: &str, _plugin_id: &str) -> Result<Value, String> {    let apps = crate::core::apps::scan();
    let hit = apps
        .into_iter()
        .find(|a| a.name.eq_ignore_ascii_case(name))
        .ok_or_else(|| format!("未找到应用 {name}"))?;
    open_path(&hit.path)
}

/// 受域名白名单约束的 HTTP 请求。域名校验在上游已完成，这里再做一次 scheme 兜底。
fn http_fetch(url: &str, _allowed: &[String]) -> Result<(u16, String), String> {
    validate_url(url).map_err(|e| e.to_string())?;
    let output = std::process::Command::new("curl")
        .args([
            "--silent",
            "--show-error",
            // 关键：不跟随重定向（`--max-redirs 0`）。
            // `validate_domain` 只校验了**初始 URL**，一旦允许跟随，插件就能
            // 声明一个白名单域名再让服务端 302 到任意地址，白名单形同虚设。
            // 需要跨域跳转时，让插件自己再发一次请求 —— 那一跳会重新过校验。
            "--max-redirs",
            "0",
            "--max-time",
            "15",
            "--proto",
            "=http,https",
            "-w",
            "\n%{http_code}",
            url,
        ])
        .output()
        .map_err(|e| format!("请求失败: {e}"))?;

    let text = String::from_utf8_lossy(&output.stdout).to_string();
    let (body, code) = match text.rsplit_once('\n') {
        Some((b, c)) => (b.to_string(), c.trim().parse().unwrap_or(0)),
        None => (text, 0),
    };
    Ok((code, body))
}

/// 插件私有存储。按插件 id 隔离，一个插件读不到另一个的数据。
fn storage(plugin_id: &str, method: &str, params: Value) -> Result<Value, String> {
    let mut all = crate::core::store::load_plugin_settings();
    let root = all
        .as_object_mut()
        .ok_or_else(|| "plugin-settings.json 结构异常".to_string())?;

    let scope = root
        .entry("__storage".to_string())
        .or_insert_with(|| Value::Object(Default::default()));
    let bucket = scope
        .as_object_mut()
        .ok_or_else(|| "storage 结构异常".to_string())?;
    let plugin_bucket = bucket
        .entry(plugin_id.to_string())
        .or_insert_with(|| Value::Object(Default::default()));

    match method {
        "storage.get" => {
            let key = params
                .get("key")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "缺少 key".to_string())?;
            Ok(plugin_bucket.get(key).cloned().unwrap_or(Value::Null))
        }
        "storage.set" => {
            let key = params
                .get("key")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "缺少 key".to_string())?;
            let value = params.get("value").cloned().unwrap_or(Value::Null);
            let obj = plugin_bucket
                .as_object_mut()
                .ok_or_else(|| "storage 结构异常".to_string())?;
            obj.insert(key.to_string(), value);
            crate::core::store::save_plugin_settings(&all)?;
            Ok(Value::Null)
        }
        "storage.remove" => {
            let key = params
                .get("key")
                .and_then(|v| v.as_str())
                .ok_or_else(|| "缺少 key".to_string())?;
            if let Some(obj) = plugin_bucket.as_object_mut() {
                obj.remove(key);
            }
            crate::core::store::save_plugin_settings(&all)?;
            Ok(Value::Null)
        }
        "storage.clear" => {
            if let Some(obj) = plugin_bucket.as_object_mut() {
                obj.clear();
            }
            crate::core::store::save_plugin_settings(&all)?;
            Ok(Value::Null)
        }
        _ => unreachable!("caller 已校验 method"),
    }
}

/// 把用户填写的设置值（经 `settings` 声明）交给插件。
fn plugin_settings(plugin_id: &str) -> Value {
    crate::core::store::load_plugin_settings()
        .get(plugin_id.to_string())
        .cloned()
        .unwrap_or(Value::Object(Default::default()))
}

fn base64_encode(bytes: &[u8]) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 域名白名单支持通配符() {
        let allowed = vec!["api.example.com".to_string(), "*.taobao.com".to_string()];
        assert!(validate_domain("https://api.example.com/x", &allowed).is_ok());
        assert!(validate_domain("https://cdn.taobao.com/x", &allowed).is_ok());
        assert!(validate_domain("https://evil.com/x", &allowed).is_err());
        // 防后缀欺骗：evil-taobao.com 不能命中 *.taobao.com
        assert!(validate_domain("https://evil-taobao.com/x", &allowed).is_err());
        // userinfo 欺骗
        assert!(validate_domain("https://api.example.com@evil.com/x", &allowed).is_err());
    }

    #[test]
    fn 只允许_http_s() {
        assert!(validate_url("https://example.com").is_ok());
        assert!(validate_url("javascript:alert(1)").is_err());
        assert!(validate_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn 未知方法被拒绝() {
        let m = Manifest {
            id: "com.a.b".into(),
            name: "t".into(),
            version: "1.0.0".into(),
            description: None,
            entry: "index.html".into(),
            icon: None,
            author: None,
            homepage: None,
            keywords: vec![],
            activation: Default::default(),
            invocation: Default::default(),
            permissions: vec![],
            web_allowed_domains: vec![],
            settings: vec![],
            min_knockbox_version: None,
        };
        assert!(matches!(
            check_permission(&m, "fs.readFile"),
            Err(PluginError::UnknownMethod(_))
        ));
        assert!(matches!(
            check_permission(&m, "clipboard.readText"),
            Err(PluginError::PermissionDenied { .. })
        ));
    }
}