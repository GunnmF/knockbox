#!/usr/bin/env node
/**
 * 打一个带版本号的发布包。
 *
 * 存在的理由：版本号散落在三个文件里（package.json / Cargo.toml / tauri.conf.json），
 * 手工改必然漏掉一处，然后 dmg 文件名和应用内「关于」页显示的版本就对不上。
 * 这里把它们绑成一个动作，顺带把产物拷到桌面并打印绝对路径。
 *
 * 用法：
 *   pnpm release              # 升补丁号  0.1.0 -> 0.1.1
 *   pnpm release minor        # 升次版本  0.1.1 -> 0.2.0
 *   pnpm release major        # 升主版本  0.2.0 -> 1.0.0
 *   pnpm release patch 0.3.0  # 直接指定
 *   pnpm release --no-build   # 只升版本号，不编译
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, copyFileSync, rmSync, mkdirSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')
const write = (p, s) => writeFileSync(join(root, p), s)

// 仓库根 .env 里的凭据（已在 .gitignore）：跑命令时自动带上，不用每次 export
{
  const f = join(root, '.env')
  if (existsSync(f)) {
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_]+)\s*=\s*(.*)\s*$/)
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
      }
    }
  }
}

const argv = process.argv.slice(2)
const noBuild = argv.includes('--no-build')
const level = argv.find((a) => ['patch', 'minor', 'major'].includes(a)) ?? 'patch'
const explicit = argv.find((a) => /^\d+\.\d+\.\d+$/.test(a))

if (!/^\d+\.\d+\.\d+$/.test(read('package.json').match(/"version":\s*"([^"]+)"/)[1])) {
  console.error('✗ package.json 的版本号不是三段式')
  process.exit(1)
}

const current = read('package.json').match(/"version":\s*"([^"]+)"/)[1]

/** 算出下一个版本号。三处文件永远一起改，不给"只改一个"留机会。 */
function nextVersion() {
  if (explicit) return explicit
  let [maj, min, pat] = current.split('.').map(Number)
  if (level === 'major') return `${maj + 1}.0.0`
  if (level === 'minor') return `${maj}.${min + 1}.0`
  return `${maj}.${min}.${pat + 1}`
}

const version = nextVersion()

// —— 1. 同步三个文件的版本号 ——
write('package.json', read('package.json').replace(/"version":\s*"[^"]+"/, `"version": "${version}"`))

// Cargo.toml 里 package 段和 [lib] 段各有一个键位，只动 [package] 下第一个 version
const cargo = read('src-tauri/Cargo.toml')
const pkgStart = cargo.indexOf('[package]')
const before = cargo.slice(0, pkgStart)
const after = cargo.slice(pkgStart).replace(/^version = "[^"]+"/m, `version = "${version}"`)
write('src-tauri/Cargo.toml', before + after)

write('src-tauri/tauri.conf.json', read('src-tauri/tauri.conf.json').replace(/"version":\s*"[^"]+"/, `"version": "${version}"`))

console.log(`\n  版本号  ${current}  →  ${version}   (package.json / Cargo.toml / tauri.conf.json)\n`)

if (noBuild) {
  console.log('  --no-build：只升了版本号，没有编译。\n')
  process.exit(0)
}

// —— 2. 把 SDK 同步进各个轻应用 ——
/**
 * 轻应用页面跑在 opaque origin 里，拿不到宿主的 Tauri IPC，所以 SDK 必须
 * 作为**本地文件**跟着插件走。规范说插件作者不需要构建步骤，那是发布
 * `@knockbox/plugin-sdk` 之后的事；在那之前这几个内置/示例应用都靠这里同步。
 */
function syncSdk() {
  const out = join(tmpdir(), 'knockbox-sdk-build')
  rmSync(out, { recursive: true, force: true })
  execFileSync(join(root, 'node_modules/.bin/tsc'), [
    'src/sdk/index.ts',
    '--outDir', out,
    '--module', 'es2020',
    '--target', 'es2022',
    '--moduleResolution', 'bundler',
    '--lib', 'es2022,dom',
    '--skipLibCheck',
  ], { cwd: root, stdio: 'inherit' })

  const built = join(out, 'index.js')
  if (!existsSync(built)) throw new Error('SDK 编译产物不存在')

  const targets = [join(root, 'examples/hello')]
  const builtins = join(root, 'src-tauri/builtins')
  if (existsSync(builtins)) {
    for (const id of readdirSync(builtins)) targets.push(join(builtins, id))
  }

  let n = 0
  for (const dir of targets) {
    if (!existsSync(join(dir, 'plugin.json'))) continue // 不是插件目录，跳过
    copyFileSync(built, join(dir, 'sdk.js'))
    n++
  }
  console.log(`  SDK 已同步到 ${n} 个轻应用\n`)
}

// —— 3. 编译 ——
// cargo 不在默认 PATH 里，不 export 就会报 "failed to run 'cargo metadata'"。
// 自更新签名：tauri build 只认 TAURI_SIGNING_PRIVATE_KEY（可以是私钥路径），
// 不会去 ~/.tauri 自动找 —— 不显式指给它就会报 "no private key"。
syncSdk()
execFileSync('pnpm', ['tauri', 'build'], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    PATH: `${join(homedir(), '.cargo', 'bin')}:${process.env.PATH}`,
    TAURI_SIGNING_PRIVATE_KEY:
      process.env.TAURI_SIGNING_PRIVATE_KEY ?? join(homedir(), '.tauri', 'knockbox.key'),
    // 密钥是空密码加密的（--ci 生成时没设密码）：不传这个环境变量，
    // tauri build 会停在 "Password:" 提示上 —— 非交互打包不能等输入
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '',
  },
})

// —— 3. 把产物端到桌面，省得每次去 target/release/bundle 里翻 ——
const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
const app = join(root, 'src-tauri/target/release/bundle/macos/Knockbox.app')
const dmg = join(root, `src-tauri/target/release/bundle/dmg/Knockbox_${version}_${arch}.dmg`)
const desktop = join(homedir(), 'Desktop')

mkdirSync(desktop, { recursive: true })
const destApp = join(desktop, 'Knockbox.app')
const destDmg = join(desktop, `Knockbox_${version}_${arch}.dmg`)

if (existsSync(app)) {
  rmSync(destApp, { recursive: true, force: true })
  execFileSync('cp', ['-R', app, destApp])
}
if (existsSync(dmg)) copyFileSync(dmg, destDmg)

const size = (p) => existsSync(p) ? `${(readFileSync(p).length / 1024 / 1024).toFixed(1)} MB` : '（没产出）'

console.log(`\n  ✓ v${version} 已完成\n`)
console.log(`    安装包  ${destDmg}`)
console.log(`              ${size(destDmg)}`)
console.log(`    应用    ${destApp}`)
console.log(`              ${size(join(destApp, 'Contents/MacOS/knockbox'))}\n`)
console.log('    提醒：单例插件会让新包复用已运行的旧实例，换版本前请先从托盘退出旧的。\n')
