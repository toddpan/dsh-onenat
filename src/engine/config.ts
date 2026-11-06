/**
 * 运行时客户端配置的读写。
 *
 * 配置内容来自 oneNat 服务端的 `GET /api/deploy?id=<TUNNEL_ID>&key=<KEY>`，
 * 服务端直接返回一段托管模式（managed）的 YAML，**原样落盘**即可 —— 客户端
 * 自己会解析它，我们不重新生成、不改字段名、不加自己的东西。
 *
 * 这段 YAML 里有 `auth_token`，它是隧道密钥。所以：
 *
 *  1. 文件权限必须是 **0600**（只有属主可读写）。写完之后再显式 `chmod`
 *     一次：`writeFileSync` 的 `mode` 会被 umask 掩掉，显式 chmod 才能保证
 *     "至少不更宽"。
 *  2. **明文绝不进日志、绝不进 `store.json`、绝不进任何返回值。** UI 只能看
 *     到掩码（`ngk-****abcd`）。这条约束落在 `maskSecret` 这一个函数上：
 *     所有会碰到配置文本的出口都先过它。
 *
 * 配置里其它几个字段（`server_addr` / `tunnel_id` / `inspect_addr`）都不是
 * 密钥，可以原样显示。
 */

import { existsSync, readFileSync } from 'node:fs'
import { chmod } from 'node:fs/promises'

import { clientConfigPath, SECRET_FILE_MODE, writeFileAtomic } from './paths.js'

/** 一行 YAML 键值对。 */
export interface ConfigField {
  key: string
  value: string
}

/**
 * 把一行 `key: value` 拆开。
 *
 * 只处理"平坦标量"这种形态 —— 服务端给的配置就是这种（`key: value`，值里
 * 没有换行）。不做通用 YAML 解析：一来没有依赖，二来通用解析器容易在
 * "值以 `#` 开头"这种细节上和 Go 的 `gopkg.in/yaml.v1` 产生分歧，而客户端
 * 读的是 Go 的解析结果 —— **我们读到的必须和客户端读到的一致**，所以这里
 * 刻意用和 Go YAML 一致的朴素规则（`#` 只有在前导空白之后才算注释）。
 */
export function parseConfigLines(yaml: string): ConfigField[] {
  const fields: ConfigField[] = []
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (match === null) continue
    const value = match[2].trim()
    // 去掉行尾注释（仅当 `#` 前有空白时才算注释，与 YAML 规则一致）。
    const commentAt = findCommentStart(value)
    fields.push({ key: match[1], value: commentAt === -1 ? value : value.slice(0, commentAt).trim() })
  }
  return fields
}

/** 找到行尾注释的起始位置（`#` 前必须是空白或行首），找不到返回 -1。 */
function findCommentStart(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '#') continue
    if (index === 0) return 0
    if (value[index - 1] === ' ' || value[index - 1] === '\t') return index
  }
  return -1
}

/** 取某个键的值（大小写不敏感）；没有则返回 undefined。 */
export function configValue(yaml: string, key: string): string | undefined {
  const wanted = key.toLowerCase()
  for (const field of parseConfigLines(yaml)) {
    if (field.key.toLowerCase() === wanted) return field.value
  }
  return undefined
}

/** 从配置里解析隧道 ID（宿主侧据此向 oneNat 查在线状态）。 */
export function parseTunnelId(yaml: string): string | undefined {
  const value = configValue(yaml, 'tunnel_id')
  if (value === undefined || value === '') return undefined
  return value
}

/**
 * 从配置里解析 auth_token。
 *
 * **仅供内部判断"配置是否完整"，不要把返回值写进日志或返回值。**
 */
export function parseAuthToken(yaml: string): string | undefined {
  const value = configValue(yaml, 'auth_token')
  if (value === undefined || value === '') return undefined
  return value
}

/**
 * 判断一段 YAML 是否具备托管模式必须的字段。
 *
 * 客户端在 `managed` 模式下会自己校验：`server_addr` 与 `auth_token` 缺一
 * 就直接退出（`managed 模式配置必须包含 server_addr 与 auth_token`）。我们
 * 在落盘之前先判一遍，好过"配置写进去了、客户端起来就死"。
 */
