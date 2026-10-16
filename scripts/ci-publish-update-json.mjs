#!/usr/bin/env node
/**
 * CI 专用：把 Release 上已有的产物和签名拼成 update.json，再传回 Release。
 *
 * 客户端（Tauri updater）只认 update.json：里面写版本号、下载地址和
 * **每个平台产物的签名**。签名由各平台的 `tauri build` 在构建时用私钥
 * 直接生成（KNOCKBOX_UPDATER_KEY secret），本脚本只做组装，不碰私钥。
 *
 * **为什么自己去 Release 上找产物，而不是从上游 job 传过来**：
 * 跨 job 传值要靠 `needs.<job>.outputs.<step>.<name>`，链路上任何一环
 * 没写上，下游拿到的就是空字符串，而且失败方式是"看起来像本 job 的问题"
 * （之前就因为这样丢了 mac 和 windows 的产物名/签名）。改成自己读 Release：
 *   - 不依赖任何上游输出，上游 job 只要把产物传上去就算成功
 *   - 可以单独重跑（GitHub 的 "Re-run failed jobs" 就能修好）
 *   - 幂等：跑几次结果一样
 *
 * 产物的形态（见 docs/HANDOVER.md §3.7）：
 *   macOS   Knockbox.app.tar.gz      + .app.tar.gz.sig
 *   Windows Knockbox_<v>_x64-setup.exe + .exe.sig
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 预演：只打印会写出的 update.json，不碰 Release
const dryRun = process.argv.includes('--dry-run')

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OWNER = process.env.KNOCKBOX_OWNER ?? 'GunnmF'
const REPO = process.env.KNOCKBOX_REPO ?? 'knockbox'

// 凭据：CI 里是 secrets.GITHUB_TOKEN，本地跑时读仓库根的 .env（已 gitignore）
const token =
  process.env.GITHUB_TOKEN ??
  process.env.GH_TOKEN ??
  (existsSync(join(root, '.env'))
    ? (readFileSync(join(root, '.env'), 'utf8').match(/GITHUB_TOKEN\s*=\s*(.+)/)?.[1] ?? '').trim().replace(/^["']|["']$/g, '')
    : '')

if (!token) {
  console.error('✗ 没有 GITHUB_TOKEN（CI 里用 secrets.GITHUB_TOKEN，本地用 .env）')
  process.exit(1)
}

const api = (path, init = {}) =>
  fetch(`https://api.github.com/repos/${OWNER}/${REPO}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  })

/** tag：显式传入优先，其次取 package.json 的版本（与 release.yml 里保持一致） */
function resolveTag() {
  const fromEnv = (process.env.TAG ?? '').replace(/^v/, '')
  if (fromEnv) return fromEnv
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error('package.json 版本号不是三段式')
  return pkg.version
}

const tag = resolveTag()

/** 网络抽风时给一句人话，而不是甩一整串 undici 栈 */
async function tryApi(path, init) {
  try {
    return await api(path, init)
  } catch (e) {
    console.error(`✗ 请求 GitHub 失败：${e.cause?.code ?? e.message}`)
    console.error('  多半是网络问题（api.github.com 连不上），重跑一次即可')
    process.exit(1)
  }
}

const relRes = await tryApi(`/releases/tags/v${tag}`)
if (!relRes.ok) {
  console.error(`✗ 找不到 release v${tag}（HTTP ${relRes.status}）`)
  console.error('  先确认 macOS / Windows 两个构建 job 跑完并把产物传上来了')
  process.exit(1)
}
const release = await relRes.json()

const assets = release.assets ?? []
const sigOf = (asset) => assets.find((a) => a.name === `${asset.name}.sig`)

/**
 * 挑产物。两个讲究：
 *   1. 必须有配套的 .sig —— 同一个产物可能存在多份（本地发过、CI 又传过），
 *      而本地那条路只把签名写进 update.json、没把 .sig 传上去。挑没签名的那份
 *      会让 update.json 指向一个无法校验的包
 *   2. 同等条件下优先带版本号的名字，它会出现在用户看到的下载链接里
 */
