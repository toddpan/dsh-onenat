#!/usr/bin/env node
/**
 * 没有 DSH 源码 checkout 时的**本地类型检查替代方案**。
 *
 * 背景：`scripts/build.sh` 需要 `DSH_CHECKOUT`（一个含 `packages/` 的 DSH 源码树），
 * 从里面链接 `@deepseek-ai/dsh-*` 与 `vendor/cordis`。本机若没有这份 checkout，
 * 就只能从 npm 上取**已发布**的同版本包来还原类型环境。
 *
 * 两个关键点（不做就会报出一堆假错误）：
 *
 * 1. **版本要对齐运行时**。npm 的 `latest` dist-tag 指向 `0.0.1-rc.*`，
 *    而实际运行时是 0.2.x。旧版 `@deepseek-ai/dsh-agent` 的 Events 里
 *    没有 `'agent/pre-step'`，`@deepseek-ai/dsh-tools` 也没有给 Context 挂 `tools`，
 *    于是 `src/prestep.ts` / `src/tools.ts` 会报「属性不存在」——那是版本漂移，不是代码问题。
 *
 * 2. **`cordis` 必须是 `@deepseek-ai/cordis` 的符号链接**。两个包的 dsh-tools 用
 *    `declare module '@deepseek-ai/cordis'` 做 Context 增强；插件侧却 `import ... from 'cordis'`。
 *    TypeScript 按**解析后的真实路径**判定模块同一性，所以只有让 `node_modules/cordis`
 *    指向 `node_modules/@deepseek-ai/cordis`，增强才会落到插件用的那个 Context 上。
 *    （真实 checkout 里 `vendor/cordis` 同时被这两个包名引用，效果相同。）
 *
 * 用法：
 *   node scripts/link-published-deps.mjs          # 装依赖 + 建链接
 *   node scripts/link-published-deps.mjs --check  # 只校验，不改动
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 与运行时对齐的 DSH 包版本（0.2.x 是当前 profile 里的运行时大版本） */
const DSH_VERSION = '0.2.2-rc.1'
const DSH_PACKAGES = [
  'dsh-agent',
  'dsh-tools',
  'dsh-host-webserver',
  'dsh-client-ui-slots',
  'dsh-llm',
]
/** 浏览器半边的类型来源；真实构建从 checkout 的 apps/web 取 */
const CLIENT_TYPES = ['react', 'react-dom', '@types/react', '@types/react-dom']

function run(cmd, args) {
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit' })
}

function linkCordis() {
  const link = join(root, 'node_modules', 'cordis')
  const target = join(root, 'node_modules', '@deepseek-ai', 'cordis')
  if (!existsSync(target)) throw new Error(`缺少 ${target}：先安装 @deepseek-ai/cordis`)
  if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) {
    const stat = lstatSync(link, { throwIfNoEntry: false })
    if (stat?.isSymbolicLink() && resolve(root, 'node_modules', readlinkSync(link)) === target) {
      console.log('cordis 链接已就绪')
      return
    }
    rmSync(link, { recursive: true, force: true })
  }
  symlinkSync(target, link, 'dir')
  console.log(`cordis -> @deepseek-ai/cordis（让 dsh-tools 的 Context 增强落到插件用的 Context 上）`)
}

function main() {
  const checkOnly = process.argv.includes('--check')
  if (checkOnly) {
    const link = join(root, 'node_modules', 'cordis')
    const ok = existsSync(link) && lstatSync(link).isSymbolicLink()
    console.log(ok ? 'cordis 链接已就绪' : 'cordis 链接缺失：请先跑 node scripts/link-published-deps.mjs')
    process.exit(ok ? 0 : 1)
  }

  // 必须**一次** npm install：分开跑时后一次会把前一次 --no-save 装的包从
  // node_modules 里清掉（npm 会按 package.json + 本次参数重新收敛整棵树），
  // 表现是「刚装好的 react 类型又没了」或者「DSH 包退回到 latest 的 0.0.1-rc」。
  run('npm', ['install', '--no-save', '--no-audit', '--no-fund',
    ...CLIENT_TYPES,
    ...DSH_PACKAGES.map((p) => `@deepseek-ai/${p}@${DSH_VERSION}`),
    '@deepseek-ai/schemastery@^3.18.0',
  ])
  linkCordis()
  console.log(`完成：DSH 包已对齐到 ${DSH_VERSION}，cordis 链接已建立。现在可以跑 npx tsc -p tsconfig.json --noEmit`)
}

main()
