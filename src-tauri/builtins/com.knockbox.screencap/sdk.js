/**
 * Knockbox 轻应用 SDK。
 *
 * 开发者只需 `import { connect } from '@knockbox/plugin-sdk'`，剩下的宿主会搞定。
 * 本文件既是应用内的实现，也是将来发布到 npm 的源码。
 *
 * 规范见 docs/PLUGIN_SPEC.md。
 */
export class KnockboxError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
/** SDK 方法 → 它需要的权限。见 docs/PLUGIN_SPEC.md §4。 */
const PERMISSION_MAP = {
    'clipboard.readText': 'clipboard:read',
    'clipboard.writeText': 'clipboard:write',
    'system.getSelection': 'system:selection',
    'shell.openUrl': 'shell:open-url',
    'shell.openPath': 'shell:open-path',
    'shell.openApp': 'shell:open-app',
    fetch: 'web:fetch',
    notify: 'notification',
    'history.list': 'history:read',
    'window.resize': 'window:resize',
    'storage.get': 'storage:local',
    'storage.set': 'storage:local',
    'storage.remove': 'storage:local',
    'storage.clear': 'storage:local',
    'system.lockScreen': 'system:lock-screen',
    'screen.capture': 'screen:capture',
    'screen.save': 'screen:capture',
};
/**
 * 连接宿主。返回一个 Proxy，使得**未授权的方法根本不存在**（`undefined`），
 * 而不是调用时才报错 —— 这样插件作者在开发期就能发现自己忘了声明权限。
 */
export async function connect() {
    const meta = await handshake();
    const granted = new Set(meta.permissions);
    const send = (method, params) => new Promise((resolve, reject) => {
        const id = nextId++;
        const onMessage = (e) => {
            const msg = e.data;
            if (!msg || msg.kb !== 1 || msg.id !== id)
                return;
            window.removeEventListener('message', onMessage);
            if (msg.ok)
                resolve(msg.result);
            else
                reject(new KnockboxError(msg.error?.code ?? 'INTERNAL', msg.error?.message ?? '调用失败'));
        };
        window.addEventListener('message', onMessage);
        window.parent.postMessage({ kb: 1, token: meta.token, id, method, params: params ?? {} }, '*');
    });
    const kb = {
        meta,
        get query() {
            return currentQuery;
        },
        onQueryChange(cb) {
            return subscribe('query', cb);
        },
        pushResult(...results) {
            void send('pushResult', { results });
        },
        setPanel(options) {
            void send('setPanel', { title: options.title, height: options.height });
            mountPanel(options.render, send);
        },
        close() {
            void send('close');
        },
        clipboard: {
            readText: () => send('clipboard.readText'),
            writeText: (text) => send('clipboard.writeText', { text }),
        },
        system: {
            getSelection: () => send('system.getSelection'),
            lockScreen: () => send('system.lockScreen'),
        },
        screen: {
            // 参数必须透传：宿主靠 mode 决定走全屏直出还是覆盖层会话。
            // 早前这里漏了参数，插件设置的 mode/format 全被静默忽略。
            capture: (options) => send('screen.capture', {
                mode: options?.mode ?? 'full',
                cursor: options?.cursor ?? false,
                format: options?.format ?? 'png',
            }),
            save: (dataUrl, tag) => send('screen.save', { dataUrl, tag }),
        },
        shell: {
            openUrl: (url) => send('shell.openUrl', { url }),
            openPath: (path) => send('shell.openPath', { path }),
            openApp: (name) => send('shell.openApp', { app: name }),
        },
        storage: {
            get: (key) => send('storage.get', { key }),
            set: (key, value) => send('storage.set', { key, value }),
            remove: (key) => send('storage.remove', { key }),
            clear: () => send('storage.clear'),
        },
        setting: {},
        notify(title, body) {
            void send('notify', { title, body });
        },
        fetch: (url, init) => send('fetch', {
            url,
            method: init?.method ?? 'GET',
            body: init?.body,
            headers: init?.headers,
        }),
        history: (limit = 20) => send('history.list', { limit }),
    };
    // 设置值：connect 时一次性取回
    const settings = await send('settings.get').catch(() => ({}));
    Object.defineProperty(kb, 'setting', { value: settings, enumerable: true });
    return pruneByPermissions(kb, granted);
}
let nextId = 1;
const subscribers = new Map();
let panelHost = null;
/** 宿主输入框的当前内容。由握手响应和后续 query 事件共同维护。 */
let currentQuery = '';
/**
 * 宿主 → 插件的单向事件通道：当前输入（query）、回车（submit）。
 *
 * 这条监听器必须挂在模块加载时就绪，早于 `connect()` —— 宿主可能在插件
 * connect 之前就已经推过一次 query 了。
 */