export function hasManagedFields(yaml: string): boolean {
  return (configValue(yaml, 'server_addr') ?? '') !== '' && (configValue(yaml, 'auth_token') ?? '') !== ''
}

/**
 * 把密钥掩码成可以安全显示的样子。
 *
 * 形如 `ngk-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxx` → `ngk-****abcd`：保留前缀
 * （便于用户确认"这是哪个 KEY"）与末 4 位（便于和 oneNat 后台对照），中间的
 * 一律打码。
 */
export function maskToken(value: string): string {
  const token = value.trim()
  if (token === '') return ''
  if (token.length <= 8) return '****'
  const dash = token.indexOf('-')
  // 前缀取到第一个短横线为止（`ngk-`），最多 8 个字符。
  const prefix = dash > 0 && dash <= 8 ? token.slice(0, dash + 1) : token.slice(0, 4)
  return `${prefix}****${token.slice(-4)}`
}

/** 会被当成密钥、必须打码的字段名（大小写不敏感，命中即打码）。 */
const SECRET_KEY_PATTERN = /(token|key|secret|password|passwd|pwd)/i

/**
 * 把一段配置里的所有密钥字段换成掩码。
 *
 * **所有会碰到配置文本的出口都要先过这个函数**：日志、UI、错误信息。
 * 没有第二处可以绕过它 —— 这就是"密钥绝不外泄"这条约束的落点。
 */
export function maskSecret(yaml: string): string {
  const lines = yaml.split(/\r?\n/)
  const out = lines.map((line) => {
    const match = /^(\s*)([A-Za-z0-9_.-]+)(\s*:\s*)(.*)$/.exec(line)
    if (match === null) return line
    const key = match[2]
    const value = match[4]
    if (!SECRET_KEY_PATTERN.test(key)) return line
    if (value.trim() === '') return line
    return `${match[1]}${key}${match[3]}${maskToken(value.trim())}`
  })
  return out.join('\n')
}

/**
 * 给 UI 回调用的**一句话**摘要：`server_addr=… · tunnel_id=… · auth_token=ngk-****cdef`。
 *
 * 为什么不把整段（已打码的）YAML 回给前端：托管配置里的密钥字段会随服务端
 * 版本变化增减，只靠正则打码是"默认信任白名单"；而 UI 其实只需要确认
 * 「是哪条隧道、连哪个地址」，用摘要就把暴露面压到最小。
 */
export function summariseConfig(yaml: string): string {
  const parts: string[] = []
  for (const key of ['server_addr', 'tunnel_id']) {
    const value = configValue(yaml, key)
    if (value !== undefined && value !== '') parts.push(`${key}=${value}`)
  }
  const token = parseAuthToken(yaml)
  if (token !== undefined && token !== '') parts.push(`auth_token=${maskToken(token)}`)
  return parts.join(' · ')
}

/** 写客户端配置（0600，原子）。 */
export async function writeClientConfig(yaml: string, root: string): Promise<{ path: string; masked: string }> {
  const path = clientConfigPath(root)
  writeFileAtomic(path, yaml.endsWith('\n') ? yaml : `${yaml}\n`, SECRET_FILE_MODE)
  // writeFileSync 的 mode 会被 umask 掩掉，显式 chmod 一次保证"不宽于 0600"。
  try {
    await chmod(path, SECRET_FILE_MODE)
  } catch {
    /* Windows 上 chmod 语义有限，失败不致命 */
  }
  return { path, masked: summariseConfig(yaml) }
}

/**
 * 读客户端配置。
 *
 * 没有配置文件时返回 null（"尚未配置"是一个正常状态，不是错误）。
 */
export function readClientConfig(root: string): string | null {
  const path = clientConfigPath(root)
  if (!existsSync(path)) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 配置文件是否存在（不读内容，状态查询用）。 */
export function clientConfigExists(root: string): boolean {
  return existsSync(clientConfigPath(root))
}
