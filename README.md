# 叩叩 Knockbox

> 叩一叩，万物即出

一个轻量的跨平台（macOS / Windows）桌面启动器。按下 `⌘⇧K`，输入一个字，应用、文件、网页搜索、装好的轻应用一起出来。

## 为什么做它

用一些启动器久了会感觉「越用越卡、越用越重」。Knockbox 的对策是三件事：

- **不常驻重活**：没有索引进程、没有文件 watcher、没有后台同步。文件搜索直接用系统的（macOS 走 Spotlight，Windows 优先用 Everything）
- **应用列表走磁盘缓存**：首次扫盘后落盘，之后启动只读 JSON，不重扫
- **窗口默认隐藏**：进程常驻但不占窗口资源，快捷键唤起是纯 `show + focus`

装好之后它安静待在托盘里，需要时才出现。

## 功能

- **全局快捷键唤起**：`⌘⇧K`（Windows 为 `Ctrl+Shift+K`），可在设置里改
- **输入即匹配**：应用 → 文件 → 网页搜索，输入框里敲字直接出结果，回车即执行
- **网页搜索**：内置 Google / 百度 / Bing / DuckDuckGo / GitHub / 哔哩哔哩 / 知乎，也可自定义模板
- **轻应用（插件）**：沙箱里跑的 WebView 小应用 + JS SDK，能钉在启动器上，也能被关键词直接唤起
- **截图**：Snipaste 式区域截图——拖框选区、画笔/方框/箭头/文字标记、放大镜取色、按 `C` 复制颜色并退出
- **锁屏**：一步锁屏

## 安装

从 [Releases](https://github.com/GunnmF/knockbox/releases) 下载对应系统的安装包（macOS 为 `.dmg`，Windows 为安装包）。

装好后可以直接用应用内的更新：**管理应用 → 设置 → 更新 → 检查更新**。更新包带签名校验，认准官方 Release。

> macOS 首次使用截图功能需要在「系统设置 → 隐私与安全性 → 屏幕录制」里授权 Knockbox。

## 开发

需要 Node.js 20+、pnpm、Rust 1.77.2+。

```bash
git clone https://github.com/GunnmF/knockbox.git
cd knockbox
pnpm install

pnpm tauri dev        # 开发模式（前端 HMR + Rust 热重启）
pnpm dev              # 只跑前端（vite，5183 端口）
```

打包与发布：

```bash
pnpm release                  # 升补丁号并打包，产物拷到桌面
pnpm release minor            # 升次版本
pnpm publish-update           # 打包 + 签名 + 上传 GitHub Releases（自更新用）
```

凭据和签名密钥的说明见 [docs/HANDOVER.md](docs/HANDOVER.md)。

## 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 框架 | [Tauri 2](https://tauri.app) + Rust | 安装包 8–15MB、内存占用小，对比 Electron 的 100MB+ |
| 前端 | React + Vite + TypeScript | 生态最大 |
| 轻应用 | 沙箱 WebView + postMessage + 能力白名单 | 第三方只需会写前端；插件无法提权 |
| 文件搜索 | macOS Spotlight / Windows Everything（缺失时限深遍历） | 不自建索引 |

## 目录

```
src/                  前端（React）
  overlay/            截图覆盖层页面（宿主自有，不过插件权限网关）
  sdk/                插件 SDK 源码（将发布为 @knockbox/plugin-sdk）
src-tauri/
  src/
    core/             数据模型、匹配器、清单校验、文件搜索
    plugins/          插件注册、安装、能力网关（host.rs 是安全边界）
    screenshot.rs     截图会话状态机（冻结帧 + 覆盖层窗口）
  builtins/           内置轻应用（截图、锁屏）
  capabilities/       Tauri 权限集（刻意最小化）
docs/
  PLUGIN_SPEC.md      轻应用开发规范
  HANDOVER.md         架构决策与交接文档
examples/hello/       示例轻应用
```

## 文档

- [轻应用开发规范](docs/PLUGIN_SPEC.md) —— 写一个插件需要知道的全部
- [架构与交接文档](docs/HANDOVER.md) —— 为什么这么设计，以及踩过的坑

## 反馈

遇到问题或想法，欢迎开 [Issue](https://github.com/GunnmF/knockbox/issues) 讨论。
