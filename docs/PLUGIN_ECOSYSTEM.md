# 轻应用生态：需求与设计

> 状态：**需求已确认，设计待拍板**。本文是这一轮架构调整的唯一依据，
> 也是会话断了之后继续推进的入口。新窗口第一句话可以是：
> 「读 `/Users/zxc/Desktop/Code/knockbox/docs/PLUGIN_ECOSYSTEM.md`，按里面的「迁移路径」继续。」
>
> 最后更新：2026-10-16

---

## 1. 要解决的问题

一句话：**宿主不该是轻应用的作者**。

现在 `截图` 和 `锁屏` 是宿主自带的内置轻应用，代码在 `src-tauri/builtins/` 下，
跟着主程序一起打包、启动时自动安装。带来的问题：

| 问题 | 现状 | 后果 |
|---|---|---|
| 宿主被具体业务拖累 | `screenshot.rs` 约 1000 行 Rust + `src/overlay/ScreenshotOverlay.tsx` 约 700 行前端，全是选区、标记、取色的交互细节 | 想加个「录屏」「长截图」「贴图」，都得改宿主代码、重新发版 |
| 装完就有，用户没有选择的余地 | `builtin.rs` 在 `setup()` 里无条件同步并默认钉住 | 用户不想要截图功能也删不掉（只能去设置里禁用） |
| 第三方插件和内置插件走同一条路却能力不对等 | 内置插件能用的一切，第三方都做不到 | 第三方开发者写不出有实用价值的插件 |

**目标形态**：宿主只做三件事——**沙箱、能力网关、应用商店**。具体功能一律由插件实现。

---

## 2. 目标形态（已确认）

1. **轻应用全部外置**，包括截图和锁屏。宿主仓库里不再有任何具体轻应用。
2. **默认不预装**。装完 Knockbox 本体是"空手"的，用户需要去**应用商店**安装。
3. **商店 = 一个仓库**。本质上就是"检查某个 GitHub 仓库里某个文件夹下的轻应用，
   远程下载安装"，不是让用户手动下载 `.kbplugin` 包。
4. **支持多个商店源**。官方源内置且默认启用；用户可以添加自己的源，
   应用聚合所有源的列表并展示，可从任一源下载安装。
5. **宿主不实现轻应用功能**，只暴露 API 和权限。插件自己实现（比如截图怎么选区、
   怎么标记、取色怎么交互），需要什么权限自己声明。
6. **插件有独立的运行生命周期**，见 §4。其中"后台运行"必须有用户可见的标识。

---

## 3. 商店源

### 3.1 源长什么样

一个源就是一个仓库（GitHub 或任何可 HTTP 访问的地址），结构：

```
knockbox-plugins/            ← 仓库根
  index.json                 ← 源索引（列表页数据）
  com.knockbox.screencap/     ← 每个插件一个顶层文件夹
    plugin.json
    index.html
    sdk.js
    icon.svg
  com.knockbox.lock/
    ...
```

`index.json` 的格式（**复用现有的 `install_from_registry` 解析逻辑**，
`src-tauri/src/plugins/source.rs:75` 已经在按这个格式解析）：

```json
{
  "name": "Knockbox 官方商店",
  "plugins": [
    {
      "id": "com.knockbox.screencap",
      "name": "截图",
      "version": "3.0.0",
      "description": "Snipaste 式区域截图",
      "icon": "https://…/icon.svg",
      "permissions": ["screen:capture", "window:overlay"],
      "download": "https://github.com/…/com.knockbox.screencap-3.0.0.kbplugin",
      "sha256": "…"
    }
  ]
}
```

要点：
- **索引里的 `permissions` 不可信**。安装时以插件包内 `plugin.json` 的声明为准，
  索引里的只用于列表页展示图标和简介（PLUGIN_SPEC §7.3 已有这条规则，保持）。
- **`sha256` 必填**。远程源的包必须校验，否则索引被篡改就能装进任意代码。
  （现在 `install_from_registry` 是"索引给了才校验"，远程源应改为强制。）
- 索引由 **CI 生成**（tag 或手动触发时扫目录、打包、算 sha256、生成 index.json 提交回去），
  不手写。

### 3.2 多源聚合

用户可以添加多个源：

| 项 | 规则 |
|---|---|
| 源的添加 | 设置里填 URL（和现在「从 Git 安装」同一个输入框），拉取 index.json 后校验格式 |
| 列表展示 | 聚合所有源的插件，按名称排序；同 id 只保留一份 |
| **id 冲突** | 两个源有同一个 `id` 但内容不同 → **以先添加的源为准**，后来者在列表里折叠成「其他源也提供该插件」，不覆盖 |
| 源的禁用 | 用户可禁用某个源（不影响已安装的插件） |
| 源的失败 | 拉取失败的源不影响其它源，列表里显示该源为"不可用"，可重试 |

