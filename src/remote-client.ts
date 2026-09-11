/**
 * @dsh-external/onenat-workbuddy - DSH 远程客户端（面向解析后的 ResolvedDshTarget）
 *
 * 相比 dsh-remote-orchestrator 的 RemoteDshClient 升级:
 *  1. 一切调用吃 { baseUrl, apiKey }（由 ResourceDirectory 实时解析而来），不再吃裸 agent（D1）
 *  2. 新增 streamPrompt: 消费远端 /sessions/:id/prompt-stream SSE（delta/reasoning/tool_call/turn_end）
 *     —— fetch 挂 undici dispatcher（bodyTimeout=0）：长工具执行 / 上下文压缩期间无 SSE 帧的静默段
 *        不再触发 undici 默认 300s「chunk 间超时」把连接掐断（长回合 SSE 断流的根因）
 *  3. 保留同步 prompt + waitForSessionResult 轮询兜底（远端不支持 SSE 或流中断时降级，D5）
 *     —— 轮询对账升级：按回合起点重建整轮文本（reconstructTurnFromHistory），不再只取最后一条 assistant 消息
 *  4. 新增 chat: OpenAI 兼容 /chat/completions（LLM Planner 用）
 */

import type { SubtaskLogEntry } from './types.js'

export interface DshTarget {
  baseUrl: string
  apiKey?: string
}

export interface PingResult {
  ok: boolean
  name?: string
  version?: string
  port?: number
  uptime?: number
  providers?: string[]
  error?: string
}

export interface RemoteModelEntry {
  id: string
  provider: string
  name: string
  isDefault?: boolean
  description?: string
  reasoning?: boolean
}

export interface StreamEventHandlers {
  onDelta?: (delta: string) => void
  onReasoning?: (delta: string) => void
  onToolCall?: (info: { id?: string; name?: string; arguments?: any }) => void
  onToolResult?: (info: { id?: string; name?: string; result?: any; isError?: boolean }) => void
  onUsage?: (usage: Record<string, number>) => void
  onLog?: (msg: string, level?: SubtaskLogEntry['level']) => void
}

export interface PromptResult {
  ok: boolean
  content?: string
  reasoning?: string
  error?: string
  timedOut?: boolean
  /** 实际生效的派发通道 */
  via?: 'sse' | 'sync' | 'poll'
  /** SSE 是否收到 turn_end（false = 流提前终结，content 可能不完整，调用方应对账兜底） */
  complete?: boolean
  /** 远端不支持 prompt-stream（旧版）⇒ 调用方降级同步 prompt */
  sseUnsupported?: boolean
  /** 远端返回的真实 token 账本（含缓存命中），供前端展示缓存率 */
  usage?: Record<string, number>
}

function clean(url: string): string {
  return url.replace(/\/+$/, '')
}

/**
 * 长静默 SSE 兜底 dispatcher：长工具执行 / 上下文压缩期间流上没有任何帧，
 * undici 默认 bodyTimeout=300s 会按「chunk 间空闲」掐断连接 → 长回合必断流。
 * bodyTimeout=0 关闭该超时（headersTimeout 保留，防远端彻底失联）。undici 不可用时优雅降级为默认行为。
 */
let longIdleDispatcher: any | null | undefined = null
async function getLongIdleDispatcher(): Promise<any | undefined> {
  if (longIdleDispatcher !== null) return longIdleDispatcher ?? undefined
  try {
    const undici: any = await import('undici')
    longIdleDispatcher = new undici.Agent({ bodyTimeout: 0, headersTimeout: 120_000 })
  } catch {
    longIdleDispatcher = undefined
  }
  return longIdleDispatcher ?? undefined
}

/** 从 history 消息提取纯文本（string 或 content blocks 数组） */
function messageText(raw: any): string {
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) return raw.filter((b: any) => b?.type === 'text').map((b: any) => b.text || '').join('\n')
  return ''
}

/** 注入型 user 消息（宿主自动注入，非真实用户输入，不能作为回合起点）：compaction checkpoint / 技能目录提醒 / 运行时上下文快照 */
const INJECTED_USER_PREFIXES = [
  'This is an automatically generated checkpoint',
  '<system-reminder>',
  'Current runtime context.',
]

