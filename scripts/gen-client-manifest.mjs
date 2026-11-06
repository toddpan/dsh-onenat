#!/usr/bin/env node
/**
 * 构建期脚本：烘焙 `manifest/client-manifest.json`。
 *
 * 烘焙的是**离线兜底**，不是事实来源。运行时优先查 GitHub Releases API
 * （见 `src/engine/manifest.ts`），只有拿不到（内网、限流、离线）才用这份
 * 快照。所以这份文件过期不会让插件坏掉，只会让"离线兜底"装到旧版本。
 *
 * 抓不到时输出一个**空壳**并以非 0 退出码结束：让 build 步骤能提示"清单
 * 没生成"，但不要让整个构建失败 —— 运行时还有 GitHub 这条路可走。
 *
 * 命名规则必须与 `src/engine/platform.ts` 一致（"清单判定与运行时选资产
 * 同源"那条铁律）。那边改资产命名，这边要跟着改；两处都靠 `assetNamesForTag`
 * 的同一套规则挑资产，运行时永远是"按名字匹配"，不按"平台键"匹配。
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const OUTPUT = join(ROOT, 'manifest', 'client-manifest.json')

/** 默认仓库（oneNat 客户端的发布仓库）。 */
const REPO = process.env.ONENAT_REPO ?? 'toddpan/onenat'

/** GitHub API 主机。 */
const GITHUB_API = 'https://api.github.com'

/**
 * 受支持的平台标签 → 资产文件名候选（按偏好顺序）。
 *
 * 与 `src/engine/platform.ts` 的 `assetNamesForTag` 保持一致：
 * ① 裸二进制 `onenat-client_<os>_<arch>`（Windows 带 .exe）
 * ② 归档 `onenat-client-<os>-<arch>.tar.gz`（Windows 是 .zip）
 */
const PLATFORMS = [
  { tag: 'darwin-arm64', names: ['onenat-client_darwin_arm64', 'onenat-client-darwin-arm64.tar.gz'] },
  { tag: 'darwin-amd64', names: ['onenat-client_darwin_amd64', 'onenat-client-darwin-amd64.tar.gz'] },
  { tag: 'linux-arm64', names: ['onenat-client_linux_arm64', 'onenat-client-linux-arm64.tar.gz'] },
  { tag: 'linux-amd64', names: ['onenat-client_linux_amd64', 'onenat-client-linux-amd64.tar.gz'] },
  { tag: 'linux-arm', names: ['onenat-client_linux_arm', 'onenat-client-linux-arm.tar.gz'] },
  { tag: 'windows-arm64', names: ['onenat-client_windows_arm64.exe', 'onenat-client-windows-arm64.zip'] },
  { tag: 'windows-amd64', names: ['onenat-client_windows_amd64.exe', 'onenat-client-windows-amd64.zip'] },
]

/** 资产形态判定（与 `assetKindForFile` 一致）。 */
function assetKind(file) {
  const lower = file.toLowerCase()
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz'
  if (lower.endsWith('.zip')) return 'zip'
  return 'binary'
}

/**
 * 解析上游 `checksums.txt`（sha256，`<hex>  <文件名>`，两个空格）。
 * 兼容 `sha256sum -b` 的二进制模式（`<hex> *<文件名>`）。
 */
function parseChecksums(text) {
  const out = new Map()
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/.exec(line)
    if (match === null) continue
    out.set(match[2].trim(), match[1].toLowerCase())
  }
  return out
}

/**
 * GitHub 认证头。
 *
 * 未认证的 GitHub API 是 **60 次/小时/IP** 的额度，在共享出口 IP（公司网络、
 * CI、咖啡厅）上几乎必然被打满 —— 一打满就是 403，烘焙出来的清单是空壳。
 * 有 token 就用：`GITHUB_TOKEN` / `GH_TOKEN` 环境变量，或者本机 `gh auth token`
 * （开发者机器上通常已经登录，没理由让它降级成匿名请求）。
 */