**为什么不做"多源优先级"**：多源体系最大的坑是 id 冲突导致"用户装的到底是哪个"。
先添加者优先 + 明示冲突，比让用户去理解优先级规则简单得多。

### 3.3 安装流程

商店列表 → 点安装 → 拉 `.kbplugin`（校验 sha256）→ 解压 → `manifest::load` 全量校验
→ **逐条展示权限让用户确认**（见 §7）→ 落盘 `plugins/<id>/`。

---

## 4. 生命周期与唤起方式

**核心原则（用户拍板）**：宿主负责所有系统级监听，轻应用只**声明**自己需要什么。
插件永远接触不到系统级监听 API——它告诉宿主"我要这个快捷键"，宿主去监听、
按下时通知插件。这样权限模型反而更干净：插件连"我在监听什么"都看不见。

现有 `plugin.json` 已有两个正交字段：

- `activation`: `keyword`（关键词命中即接管面板）/ `manual`（仅手动点开）
- `invocation`: `panel`（弹面板）/ `direct`（静默执行）

在此之上增加两组。

### 4.1 shortcuts —— 触发入口（宿主监听，插件声明）

```json
"shortcuts": [
  { "key": "CmdOrCtrl+Shift+S", "description": "区域截图", "mode": "silent" },
  { "key": "CmdOrCtrl+Shift+L", "description": "锁屏",       "mode": "silent" }
]
```

| `mode` | 按下时的行为 | 对应场景 |
|---|---|---|
| `silent` | 静默执行，**不唤醒主窗口** | 截图、锁屏 —— 「截图用快捷键，不用唤醒主程序再选择截图」 |
| `panel`（默认） | 唤醒主窗口并打开插件面板 | 「只是唤醒主程序执行」 |

按下后的判断顺序：**先看 `invocation`，再看要不要界面**——

1. `invocation: direct`（如锁屏）→ 静默执行，宿主窗口保持隐藏 → 这就是用户说的
   "执行完就可以直接关闭"
2. 需要自己的 UI（如截图的选区覆盖层）→ 走 `window:overlay` 路径，宿主只开覆盖层窗口，
   主窗口**不显示**
3. `invocation: panel` → 唤醒主窗口并切到该插件面板

冲突规则（和现在主快捷键注册失败的教训一致）：
- **主快捷键优先**：插件不能抢 `CmdOrCtrl+Shift+K`（默认唤起键）。
- 插件间冲突：后装者**不给占用的键**，明确告诉用户"已被 XXX 占用"，并提供改键入口。
- 设置页里每个插件列出它注册的快捷键，用户能改、能停；随启用/禁用/卸载增删。

### 4.2 background —— 要不要常驻（为了持续监听）

`background` 的真实含义（用户拍板）：**这个插件要不要持续监听事件**——快捷键、
剪贴板变化、URL Scheme、系统事件等。需要监听就得常驻，否则宿主随时可以回收它。

| 值 | 含义 |
|---|---|
| `background: false`（默认） | 不需要监听。被唤起时才创建页面，用完就回收 |
| `background: true` | 需要持续监听（快捷键、剪贴板 watch 等）。宿主启动时拉起，随宿主退出才结束 |

`background: true` 的硬性要求（缺一不可）：
1. 用户**必须能看见它**。托盘菜单列出所有后台运行的插件，可单独停止。
2. 设置页的已安装列表里标「后台运行中」。
3. 崩溃**不能拖垮宿主**。

### 4.3 clipboard watch（和快捷键同一个模式）

剪贴板监听同样是宿主来做：插件在 manifest 里声明 `clipboard.watch` 的触发条件
（如 `{"type": "image"}` 或 `{"type": "text", "pattern": "^https?://"}`），宿主监听
剪贴板变化、命中条件时把内容推给插件。插件**碰不到**剪贴板原始数据流，只在命中时
收到单条内容。这样"装一个监听剪贴板的插件"不会变成"它能记录你所有复制过的内容"。

---

## 5. 宿主需要新增的能力

### 5.1 新增权限（写入 `KNOWN_PERMISSIONS`）

| 权限 | 用途 | 风险等级 |
|---|---|---|
| `system:hotkey` | 允许在 manifest 里声明全局快捷键（宿主负责监听） | 高（劫持按键） |
| `system:clipboard-watch` | 允许声明剪贴板触发条件（宿主监听、命中时推送） | 高（读取复制内容） |
| `window:overlay` | 开一个覆盖全屏的置顶窗口承载自己的 UI | 高（全屏遮挡） |
| `app:background` | 允许常驻后台（持续监听事件） | 中（长期占用资源） |

四个都不是默认给的——用户应当在安装时就决定要不要授予。

### 5.2 新增 API（`host::dispatch`）

