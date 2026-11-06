/**
 * 发行版解析：运行时查 GitHub Releases，失败回落构建期烘焙的清单。
 *
 * 为什么运行时还要联网查：构建期烘焙的清单是**快照**。oneNat 客户端更新
 * 频率不低（上游按 `r2026.09.07` 这种日期版本发版），一份几个月前的快照
 * 会让用户永远装不上最新版。所以运行时以 GitHub API 为准，烘焙清单只做
 * 离线兜底（内网、无外网、GitHub 被限流时仍能装上"当时已知的那一版"）。
 *
 * 为什么"绝不构造下载 URL"：上游的资产名换过好几套写法，靠字符串拼 URL
 * 的代码会在某些版本上"下载成功但下到的是 404 页面"或者更糟——下到另一个
 * 平台的资产。所以**资产 URL 一律来自 GitHub API 返回的 `browser_download_url`**
 * （或构建期清单里烘焙好的同一个字段），本文件只做"读 + 匹配"，不造 URL。
 *
 * 为什么必须缓存：GitHub 未认证 API 是 **60 次/小时/IP**。而设置页会轮询
 * 状态、每次"安装"都要解析一次发行版 —— 不缓存的话，用户点几次安装就把
 * 额度耗光，之后连"看最新版本"都做不了。所以元数据落盘缓存（TTL 6 小时）。
 *
 * 缓存的是**发行版元数据**（资产列表 + checksums），不是下载好的资产文件。
 * 资产文件的缓存是另一回事（见 `install.ts`），因为它要按 sha256 校验。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { fetchText } from './download.js'
import { assetKindForFile, assetNamesForTag, detectPlatformTag, platformTagForAssetFile, type AssetKind, type PlatformTag } from './platform.js'
import { cacheDir, ensureDir, readJson, writeJsonAtomic } from './paths.js'

/** oneNat 客户端的默认发布仓库。 */
export const DEFAULT_CLIENT_REPO = 'toddpan/onenat'

/** 构建期烘焙清单的相对路径。 */
export const BAKED_MANIFEST_RELATIVE = join('manifest', 'client-manifest.json')

/** GitHub 发行版元数据缓存的 TTL：6 小时。 */
export const RELEASE_CACHE_TTL_MS = 6 * 60 * 60 * 1000

/** GitHub API 主机。 */
const GITHUB_API = 'https://api.github.com'

/**
 * GitHub API 的可选认证头。
 *
 * 未认证额度是 **60 次/小时/IP**；打满就 403，插件会以为"没有发行版"而安装失败。
 * 只读环境变量，**不去调 `gh auth token`** —— 运行时不该为了发一个 HTTP 请求
 * 去 exec 一个外部命令。有 token 就用，没有就匿名（同时走 6 小时磁盘缓存兜住频率）。
 */
function githubAuthHeaders(): Record<string, string> | undefined {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token === undefined || token.trim() === '') return undefined
  return { authorization: `Bearer ${token.trim()}` }
}

/** 发行版资产。 */
export interface ReleaseAsset {
  /** 资产文件名（与上游 release 里的名字完全一致）。 */
  file: string
  /** 下载地址。**永远来自上游元数据，不构造。** */
  url: string
  /** 上游 `checksums.txt` 里的 sha256；上游没给就是 null。 */
  sha256: string | null
  /** 资产形态。 */
  kind: AssetKind
  /** 资产字节数（上游给的时候才有）。 */
  size: number | null
}

/** 一次安装要用的发行版计划。 */
export interface ReleasePlan {
  repo: string
  /** 上游 release tag（如 `r2026.09.07`）。 */
  tag: string
  /** 版本目录名（等于 tag 的安全化形式）。 */
  version: string
  asset: ReleaseAsset
  /** 计划来源：GitHub 实时解析 还是 构建期烘焙。 */
  source: 'github' | 'baked'
}

/** 构建期烘焙清单。 */
export interface BakedClientManifest {
  repo: string
  tag: string
  generatedAt: string
  /** 平台标签 → 资产。方便人看与工具消费。 */
  platforms: Record<string, { file: string; url: string; sha256: string | null; kind: AssetKind }>
  /**
   * 扁平资产列表。
   *
   * 运行时**只按资产文件名**挑资产（和 GitHub 路径完全同一套规则），
   * `platforms` 只是给人看的；保留两份是为了"同一份文件既能被人读、又能被
   * 机器用同一套规则处理"。
   */
  assets?: Array<{ file: string; url: string; sha256: string | null; kind: AssetKind; platform?: string }>
}

