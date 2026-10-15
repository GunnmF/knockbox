pub mod apps;
pub mod files;
pub mod manifest;
pub mod matcher;
pub mod store;

use serde::{Deserialize, Serialize};

/// 搜索结果的点击目标。宿主拿到它就知道该怎么执行。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", content = "v", rename_all = "camelCase")]
pub enum Target {
    /// 启动应用，v 为可执行路径
    App(String),
    /// 用系统默认程序打开，v 为文件/目录路径
    Path(String),
    /// 用默认浏览器打开，v 为完整 URL
    Url(String),
    /// 唤起轻应用，v 为插件 id
    Plugin(String),
}

/// 统一的结果条目，前端只需按 `kind` 决定图标样式。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultItem {
    pub id: String,
    /// `app` | `file` | `web` | `plugin`
    pub kind: String,
    pub title: String,
    pub subtitle: String,
    pub icon: Option<String>,
    pub score: f64,
    pub target: Target,
}

/// 已安装应用的扫描结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEntry {
    pub name: String,
    pub path: String,
    /// 缓存的图标文件路径，前端用 `convertFileSrc` 转成可显示 URL
    pub icon: Option<String>,
}