声明式的东西**不需要 API**——快捷键和剪贴板 watch 都在 manifest 里写，宿主读
清单、自己注册，插件不碰注册接口。需要 API 的是**主动的动作**：

| 方法 | 说明 |
|---|---|
| `window.openOverlay` / `window.closeOverlay` | 开/关覆盖层窗口，加载插件自己的页面 |
| `app.background` | 申请进入后台（需 `app:background` 权限 + 用户开启） |
| `screen.capture({ mode: 'freeze' })` | **改造**：只截一张冻结帧返回给插件，不带任何 UI |

宿主侧要做的监听管理（不是 API，是宿主内部的职责）：
- 快捷键注册表：从每个已安装插件的 manifest 收集 `shortcuts`，安装/启用/禁用/卸载时增删
- 剪贴板 watcher：收集 `clipboard.watch` 触发条件，命中时通过 postMessage 推给插件

### 5.3 `screen.capture` 的职责收缩

现在 `mode: 'region'` 会驱动宿主自己的覆盖层 UI（`screenshot.rs::run_region_session` +
`ScreenshotOverlay.tsx`），插件只管发一句话"截个图"。

改造后 `screen.capture` **只负责产出图像**：

```js
const frame = await kb.screen.capture({ mode: 'freeze' })   // 返回 dataUrl 或临时文件路径
await kb.window.openOverlay({ entry: 'overlay.html' })        // 插件自己的选区 UI
await kb.screen.save(dataUrl, 'my-shot')                     // 落盘
```

宿主不再认识"选区""标记""取色"这些概念。

---

## 6. 最大的技术债：截图外置

这一节单独写，因为它是整个改造里唯一真正难的部分，其余都是配置和搬运。

### 6.1 现在的问题

宿主的覆盖层窗口是**宿主自己的 React 页面**（`index.html?overlay=1` → `main.tsx`
按 URL 参数分流渲染 `ScreenshotOverlay`）。插件页面跑在主窗口的 iframe 里，
**没有办法在自己那边开一个置顶全屏窗口**。

### 6.2 方案

宿主保留一个**通用的**覆盖层窗口，但它的内容由插件决定：

```
window.openOverlay({ entry: 'overlay.html' })
   ↓
宿主开一个无边框置顶窗口（逻辑尺寸 = 当前屏幕），加载 index.html?overlay=1
   ↓
宿主的通用覆盖层页面按参数渲染 <iframe src="插件的 overlay.html">
   ↓
iframe 里的插件页面拿到冻结帧（screen.capture）自己画选区
   ↓
window.closeOverlay()
```

这样做的关键好处：**插件仍然活在 opaque origin 的 iframe 里**，不碰宿主 DOM，
能力网关（`plugin_call` → `host::dispatch`）原样复用，不需要给插件开任何 Tauri
capability。宿主只提供"一块全屏的画布"。

### 6.3 需要搬运的代码

| 现在在哪 | 搬到哪 | 说明 |
|---|---|---|
| `src/overlay/ScreenshotOverlay.tsx`（~700 行） | 商店仓库的 `com.knockbox.screencap/overlay.html` | 选区、标记、取色、工具栏的交互全归插件 |
| `src/overlay/overlay.css` | 同上 | |
| `src-tauri/src/screenshot.rs` 的 `run_region_session` | 宿主保留**通用会话管理**，去掉截图语义 | 冻结帧、开窗、回传结果、销毁窗口的骨架 |
| `screenshot_begin/finish/cancel/copy_color` 四个 command | 变成插件可调用的 `kb.screen.*` 方法 | |
| `src-tauri/builtins/com.knockbox.screencap/` | 商店仓库的 `com.knockbox.screencap/` | |
| `src-tauri/builtins/com.knockbox.lock/` | 商店仓库的 `com.knockbox.lock/` | 锁屏改动少，可以先搬 |

### 6.4 前端 API 的等价物

插件现在用的是 `invoke('screenshot_begin')`（Tauri IPC）。外置后插件**拿不到
Tauri IPC**（这是沙箱模型的核心），必须走 `kb.*` 的 postMessage 通道。
所以 SDK 需要新增对应的方法，并且**先发布 `@knockbox/plugin-sdk`**
（PLUGIN_SPEC §10 早就要求了，一直没做——现在是它的第一个真实用例）。

---

## 7. 安装时的权限确认（现存的最大模型空洞）

PLUGIN_SPEC §4 要求「安装界面上逐条向用户展示即将授予的能力，由用户确认」。
现在 `Settings.tsx` 只把它拼成一句「申请 N 项权限」，用户点一下就装完了——
**用户从未真正授权过**，而 `check_permission` 查的永远是插件自己写的清单。

