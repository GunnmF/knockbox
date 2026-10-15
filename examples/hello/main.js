// 示例轻应用：把宿主输入框的实时内容显示出来，并演示几个需要权限的能力。
//
// 权限来自 plugin.json 的 `permissions` 字段。SDK 会把没声明的能力
// 直接裁掉（kb.clipboard 就是 undefined），所以这里可以放心直接调用 ——
// 真忘了声明权限，console 里会立刻报 TypeError，而不是等运行时才发现。

import { connect } from './sdk.js'

const out = document.getElementById('out')
const log = (msg) => {
  out.textContent = msg
  out.classList.remove('muted')
}

async function main() {
  const kb = await connect()

  kb.setPanel({
    title: '打个招呼 · 轻应用示例',
    height: 220,
    render(container, ctx) {
      const line = document.createElement('div')
      line.className = 'muted'
      container.appendChild(line)

      const paint = (q) => {
        line.textContent = q
          ? `宿主输入框：${q}`
          : '宿主输入框是空的。在 Knockbox 里敲几个字试试。'
      }
      paint(ctx.query)
      ctx.onQueryChange(paint)

      ctx.onSubmit((q) => log(`收到回车：${q}`))

      document.getElementById('copy').onclick = async () => {
        if (!kb.clipboard) return log('未授予 clipboard:write 权限')
        await kb.clipboard.writeText(ctx.query)
        log(`已复制到剪贴板：${ctx.query}`)
      }
      document.getElementById('paste').onclick = async () => {
        if (!kb.clipboard) return log('未授予 clipboard:read 权限')
        log(`剪贴板内容：\n${await kb.clipboard.readText()}`)
      }
      document.getElementById('selection').onclick = async () => {
        if (!kb.system) return log('未授予 system:selection 权限')
        const { text, app } = await kb.system.getSelection()
        log(`前台选中文本（${app || '未知应用'}）：\n${text || '（没有读到，Windows 上暂不支持）'}`)
      }
      document.getElementById('save').onclick = async () => {
        if (!kb.storage) return log('未授予 storage:local 权限')
        await kb.storage.set('last', ctx.query)
        log(`已存：storage.last = ${ctx.query}`)
      }
      document.getElementById('load').onclick = async () => {
        if (!kb.storage) return log('未授予 storage:local 权限')
        log(`storage.last = ${JSON.stringify(await kb.storage.get('last'))}`)
      }
    },
  })
}

main().catch((err) => {
  document.getElementById('out').classList.remove('muted')
  log(`连接宿主失败：${err.code ?? ''} ${err.message}`)
})
