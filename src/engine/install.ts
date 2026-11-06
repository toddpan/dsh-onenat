/**
 * 安装编排。
 *
 * 顺序是**不可改**的，每一步都为下一步提供前提：
 *
 *   解析发行版 → 下载 → **先校验 sha256** → 解包/落位 → chmod 0755 →
 *   原子就位到 versions/<version>/ → 写 current 指针
 *
 * "先校验后解包"是硬要求：校验必须在**任何字节变成可执行文件之前**完成。
 * 反过来做（先解包再校验）的话，一个被投毒的包已经躺在磁盘上等着被运行了，
 * 校验只是"事后发现"。
 *
 * 幂等：目标版本已经装好且 current 指针指向它时，直接返回成功（除非 force）。
 * 这不是省事，是**必须**：设置页会轮询状态，用户连点两次"安装"是常态，
 * 两次都重新下载 8MB 纯属浪费。
 */

import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { downloadToFile } from './download.js'
import { ensureExecutableMode, extractArchive, findBinaryFile, flattenSingleTopDir, removeQuietly } from './extract.js'
import { resolveReleasePlan } from './manifest.js'
import { binaryFileName, detectPlatformTag, type PlatformTag } from './platform.js'
import {
  cacheDir,
  currentPointerPath,
  ensureDir,
  readCurrentPointer,
  readJson,
  versionBinaryPath,
  versionDir,
  versionMetaPath,
  writeCurrentPointer,
  writeJsonAtomic,
} from './paths.js'
import { sha256File, sha256Matches } from './verify.js'

/** 安装过程的进度。 */
export interface InstallProgress {
  phase: 'resolving' | 'downloading' | 'verifying' | 'extracting' | 'installing'
  message?: string
  percent?: number | null
  bytesDone?: number
  bytesTotal?: number | null
}

/** 安装结果。 */
export interface InstallResult {
  /** 版本目录名（= release tag 的安全化形式）。 */
  version: string
  tag: string
  /** 资产文件名。 */
  assetFile: string
  /** 发行版来源。 */
  source: 'github' | 'baked'
  /** 落位后的二进制路径。 */
  binaryPath: string
  /** 实测 sha256。 */
  sha256: string | null
  /** 是否真的校验过（上游没给校验值时为 false）。 */
  verified: boolean
  /** true = 什么都没做（已经是这个版本了）。 */
  noop: boolean
}

/** 安装选项。 */
export interface InstallOptions {
  /** 引擎根目录。 */
  root: string
  /** GitHub 仓库（默认 `toddpan/onenat`）。 */
  repo?: string
  /** 指定 release tag；不给就是 latest。 */
  version?: string
  /** 强制重装（即使版本相同也重新下载）。 */
  force?: boolean
  /** 是否允许联网解析发行版。 */
  allowNetwork?: boolean
  /** 取消信号。 */
  signal?: AbortSignal
  /** 目标平台；默认按当前进程推断。 */
  platform?: PlatformTag | null
  /** 进度回调。 */
  onProgress?: (progress: InstallProgress) => void
}

/** 每个版本的安装元信息。 */
export interface InstallMeta {
  version: string
  tag: string
  assetFile: string
  source: 'github' | 'baked'
  url: string
  sha256: string | null
  verified: boolean
  installedAt: number
}

