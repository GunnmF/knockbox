#!/usr/bin/env node
/**
 * 发布一个自更新版本。
 *
 * 流程：跑 release.mjs（升版本号 + 构建 + dmg 拷桌面）→ 找到 tauri 的
 * updater 产物（*.app.tar.gz + .sig）→ 组成 update.json →
 * 有 GITHUB_TOKEN 就用 REST API 建 GitHub Release 并上传，没有就把文件
 * 准备好并打印手动步骤。
 *
 * 首次使用前的两件事：
 *  1. 更新签名私钥已经生成并放在 ~/.tauri/knockbox.key（release 构建自动用，
 *     丢了所有用户都无法再更新，记得备份）
 *  2. GitHub → Settings → Developer settings → Personal access tokens
 *     （classic，勾 repo）→ export GITHUB_TOKEN=...
 *
 * 用法：pnpm publish-update [patch|minor|major]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OWNER = 'GunnmF'
const REPO = 'knockbox'

// —— 1. 升版本 + 构建（复用 release.mjs，产物会拷到桌面）——
const level = process.argv.slice(2).find((a) => ['patch', 'minor', 'major'].includes(a)) ?? 'patch'
execFileSync('node', [join(root, 'scripts/release.mjs'), level], { cwd: root, stdio: 'inherit' })

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const tag = `v${version}`
const bundleDir = join(root, 'src-tauri/target/release/bundle/macos')

// —— 2. 找 updater 产物（createUpdaterArtifacts 生成的 tar.gz + .sig）——
const tgz = readdirSync(bundleDir).find((f) => f.endsWith('.app.tar.gz'))
const sig = tgz && readdirSync(bundleDir).find((f) => f === `${tgz}.sig`)
if (!tgz || !sig) {
  console.error('\n✗ 找不到 updater 产物（*.app.tar.gz/.sig）。')
  console.error('  检查 tauri.conf.json 的 bundle.createUpdaterArtifacts 和 ~/.tauri/knockbox.key\n')
  process.exit(1)
}
const signature = readFileSync(join(bundleDir, sig), 'utf8').trim()
const assetName = `Knockbox_${version}_aarch64.app.tar.gz`
const dmgLocal = join(homedir(), 'Desktop', `Knockbox_${version}_aarch64.dmg`)

// —— 3. 组 update.json（updater 客户端只读这个）——
const updateJson = {
  version,
  notes: '',
  pub_date: new Date().toISOString(),
  platforms: {
    'darwin-aarch64': {
      signature,
      url: `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${assetName}`,
    },
  },
}

const outDir = join(root, 'release-out', tag)
mkdirSync(outDir, { recursive: true })
copyFileSync(join(bundleDir, tgz), join(outDir, assetName))
writeFileSync(join(outDir, 'update.json'), JSON.stringify(updateJson, null, 2) + '\n')
console.log(`\n  产物已准备好：${outDir}/`)

// —— 4. 上传：有 GITHUB_TOKEN 走 REST，没有就打印手动步骤 ——
const token = process.env.GITHUB_TOKEN
if (!token) {
  console.log(`
  没设 GITHUB_TOKEN，手动发布步骤：

  1. 打开 https://github.com/${OWNER}/${REPO}/releases/new?tag=${tag}
     tag 填 ${tag}，标题随意
  2. 上传这三个文件：
     ${join(outDir, assetName)}
     ${join(outDir, 'update.json')}
     ${dmgLocal}
  3. 点 Publish。下次客户端「检查更新」就会拉到它。

  以后想自动化：GitHub 里建一个 classic PAT（勾 repo），然后
  export GITHUB_TOKEN=... 再跑 pnpm publish-update 即可。
`)
  process.exit(0)
}

const api = (method, url, body, extra = {}) =>
  execFileSync('curl', [
    '-sSf', '-X', method,
    '-H', `Authorization: Bearer ${token}`,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
    ...extra,
    ...(body ? ['-d', JSON.stringify(body)] : []),
    url,
  ], { encoding: 'utf8' })

const upload = (uploadUrl, filePath, contentType) =>
  execFileSync('curl', [
    '-sSf', '-X', 'POST',
    '-H', `Authorization: Bearer ${token}`,
    '-H', `Content-Type: ${contentType}`,
    '--data-binary', `@${filePath}`,
    uploadUrl,
  ], { encoding: 'utf8' })

// 取或建 release
let release
try {
  release = JSON.parse(api('GET', `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${tag}`))
  console.log(`  release ${tag} 已存在，复用`)
} catch {
  release = JSON.parse(api('POST', `https://api.github.com/repos/${OWNER}/${REPO}/releases`, {
    tag_name: tag,
    name: tag,
    draft: false,
    prerelease: false,
  }))
  console.log(`  已创建 release ${tag}`)
}

const uploadBase = release.upload_url.split('{')[0]
for (const [file, type] of [
  [assetName, 'application/gzip'],
  ['update.json', 'application/json'],
]) {
  const name = encodeURIComponent(file)
  // 同名 asset 已存在会先 422，删掉重传
  try {
    upload(`${uploadBase}?name=${name}`, join(outDir, file), type)
  } catch {
    const assets = JSON.parse(api('GET', `https://api.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets`))
    const dup = assets.find((a) => a.name === file)
    if (dup) api('DELETE', `https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/${dup.id}`)
    upload(`${uploadBase}?name=${name}`, join(outDir, file), type)
  }
  console.log(`  已上传 ${file}`)
}

if (existsSync(dmgLocal)) {
  try {
    upload(`${uploadBase}?name=${encodeURIComponent(`Knockbox_${version}_aarch64.dmg`)}`, dmgLocal, 'application/octet-stream')
    console.log('  已上传 dmg（给首次安装的人）')
  } catch { /* dmg 已存在就跳过 */ }
}

console.log(`\n  ✓ ${tag} 发布完成。客户端下次「检查更新」就能看到。\n`)
