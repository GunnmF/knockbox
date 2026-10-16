# Knockbox 轻应用标准 v0.1（Knockbox Plugin Spec）

> 目标：让任何会写前端的开发者，在 **一个下午**内做出一个能被 Knockbox 唤起的轻应用，
> 而不需要了解 Rust、系统 API 或 Electron。

- 协议命名：`knockbox-plugin`
- 协议版本：`0.1`
- 安装包后缀：`.kbplugin`（本质是 zip，根目录含 `plugin.json`）
- 参考实现：`packages/knockbox-plugin-sdk`（发布到 npm 名为 `@knockbox/plugin-sdk`）

---

## 1. 一个轻应用长什么样

```
my-plugin/
├── plugin.json          # 必需：清单文件，声明身份、入口、权限
├── index.html           # 必需：入口页面（entry 字段指向它）
├── icon.svg             # 可选：图标
├── styles.css
└── src/
    └── main.js
```

最小可运行版本：

```json
// plugin.json
{
  "id": "com.example.hello",
  "name": "打个招呼",
  "version": "1.0.0",
  "entry": "index.html"
}
```

```html
<!-- index.html -->
<!doctype html>
<html>
  <head><meta charset="utf-8" /><script src="./sdk.js"></script></head>
  <body>
    <input id="q" placeholder="说点什么…" />
    <p id="out"></p>
    <script src="./main.js"></script>
  </body>
</html>
```

---

## 2. plugin.json 清单

### 2.1 字段定义

| 字段 | 类型 | 必需 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 反向域名格式，全局唯一。**安装后不可更改**，是插件的永久身份 |
| `name` | string | ✅ | 展示名，1–32 字符 |
| `version` | string | ✅ | 语义化版本 `x.y.z` |
| `description` | string | | 一句话描述，≤120 字符 |
| `entry` | string | ✅ | 入口 HTML，相对插件根目录。**必须是本地文件** |
| `icon` | string | | 图标路径，相对插件根目录，svg/png |
| `author` | string | | 作者名或组织 |
| `homepage` | string | | 主页 URL |
| `keywords` | string[] | | 唤起关键词。输入框匹配到关键词时，该插件排在结果首位 |
| `activation` | enum | | `keyword`（默认，输入关键词即接管）/ `manual`（仅用户主动点开） |
| `invocation` | enum | | `panel`（默认，弹出面板让用户操作）/ `direct`（静默执行，不显示界面） |
| `shortcuts` | object[] | | 声明全局快捷键，见 §2.3。**声明了就必须有 `system:hotkey` 权限** |
| `background` | boolean | | 是否需要常驻后台（持续监听事件），见 §2.4。**必须配 `app:background` 权限** |
| `permissions` | string[] | | 能力白名单，见 §4。**未声明的能力一律不可用** |
| `settings` | object[] | | 设置项声明，Knockbox 自动生成设置界面，见 §5 |
| `minKnockboxVersion` | string | | 最低宿主版本，不满足则拒绝安装 |

### 2.2 校验规则

安装时内核强制校验，任何一条不满足则拒绝安装并给出明确原因：

1. `id` 必须匹配 `^[a-z0-9]+([-.][a-z0-9]+)*\.[a-z]{2,}$`（至少两段，形如 `com.example.hello`）
2. `id` 不得与已安装插件冲突（升级场景除外）
3. `version` 必须匹配 `^\d+\.\d+\.\d+$`
4. `entry` 指向的文件必须存在，且**解析后仍在插件根目录内**（阻断 `../../` 路径穿越）
5. `entry` 必须是 `.html`/`.htm`
6. `permissions` 中每一项必须在内核已知的权限表中，未知权限报错而非忽略
7. 单个插件解压后体积 ≤ 50 MB（软限制，超出仅告警）
8. 插件目录内不得包含符号链接（阻断指向宿主文件系统的逃逸）
9. 声明了 `shortcuts` 就必须有 `system:hotkey` 权限；每个快捷键**必须带修饰键**
   （裸按键会劫走用户的正常打字），同一插件内不允许重复
10. `background: true` 必须有 `app:background` 权限

---

### 2.3 全局快捷键（shortcuts）

```json
"shortcuts": [
  { "key": "CmdOrCtrl+Shift+S", "description": "区域截图", "mode": "silent" }
]
```

| 字段 | 说明 |
|---|---|
| `key` | 组合键，`CmdOrCtrl` 在 macOS 上是 ⌘、在其它平台是 Ctrl。**必须有修饰键** |
| `description` | 给人看的说明，显示在设置页的快捷键列表里 |
| `mode` | `silent`（默认按下即静默执行，主窗口不出现）/ `panel`（唤醒主窗口并打开插件面板） |

