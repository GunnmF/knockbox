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
            capture: () => send('screen.capture'),
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
 */
function pruneByPermissions(kb, granted) {
    const target = kb;
    for (const [method, permission] of Object.entries(PERMISSION_MAP)) {
        if (!granted.has(permission)) {
            delete target[methodGroup(method)];
        }
    }
    return kb;
}
function methodGroup(method) {
    const [group, action] = method.split('.');
    return action ? group : method;
}
export default connect;