/** 落盘的发行版缓存。 */
interface CachedRelease {
  repo: string
  fetchedAt: number
  tag: string
  assets: Array<{ name: string; url: string; size: number | null }>
  checksums: Record<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 插件包根目录（含 `package.json` 的那一层）。
 *
 * 从本文件所在目录**向上找**而不是写死层数：源码里是 `src/engine/`，
 * 编译产物里是 `lib/engine/`，两者的上两层刚好都是包根，但写死层数的话
 * 以后多一层构建目录就会静默读错文件 —— 那种 bug 只在"打包后清单读不到"
 * 时才显形，非常难查。
 */
export function packageRoot(): string {
  let dir = resolve(fileURLToPath(new URL('.', import.meta.url)))
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  // 兜底：即便找不到 package.json，也给一个"当前目录上两层"的合理猜测。
  return resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
}

/** 构建期清单的绝对路径。 */
export function bakedManifestPath(): string {
  return join(packageRoot(), BAKED_MANIFEST_RELATIVE)
}

/**
 * 读取构建期烘焙清单。
 *
 * 读不到/坏了都返回 null（而不是抛异常）：它是**兜底**，兜底本身出问题不该
 * 把"走 GitHub 实时解析"这条主路径一起带崩。
 */
export function loadClientManifest(): BakedClientManifest | null {
  const file = bakedManifestPath()
  try {
    if (!existsSync(file)) return null
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isRecord(parsed)) return null
    const repo = typeof parsed.repo === 'string' && parsed.repo !== '' ? parsed.repo : DEFAULT_CLIENT_REPO
    const tag = typeof parsed.tag === 'string' ? parsed.tag : ''
    const generatedAt = typeof parsed.generatedAt === 'string' ? parsed.generatedAt : ''
    const platforms: BakedClientManifest['platforms'] = {}
    if (isRecord(parsed.platforms)) {
      for (const [key, value] of Object.entries(parsed.platforms)) {
        if (!isRecord(value)) continue
        const fileName = typeof value.file === 'string' ? value.file : ''
        const url = typeof value.url === 'string' ? value.url : ''
        if (fileName === '' || url === '') continue
        platforms[key] = {
          file: fileName,
          url,
          sha256: typeof value.sha256 === 'string' ? value.sha256.toLowerCase() : null,
          kind: valueKind(typeof value.kind === 'string' ? value.kind : '') ?? assetKindForFile(fileName) ?? 'binary',
        }
      }
    }
    const assets: NonNullable<BakedClientManifest['assets']> = []
    if (Array.isArray(parsed.assets)) {
      for (const item of parsed.assets) {
        if (!isRecord(item)) continue
        const fileName = typeof item.file === 'string' ? item.file : ''
        const url = typeof item.url === 'string' ? item.url : ''
        if (fileName === '' || url === '') continue
        assets.push({
          file: fileName,
          url,
          sha256: typeof item.sha256 === 'string' ? item.sha256.toLowerCase() : null,
          kind: valueKind(typeof item.kind === 'string' ? item.kind : '') ?? assetKindForFile(fileName) ?? 'binary',
          platform: typeof item.platform === 'string' ? item.platform : (platformTagForAssetFile(fileName) ?? undefined),
        })
      }
    }
    return { repo, tag, generatedAt, platforms, assets }
  } catch {
    return null
  }
}

function valueKind(value: string): AssetKind | null {
  if (value === 'binary' || value === 'tar.gz' || value === 'zip') return value
  return null
}

/**
 * 解析上游 `checksums.txt`。
 *
 * 格式是 GNU coreutils 的默认文本模式输出：`<hex>  <文件名>`（**两个**空格）。
 * 也兼容 `sha256sum -b` 的二进制模式（`<hex> *<文件名>`）与单空格。
 * 认不出来的行直接跳过 —— 校验文件里混进注释行是正常的。
 */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^([0-9a-fA-F]{64})[ \t]+\*?(.+)$/.exec(line)
    if (match === null) continue
    const name = match[2].trim()
    if (name === '') continue
    out.set(name, match[1].toLowerCase())
  }
  return out
}

/** GitHub release 的资产。 */
interface GithubAsset {
  name: string
  url: string
  size: number | null
}

/** GitHub release 的元数据。 */
interface GithubRelease {
  tag: string
  assets: GithubAsset[]
}

/**
 * 解析 GitHub Releases API 的响应。
 *
 * 全部字段都按"可能缺失"处理：GitHub 会给 `draft`/`prerelease` 的 release
 * 返回不同的字段集，一个字段的缺失不该让整次解析崩掉。
 */