window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || msg.kb !== 1 || typeof msg.event !== 'string')
        return;
    if (typeof msg.query === 'string')
        currentQuery = msg.query;
    subscribers.get(msg.event)?.forEach((cb) => cb(msg.query ?? ''));
});
function handshake() {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new KnockboxError('HOST_CLOSED', '未收到宿主响应')), 3000);
        const onMessage = (e) => {
            const msg = e.data;
            // 宿主不知道我们的请求 id，只能按「第一条带 meta 的响应」来认领
            if (!msg || msg.kb !== 1 || !msg.ok || !msg.result?.token)
                return;
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            // 握手响应会捎带当前输入，省掉"等下一次 query 事件"的空窗期
            if (typeof msg.result.query === 'string')
                currentQuery = msg.result.query;
            resolve(msg.result);
        };
        window.addEventListener('message', onMessage);
        window.parent.postMessage({ kb: 1, token: '', method: 'handshake' }, '*');
    });
}
function subscribe(channel, cb) {
    const set = subscribers.get(channel) ?? new Set();
    set.add(cb);
    subscribers.set(channel, set);
    return () => set.delete(cb);
}
function mountPanel(render, send) {
    panelHost?.remove();
    panelHost = document.createElement('div');
    panelHost.className = 'kb-plugin-panel';
    panelHost.style.cssText = 'height:100%;overflow:auto;padding:10px 12px;';
    document.body.appendChild(panelHost);
    document.documentElement.style.height = '100%';
    render(panelHost, {
        get query() {
            return currentQuery;
        },
        onQueryChange(cb) {
            return subscribe('query', cb);
        },
        onSubmit(cb) {
            return subscribe('submit', cb);
        },
        close() {
            void send('close');
        },
    });
}
/**
 * 按权限裁剪 API：没声明的方法直接不存在。
 * SDK 层的这道裁剪不是安全措施（真正的关卡在 Rust 侧的 dispatch），
 * 但它能让插件作者在开发期就拿到明确反馈。
 *
 * 注意是**按方法**裁剪，不是按分组。一组里的方法可能属于不同权限 ——
 * `kb.system` 下 `getSelection` 要 `system:selection`、`lockScreen` 要
 * `system:lock-screen`。早前按组删除，导致只声明了后者的插件（比如锁屏）
 * 会因为前者没声明而把整个 `system` 删掉，连已授权的方法也一起没了。
 * 整组被清空之后才把组本身删掉，这样"完全没声明"时作者拿到的仍是 undefined。
 */
function pruneByPermissions(kb, granted) {
    const target = kb;
    for (const [method, permission] of Object.entries(PERMISSION_MAP)) {
        if (granted.has(permission))
            continue;
        const [group, action] = method.split('.');
        if (!action) {
            delete target[group];
            continue;
        }
        const holder = target[group];
        if (!holder)
            continue;
        // kb.history(limit) 这种是函数而不是对象，没法只删一个方法，只能整个删
        if (typeof holder === 'function') {
            delete target[group];
            continue;
        }
        delete holder[action];
    }
    for (const group of ['clipboard', 'system', 'shell', 'storage', 'screen']) {
        const holder = target[group];
        if (holder && typeof holder === 'object' && Object.keys(holder).length === 0) {
            delete target[group];
        }
    }
    return kb;
}
export default connect;