/**
 * 按回合起点重建整轮 assistant 文本。
 * 优先定位「包含本次提交 prompt 片段」的最后一条 user 消息作为回合起点（注入消息不含用户文本，天然排除）；
 * 找不到时退化为最后一条非注入型 user 消息。回合内所有非空 assistant 文本按序拼接。
 */
export function reconstructTurnFromHistory(
  messages: any[],
  promptFragment?: string,
): { text: string; matched: boolean } {
  const isInjected = (t: string) => INJECTED_USER_PREFIXES.some((p) => t.startsWith(p))
  let startIdx = -1
  if (promptFragment) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m?.role !== 'user') continue
      const t = messageText(m.content)
      if (t && t.includes(promptFragment)) {
        startIdx = i
        break
      }
    }
  }
  if (startIdx < 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m?.role !== 'user') continue
      const t = messageText(m.content)
      if (t && !isInjected(t)) {
        startIdx = i
        break
      }
    }
  }
  if (startIdx < 0) return { text: '', matched: false }
  const parts: string[] = []
  for (let j = startIdx + 1; j < messages.length; j++) {
    const m = messages[j]
    if (m?.role !== 'assistant') continue
    const t = messageText(m.content).trim()
    if (t) parts.push(t)
  }
  return { text: parts.join('\n\n'), matched: true }
}

function toQuery(opts?: { root?: string; cwd?: string }): string {
  const q: string[] = []
  if (opts?.root) q.push(`root=${encodeURIComponent(opts.root)}`)
  if (opts?.cwd) q.push(`cwd=${encodeURIComponent(opts.cwd)}`)
  return q.length ? '?' + q.join('&') : ''
}

/** 远端 /skills 列表条目 */
export interface RemoteSkillEntry {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  source: string
  path: string
  root: string
  size: number
}

/** 远端 /skills/:name 详情 */
export interface RemoteSkillDetail {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
  userInvocable: boolean
  path: string
  root: string
  content: string
  raw: string
  size: number
}