const find = (re) => {
  const hits = assets.filter((a) => re.test(a.name) && !a.name.endsWith('.sig'))
  const signed = hits.filter((a) => sigOf(a))
  const pool = signed.length ? signed : hits
  return pool.find((a) => a.name.includes(tag)) ?? pool[0]
}

/** 下载 .sig 文件的内容（它就是 update.json 里要写的那段 base64 签名） */
async function signatureOf(asset) {
  const sig = sigOf(asset)
  if (!sig) return null
  const res = await tryApi(`/releases/assets/${sig.id}`, {
    headers: { Accept: 'application/octet-stream' },
  })
  if (!res.ok) {
    console.error(`✗ 下载签名失败 ${sig.name}（HTTP ${res.status}）`)
    process.exit(1)
  }
  return (await res.text()).trim()
}

const platforms = {}

/** 报错时把 Release 上有什么列出来：否则「找不到 xxx」根本无从下手 */
const listAssets = () => {
  console.error(`  Release v${tag} 现有资产：`)
  for (const a of assets) console.error(`    ${a.name}`)
  console.error('  （*.sig 是签名文件，必须和产物成对出现）')
}

const mac = find(/\.app\.tar\.gz$/)
if (mac) {
  const signature = await signatureOf(mac)
  if (!signature) {
    console.error(`✗ 找不到 ${mac.name}.sig，签名产物没传上来`)
    listAssets()
    process.exit(1)
  }
  platforms['darwin-aarch64'] = { signature, url: mac.browser_download_url }
} else {
  console.error('✗ Release 上没有 *.app.tar.gz（macOS job 没跑成功？）')
  listAssets()
  process.exit(1)
}

// Windows 更新包是 NSIS 安装器 exe 本身（Tauri v2 没有 zip）
const win = find(/x64-setup\.exe$/i) ?? find(/\.exe$/i)
if (win) {
  const signature = await signatureOf(win)
  if (signature) {
    platforms['windows-x86_64'] = { signature, url: win.browser_download_url }
  } else {
    console.log(`· ${win.name} 没有配套 .sig，本次 update.json 只含 macOS`)
  }
} else {
  console.log('· Release 上没有 Windows 安装器，本次 update.json 只含 macOS')
}

const updateJson = {
  version: tag,
  notes: release.body ?? '',
  pub_date: release.published_at ?? new Date().toISOString(),
  platforms,
}

const existing = assets.find((a) => a.name === 'update.json')
if (dryRun) {
  console.log(`\n预演：v${tag} 的 update.json 会变成这样（不传）：\n`)
  console.log(
    JSON.stringify(
      { ...updateJson, platforms: Object.fromEntries(Object.entries(platforms).map(([k, v]) => [k, { signature: v.signature.slice(0, 24) + '…', url: v.url }])) },
      null,
      2,
    ),
  )
  console.log(`\n会覆盖 Release 上已有的 update.json${existing ? `（asset id ${existing.id}）` : ''}\n`)
  process.exit(0)
}

// 上传资产走的是 uploads.github.com，**不是** api.github.com —— 用错 host 会 404
const uploadAsset = () =>
  fetch(`https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=update.json`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(updateJson, null, 2),
  })

// **先传，传不动才删旧的**。反过来做（先删后传）的话，一旦上传失败，
// Release 上就一个 update.json 都不剩 —— 客户端读不到文件会直接报错，
// 而不是「已是最新」。GitHub 对重名返回 422，只有那一种情况才需要删。
let upload = await uploadAsset()
if (upload.status === 422 && existing) {
  console.log('  已存在同名 update.json，删掉重传')
  await tryApi(`/releases/assets/${existing.id}`, { method: 'DELETE' })
  upload = await uploadAsset()
}

if (!upload.ok) {
  console.error(`✗ 上传 update.json 失败（HTTP ${upload.status}）`)
  console.error(await upload.text())
  process.exit(1)
}

console.log(`✓ v${tag} 的 update.json 已发布：`)
for (const [k, v] of Object.entries(platforms)) {
  console.log(`    ${k.padEnd(16)} ${v.url.split('/').pop()}`)
}