let cachedToken
function authHeaders() {
  if (cachedToken !== undefined) return cachedToken === null ? {} : { authorization: `Bearer ${cachedToken}` }
  let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  if (token === '') {
    try {
      token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
      token = ''
    }
  }
  cachedToken = token === '' ? null : token
  return cachedToken === null ? {} : { authorization: `Bearer ${cachedToken}` }
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-onenat-manifest', ...authHeaders() },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} (${url})`)
  return res.json()
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { accept: 'text/plain, */*', 'user-agent': 'dsh-onenat-manifest', ...authHeaders() },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} (${url})`)
  return res.text()
}

function emptyManifest(reason) {
  return {
    repo: REPO,
    tag: '',
    generatedAt: new Date().toISOString(),
    error: reason,
    platforms: {},
    assets: [],
  }
}

async function main() {
  // `--tag <t>` 手工指定发行版（草稿 release 不能用 /releases/latest，
  // 也不能用 /releases/tags/<t> —— 后者对草稿返回 404；此时得走
  // `gh api repos/:o/:r/releases` 自己挑，或在公开后直接跑本脚本）。
  const tagIndex = process.argv.indexOf('--tag')
  const explicitTag = tagIndex >= 0 ? process.argv[tagIndex + 1] : undefined
  const url = explicitTag === undefined
    ? `${GITHUB_API}/repos/${REPO}/releases/latest`
    : `${GITHUB_API}/repos/${REPO}/releases/tags/${encodeURIComponent(explicitTag)}`
  let release
  try {
    release = await fetchJson(url)
  } catch (error) {
    const reason = `无法访问 GitHub Releases API：${error instanceof Error ? error.message : String(error)}`
    mkdirSync(dirname(OUTPUT), { recursive: true })
    writeFileSync(OUTPUT, `${JSON.stringify(emptyManifest(reason), null, 2)}\n`, 'utf8')
    console.error(`gen-client-manifest: ${reason}`)
    console.error(`gen-client-manifest: 已写出空壳清单 ${OUTPUT}（运行时会回落 GitHub 实时解析）`)
    process.exitCode = 1
    return
  }

  const tag = typeof release?.tag_name === 'string' ? release.tag_name : ''
  const rawAssets = Array.isArray(release?.assets) ? release.assets : []

  // checksums.txt 与资产在同一个 release 里。
  let checksums = new Map()
  const checksumAsset = rawAssets.find((asset) => String(asset?.name ?? '').toLowerCase() === 'checksums.txt')
  if (checksumAsset?.browser_download_url) {
    try {
      checksums = parseChecksums(await fetchText(checksumAsset.browser_download_url))
    } catch (error) {
      console.error(
        `gen-client-manifest: 拉取 checksums.txt 失败：${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const platforms = {}
  const assets = []
  for (const platform of PLATFORMS) {
    // 按候选名顺序挑：裸二进制优先，其次归档。
    let picked = null
    for (const name of platform.names) {
      const hit = rawAssets.find((asset) => asset?.name === name)
      if (hit) {
        picked = hit
        break
      }
    }
    if (!picked) continue
    const file = picked.name
    const url = picked.browser_download_url
    if (typeof url !== 'string' || url === '') continue
    const sha256 = checksums.get(file) ?? null
    const kind = assetKind(file)
    platforms[platform.tag] = { file, url, sha256, kind }
    assets.push({ file, url, sha256, kind, platform: platform.tag })
  }

  const manifest = {
    repo: REPO,
    tag,
    generatedAt: new Date().toISOString(),
    platforms,
    assets,
  }

  mkdirSync(dirname(OUTPUT), { recursive: true })
  writeFileSync(OUTPUT, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  const covered = Object.keys(platforms).length
  console.log(`gen-client-manifest: ${REPO} ${tag || '(未知 tag)'} → ${OUTPUT}（覆盖 ${covered}/${PLATFORMS.length} 个平台）`)
  if (covered === 0) {
    console.error('gen-client-manifest: 没有任何平台被覆盖，清单不可用')
    process.exitCode = 1
  }
}

await main()