export class DshClient {
  private headers(apiKey?: string): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' }
    if (apiKey && apiKey.trim()) h.Authorization = `Bearer ${apiKey.trim()}`
    return h
  }

  /** 无 Content-Type 的鉴权头（FormData/流式场景） */
  private headersAuth(apiKey?: string): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' }
    if (apiKey && apiKey.trim()) h.Authorization = `Bearer ${apiKey.trim()}`
    return h
  }

  /** 上传文件到远端会话工作区（远端 DSH 需 dsh-web-service >= 0.1.0） */
  public async uploadFiles(
    target: DshTarget,
    sessionId: string,
    files: Array<{ filename: string; data: Buffer; mimeType?: string }>,
  ): Promise<{ ok: boolean; files?: Array<{ name: string; path: string; size: number; mimeType?: string }>; cwd?: string; error?: string }> {
    try {
      const fd = new FormData()
      for (const f of files) {
        const blob = new Blob([new Uint8Array(f.data)], { type: f.mimeType || 'application/octet-stream' })
        fd.append('files', blob, f.filename)
      }
      const res = await fetch(`${clean(target.baseUrl)}/sessions/${sessionId}/files`, {
        method: 'POST',
        headers: this.headersAuth(target.apiKey),
        body: fd,
        signal: AbortSignal.timeout(120_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return { ok: true, files: json.data?.files || [], cwd: json.data?.cwd }
    } catch (err: any) {
      return { ok: false, error: err?.message || '上传失败' }
    }
  }

  /** 远端目录浏览（对齐 DSH directory-picker-browse：只返回目录行，hidden 标记） */
  public async fsList(target: DshTarget, dirPath?: string): Promise<{
    ok: boolean
    error?: string
    data?: { path: string; home: string; parent?: string; entries: Array<{ name: string; path: string; hidden: boolean }>; truncated: boolean }
  }> {
    try {
      const url = `${clean(target.baseUrl)}/fs/list${dirPath ? `?path=${encodeURIComponent(dirPath)}` : ''}`
      const res = await fetch(url, { headers: this.headers(target.apiKey), signal: AbortSignal.timeout(15_000) })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return { ok: true, data: json.data }
    } catch (err: any) {
      return { ok: false, error: err?.message || '目录浏览失败' }
    }
  }

  /** 远端新建目录 */
  public async fsMkdir(target: DshTarget, parent: string, name: string): Promise<{ ok: boolean; error?: string; data?: { path: string; name: string } }> {
    try {
      const res = await fetch(`${clean(target.baseUrl)}/fs/mkdir`, {
        method: 'POST',
        headers: this.headers(target.apiKey),
        body: JSON.stringify({ path: parent, name }),
        signal: AbortSignal.timeout(15_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return { ok: true, data: json.data }
    } catch (err: any) {
      return { ok: false, error: err?.message || '新建目录失败' }
    }
  }

  /** 查询远端会话信息（cwd 用于把 AI 报告的绝对路径换算成工作区相对路径） */
  public async getSessionInfo(target: DshTarget, sessionId: string): Promise<{ ok: boolean; cwd?: string; title?: string; status?: string; error?: string }> {
    try {
      const res = await fetch(`${clean(target.baseUrl)}/sessions/${sessionId}`, {
        headers: this.headers(target.apiKey),
        signal: AbortSignal.timeout(10_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return { ok: true, cwd: json.data?.cwd, title: json.data?.title, status: json.data?.status }
    } catch (err: any) {
      return { ok: false, error: err?.message || '查询会话失败' }
    }
  }

  /** 下载远端会话工作区文件，返回原始 Response 供流式转发 */
  public async downloadFile(target: DshTarget, sessionId: string, relPath: string): Promise<{ ok: boolean; res?: Response; name?: string; error?: string }> {
    try {
      const url = `${clean(target.baseUrl)}/sessions/${sessionId}/files/download?path=${encodeURIComponent(relPath)}`
      const res = await fetch(url, { headers: this.headersAuth(target.apiKey), signal: AbortSignal.timeout(120_000) })
      if (!res.ok || !res.body) {
        const json: any = await res.json().catch(() => ({}))
        return { ok: false, error: json?.error || `HTTP ${res.status}` }
      }
      return { ok: true, res, name: relPath.split('/').pop() }
    } catch (err: any) {
      return { ok: false, error: err?.message || '下载失败' }
    }
  }

  // ---------- 技能管理（dsh-web-service /skills） ----------

  /** 技能条目（远端 /skills 列表返回） */
  public async listSkills(
    target: DshTarget,
    opts?: { root?: string; cwd?: string; search?: string },
  ): Promise<{ ok: boolean; root?: { kind: string; path: string }; skills: Array<RemoteSkillEntry>; count?: number; error?: string; unsupported?: boolean }> {
    try {
      const q: string[] = []
      if (opts?.root) q.push(`root=${encodeURIComponent(opts.root)}`)
      if (opts?.cwd) q.push(`cwd=${encodeURIComponent(opts.cwd)}`)
      if (opts?.search) q.push(`search=${encodeURIComponent(opts.search)}`)
      const url = `${clean(target.baseUrl)}/skills${q.length ? '?' + q.join('&') : ''}`
      const res = await fetch(url, { headers: this.headers(target.apiKey), signal: AbortSignal.timeout(15_000) })
      if (res.status === 404 || res.status === 501) return { ok: false, skills: [], unsupported: true, error: '远端 dsh-web-service 未安装 /skills 端点' }
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, skills: [], error: json?.error || `HTTP ${res.status}` }
      return { ok: true, root: json.data?.root, count: json.data?.count, skills: Array.isArray(json.data?.skills) ? json.data.skills : [] }
    } catch (err: any) {
      return { ok: false, skills: [], error: err?.message || '获取技能列表失败' }
    }
  }

  /** 单技能详情（含正文 content 与全文 raw） */
  public async getSkill(
    target: DshTarget,
    name: string,
    opts?: { root?: string; cwd?: string },
  ): Promise<{ ok: boolean; skill?: RemoteSkillDetail; error?: string; unsupported?: boolean }> {
    const q = toQuery(opts)
    try {
      const res = await fetch(`${clean(target.baseUrl)}/skills/${encodeURIComponent(name)}${q}`, {
        headers: this.headers(target.apiKey),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status === 404 || res.status === 501) return { ok: false, unsupported: true, error: '远端 dsh-web-service 未安装 /skills 端点' }
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return { ok: true, skill: json.data }
    } catch (err: any) {
      return { ok: false, error: err?.message || '获取技能详情失败' }
    }
  }

  /** 获取 SKILL.md 全文（预览/下载） */
  public async getSkillBody(
    target: DshTarget,
    name: string,
    opts?: { root?: string; cwd?: string },
  ): Promise<{ ok: boolean; content?: string; error?: string; unsupported?: boolean }> {
    const q = toQuery(opts)
    try {
      const res = await fetch(`${clean(target.baseUrl)}/skills/${encodeURIComponent(name)}/body${q}`, {
        headers: this.headersAuth(target.apiKey),
        signal: AbortSignal.timeout(20_000),
      })
      if (res.status === 404 || res.status === 501) return { ok: false, unsupported: true, error: '远端 dsh-web-service 未安装 /skills 端点' }
      if (!res.ok) {
        const json: any = await res.json().catch(() => ({}))
        return { ok: false, error: json?.error || `HTTP ${res.status}` }
      }
      return { ok: true, content: await res.text() }
    } catch (err: any) {
      return { ok: false, error: err?.message || '获取技能全文失败' }
    }
  }

  /** 下载整个技能目录归档 (.tgz)，返回原始 Response 供流式转发 */
  public async downloadSkillArchive(
    target: DshTarget,
    name: string,
    opts?: { root?: string; cwd?: string },
  ): Promise<{ ok: boolean; res?: Response; name?: string; error?: string; unsupported?: boolean }> {
    const q = toQuery(opts)
    try {
      const res = await fetch(`${clean(target.baseUrl)}/skills/${encodeURIComponent(name)}/archive${q}`, {
        headers: this.headersAuth(target.apiKey),
        signal: AbortSignal.timeout(120_000),
      })
      if (res.status === 404 || res.status === 501) return { ok: false, unsupported: true, error: '远端 dsh-web-service 未安装 /skills 端点' }
      if (!res.ok || !res.body) {
        const json: any = await res.json().catch(() => ({}))
        return { ok: false, error: json?.error || `HTTP ${res.status}` }
      }
      return { ok: true, res, name: `${name}.tgz` }
    } catch (err: any) {
      return { ok: false, error: err?.message || '下载技能归档失败' }
    }
  }

  /** 上传技能（multipart：file=技能压缩包 .zip/.tgz，字段 root/name） */
  public async uploadSkill(
    target: DshTarget,
    file: { filename: string; data: Buffer },
    fields?: { root?: string; name?: string; cwd?: string },
  ): Promise<{ ok: boolean; name?: string; path?: string; error?: string; unsupported?: boolean }> {
    try {
      const fd = new FormData()
      fd.append('file', new Blob([new Uint8Array(file.data)]), file.filename)
      if (fields?.root) fd.append('root', fields.root)
      if (fields?.name) fd.append('name', fields.name)
      if (fields?.cwd) fd.append('cwd', fields.cwd)
      const res = await fetch(`${clean(target.baseUrl)}/skills`, {
        method: 'POST',
        headers: this.headersAuth(target.apiKey),
        body: fd,
        signal: AbortSignal.timeout(120_000),
      })
      if (res.status === 404 || res.status === 501) return { ok: false, unsupported: true, error: '远端 dsh-web-service 未安装 /skills 端点' }
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return { ok: true, name: json.data?.name, path: json.data?.path }
    } catch (err: any) {
      return { ok: false, error: err?.message || '上传技能失败' }
    }
  }

  /** 更新技能元数据/正文（JSON） */
  public async updateSkill(
    target: DshTarget,
    name: string,
    payload: { description?: string; whenToUse?: string; content?: string; modelInvocable?: boolean; userInvocable?: boolean },
    opts?: { root?: string; cwd?: string },
  ): Promise<{ ok: boolean; error?: string }> {
    const q = toQuery(opts)
    try {
      const res = await fetch(`${clean(target.baseUrl)}/skills/${encodeURIComponent(name)}${q}`, {
        method: 'PUT',
        headers: this.headers(target.apiKey),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status === 404 || res.status === 501) return { ok: false, error: '远端 dsh-web-service 未安装 /skills 端点' }
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || '更新技能失败' }
    }
  }

  /** 删除技能 */
  public async deleteSkill(target: DshTarget, name: string, opts?: { root?: string; cwd?: string }): Promise<{ ok: boolean; error?: string }> {
    const q = toQuery(opts)
    try {
      const res = await fetch(`${clean(target.baseUrl)}/skills/${encodeURIComponent(name)}${q}`, {
        method: 'DELETE',
        headers: this.headers(target.apiKey),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status === 404 || res.status === 501) return { ok: false, error: '远端 dsh-web-service 未安装 /skills 端点' }
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || '删除技能失败' }
    }
  }

  public async ping(target: DshTarget): Promise<PingResult> {
    try {
      const res = await fetch(`${clean(target.baseUrl)}/system/status`, {
        headers: this.headers(target.apiKey),
        signal: AbortSignal.timeout(10_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return {
        ok: true,
        name: json.data?.name,
        version: json.data?.version,
        port: json.data?.port,
        uptime: json.data?.uptime,
        providers: json.data?.providers || [],
      }
    } catch (err: any) {
      return { ok: false, error: err?.message || '连接失败' }
    }
  }

  public async getModels(target: DshTarget): Promise<{ ok: boolean; defaultModel?: any; models: RemoteModelEntry[]; error?: string }> {
    try {
      const res = await fetch(`${clean(target.baseUrl)}/models`, {
        headers: this.headers(target.apiKey),
        signal: AbortSignal.timeout(10_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, models: [], error: json?.error || `HTTP ${res.status}` }
      return { ok: true, defaultModel: json.data?.defaultModel, models: Array.isArray(json.data?.models) ? json.data.models : [] }
    } catch (err: any) {
      return { ok: false, models: [], error: err?.message || '获取模型失败' }
    }
  }

  public async getPresets(target: DshTarget): Promise<{ ok: boolean; presets: Array<{ id: string; name?: string; description?: string }>; error?: string }> {
    try {
      const res = await fetch(`${clean(target.baseUrl)}/presets`, {
        headers: this.headers(target.apiKey),
        signal: AbortSignal.timeout(10_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, presets: [], error: json?.error || `HTTP ${res.status}` }
      return { ok: true, presets: Array.isArray(json.data?.presets) ? json.data.presets : [] }
    } catch (err: any) {
      return { ok: false, presets: [], error: err?.message || '获取预设失败' }
    }
  }

  public async createSession(
    target: DshTarget,
    title: string,
    options?: { agentPreset?: string; provider?: string; model?: string; cwd?: string },
  ): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
    const payload: Record<string, any> = { title, agentPreset: options?.agentPreset || 'cordis' }
    if (options?.provider) payload.provider = options.provider
    if (options?.model) payload.model = options.model
    if (options?.cwd) payload.cwd = options.cwd
    try {
      const res = await fetch(`${clean(target.baseUrl)}/sessions`, {
        method: 'POST',
        headers: this.headers(target.apiKey),
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(20_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return { ok: true, sessionId: json.data?.sessionId }
    } catch (err: any) {
      return { ok: false, error: err?.message || '创建会话失败' }
    }
  }

  public async cancelSession(target: DshTarget, sessionId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      // 1. 尝试专用的 /cancel 路由
      const cancelRes = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/cancel`, {
        method: 'POST',
        headers: this.headers(target.apiKey),
        signal: AbortSignal.timeout(6000),
      }).catch(() => null)
      if (cancelRes && cancelRes.ok) return { ok: true }

      // 2. 尝试标准 RESTful DELETE /sessions/:id 终止远端会话
      const delRes = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        headers: this.headers(target.apiKey),
        signal: AbortSignal.timeout(6000),
      }).catch(() => null)
      if (delRes && delRes.ok) return { ok: true }

      return { ok: false, error: '远端会话未响应终止请求' }
    } catch (err: any) {
      return { ok: false, error: err?.message || '中止失败' }
    }
  }

  public async getSession(target: DshTarget, sessionId: string): Promise<{ ok: boolean; status?: string; error?: string }> {
    try {
      const res = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}`, {
        headers: this.headers(target.apiKey),
        signal: AbortSignal.timeout(10_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return { ok: true, status: json.data?.status }
    } catch (err: any) {
      return { ok: false, error: err?.message || '查询会话失败' }
    }
  }

  /**
   * 会话作用域技能目录（对齐 harness skills/list：按会话 cwd 解析技能根）。
   * 需要 dsh-web-service ≥ 0.1.5（GET /sessions/:id/skills）；旧版返回 supported=false。
   * 「装载到上下文」由远端 DSH 核心完成：用户消息中空白符边界的 /name 手势
   * （tool-skill pre-step）会注入技能正文，这里只取清单。
   */
  public async getSessionSkills(target: DshTarget, sessionId: string, q?: string): Promise<{
    ok: boolean
    supported?: boolean
    cwd?: string
    skills?: Array<{ name: string; description?: string; whenToUse?: string; modelInvocable?: boolean; userInvocable?: boolean }>
    error?: string
  }> {
    try {
      const query = q ? `?search=${encodeURIComponent(q)}` : ''
      const res = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/skills${query}`, {
        headers: this.headers(target.apiKey),
        signal: AbortSignal.timeout(12_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (res.status === 404 || res.status === 501) return { ok: false, supported: false, error: '远端 dsh-web-service 版本过低，无会话技能目录' }
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return {
        ok: true,
        supported: true,
        cwd: json.data?.cwd,
        skills: Array.isArray(json.data?.skills) ? json.data.skills : [],
      }
    } catch (err: any) {
      return { ok: false, error: err?.message || '查询会话技能失败' }
    }
  }

  /**
   * 会话实时统计（轮/步/LLM 与工具耗时/首 token/吞吐/token 账本）。
   * 需要 dsh-web-service ≥ 0.1.5（GET /sessions/:id/stats）；旧版返回 supported=false 供调用方降级隐藏。
   */
  public async getSessionStats(target: DshTarget, sessionId: string): Promise<{
    ok: boolean
    supported?: boolean
    stats?: Record<string, number>
    error?: string
  }> {
    try {
      const res = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/stats`, {
        headers: this.headers(target.apiKey),
        signal: AbortSignal.timeout(12_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (res.status === 404 || res.status === 501) return { ok: false, supported: false, error: '远端 dsh-web-service 版本过低，不含统计接口' }
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      const d = json.data || {}
      const stats: Record<string, number> = {
        turns: d.turns || 0,
        steps: d.steps || 0,
        llmMs: d.llmMs || 0,
        toolMs: d.toolMs || 0,
        ttftMs: d.ttftMs || 0,
        ttftSteps: d.ttftSteps || 0,
        decodeMs: d.decodeMs || 0,
        decodeTokens: d.decodeTokens || 0,
        inputTokens: d.usage?.inputTokens || 0,
        cacheReadTokens: d.usage?.cacheReadTokens || 0,
        cacheWriteTokens: d.usage?.cacheWriteTokens || 0,
        outputTokens: d.usage?.outputTokens || 0,
      }
      return { ok: true, supported: true, stats }
    } catch (err: any) {
      return { ok: false, error: err?.message || '查询会话统计失败' }
    }
  }

  /**
   * 提交 ask_user_question 挂起问题的答复（远端宿主 waterfall 桥）。
   * 需要 dsh-web-service ≥ 0.1.6（POST /sessions/:id/answers）；旧版返回 supported=false。
   */
  public async answerQuestion(
    target: DshTarget,
    sessionId: string,
    answers: Array<{ id: string; selected: string[]; custom?: string }>,
  ): Promise<{ ok: boolean; supported?: boolean; error?: string }> {
    try {
      const res = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/answers`, {
        method: 'POST',
        headers: this.headers(target.apiKey),
        body: JSON.stringify({ answers }),
        signal: AbortSignal.timeout(12_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (res.status === 404 || res.status === 501) return { ok: false, supported: false, error: '远端 dsh-web-service 版本过低，无问题答复接口' }
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return { ok: true, supported: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || '提交问题答复失败' }
    }
  }

  /**
   * SSE 流式派发 prompt。解析 `event: X\ndata: Y` 帧。
   * 远端返回 404/501（旧版无此路由）时返回 sseUnsupported=true 供调用方降级。
   */
  public async streamPrompt(
    target: DshTarget,
    sessionId: string,
    prompt: string,
    handlers: StreamEventHandlers,
    options?: { remoteTimeoutMs?: number; signal?: AbortSignal },
  ): Promise<PromptResult> {
    let content = ''
    let reasoning = ''
    try {
      const dispatcher = await getLongIdleDispatcher()
      const res = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/prompt-stream`, {
        method: 'POST',
        headers: this.headers(target.apiKey),
        body: JSON.stringify({ prompt, timeoutMs: options?.remoteTimeoutMs ?? 1_800_000 }),
        signal: options?.signal,
        // bodyTimeout=0：长工具执行/压缩期间无帧的静默段不断流（undici 缺失时无此键，退回默认）
        ...(dispatcher ? { dispatcher } : {}),
      } as any)
      if (res.status === 404 || res.status === 501) {
        return { ok: false, error: `远端不支持 prompt-stream (HTTP ${res.status})`, sseUnsupported: true }
      }
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '')
        return { ok: false, error: `prompt-stream HTTP ${res.status}: ${text.slice(0, 200)}` }
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let done = false
      let sawTurnEnd = false
      let loggedFirstReasoning = false
      let usage: Record<string, number> | undefined
      handlers.onLog?.('远端 SSE 流已连接，指令已提交', 'info')
      while (!done) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let idx: number
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const evName = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim()
          const dataRaw = /^data:\s*([\s\S]*)$/m.exec(frame)?.[1] ?? ''
          let data: any = dataRaw
          try {
            data = JSON.parse(dataRaw)
          } catch {
            /* 保留原始字符串（如 [DONE]） */
          }
          switch (evName) {
            case 'delta':
              if (typeof data?.delta === 'string' && data.delta) {
                content += data.delta
                handlers.onDelta?.(data.delta)
              }
              break
            case 'reasoning':
              if (typeof data?.delta === 'string' && data.delta) {
                reasoning += data.delta
                if (!loggedFirstReasoning) {
                  loggedFirstReasoning = true
                  handlers.onLog?.('远端开始推理…', 'info')
                }
                handlers.onReasoning?.(data.delta)
              }
              break
            case 'tool_call':
              handlers.onToolCall?.(data || {})
              handlers.onLog?.(`工具调用: ${data?.name || 'unknown'}`, 'tool')
              break
            case 'tool_result':
              handlers.onToolResult?.(data || {})
              break
            case 'usage':
              // 远端透传的真实 token 账本（含缓存命中）
              if (data?.usage && typeof data.usage === 'object') {
                const u = { ...data.usage }
                usage = u
                handlers.onUsage?.(u)
              }
              break
            case 'error':
              return { ok: false, content, reasoning, complete: false, error: data?.message || '远端执行错误' }
            case 'turn_end': {
              const r = data?.reason
              const reason = typeof r === 'string' ? r : r && typeof r === 'object' && typeof r.kind === 'string' ? r.kind : r != null ? JSON.stringify(r) : 'completed'
              sawTurnEnd = true
              handlers.onLog?.(`远端轮次结束 (${reason})`, 'info')
              break
            }
            case 'done':
              done = true
              break
          }
          if (sawTurnEnd && evName === 'done') break
        }
      }
      if (!sawTurnEnd && !content) {
        return { ok: false, error: 'SSE 流在产出任何内容前结束', sseUnsupported: false }
      }
      // complete=false：流被远端/网络提前收掉且未收到 turn_end，内容可能缺尾，交由调用方对账
      return { ok: true, content, reasoning: reasoning || undefined, via: 'sse', usage, complete: sawTurnEnd }
    } catch (err: any) {
      if (err?.name === 'AbortError') return { ok: false, content, reasoning, complete: false, error: '已中止', timedOut: true }
      return { ok: false, content, reasoning, complete: false, error: err?.message || 'SSE 流失败' }
    }
  }

  /** 同步派发（降级路径，沿用 orchestrator 的双窗口超时策略） */
  public async prompt(
    target: DshTarget,
    sessionId: string,
    prompt: string,
    options?: { timeoutMs?: number; remoteTimeoutMs?: number; signal?: AbortSignal },
  ): Promise<PromptResult> {
    const localTimeoutMs = options?.timeoutMs ?? 300_000
    try {
      const res = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/prompt`, {
        method: 'POST',
        headers: this.headers(target.apiKey),
        body: JSON.stringify({ prompt, timeoutMs: options?.remoteTimeoutMs ?? 1_800_000 }),
        signal: options?.signal ?? AbortSignal.timeout(localTimeoutMs),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      const usage = json.data?.usage && typeof json.data.usage === 'object' ? { ...json.data.usage } : undefined
      return { ok: true, content: json.data?.content || '', reasoning: json.data?.reasoning, via: 'sync', usage }
    } catch (err: any) {
      const msg = err?.message || 'prompt 失败'
      const isTimeout = err?.name === 'AbortError' || /abort|timeout/i.test(msg)
      return { ok: false, error: msg, timedOut: isTimeout }
    }
  }

  public async getHistory(
    target: DshTarget,
    sessionId: string,
    maxMessages = 100,
  ): Promise<{ ok: boolean; messages?: any[]; error?: string }> {
    try {
      const res = await fetch(
        `${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/history?maxMessages=${maxMessages}`,
        { headers: this.headers(target.apiKey), signal: AbortSignal.timeout(15_000) },
      )
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      const data = json.data
      const messages = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : []
      return { ok: true, messages }
    } catch (err: any) {
      return { ok: false, error: err?.message || '获取历史失败' }
    }
  }

  /** 轮询远端会话直到结束并提取最后一条助手回复（同步超时兜底） */
  public async waitForSessionResult(
    target: DshTarget,
    sessionId: string,
    options?: { maxMs?: number; intervalMs?: number; signal?: AbortSignal; onLog?: (msg: string, level?: SubtaskLogEntry['level']) => void; promptFragment?: string },
  ): Promise<PromptResult> {
    const maxMs = options?.maxMs ?? 1_800_000
    const intervalMs = options?.intervalMs ?? 15_000
    const deadline = Date.now() + maxMs
    let lastStatus = ''
    options?.onLog?.(`转入轮询模式（最长 ${Math.round(maxMs / 60_000)} 分钟）...`, 'info')
    while (Date.now() < deadline) {
      if (options?.signal?.aborted) return { ok: false, error: '已中止' }
      await new Promise((r) => setTimeout(r, intervalMs))
      const st = await this.getSession(target, sessionId)
      if (!st.ok) return { ok: false, error: st.error }
      if (st.status !== lastStatus) {
        options?.onLog?.(`远端会话状态: ${st.status || 'unknown'}`, 'info')
        lastStatus = st.status || ''
      }
      if (st.status && st.status !== 'running') {
        const hist = await this.getHistory(target, sessionId, 200)
        if (!hist.ok) return { ok: false, error: hist.error }
        const messages = hist.messages || []
        // 优先按回合起点重建整轮文本：回合内往往有多条 assistant 消息（逐步叙述），
        // 只取最后一条会把整轮压缩成结尾总结，造成与远端会话展示不一致
        const rec = reconstructTurnFromHistory(messages, options?.promptFragment)
        if (rec.text.trim()) return { ok: true, content: rec.text, via: 'poll' }
        // 退化：取最后一条非空 assistant 消息（旧行为）
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i]
          if (m?.role !== 'assistant') continue
          const text = messageText(m.content)
          if (text && text.trim()) return { ok: true, content: text, reasoning: m.reasoning, via: 'poll' }
        }
        return { ok: false, error: '会话已结束但未提取到助手回复' }
      }
    }
    return { ok: false, error: `等待远程会话完成超时 (>${Math.round(maxMs / 60_000)} 分钟)` }
  }

  /** OpenAI 兼容 /chat/completions（Planner 用，非流式） */
  public async chat(
    target: DshTarget,
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    options?: { model?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ ok: boolean; content?: string; reasoning?: string; sessionId?: string; error?: string }> {
    try {
      const res = await fetch(`${clean(target.baseUrl)}/chat/completions`, {
        method: 'POST',
        headers: this.headers(target.apiKey),
        body: JSON.stringify({
          messages,
          stream: false,
          ...(options?.model && options.model.includes('/') ? { model: options.model } : {}),
        }),
        signal: options?.signal ?? AbortSignal.timeout(options?.timeoutMs ?? 300_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      const choice = json?.choices?.[0]
      const content: string = choice?.message?.content ?? ''
      if (!content.trim()) return { ok: false, error: 'chat/completions 返回空内容' }
      return { ok: true, content, reasoning: choice?.message?.reasoning_content, sessionId: json?.sessionId }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'chat/completions 失败' }
    }
  }
}
