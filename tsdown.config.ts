import { readFileSync } from 'node:fs'
import type { UserConfig } from 'tsdown'

const readRepoFile = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')

/**
 * 浏览器 bundle 在启动图里的身份。它必须与 package.json 的 name 逐字相同：
 * DSH 的 client-modules 用 Loader 行里的 specifier 解析包，并要求 package.json
 * 的 name 与之完全相等，相等才生成启动图行（行 id 即包名）；bundle 里的
 * factory 又必须用同一个 id 注册自己。写死字符串时改包名极易漏改其中一处，
 * 后果是 host 半边照常工作、设置页却静默不出现。
 */
const PLUGIN_ID = JSON.parse(readRepoFile('./package.json')).name as string

// cordis.patch.yml 插入的 Loader 行 name 是同一身份的第二份副本，构建时校验。
{
  const patch = readRepoFile('./cordis.patch.yml')
  const rowName = /^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/m.exec(patch)?.[1]
  if (rowName !== PLUGIN_ID) {
    throw new Error(
      `package name "${PLUGIN_ID}" 与 cordis.patch.yml 里的 Loader 行 name "${rowName}" 不一致。`
      + ' 两者必须逐字相同，否则浏览器半边不会被加载。',
    )
  }
}

// 平台种子词（apps/web seed.ts 的静态模块表）：只有这些能作为外部依赖由 require 提供。
// 注意：动态 Cordis Package 专有的 `styles` / `host` / `harness` **不是** bundle 插件可用的全局。
const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

const clientBundle: UserConfig = {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [clientBundle] satisfies UserConfig[]