**宿主负责监听，插件只声明。** 插件代码里没有任何"注册快捷键"的 API ——
它在清单里写清楚要什么，宿主去注册系统监听，按下时通知插件。这既是安全边界
（装一个截图插件不会顺带拿到"监听所有按键"的能力），也解决了组合键冲突：
主快捷键优先，插件之间先到先得，后注册的那个会被跳过并在设置页里看到提示。

`silent` + `invocation: direct` 的组合就是「一步做完的事」：按下快捷键，
主窗口始终隐藏，只有插件自己需要的界面（比如全屏覆盖层）会出现，做完即走。

### 2.4 后台常驻（background）

```json
"background": true
```

`background: true` 表示这个轻应用需要**持续监听事件**（快捷键之外还有剪贴板
变化等），必须一直活着；不声明就是"被唤起时才创建页面，用完就回收"。

后台常驻的轻应用必须在界面上让用户看得见：托盘菜单会列出它们，设置页的已安装
列表也会标注。这条权限单独列出来而不是默认给，是因为"长期占着资源"该由用户决定。

---

## 3. 运行时模型：WebView 沙箱

轻应用运行在 Knockbox 主窗口内的一个 `<iframe>` 中，而不是独立的 WebView 进程。这是刻意的选择：
省掉一次进程创建，唤起延迟控制在 10ms 内。

```
┌─ Knockbox 主窗口 (React) ─────────────────────────┐
│  ┌──────────────────────────────────────────────┐  │
│  │  搜索框 + 结果列表（宿主渲染）                 │  │
│  ├──────────────────────────────────────────────┤  │
│  │  <iframe src="knockbox-plugin://com.x.y/">    │  │
│  │   sandbox="allow-scripts"                    │  │
│  │   ← 插件页面，独立 origin，碰不到宿主 DOM      │  │
│  └──────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────┘
```

**隔离保证：**

| 威胁 | 防护 |
|---|---|
| 读取宿主页面 / DOM / localStorage | `sandbox` 不含 `allow-same-origin`，插件处于独立 opaque origin |
| 顶层导航、弹窗劫持 | 不含 `allow-top-navigation`、`allow-popups` |
| 直接调用 Tauri IPC 提权 | 插件 iframe 不绑定任何 Tauri capability，无法触达 `invoke` |
| 伪造 SDK 调用 | 每次会话下发一次性 `token`，所有 bridge 消息必须携带且逐一校验 |
| 恶意插件读到用户文件 | 唯一通道是 SDK，且必须事先声明对应 permission |

**宿主注入的桥接对象：**

插件页面通过 `window.parent.postMessage(msg, '*')` 发出请求，
宿主 `window.addEventListener('message')` 收到后按白名单分发。SDK 负责封装。

---

## 4. 权限模型（能力白名单）

插件想用某个能力，必须在 `plugin.json.permissions` 里显式声明。
安装界面上会**逐条向用户展示**用户即将授予的能力，由用户确认。

| 权限 | 能力 | 风险 |
|---|---|---|
| `clipboard:read` | 读剪贴板文本 | 中 —— 可能读到密码 |
| `clipboard:write` | 写剪贴板 | 低 |
| `shell:open-url` | 用默认浏览器打开 URL | 中 —— 需配合 `web:allowed-domains` |
| `shell:open-path` | 用系统默认程序打开文件 | 中 |
| `shell:open-app` | 启动已安装应用 | 低 |
| `notification` | 发送系统通知 | 低 |
| `system:selection` | 读取前台窗口当前选中的文本 | 中 |
| `web:fetch` | 通过宿主代理发起 HTTP 请求 | 中 —— 受 `web:allowed-domains` 限制 |
| `storage:local` | 插件私有的键值存储 | 无 |
| `history:read` | 读取 Knockbox 最近使用记录 | 低 |
| `window:resize` | 调整面板高度（多行输入类插件需要） | 无 |
| `system:lock-screen` | 锁定屏幕 | 高 —— **不可撤销**。插件必须给用户明确的确认动作，禁止在唤起时直接调用 |
| `screen:capture` | 截取屏幕，存到本机并返回文件路径 | 高 —— 会拍到屏幕上的密码、聊天记录 |
| `system:hotkey` | 允许在 `shortcuts` 里声明全局快捷键（**宿主负责监听**） | 高 —— 劫持按键 |
| `system:clipboard-watch` | 允许声明剪贴板触发条件，命中时宿主把内容推给插件 | 高 —— 复制过的内容 |
| `window:overlay` | 允许开一个覆盖全屏的置顶窗口承载自己的界面 | 高 —— 全屏遮挡 |
| `app:background` | 允许常驻后台（持续监听事件） | 中 —— 长期占用资源 |

