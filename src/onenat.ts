/**
 * @dsh-external/onenat-workbuddy - ONENAT 资源目录与解析器
 *
 * 唯一实时数据源: GET /api/v1/resources（+ /api/v1/apps 交叉补充）
 * 解析规则对齐 onenat.md（实测语义）:
 *  - online=false 或缺 public_url ⇒ 不可达，不缓存旧端口
 *  - tcp 隧道承载 HTTP（local 指向 web 端口或绑定 http-api 应用）⇒ 合成 baseUrl
 *  - DSH 实体识别: app.type === 'http-api' 且技能清单含 dsh-web-service（双重校验防绑错）
 *  - 公网端口动态: 每次派发前强刷新，绝不变异缓存 URL（D1）
 */

import type {
  OnenatApp,
  OnenatCredentials,
  OnenatTunnel,
  ResolvedEndpoint,
  ResourceSnapshot,
} from './types.js'

const WEB_PORT_MIN = 3000
const WEB_PORT_MAX = 9999

export function cleanBaseUrl(url: string): string {
  return url.replace(/\/+$/, '')
}

function parsePublicUrl(publicUrl: string | undefined): { proto: 'tcp' | 'http'; host: string; port?: number } | undefined {
  if (!publicUrl) return undefined
  const m = /^(tcp|http):\/\/([^:/]+)(?::(\d+))?/.exec(publicUrl.trim())
  if (!m) return undefined
  return {
    proto: m[1] === 'http' ? 'http' : 'tcp',
    host: m[2],
    port: m[3] ? Number(m[3]) : undefined,
  }
}

function looksLikeWebPort(local: string): boolean {
  const m = /:(\d+)$/.exec(local.trim())
  if (!m) return false
  const port = Number(m[1])
  return port >= WEB_PORT_MIN && port <= WEB_PORT_MAX
}

function classifyKind(app: OnenatApp | undefined, local: string, proto: 'tcp' | 'http'): ResolvedEndpoint['kind'] {
  const type = (app?.type || '').toLowerCase()
  if (type === 'ssh' || /:(\d+)$/.exec(local)?.[1] === '22') return 'ssh'
  if (type === 'http-api' && app?.skills?.some((s) => /dsh/i.test(s.name))) return 'dsh'
  if (type === 'http-api' || proto === 'http' || looksLikeWebPort(local)) return 'http'
  return 'tcp'
}

