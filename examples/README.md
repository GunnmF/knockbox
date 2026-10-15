# 示例轻应用

`hello/` 是一个可直接安装的示例插件，用来端到端验证这条链路：

```
安装 → 清单校验 → 落盘 → 唤起 → iframe 加载 → 握手 → setPanel → 权限校验
```

## 安装并试跑

1. 启动 Knockbox（⌘⇧K）
2. 底部点「管理轻应用」
3. 选「从本地目录安装」，挑 `examples/hello/` 这个文件夹
4. 回到主界面，输入 `hi` / `你好` / `hello` —— 关键词命中后「打个招呼」会排在首位
5. 回车唤起，面板里能看到宿主输入框的实时内容；按钮可以试剪贴板、私有存储

## 为什么需要关键词

`plugin.json` 里声明了 `"keywords": ["hi", "hello", "你好", "打招呼"]`。
命中关键词的轻应用在打分时会被直接置顶（权重 1200），这是 `commands/search`
里的规则。想让它只被手动打开，把 `"activation"` 设成 `"manual"`。

## sdk.js 是怎么来的

插件作者用 `npm i @knockbox/plugin-sdk`（还没发布），自己**不需要**构建步骤 ——
规范 §9 承诺的是「原生 ESM + 相对路径 import 即可运行」。

但 `hello/sdk.js` 是我们自己仓库里从 TypeScript 源码同步过来的产物。
SDK 改动后重新生成：

```bash
./node_modules/.bin/tsc src/sdk/index.ts \
  --outDir /tmp/kbsdk \
  --module es2020 --target es2022 --moduleResolution bundler \
  --lib es2022,dom --skipLibCheck
cp /tmp/kbsdk/index.js examples/hello/sdk.js
```

发布 `@knockbox/plugin-sdk` 之后，这一步就可以删掉了。