> `screen:capture` 覆盖两个方法：`screen.capture`（`mode: 'region'` 时宿主会弹
> 全屏覆盖层让用户框选/标记/取色，这个 Promise 会挂到用户操作结束，取消时
> 以「已取消截图」reject）和 `screen.save`（把插件在画布上标好的图落盘，
> 只能写进宿主的截图目录，文件名由宿主生成）。

> `system:lock-screen` 和 `screen:capture` 是内置轻应用（锁屏、截图）需要的能力。
> 两者都是高影响操作，因此独立成权限而不是并入 `shell:*` —— 用户能分别授予或拒绝。

> **`mode: 'freeze'`（宿主只给图，界面全归插件）**：`freeze` 截一张全屏画面立刻返回
> `{ path, bytes, dataUrl? }`，**不带任何界面**。想自己做选区的轻应用用它拿到一张
> 干净的屏幕图，再配合 `window.openOverlay` 开自己的覆盖层去画 —— `region` 模式是
> 给"一步就完事"的轻应用用的快捷通道（宿主代画选区），标记、取色、快捷键这些
> 交互细节一律由插件自己实现。

补充声明字段：

```json
{
  "permissions": ["web:fetch", "shell:open-url"],
  "web:allowed-domains": ["api.example.com", "*.taobao.com"]
}
```

> 未声明的权限在 SDK 上根本不存在对应方法 —— 不是调用时报错，是 `undefined`。
> 这样插件作者误用时能立刻在开发期发现。

---

## 5. 设置声明

`settings` 用于让 Knockbox 自动生成插件设置界面，插件作者不需要自己写 UI：

```json
{
  "settings": [
    { "key": "lang",   "label": "语言",   "type": "select",
      "options": ["中文", "English"], "default": "中文" },
    { "key": "apikey", "label": "API Key", "type": "string", "secret": true },
    { "key": "auto",   "label": "自动执行", "type": "boolean", "default": false }
  ]
}
```

类型：`string` / `number` / `boolean` / `select` / `text`（多行文本）。
`secret: true` 的值在 UI 中掩码显示，宿主侧加密存储，SDK 读取时返回掩码值。

---

## 6. SDK API

### 6.1 连接

```js
import { connect } from '@knockbox/plugin-sdk'

const kb = await connect()
// 断线时自动重连；宿主窗口关闭时 SDK 不会抛错
```

`connect()` 会等待握手完成，解析出插件的 `id` / `name` / `keywords` / `permissions` / `settings`。

### 6.2 结果面板（插件接管展示区）

宿主默认渲染自己的结果列表。插件被唤起后，可以选择"接管"结果区：

```js
// 只声明一条静态结果，宿主渲染（最轻，无需 iframe 展开）
kb.pushResult({
  type: 'action',
  title: '翻译成英文',
  subtitle: 'Hello, world',
  icon: 'https://...',
  onSelect: () => console.log('用户按下了回车'),
})

// 完全接管：宿主隐藏自己的结果列表，把区域让给你
kb.setPanel({
  title: '待办清单',
  height: 320,          // 面板高度（px），触发 window:resize 权限
  render: (container, ctx) => {
    // container: 一个干净的 DOM 节点
    // ctx.query: 宿主输入框当前内容
    // ctx.onQueryChange(cb): 输入变化回调
    // ctx.onSubmit(cb): 回车回调
    // ctx.close(): 关闭插件面板
  },
})
```

### 6.3 能力方法（完整清单）

```js
// —— 输入 ——
kb.query                  // 当前输入框文本（getter）
kb.onQueryChange(cb)      // 订阅输入变化，返回 unsubscribe

// —— 剪贴板 (clipboard:read / write) ——
await kb.clipboard.readText()
await kb.clipboard.writeText('...')

// —— 选中文本 (system:selection) ——
const { text, app } = await kb.system.getSelection()

// —— 锁屏 / 截屏（高影响，务必给用户确认动作）——
await kb.system.lockScreen()
await kb.screen.capture()                    // 全屏直出，存到本机，立即返回
await kb.screen.capture({ mode: 'region' })  // 弹出宿主全屏覆盖层，等用户操作完才返回
await kb.screen.capture({ mode: 'freeze' })  // 只拿一张全屏图，界面自己画（配合 window.openOverlay）
await kb.screen.save(dataUrl, 'tag')         // 画布上标好的图落盘（只能写进截图目录）

// —— 启动 (shell:*) ——
await kb.shell.openUrl('https://example.com')
await kb.shell.openPath('/Users/me/a.pdf')
await kb.shell.openApp('com.apple.Safari')

// —— 网络 (web:fetch) ——
const res = await kb.fetch('https://api.example.com/q', { method: 'POST' })
// 宿主代理发起，受 web:allowed-domains 限制；返回 { ok, status, json(), text() }

// —— 存储 (storage:local) ——
await kb.storage.set('token', 'abc')     // 插件私有，与其它插件隔离
const token = await kb.storage.get('token')
await kb.storage.remove('token')
await kb.storage.clear()

// —— 设置 (由用户在设置界面填写) ——
const lang = kb.setting.lang                // 读 settings 声明的值
await kb.settings.open()                    // 打开宿主设置页到本插件

// —— 历史 (history:read) ——
const recent = await kb.history.list(20)

// —— 通知 / 窗口 ——
kb.notify('title', 'body')
kb.close()                                   // 收起主窗口
kb.hide()                                    // 等同 close 的语义别名
```

