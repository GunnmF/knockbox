#!/usr/bin/env node
/**
 * CI 专用：把两个平台 job 传出来的签名拼成 update.json 并上传到 Release。
 *
 * 客户端（Tauri updater）只认 update.json：里面写版本号、下载地址和
 * **每个平台产物的签名**。签名由各平台的 `tauri build` 在构建时用私钥
 * 直接生成（KNOCKBOX_UPDATER_KEY secret），本脚本只做组装，不碰私钥。
 *
 * 由 .github/workflows/release.yml 的 publish-update-json job 调用，
 * 输入全部走环境变量：TAG / MAC_ASSET / MAC_SIG / WIN_ASSET / WIN_SIG。
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OWNER = 'GunnmF'
const REPO = 'knockbox'

const tag = (process.env.TAG ?? '').replace(/^v/, '')
const { TAG: _t, MAC_ASSET, MAC_SIG, WIN_ASSET, WIN_SIG, GH_TOKEN, GITHUB_OUTPUT, ..._rest } =
  process.env

if (!tag) {
  console.error('✗ 缺少 TAG 环境变量（tag 形如 "v" 也是空）')
  console.error('  TAG 来自 needs.macos.outputs.version，所以这基本只有一个原因：')
  console.error('  macOS 或 Windows 的构建 job 失败了/被取消，没有产出可用的产物名。')
  console.error('  先去看那两个 job 的失败原因，修好之后重跑本 job。')
  process.exit(1)
}
if (!MAC_ASSET || !MAC_SIG) {
  console.error('✗ 缺少 macOS 的产物/签名（macOS job 失败或未产出 updater 产物？）')
  process.exit(1)
}

const url = (asset) => `https://github.com/${OWNER}/${REPO}/releases/download/v${tag}/${asset}`

const platforms = {
  'darwin-aarch64': { signature: MAC_SIG.trim(), url: url(MAC_ASSET) },
}
if (WIN_ASSET && WIN_SIG) {
  // Windows 的更新产物就是 NSIS 安装器 exe 本身（平台键是 OS-ARCH，没有 -msvc 后缀），
  // 不是 zip —— 客户端下载 exe 后用这里给的 signature 校验 exe.sig
  platforms['windows-x86_64'] = { signature: WIN_SIG.trim(), url: url(WIN_ASSET) }
} else {
  console.log('· 没有 Windows 产物，本次 update.json 只含 macOS')
}

const updateJson = {
  version: tag,
  notes: '',
  pub_date: new Date().toISOString(),
  platforms,
}

const file = join(tmpdir(), 'update.json')
writeFileSync(file, JSON.stringify(updateJson, null, 2) + '\n')

execFileSync('gh', ['release', 'upload', `v${tag}`, file, '--clobber', '-R', `${OWNER}/${REPO}`], {
  stdio: 'inherit',
  env: { ...process.env, GH_TOKEN },
})

console.log(`✓ v${tag} 的 update.json 已发布（${Object.keys(platforms).join('、')}）`)