外置商店之后这件事变得更要命：一个公开的第三方仓库，用户装了个带
`system:hotkey` + `window:overlay` 的插件，还"后台常驻"，却全程没被问过一句。

方案：
- 新增 `granted-permissions.json`，记录每个插件**用户实际同意的**权限集合
- 安装流程：解析 manifest → 逐条列出「这个插件要 xxx 能力 / 用途」→ 用户勾选 → 写入
- `host::check_permission` 改查「已授予集合」，插件多要的能力一律拒绝
- 卸载时一并删除；升级时若新版本**新增**权限，必须重新走确认流程（不能静默扩权）

---

## 8. 迁移路径

分四阶段，**每阶段结束都能独立发布**，任何一阶段停下来产品都是可用的。

### 阶段 1：宿主补齐能力（不破坏现状）

- 加 `system:hotkey` / `window:overlay` / `app:background` 三个权限与对应 API
- 加 `screen.capture({mode:'freeze'})`，**不动**现有的 region 分支
- 实现通用覆盖层窗口（宿主页面只做「渲染插件 iframe」这一件事）
- `builtin.rs` 保留（内置应用还在），但**改为默认不装**：
  `plugin.json` 里标 `"builtin": true`，首次启动只登记不安装，管理页里显示「官方内置，点击安装」

**产出**：宿主具备被外部插件驱动截图的全部能力，但没有任何功能因此改变。

### 阶段 2：商店与多源

- 源管理（增删、启用/禁用、聚合列表、id 冲突规则）
- 商店页 UI（列表、图标、简介、一键安装、权限确认）
- 索引由 CI 生成
- 权限确认落地（§7）

**产出**：用户能从商店装插件了；内置应用改成"可安装的官方插件"。

### 阶段 3：截图、锁屏外置

- 建 `GunnmF/knockbox-plugins` 仓库 + 生成索引的 CI
- 把锁屏搬过去（改动小，先验证整条路）
- 把截图搬过去（§6 的四个文件）
- 删掉宿主里的 `src/overlay/ScreenshotOverlay.tsx` 和 `builtins/`
- `screenshot.rs` 只保留通用会话管理

**产出**：宿主里一行截图代码都没有了。

### 阶段 4：发布 SDK + 生命周期收尾

- 发布 `@knockbox/plugin-sdk`（截图是它的第一个真实用例）
- `lifecycle` 三种模式全实现
- 托盘菜单的后台插件列表 + 标识
- 快捷键管理页（冲突提示、改键、停用）

---

## 9. 已拍板的问题（2026-10-16）

1. **官方商店仓库**：`GunnmF/knockbox-apps`（已创建，插件在 `apps/` 下）。
   用户说的"轻应用"在 UI 和文档里用这个叫法；`plugin.json` 这个**线上格式**的名字保留，
   改名会炸掉所有已安装插件和 PLUGIN_SPEC，得不偿失。
2. **截图不预装**：装完本体是空手的，截图/锁屏放商店仓库由用户自己装。
   迁移完成前宿主的 `builtins/` 先保留（否则截图直接没掉）。
3. **快捷键：宿主监听，插件只声明**。轻应用不碰系统级监听 API（见 §4.1）。
4. **版本区分要，回退不要**：索引里只放最新版本；有新版本就提示升级，用户可以不升。
5. **`background` = 要不要常驻监听**：需要监听快捷键/剪贴板才常驻，否则随用随回收（见 §4.2）。

## 10. 仍需你拍板的问题

1. **崩溃隔离做到什么程度**：后台插件崩溃只记日志就够，还是每个插件跑在独立的
   WebView 进程里（真隔离，但内存翻倍，和"轻量"的立项动机冲突）？
2. **第三方源要不要限制能力**：比如只允许官方源（可签名）声明 `system:hotkey` /
   `window:overlay`，第三方源只能用普通能力。第一版可以不做，但要想清楚要不要。

---

## 10. 相关文件索引

| 文件 | 作用 |
|---|---|
| `docs/PLUGIN_SPEC.md` | 插件包格式与 API 规范（外置后需要扩写 lifecycle/shortcuts/overlay） |
| `docs/HANDOVER.md` | 架构决策与踩坑记录 |
| `src-tauri/src/plugins/host.rs` | 权限网关（`dispatch` / `requirement_for`） |
| `src-tauri/src/plugins/source.rs` | 四种安装来源（目录/zip/git/registry） |
| `src-tauri/src/plugins/builtin.rs` | 内置应用同步（阶段 1 后语义要变） |
| `src-tauri/src/core/manifest.rs` | `plugin.json` 校验、`KNOWN_PERMISSIONS` |
| `src/components/settings/AppsTab.tsx` | 现在只有「本地目录 / 安装包 / Git」三个入口 |
| `src/sdk/index.ts` | 插件 SDK（发布前靠 `tsc` 手工同步到各插件目录） |