/** 安装（或重装）oneNat 客户端。 */
export async function installClient(options: InstallOptions): Promise<InstallResult> {
  const root = options.root
  const platform = options.platform !== undefined ? options.platform : detectPlatformTag()
  if (platform === null || platform === undefined) {
    throw new Error(
      `当前平台（${process.platform}/${process.arch}）没有对应的 oneNat 客户端发行包，无法安装。`,
    )
  }
  const binary = binaryFileName(platform)

  // ── 1. 解析发行版 ────────────────────────────────────────────────
  options.onProgress?.({ phase: 'resolving', message: '正在解析 oneNat 客户端发行版' })
  const plan = await resolveReleasePlan({
    repo: options.repo,
    tag: options.version,
    platform,
    allowNetwork: options.allowNetwork,
    signal: options.signal,
    root,
  })

  // 幂等：版本相同且二进制在位 → 什么都不做。
  const targetDir = versionDir(root, plan.version)
  const targetBinary = versionBinaryPath(root, plan.version, binary)
  const pointer = readCurrentPointer(root)
  if (options.force !== true && pointer === plan.version && await fileExists(targetBinary)) {
    options.onProgress?.({ phase: 'installing', message: `v${plan.version} 已是当前版本` })
    return {
      version: plan.version,
      tag: plan.tag,
      assetFile: plan.asset.file,
      source: plan.source,
      binaryPath: targetBinary,
      sha256: plan.asset.sha256,
      verified: plan.asset.sha256 !== null,
      noop: true,
    }
  }

  // zip 我们解不了，直接在下载之前就说清楚，别让人白等 8MB。
  if (plan.asset.kind === 'zip') {
    throw new Error(
      `上游该平台（${platform}）只发布了 .zip 归档（${plan.asset.file}），` +
        '本插件不引入 zip 解包依赖，无法安装。请在 macOS / Linux 上使用，或手动放置可执行文件。',
    )
  }

  // ── 2. 下载 ─────────────────────────────────────────────────────
  ensureDir(cacheDir(root))
  const cached = join(cacheDir(root), plan.asset.file)
  let sha256: string | null = null
  let verified = false

  const cachedUsable = await fileExists(cached) && plan.asset.sha256 !== null
  if (cachedUsable && options.force !== true) {
    const actual = await sha256File(cached)
    if (sha256Matches(plan.asset.sha256 as string, actual)) {
      sha256 = actual
      verified = true
      options.onProgress?.({ phase: 'downloading', message: `复用缓存 ${plan.asset.file}`, percent: 100 })
    } else {
      // 缓存里的文件对不上：多半是上一次下载被截断。删掉重下。
      await removeQuietly(cached)
    }
  }

  if (!verified) {
    options.onProgress?.({ phase: 'downloading', message: `正在下载 ${plan.asset.file}` })
    const result = await downloadToFile({
      url: plan.asset.url,
      dest: cached,
      signal: options.signal,
      onProgress: (progress) => {
        options.onProgress?.({
          phase: 'downloading',
          percent: progress.bytesTotal !== null && progress.bytesTotal > 0
            ? Math.round((progress.bytesDone / progress.bytesTotal) * 100)
            : null,
          bytesDone: progress.bytesDone,
          bytesTotal: progress.bytesTotal,
        })
      },
    })
    sha256 = result.sha256
  }

  // ── 3. 校验（**在任何字节变成可执行文件之前**）────────────────────
  options.onProgress?.({ phase: 'verifying', message: '正在校验 sha256' })
  if (plan.asset.sha256 === null) {
    // 上游没给校验值：只能记录实测值。要装，但要在日志与元信息里留痕。
    options.onProgress?.({
      phase: 'verifying',
      message: `上游未提供 ${plan.asset.file} 的 sha256，仅记录实测值 ${(sha256 ?? '').slice(0, 12)}…`,
    })
  } else {
    const actual = sha256 ?? (await sha256File(cached))
    sha256 = actual
    if (!sha256Matches(plan.asset.sha256, actual)) {
      // 校验不过：删掉文件，绝不留下"下了一半但看起来完整"的资产。
      await removeQuietly(cached)
      throw new Error(
        `sha256 校验不通过，已删除下载文件：期望 ${plan.asset.sha256}，实测 ${actual}。` +
          '可能是网络被劫持或上游资产被替换，请重试。',
      )
    }
    verified = true
  }

  // ── 4. 解包 / 直接落位 ──────────────────────────────────────────
  options.onProgress?.({ phase: 'extracting', message: '正在解包' })
  const staging = join(versionDir(root, '..'), `.staging-${process.pid}-${randomBytes(4).toString('hex')}`)
  await mkdir(staging, { recursive: true })
  let extractedBinary: string | null = null
  try {
    const result = await extractArchive({
      archive: cached,
      kind: plan.asset.kind,
      destDir: staging,
      onProgress: (progress) => {
        options.onProgress?.({ phase: 'extracting', message: progress.message })
      },
    })
    extractedBinary = result.binaryPath
    // 归档里只有一个顶层目录时上移一层，让两种打包形态在磁盘上一致。
    await flattenSingleTopDir(staging)
    if (extractedBinary === null) {
      extractedBinary = await findBinaryFile(staging)
    }
    if (extractedBinary === null) {
      throw new Error(`归档 ${plan.asset.file} 里没有找到可执行文件`)
    }

    // ── 5. chmod 0755 ────────────────────────────────────────────
    await ensureExecutableMode(extractedBinary)

    // ── 6. 原子就位 ───────────────────────────────────────────────
    options.onProgress?.({ phase: 'installing', message: `正在安装到 ${plan.version}` })
    ensureDir(targetDir)
    const staged = join(targetDir, `.${binary}.staged-${randomBytes(4).toString('hex')}`)
    await copyFile(extractedBinary, staged)
    await ensureExecutableMode(staged)
    // rename 在同一文件系统内是原子的：读者只会看到"旧文件"或"新文件"。
    await rm(targetBinary, { force: true })
    await rename(staged, targetBinary)
  } finally {
    await removeQuietly(staging)
  }

  const meta: InstallMeta = {
    version: plan.version,
    tag: plan.tag,
    assetFile: plan.asset.file,
    source: plan.source,
    url: plan.asset.url,
    sha256,
    verified,
    installedAt: Date.now(),
  }
  writeJsonAtomic(versionMetaPath(root, plan.version), meta)

  // ── 7. 写 current 指针 ───────────────────────────────────────────
  writeCurrentPointer(root, plan.version)

  return {
    version: plan.version,
    tag: plan.tag,
    assetFile: plan.asset.file,
    source: plan.source,
    binaryPath: targetBinary,
    sha256,
    verified,
    noop: false,
  }
}

/** 读取某个版本的安装元信息（没有则 null）。 */
export function readInstallMeta(root: string, version: string): InstallMeta | null {
  return readJson<InstallMeta | null>(versionMetaPath(root, version), null)
}

/** 判断文件是否存在。 */
async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

/** 当前指针指向的版本（宿主侧查询用）。 */
export function currentVersion(root: string): string | null {
  return readCurrentPointer(root)
}

/** 当前指针文件路径（诊断用）。 */
export function pointerPath(root: string): string {
  return currentPointerPath(root)
}