export function parseGithubRelease(payload: unknown): GithubRelease {
  if (!isRecord(payload)) throw new Error('GitHub Release 响应不是 JSON 对象')
  const tag = typeof payload.tag_name === 'string' ? payload.tag_name : ''
  if (tag === '') throw new Error('GitHub Release 响应缺少 tag_name')
  const assets: GithubAsset[] = []
  if (Array.isArray(payload.assets)) {
    for (const item of payload.assets) {
      if (!isRecord(item)) continue
      const name = typeof item.name === 'string' ? item.name : ''
      const url = typeof item.browser_download_url === 'string' ? item.browser_download_url : ''
      if (name === '' || url === '') continue
      assets.push({ name, url, size: typeof item.size === 'number' ? item.size : null })
    }
  }
  return { tag, assets }
}

/**
 * 从资产列表里挑出该平台的那一份。
 *
 * 挑选规则来自 `platform.ts` 的 `assetNamesForTag` —— **与构建期清单同一套
 * 规则**。这是"清单判定与运行时选资产同源"那条铁律的落点。
 */
export function pickAssetForTag(
  assets: Array<{ file: string; url: string; size?: number | null }>,
  tag: PlatformTag,
  checksums: Map<string, string>,
): ReleaseAsset | null {
  for (const candidate of assetNamesForTag(tag)) {
    const hit = assets.find((asset) => asset.file === candidate)
    if (hit === undefined) continue
    return {
      file: hit.file,
      url: hit.url,
      sha256: checksums.get(hit.file) ?? null,
      kind: assetKindForFile(hit.file) ?? 'binary',
      size: hit.size ?? null,
    }
  }
  return null
}

/** 缓存文件名：把 `owner/repo` 变成安全的文件名。 */
function cacheFileName(repo: string): string {
  return `release-${repo.replace(/[^0-9A-Za-z._-]/g, '_')}.json`
}

/** 读取落盘缓存；过期或损坏都返回 null。 */
function readReleaseCache(root: string, repo: string, now: number, ttlMs: number): CachedRelease | null {
  const file = join(ensureDir(cacheDir(root)), cacheFileName(repo))
  const cached = readJson<CachedRelease | null>(file, null)
  if (cached === null) return null
  if (cached.repo !== repo) return null
  if (!Array.isArray(cached.assets)) return null
  if (now - cached.fetchedAt > ttlMs) return null
  return cached
}

function writeReleaseCache(root: string, cached: CachedRelease): void {
  const file = join(ensureDir(cacheDir(root)), cacheFileName(cached.repo))
  writeJsonAtomic(file, cached)
}

/**
 * 取发行版元数据：先看缓存，再问 GitHub。
 *
 * 返回 null 表示"拿不到"（网络失败、限流、release 不存在），调用方决定
 * 回落还是报错。
 */
async function fetchRelease(options: {
  repo: string
  tag?: string | undefined
  root: string
  signal: AbortSignal | undefined
  now: number
  ttlMs: number
  forceRefresh: boolean
}): Promise<CachedRelease | null> {
  if (!options.forceRefresh) {
    const cached = readReleaseCache(options.root, options.repo, options.now, options.ttlMs)
    if (cached !== null) return cached
  }

  const apiPath = options.tag === undefined
    ? `${GITHUB_API}/repos/${options.repo}/releases/latest`
    : `${GITHUB_API}/repos/${options.repo}/releases/tags/${encodeURIComponent(options.tag)}`

  const body = await fetchText(apiPath, {
    signal: options.signal,
    accept: 'application/vnd.github+json',
    timeoutMs: 15_000,
    headers: githubAuthHeaders(),
  })
  const release = parseGithubRelease(JSON.parse(body) as unknown)

  // checksums.txt 与资产在同一个 release 里，单独再下一份即可拿到每个资产的 sha256。
  let checksums = new Map<string, string>()
  const checksumAsset = release.assets.find((asset) => asset.name.toLowerCase() === 'checksums.txt')
  if (checksumAsset !== undefined) {
    const text = await fetchText(checksumAsset.url, { signal: options.signal, timeoutMs: 15_000 })
    checksums = parseChecksums(text)
  }

  const cached: CachedRelease = {
    repo: options.repo,
    fetchedAt: options.now,
    tag: release.tag,
    assets: release.assets.map((asset) => ({ name: asset.name, url: asset.url, size: asset.size })),
    checksums: Object.fromEntries(checksums),
  }
  try {
    writeReleaseCache(options.root, cached)
  } catch {
    /* 缓存写不进去不影响本次安装 */
  }
  return cached
}

