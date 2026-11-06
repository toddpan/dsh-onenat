/**
 * 校验值计算。
 *
 * 流式算是硬要求，不是风格问题：客户端归档 7–15MB，一次 `readFileSync` 会在
 * DSH 主进程里多出同量级的常驻内存，而且恰好发生在用户点"安装"、桌面最需要
 * 响应的时候。
 *
 * 上游 oneNat 的 `checksums.txt` 用 **sha256**（不是 md5），格式是
 * `<hex>  <文件名>`（两个空格，GNU coreutils 的默认文本模式输出）。
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import type { Hash } from 'node:crypto'

async function digestFile(file: string, algorithm: 'sha256' | 'md5'): Promise<string> {
  const hash: Hash = createHash(algorithm)
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex').toLowerCase()
}

/** 小写 hex 的 sha256（流式）。 */
export function sha256File(file: string): Promise<string> {
  return digestFile(file, 'sha256')
}

/** 小写 hex 的 md5（流式）。oneNat 上游用 sha256，md5 只是兜底能力。 */
export function md5File(file: string): Promise<string> {
  return digestFile(file, 'md5')
}

/** 合法 sha256 的形态：64 位小写 hex。 */
export function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

/** 两个 sha256 是否一致（大小写不敏感）。 */
export function sha256Matches(expected: string, actual: string): boolean {
  return expected.trim().toLowerCase() === actual.trim().toLowerCase()
}

/**
 * 给人看的一句话说明"这次装包会被怎么校验"。
 *
 * 没有可用校验值时必须说清楚 —— 静默地"没校验就装上"是最危险的默认值。
 */
export function describeVerification(expectedSha256: string | null, actualSha256?: string | null): string {
  if (expectedSha256 === null || expectedSha256.trim() === '') {
    return '上游未提供 sha256 校验值，本次仅记录实测值（无法验证完整性）'
  }
  const prefix = `SHA-256（${expectedSha256.slice(0, 12)}…）`
  if (actualSha256 === undefined || actualSha256 === null) return `将使用 ${prefix} 校验`
  return sha256Matches(expectedSha256, actualSha256)
    ? `SHA-256 校验通过（${actualSha256.slice(0, 12)}…）`
    : `SHA-256 校验不通过：期望 ${expectedSha256}，实测 ${actualSha256}`
}
