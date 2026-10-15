#!/usr/bin/env node
/**
 * 给 CI 传上来的产物签名，并发布 update.json（自更新的最后一步）。
 *
 * 分工：CI 编包（mac + Windows），**签名在本地做** —— 更新签名私钥
 * (~/.tauri/knockbox.key) 不进 CI，仓库被入侵也拿不到「给所有用户发
 * 恶意更新包」的能力。CI 传的是未签名产物。
 *
 * 完整发版：
 *   pnpm release                     # 升版本 + 本机自测
 *   git commit -am v0.2.x && git tag v0.2.x && git push --tags
 *   （等 Actions 的 release 跑完，Release 里已有未签名的产物）
 *   pnpm sign-release                # 本条脚本：签名 + 回传 + update.json
 *
 * 凭据：仓库根 .env 里的 GITHUB_TOKEN（已 gitignore）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OWNER = 'GunnmF'
const REPO = 'knockbox'

// .env 里的凭据（已在 .gitignore）：跑命令自动带上，不用每次 export
function loadDotEnv() {
  const f = join(root, '.env')
  if (!existsSync(f)) return
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_]+)\s*=\s*(.*)\s*$/)
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
loadDotEnv()

const token = process.env.GITHUB_TOKEN
if (!token) {
  console.error('\n✗ 没有 GITHUB_TOKEN。放仓库根的 .env 里（GITHUB_TOKEN=ghp_xxx）再跑。\n')
  process.exit(1)
}

const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const tag = `v${version}`
const keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY ?? join(homedir(), '.tauri', 'knockbox.key')
if (!existsSync(keyPath)) {
  console.error(`\n✗ 找不到签名私钥 ${keyPath}`)
  console.error('  生成：npx tauri signer generate -w ~/.tauri/knockbox.key --ci\n')
  process.exit(1)
}

const api = (method, url, body) =>
  execFileSync(
    'curl',
    [
      '-sSf', '-X', method,
      '-H', `Authorization: Bearer ${token}`,
      '-H', 'Accept: application/vnd.github+json',
      '-H', 'X-GitHub-Api-Version: 2022-11-28',
      ...(body ? ['-d', JSON.stringify(body)] : []),
      url,
    ],
    { encoding: 'utf8' },
  )

// —— 1. 找 release（必须 CI 先跑过；tag 用 vX.Y.Z）——
let release
try {
  release = JSON.parse(api('GET', `https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${tag}`))
} catch {
  console.error(`\n✗ 找不到 release ${tag}。`)
  console.error('  先推 tag 让 Actions 跑完：git tag ' + tag + ' && git push --tags\n')
  process.exit(1)
}
console.log(`\n  release ${tag}`)

const assets = JSON.parse(
  api('GET', `https://api.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets`),
)
const uploadBase = release.upload_url.split('{')[0]

// —— 2. 下载 CI 传上来的未签名产物 ——
const work = join(root, 'release-in', 'sign')
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const download = (asset) => {
  const to = join(work, asset.name)
  execFileSync(
    'curl',
    [
      '-sSfL', '-H', `Authorization: Bearer ${token}`,
      '-H', 'Accept: application/octet-stream',
      '-o', to, asset.url,
    ],
    { stdio: 'inherit' },
  )
  console.log(`  下载 ${asset.name}`)
  return to
}

const macAsset = assets.find((a) => /darwin|aarch64/i.test(a.name) && a.name.endsWith('.app.tar.gz'))
const winExe = assets.find((a) => /x64/i.test(a.name) && a.name.endsWith('.exe'))
if (!macAsset && !winExe) {
  console.error('\n✗ release 里没有可签名的产物（*.app.tar.gz / *x64*.exe）。')
  console.error('  确认 Actions 的 release 工作流已跑完。\n')
  process.exit(1)
}

// —— 3. 签名并回传 ——
/** --app-version 把版本号写进签名的受保护部分；客户端据此拒绝「新版本号配旧包」 */
const sign = (file) => {
  execFileSync(
    'npx',
    ['tauri', 'signer', 'sign', '--app-version', version, '-f', keyPath, file],
    { cwd: root, stdio: 'inherit', env: { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' } },
  )
  return readFileSync(`${file}.sig`, 'utf8').trim()
}

const upload = (filePath, contentType) => {
  const name = encodeURIComponent(filePath.split('/').pop())
  try {
    api('POST', `${uploadBase}?name=${name}`, undefined)
  } catch { /* 已存在的情况下面会删了重传 */ }
  const cur = JSON.parse(
    api('GET', `https://api.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets`),
  ).find((a) => a.name === filePath.split('/').pop())
  if (cur) api('DELETE', `https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/${cur.id}`)
  execFileSync(
    'curl',
    [
      '-sSf', '-X', 'POST',
      '-H', `Authorization: Bearer ${token}`,
      '-H', `Content-Type: ${contentType}`,
      '--data-binary', `@${filePath}`,
      `${uploadBase}?name=${name}`,
    ],
    { stdio: 'inherit' },
  )
  console.log(`  已上传 ${filePath.split('/').pop()}`)
}

const platforms = {}

if (macAsset) {
  const file = download(macAsset)
  platforms['darwin-aarch64'] = {
    signature: sign(file),
    url: `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${macAsset.name}`,
  }
}

if (winExe) {
  const exe = download(winExe)
  // Windows 端更新产物是 zip（装 nsis 安装器），不是裸 exe
  const zipName = winExe.name.replace(/\.exe$/i, '.zip')
  const zipPath = join(work, zipName)
  execFileSync('zip', ['-j', '-q', '-FS', zipPath, exe])
  platforms['windows-x86_64'] = {
    signature: sign(zipPath),
    url: `https://github.com/${OWNER}/${REPO}/releases/download/${tag}/${zipName}`,
  }
  upload(zipPath, 'application/zip')
}

// —— 4. update.json：客户端只认这一个文件 ——
const updateJson = {
  version,
  notes: release.body ?? '',
  pub_date: release.published_at ?? new Date().toISOString(),
  platforms,
}
const jsonPath = join(work, 'update.json')
writeFileSync(jsonPath, JSON.stringify(updateJson, null, 2) + '\n')
upload(jsonPath, 'application/json')

console.log(`\n  ✓ v${version} 签名完成，自更新已生效。`)
console.log('    客户端：管理应用 → 设置 → 更新 → 检查更新\n')