/** 解析发行版计划。 */
export interface ResolveReleasePlanOptions {
  /** GitHub 仓库（`owner/repo`），默认 `toddpan/onenat`。 */
  repo?: string
  /** 指定 release tag；不给就是 latest。 */
  tag?: string
  /** 目标平台；默认按当前进程推断。 */
  platform?: PlatformTag | null
  /** 是否允许联网（false = 只用构建期清单）。 */
  allowNetwork?: boolean
  /** 取消信号。 */
  signal?: AbortSignal
  /** 引擎根目录（缓存落盘位置）。 */
  root?: string
  /** 强制绕过缓存重新拉发行版。 */
  forceRefresh?: boolean
  /** 缓存 TTL（毫秒）。 */
  ttlMs?: number
  /** 当前时间（测试注入）。 */
  now?: number
}

/**
 * 解析出"这次要装哪个文件"。
 *
 * 顺序：**GitHub 实时 → 构建期烘焙**。实时拿不到（离线 / 限流 / 该 tag 不
 * 存在）就回落烘焙清单；两边都没有才报错，并且错误信息里把两个原因都说清楚
 * —— 只说"安装失败"的话，用户根本不知道该检查网络还是该升级插件。
 */
export async function resolveReleasePlan(options: ResolveReleasePlanOptions = {}): Promise<ReleasePlan> {
  const repo = options.repo !== undefined && options.repo.trim() !== '' ? options.repo.trim() : DEFAULT_CLIENT_REPO
  const platform = options.platform !== undefined ? options.platform : detectPlatformTag()
  if (platform === null || platform === undefined) {
    throw new Error(
      `当前平台（${process.platform}/${process.arch}）没有对应的 oneNat 客户端发行包，` +
        '请在受支持的平台上安装，或手动放置二进制。',
    )
  }

  const root = options.root ?? ''
  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? RELEASE_CACHE_TTL_MS
  const allowNetwork = options.allowNetwork !== false

  const networkErrors: string[] = []
  if (allowNetwork && root !== '') {
    try {
      const cached = await fetchRelease({
        repo,
        tag: options.tag,
        root,
        signal: options.signal,
        now,
        ttlMs,
        forceRefresh: options.forceRefresh === true,
      })
      if (cached !== null) {
        const asset = pickAssetForTag(
          cached.assets.map((item) => ({ file: item.name, url: item.url, size: item.size })),
          platform,
          new Map(Object.entries(cached.checksums)),
        )
        if (asset !== null) {
          return { repo, tag: cached.tag, version: cached.tag, asset, source: 'github' }
        }
        networkErrors.push(`release ${cached.tag} 里没有 ${platform} 对应的资产`)
      }
    } catch (error) {
      networkErrors.push(describe(error))
    }
  } else if (!allowNetwork) {
    networkErrors.push('本次未允许联网')
  }

  // 回落：构建期烘焙清单。
  const baked = loadClientManifest()
  if (baked !== null) {
    const list = baked.assets !== undefined && baked.assets.length > 0
      ? baked.assets.map((item) => ({ file: item.file, url: item.url, size: null }))
      : Object.entries(baked.platforms).map(([, item]) => ({ file: item.file, url: item.url, size: null }))
    const checksums = new Map<string, string>()
    for (const item of baked.assets ?? []) {
      if (item.sha256 !== null) checksums.set(item.file, item.sha256)
    }
    for (const item of Object.values(baked.platforms)) {
      if (item.sha256 !== null && !checksums.has(item.file)) checksums.set(item.file, item.sha256)
    }
    const asset = pickAssetForTag(list, platform, checksums)
    if (asset !== null) {
      const tag = options.tag !== undefined && options.tag !== '' ? options.tag : baked.tag
      return { repo: baked.repo !== '' ? baked.repo : repo, tag, version: tag, asset, source: 'baked' }
    }
  }

  const detail = networkErrors.length > 0 ? `（${networkErrors.join('；')}）` : ''
  throw new Error(
    `无法解析 ${platform} 对应的 oneNat 客户端发行包${detail}。` +
      '请检查网络，或稍后重试（GitHub 未认证 API 限速 60 次/小时）。',
  )
}

/** 判断构建期清单是否可用（设置页可以据此提示"当前处于离线兜底模式"）。 */
export function bakedManifestAvailable(): boolean {
  const manifest = loadClientManifest()
  return manifest !== null && (manifest.tag !== '' || Object.keys(manifest.platforms).length > 0)
}

/** 构建期清单里烘焙的版本号（没有清单时返回 null）。 */
export function bakedManifestTag(): string | null {
  const manifest = loadClientManifest()
  if (manifest === null || manifest.tag === '') return null
  return manifest.tag
}

/** 供诊断用：构建期清单文件的修改时间（不存在返回 null）。 */
export function bakedManifestMtime(): number | null {
  try {
    return statSync(bakedManifestPath()).mtimeMs
  } catch {
    return null
  }
}