export class OnenatDirectory {
  private snapshot: ResourceSnapshot | undefined
  private refreshPromise: Promise<ResourceSnapshot> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private credCache = new Map<string, { at: number; data: OnenatCredentials }>()
  /**
   * 凭证缓存 TTL。**必须短**：映射实例凭证在 OneNat 后台改完后，本进程缓存最多
   * 只会阻碍这么久（旧实现 10 分钟 ⇒ "设了独立凭证，注入的还是应用默认/旧密码"）。
   * 同时它也是 OneNat 侧 5 次/分限速的保护：30s 内同映射最多取 2 次。
   */
  private static CRED_TTL = 30 * 1000
  /** 失败（403/429）负缓存 TTL：只用来挡连环触发，绝不当成功凭证用 */
  private static CRED_NEG_TTL = 15 * 1000

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private log: (msg: string) => void = () => {},
  ) {}

  public configure(baseUrl: string, apiKey: string): void {
    this.baseUrl = cleanBaseUrl(baseUrl || '')
    this.apiKey = apiKey || ''
    this.snapshot = undefined
    this.credCache.clear()
  }

  /**
   * 让某映射（或全部）的凭证缓存立即失效。
   * 调用时机：OneNat 侧改过实例凭证后、以及需要"派发必取最新值"的场合。
   */
  public invalidateCredential(mappingId?: string): void {
    if (mappingId) this.credCache.delete(mappingId)
    else this.credCache.clear()
  }

  public get configured(): boolean {
    return Boolean(this.baseUrl && this.apiKey)
  }

  public get endpoint(): string {
    return cleanBaseUrl(this.baseUrl)
  }

  /** 平台 API Key（提示词 [平台接入] 段用；self-fetch 凭证策略需要） */
  public get key(): string {
    return this.apiKey
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
      ...extra,
    }
  }

  /** 拉取实时资源快照（并发去重；force 时丢弃缓存） */
  public async refresh(force = false): Promise<ResourceSnapshot> {
    if (!this.configured) throw new Error('ONENAT 未配置（baseUrl / apiKey 缺失）')
    if (!force && this.snapshot && Date.now() - this.snapshot.fetchedAt < 15_000) {
      return this.snapshot
    }
    if (this.refreshPromise) return this.refreshPromise
    this.refreshPromise = this.doFetch()
      .then((snap) => {
        this.snapshot = snap
        return snap
      })
      .finally(() => {
        this.refreshPromise = undefined
      })
    return this.refreshPromise
  }

  private async doFetch(): Promise<ResourceSnapshot> {
    const res = await fetch(`${this.baseUrl}/api/v1/resources`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`ONENAT /api/v1/resources HTTP ${res.status}: ${text.slice(0, 200)}`)
    }
    const json: any = await res.json()
    const tunnels: OnenatTunnel[] = Array.isArray(json?.tunnels) ? json.tunnels : []
    return { fetchedAt: Date.now(), baseUrl: this.baseUrl, tunnels }
  }

  public current(): ResourceSnapshot | undefined {
    return this.snapshot
  }

  /** 解析单个映射为当下公网入口；不可达时返回 online=false 的结果（不抛错，由调用方决定跳过） */
  public resolveMapping(mappingId: string): ResolvedEndpoint | undefined {
    const snap = this.snapshot
    if (!snap) return undefined
    for (const t of snap.tunnels) {
      for (const m of t.mappings || []) {
        if (m.id !== mappingId) continue
        return this.buildEndpoint(t, m, snap.fetchedAt)
      }
    }
    return undefined
  }

  /** 按应用 ID 反查绑定它的映射（取第一条可达的） */
  public resolveApp(appId: string): ResolvedEndpoint | undefined {
    const snap = this.snapshot
    if (!snap) return undefined
    let fallback: ResolvedEndpoint | undefined
    for (const t of snap.tunnels) {
      for (const m of t.mappings || []) {
        if (m.app?.id !== appId) continue
        const ep = this.buildEndpoint(t, m, snap.fetchedAt)
        if (ep.online) return ep
        fallback ??= ep
      }
    }
    return fallback
  }

  private buildEndpoint(t: OnenatTunnel, m: any, at: number): ResolvedEndpoint {
    const parsed = parsePublicUrl(m.public_url)
    const app: OnenatApp | undefined = m.app
    const online = Boolean(t.online && parsed)
    const kind = classifyKind(app, String(m.local ?? ''), m.proto === 'http' ? 'http' : 'tcp')
    const rawAppName = app?.name || m.note || ''
    // 自动为同名或泛称资源（如 "SSH Server"、"DSH"）打上隧道环境前缀，确保全系统资源名唯一直观
    let uniqueName = rawAppName
    if (t.name) {
      if (!uniqueName) {
        uniqueName = `${t.name}-${kind.toUpperCase()}`
      } else if (uniqueName === 'SSH Server' || uniqueName === 'SSH' || uniqueName === 'DSH' || uniqueName === 'HTTP API') {
        uniqueName = `${t.name}-${uniqueName}`
      }
    }

    const ep: ResolvedEndpoint = {
      mappingId: m.id,
      appId: app?.id,
      tunnelId: t.id,
      tunnelName: t.name,
      note: m.note,
      online,
      proto: m.proto === 'http' ? 'http' : 'tcp',
      host: parsed?.host || '',
      port: parsed?.port,
      local: String(m.local ?? ''),
      kind,
      // 平台已给出"是否实例级覆盖"标志：接住它，合成时才能区分
      // 实例独立凭证(mapping) 与 继承应用默认(app)；字段缺失时保持 undefined(未知)
      authOverride: m.auth_override === undefined ? undefined : Boolean(m.auth_override),
      appName: uniqueName || rawAppName || `${t.name || 'node'}-${kind}`,
      appType: app?.type,
      appSkills: app?.skills,
      resolvedAt: at,
    }
    if (online && parsed) {
      const portPart = `:${parsed.port ?? (ep.local ? Number(/:(\d+)$/.exec(ep.local)?.[1] ?? 80) : 80)}`
      if (m.proto === 'http') {
        ep.baseUrl = `http://${parsed.host}${parsed.port ? `:${parsed.port}` : ''}`
      } else if (kind === 'dsh' || kind === 'http' || (app?.type === 'http-api') || looksLikeWebPort(ep.local)) {
        // DSH 实体: dsh-web-service 约定 Base URL 含 /api/v1 路径（技能文件同口径）
        ep.baseUrl = kind === 'dsh' ? `http://${parsed.host}${portPart}/api/v1` : `http://${parsed.host}${portPart}`
      }
    }
    return ep
  }

  /** DSH 型映射速览（供 UI 下拉与自动发现） */
  public listDshEndpoints(): ResolvedEndpoint[] {
    const snap = this.snapshot
    if (!snap) return []
    const out: ResolvedEndpoint[] = []
    for (const t of snap.tunnels) {
      for (const m of t.mappings || []) {
        const ep = this.buildEndpoint(t, m, snap.fetchedAt)
        if (ep.kind === 'dsh') out.push(ep)
      }
    }
    return out
  }

  /** 全量资源清单（供资源目录页展示） */
  public listEndpoints(): ResolvedEndpoint[] {
    const snap = this.snapshot
    if (!snap) return []
    const out: ResolvedEndpoint[] = []
    for (const t of snap.tunnels) {
      for (const m of t.mappings || []) {
        out.push(this.buildEndpoint(t, m, snap.fetchedAt))
      }
    }
    return out
  }

  /** 下载应用技能文件全文（url 已自带 key） */
  /**
   * 读取映射实例的有效凭证（映射覆盖优先，回退应用默认）。
   * ONENAT 侧限速 5 次/分 ⇒ 本地缓存，但**成功值与失败值分开计时**：
   * 成功值 30s（保证刚改完凭证就派发也能取到新值），403/429 等失败 15s；
   * 失败值永远不会被当成可用凭证。
   * 返回值带 resolvedFrom（mapping=实例独立 / app=继承应用默认）与 fetchedAt。
   */
  public async fetchMappingCredentials(mappingId: string, force = false): Promise<OnenatCredentials> {
    const cached = this.credCache.get(mappingId)
    const ttl = cached?.data.ok ? OnenatDirectory.CRED_TTL : OnenatDirectory.CRED_NEG_TTL
    if (!force && cached && Date.now() - cached.at < ttl) return cached.data
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/mappings/${encodeURIComponent(mappingId)}/credentials`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok) {
        const data: OnenatCredentials = { ok: false, error: json?.error || `HTTP ${res.status}`, fetchedAt: Date.now() }
        // 403/429 属策略性失败：只做短负缓存，避免连环触发限速
        if (res.status === 403 || res.status === 429) this.credCache.set(mappingId, { at: Date.now(), data })
        return data
      }
      const data: OnenatCredentials = {
        ok: true,
        authType: json?.auth_type || json?.authType,
        username: json?.username,
        password: json?.password,
        apiKey: json?.api_key || json?.apiKey,
        token: json?.token,
        resolvedFrom: json?.resolved_from || json?.resolvedFrom,
        fetchedAt: Date.now(),
      }
      this.credCache.set(mappingId, { at: Date.now(), data })
      return data
    } catch (err: any) {
      return { ok: false, error: err?.message || '凭证读取失败', fetchedAt: Date.now() }
    }
  }

  /** 对 DSH 端点探活：GET /system/status */
  public static async pingDsh(baseUrl: string, apiKey?: string): Promise<{ ok: boolean; name?: string; version?: string; providers?: string[]; error?: string }> {
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`
      const res = await fetch(`${cleanBaseUrl(baseUrl)}/system/status`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      })
      const json: any = await res.json().catch(() => ({}))
      if (!res.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${res.status}` }
      return { ok: true, name: json.data?.name, version: json.data?.version, providers: json.data?.providers || [] }
    } catch (err: any) {
      return { ok: false, error: err?.message || '连接失败' }
    }
  }

  /** 启动周期刷新（60s 级；派发前另有强刷新） */
  public startAutoRefresh(intervalMs: number): void {
    this.stopAutoRefresh()
    const ms = Math.max(15_000, intervalMs || 60_000)
    this.timer = setInterval(() => {
      this.refresh(true).catch((err) => {
        this.log(`[onenat] 自动刷新失败: ${err?.message || err}`)
      })
    }, ms)
    this.refresh(true).catch(() => {})
  }

  public stopAutoRefresh(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }
}