### 6.4 通信协议

宿主与插件之间的消息格式（SDK 已封装，一般无需手写）：

```jsonc
// 插件 -> 宿主
{ "kb": 1, "token": "xxxx", "id": 7, "method": "clipboard.readText", "params": {} }
// 宿主 -> 插件（成功）
{ "kb": 1, "id": 7, "ok": true, "result": "..." }
// 宿主 -> 插件（失败：权限不足 / 参数错误 / 宿主内部错误）
{ "kb": 1, "id": 7, "ok": false, "error": { "code": "PERMISSION_DENIED", "message": "..." } }
```

**为什么插件页需要宿主发 CORS 头**：插件跑在 `sandbox` 不含 `allow-same-origin` 的 iframe 里，
origin 是 `null`；而 ES module 一律按 CORS 模式请求。宿主若不发
`Access-Control-Allow-Origin`，`<script type="module">` 会被浏览器直接拦掉——
表现为"点了插件毫无反应"，因为插件的 JS 压根没跑起来。

**错误码**：`PERMISSION_DENIED` / `INVALID_PARAMS` / `NOT_FOUND` / `RATE_LIMITED` / `HOST_CLOSED` / `INTERNAL`

每个会话对单个方法有速率限制（默认 60 次/秒），超出返回 `RATE_LIMITED`。

---

## 7. 安装来源

统一的三种安装方式，落盘格式一致（都是解压后的目录）：

### 7.1 本地目录

直接把插件文件夹拖进 Knockbox 窗口，或在设置里选择目录。

### 7.2 `.kbplugin` 安装包

zip 结构要求：**`plugin.json` 必须在压缩包根目录**（不允许外层再套一层目录），
以此避免路径穿越和安装路径歧义。

```bash
my-plugin.zip
├── plugin.json     ← 必须在这里
├── index.html
└── icon.svg
```

### 7.3 Git URL

```
knockbox://install?url=https://github.com/you/my-plugin.git
```

或在设置里粘贴 URL。安装流程：`git clone --depth 1` 到临时目录 → 按 §2 校验 →
若仓库有 `tags`，取最新 tag 作为版本；否则用 `0.0.0+<commit>`。

### 7.4 远程市场（可选）

指向一个返回 JSON 索引的 URL：

```jsonc
{
  "version": 1,
  "plugins": [
    {
      "id": "com.example.hello",
      "name": "打个招呼",
      "version": "1.0.0",
      "download": "https://example.com/hello.kbplugin",
      "sha256": "…",              // 下载后必须校验
      "permissions": ["clipboard:write"]
    }
  ]
}
```

索引里的 `permissions` 会被**强制合并进**安装时用户的授权确认流程 —— 用户看到的永远是插件真实请求的能力，而不是索引里写的。

---

## 8. 生命周期

```
install → validate(§2) → 落盘 ~/.knockbox/plugins/<id>/
       → 用户确认权限 → enabled

launch(keyword 命中) → 宿主创建 iframe → connect() 握手
                     → setPanel()/pushResult() → 展开
用户关闭面板 → iframe 销毁 → 内存释放

update → 校验新包 → 保留用户设置 → 覆盖目录 → 热重载
uninstall → 删除目录 → 保留一份设置备份（重装可恢复）
```

轻应用**不常驻**：没被唤起时不占任何内存，这是 Knockbox 与 uTool「越用越卡」的主要区别。

---

## 9. 开发者路线

```
plugin.json  →  npm i @knockbox/plugin-sdk  →  connect()
             →  kb.onQueryChange(q => ...)
             →  kb.setPanel({ render })
             →  kb.clipboard.readText()  // 注意先声明权限
             →  打包成 .kbplugin
```

发布只需三步：填 `plugin.json`、声明 `permissions`、`zip` 打包。
没有构建步骤要求 —— 原生 ESM + 相对路径 import 即可运行。

---

## 10. 版本策略

- 宿主向后兼容：旧版 SDK 写的插件，新版 Knockbox 必须能跑。
- `minKnockboxVersion` 不满足 → 安装时明确拒绝，提示所需版本。
- SDK 方法只增不删；废弃的方法标记 `deprecated` 并保留至少一个大版本。