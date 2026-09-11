/**
 * @dsh-external/onenat-workbuddy-mention — DSH Web GUI 集成
 *
 * 只有两件事，都在 DSH 原生界面里：
 *   1. `@` 输入触发源（ctx.inputTriggers）：候选 = ONENAT 子智能体 + ONENAT 资源 + 本地 SSH 资源；
 *      选中插入原子胶囊，提交时由本插件的 codec 序列化为 `@[名称](onenat-agent:…)`，
 *      宿主在 agent/pre-step 解析回结构化身份。
 *   2. 设置页 management UI（settings.section）：子智能体 / 资源目录 / 本地 SSH 资源池 的可视化管理。
 *
 * 不注册侧栏入口、不劫持中央列、不内嵌 iframe —— 对话与工具卡全部复用 DSH 原生能力。
 */

export const inject = ['slots']

import React from 'react'

type ClientCtx = {
  slots: {
    inject(slot: string, factory: () => (() => void) | void): () => void
    register(config: Record<string, unknown>, component: unknown): () => void
  }
  effect(fn: () => () => void, name: string): () => void
}

/**
 * 静态 bundle 工厂只拿到 require —— 动态插件专属的 `styles` 闭包全局在这里
 * 不存在。自己插 <style>，按平台 data-plugin / data-plugin-css 约定打标
 * （重复加载时按 tagId 去重），返回卸载清理函数。
 */
function insertStyles(css: string): () => void {
  const tagId = `${NS}/client.css`
  let tag = document.querySelector<HTMLStyleElement>(`style[data-plugin-css="${tagId}"]`)
  if (tag === null) {
    tag = document.createElement('style')
    tag.dataset.plugin = NS
    tag.dataset.pluginCss = tagId
    tag.textContent = css
    document.head.appendChild(tag)
  }
  return () => { tag.remove() }
}
declare const console: { log(...v: unknown[]): void; error(...v: unknown[]): void }

const NS = 'onenat-workbuddy-mention'

/**
 * `@` 源注册状态：模块级快照 + 订阅。
 * 让「为什么 @ 菜单里没有 ONENAT 条目」在界面上直接可见，而不是静默失败。
 */
type MentionStatus = {
  state: 'waiting' | 'ready' | 'error'
  sourceRegistered: boolean
  agentCount: number
  resourceCount: number
  detail: string
}

const STATUS = {
  listeners: new Set<() => void>(),
  snapshot: { state: 'waiting', sourceRegistered: false, agentCount: 0, resourceCount: 0, detail: '正在等待 inputTriggers 服务…' } as MentionStatus,
  subscribe(listener: () => void): () => void {
    STATUS.listeners.add(listener)
    return () => {
      STATUS.listeners.delete(listener)
    }
  },
  get(): MentionStatus {
    return STATUS.snapshot
  },
  set(patch: Partial<MentionStatus>): void {
    STATUS.snapshot = { ...STATUS.snapshot, ...patch }
    for (const listener of STATUS.listeners) {
      try {
        listener()
      } catch {
        /* ignore */
      }
    }
  },
}

/**
 * 管理 API 前缀：由 Host 注入到 index.html（插件为普通 bundle，浏览器半边走同源 HTTP）。
 */
function apiPrefix(): string {
  const injected = (globalThis as any).__DSH_ONENAT_WORKBUDDY__
  const prefix = injected && typeof injected.pathPrefix === 'string' ? injected.pathPrefix : '/onenat-workbuddy-mention'
  return String(prefix).replace(/\/+$/, '')
}

/** 同源管理 API 调用：统一信封 { ok, data?, error? } */
async function api(path: string, init?: { method?: string; body?: unknown }): Promise<any> {
  const response = await globalThis.fetch(`${apiPrefix()}${path}`, {
    method: init?.method || 'GET',
    ...(init?.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }),
  })
  const payload: any = await response.json().catch(() => ({}))
  if (!response.ok || payload?.ok === false) throw new Error(String(payload?.error || `HTTP ${response.status}`))
  return payload?.data
}

interface CandidateRow {
  kind: 'agent' | 'resource'
  key: string
  name: string
  description: string
  section: string
  uri: string
  resourceKind?: string
  online?: boolean
}

// --------------------------------------------------------------- @ 输入触发源

function createMentionSource(
  log: (msg: string) => void,
  onCounts?: (counts: { agentCount: number; resourceCount: number }) => void,
) {
  /** 最近一次候选快照：warm/candidates 写入，lexicon/onPick 同步读取 */
  let snapshot: CandidateRow[] = []
  let lexicon: string[] | undefined
  const listeners = new Set<() => void>()

  const publish = (rows: CandidateRow[]): void => {
    snapshot = rows
    lexicon = rows.length > 0 ? rows.map((r) => r.name) : undefined
    onCounts?.({
      agentCount: rows.filter((r) => r.kind === 'agent').length,
      resourceCount: rows.filter((r) => r.kind === 'resource').length,
    })
    for (const listener of listeners) {
      try {
        listener()
      } catch {
        /* ignore */
      }
    }
  }

  const hostCandidates = async (query: string): Promise<CandidateRow[]> => {
    const rows = await api(`/api/candidates?q=${encodeURIComponent(query)}`)
    return Array.isArray(rows) ? rows : []
  }

  const source = {
    trigger: '@' as const,
    name: 'onenat',
    order: 2,
    showGroupTitle: false,
    async candidates(_session: unknown, req: any) {
      const query = String(req?.query ?? '')
      try {
        // 空查询直接复用预热快照，避免每次打开菜单都打一次 RPC
        if (query === '' && snapshot.length > 0) return rows(snapshot)
        const rowsNow = await hostCandidates(query)
        if (query === '') publish(rowsNow)
        return rows(rowsNow)
      } catch (err: any) {
        log(`候选拉取失败：${err?.message || err}`)
        STATUS.set({ state: 'error', detail: `候选拉取失败：${err?.message || err}` })
        return []
      }
    },
    warm() {
      void hostCandidates('')
        .then((rowsNow) => publish(rowsNow))
        .catch((err) => log(`预热失败：${err?.message || err}`))
    },
    lexicon() {
      return lexicon
    },
    subscribeLexicon(_session: unknown, listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    onPick(pick: any) {
      const uri = String(pick?.candidate?.value || '')
      const name = String(pick?.candidate?.name || '')
      if (!uri) return undefined
      return {
        insert: {
          source: 'onenat',
          ref: uri,
          label: name,
          clipboardText: `@[${name}](${uri})`,
        },
      }
    },
    codec: {
      clipboardText: (ref: string) => `@[${labelOf(ref)}](${ref})`,
      serialize: (ref: string) => Promise.resolve(`@[${labelOf(ref)}](${ref})`),
    },
  }

  const labelOf = (ref: string): string => {
    const hit = snapshot.find((row) => row.uri === ref)
    return hit?.name || ref.replace(/^onenat-(agent|resource):/, '')
  }

  const rows = (list: CandidateRow[]) =>
    list.map((row) => ({
      name: row.name,
      description: row.description,
      section: row.section,
      value: row.uri,
      icon: 'session' as const,
    }))

  return { source, refresh: () => hostCandidates('').then(publish).catch(() => {}) }
}

// ------------------------------------------------------------------- 设置页 UI

const CSS = `
.onm-root { display: flex; flex-direction: column; gap: 18px; padding: 4px 2px 32px; font-size: 13px; }
.onm-card { border: 1px solid var(--dsw-alias-border-secondary, #e2e8f0); border-radius: 10px; padding: 14px 16px; }
.onm-card > h3 { margin: 0 0 10px; font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.onm-muted { color: var(--dsw-alias-label-secondary, #64748b); font-size: 12px; line-height: 1.6; }
.onm-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.onm-row + .onm-row { margin-top: 8px; }
.onm-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px 12px; }
.onm-field { display: flex; flex-direction: column; gap: 4px; }
.onm-field > span { font-size: 11px; color: var(--dsw-alias-label-secondary, #64748b); }
.onm-field input, .onm-field select, .onm-field textarea {
  font: inherit; padding: 5px 8px; border-radius: 6px; width: 100%; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-secondary, #cbd5e1);
  background: var(--dsw-alias-bg-primary, #fff); color: inherit;
}
.onm-field textarea { min-height: 64px; resize: vertical; font-family: inherit; }
.onm-btn {
  font: inherit; padding: 4px 10px; border-radius: 6px; cursor: pointer; white-space: nowrap;
  border: 1px solid var(--dsw-alias-border-secondary, #cbd5e1);
  background: var(--dsw-alias-bg-primary, #fff); color: inherit;
}
.onm-btn:hover { border-color: var(--dsw-alias-brand-primary, #2563eb); }
.onm-btn.primary { background: var(--dsw-alias-brand-primary, #2563eb); border-color: transparent; color: #fff; }
.onm-btn.danger { color: #dc2626; }
.onm-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.onm-table th, .onm-table td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--dsw-alias-border-secondary, #e2e8f0); vertical-align: top; }
.onm-table th { font-weight: 600; color: var(--dsw-alias-label-secondary, #64748b); font-size: 11px; }
.onm-tag {
  display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 11px;
  border: 1px solid var(--dsw-alias-border-secondary, #cbd5e1);
}
.onm-tag.ok { color: #15803d; border-color: #86efac; }
.onm-tag.off { color: #b91c1c; border-color: #fca5a5; }
.onm-code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; white-space: pre-wrap; word-break: break-all; }
.onm-pre { max-height: 300px; overflow: auto; background: var(--dsw-alias-bg-secondary, #f8fafc); border-radius: 8px; padding: 10px; margin: 8px 0 0; }
.onm-banner { padding: 8px 10px; border-radius: 8px; font-size: 12px; }
.onm-banner.ok { background: rgba(22,163,74,.12); color: #15803d; }
.onm-banner.err { background: rgba(220,38,38,.12); color: #b91c1c; }
.onm-section-title { font-size: 12px; font-weight: 600; margin: 12px 0 6px; }
.onm-list { display: flex; flex-direction: column; gap: 6px; }
.onm-list-item { display: flex; align-items: center; gap: 8px; justify-content: space-between; padding: 6px 8px; border-radius: 8px; background: var(--dsw-alias-bg-secondary, #f8fafc); }
.onm-statusline {
  display: flex; align-items: center; gap: 8px;
  padding: 2px 4px; font-size: 11px; line-height: 1.6;
  color: var(--dsw-alias-label-secondary, #64748b);
}
.onm-statusdot { width: 7px; height: 7px; border-radius: 50%; flex: none; display: inline-block; }
`

function useAsync<T>(fn: () => Promise<T>, deps: unknown[], initial: T) {
  const [value, setValue] = React.useState<T>(initial)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | undefined>(undefined)
  const reload = React.useCallback(() => {
    setLoading(true)
    setError(undefined)
    fn()
      .then((result) => setValue(result))
      .catch((err) => setError(String(err?.message || err)))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  React.useEffect(() => {
    reload()
  }, [reload])
  return { value, loading, error, reload, setValue }
}

/**
 * 管理 API 客户端：每个函数对应 router.ts 的一条路由，避免在 UI 里拼路径。
 */
const consoleApi = {
  settingsGet: () => api('/api/settings'),
  settingsSave: (patch: unknown) => api('/api/settings', { method: 'POST', body: patch }),
  agentsList: () => api('/api/agents'),
  agentsSave: (agent: unknown) => api('/api/agents', { method: 'POST', body: agent }),
  agentsDelete: (id: string) => api(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  agentsPing: (key: string) => api(`/api/agents/${encodeURIComponent(key)}/ping`, { method: 'POST' }),
  agentsPreview: (key: string) => api(`/api/agents/${encodeURIComponent(key)}/preview`),
  resources: (refresh: boolean) => api(`/api/resources${refresh ? '?refresh=1' : ''}`),
  candidates: (query: string) => api(`/api/candidates?q=${encodeURIComponent(query)}`),
  parse: (text: string) => api('/api/debug/parse', { method: 'POST', body: { text } }),
  sshList: () => api('/api/ssh'),
  sshSave: (resource: unknown) => api('/api/ssh', { method: 'POST', body: resource }),
  sshDelete: (id: string) => api(`/api/ssh/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  sshTest: (id: string) => api(`/api/ssh/${encodeURIComponent(id)}/test`, { method: 'POST' }),
}

function Field(props: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; textarea?: boolean }) {
  return React.createElement(
    'label',
    { className: 'onm-field' },
    React.createElement('span', null, props.label),
    props.textarea
      ? React.createElement('textarea', {
          value: props.value,
          placeholder: props.placeholder,
          onChange: (e: any) => props.onChange(e.target.value),
        })
      : React.createElement('input', {
          value: props.value,
          placeholder: props.placeholder,
          onChange: (e: any) => props.onChange(e.target.value),
        }),
  )
}

function Btn(props: { children?: React.ReactNode; onClick: () => void; variant?: 'primary' | 'danger'; title?: string }) {
  return React.createElement(
    'button',
    {
      type: 'button',
      title: props.title,
      className: 'onm-btn' + (props.variant ? ' ' + props.variant : ''),
      onClick: props.onClick,
    },
    props.children,
  )
}

function Banner(props: { kind: 'ok' | 'err'; text: string }) {
  return React.createElement('div', { className: 'onm-banner ' + props.kind }, props.text)
}

// ---- 连接与默认设置 ----

function ConnectionCard(props: { settings: any; onSaved: () => void }) {
  const [baseUrl, setBaseUrl] = React.useState(String(props.settings?.onenat?.baseUrl || ''))
  const [apiKey, setApiKey] = React.useState(String(props.settings?.onenat?.apiKey || ''))
  const [reuse, setReuse] = React.useState(props.settings?.defaults?.reuseSession !== false)
  const [timeoutMs, setTimeoutMs] = React.useState(String(props.settings?.defaults?.timeoutMs || 900000))
  const [message, setMessage] = React.useState<{ kind: 'ok' | 'err'; text: string } | undefined>(undefined)
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    setBaseUrl(String(props.settings?.onenat?.baseUrl || ''))
    setApiKey(String(props.settings?.onenat?.apiKey || ''))
    setReuse(props.settings?.defaults?.reuseSession !== false)
    setTimeoutMs(String(props.settings?.defaults?.timeoutMs || 900000))
  }, [props.settings])

  const save = (): void => {
    setBusy(true)
    consoleApi.settingsSave({
      onenat: { baseUrl, apiKey },
      defaults: { reuseSession: reuse, timeoutMs: Number(timeoutMs) || 900000 },
    })
      .then(() => {
        setMessage({ kind: 'ok', text: '已保存。ONENAT 资源目录将立即按新配置刷新。' })
        props.onSaved()
      })
      .catch((err) => setMessage({ kind: 'err', text: String(err?.message || err) }))
      .finally(() => setBusy(false))
  }

  return React.createElement(
    'div',
    { className: 'onm-card' },
    React.createElement('h3', null, '① ONENAT 连接与派发默认值'),
    React.createElement(
      'div',
      { className: 'onm-grid' },
      React.createElement(Field, { label: 'ONENAT 服务地址', value: baseUrl, onChange: setBaseUrl, placeholder: 'https://onenat.sooncore.com' }),
      React.createElement(Field, { label: 'ONENAT API Key', value: apiKey, onChange: setApiKey, placeholder: 'onk-…' }),
      React.createElement(Field, { label: '派发超时（毫秒）', value: timeoutMs, onChange: setTimeoutMs }),
    ),
    React.createElement(
      'div',
      { className: 'onm-row' },
      React.createElement('label', { className: 'onm-row' },
        React.createElement('input', { type: 'checkbox', checked: reuse, onChange: (e: any) => setReuse(e.target.checked) }),
        React.createElement('span', null, '同一子智能体在本会话中复用远端会话（多轮续聊）'),
      ),
    ),
    React.createElement('div', { className: 'onm-row' }, React.createElement(Btn, { variant: 'primary', onClick: save }, busy ? '保存中…' : '保存')),
    message ? React.createElement(Banner, message) : null,
  )
}

// ---- 资源目录 ----

function ResourceCard() {
  const state = useAsync(async () => (await consoleApi.resources(true)) || {}, [], {} as any)
  const endpoints: any[] = state.value?.endpoints || []
  return React.createElement(
    'div',
    { className: 'onm-card' },
    React.createElement('h3', null, '② ONENAT 资源目录', React.createElement('span', { className: 'onm-tag' }, String(endpoints.length))),
    React.createElement('div', { className: 'onm-row' },
      React.createElement(Btn, { onClick: state.reload }, state.loading ? '刷新中…' : '强制刷新'),
      React.createElement('span', { className: 'onm-muted' }, '在输入框用 @ 可以直接选中下列资源；条目里的公网入口是实时解析结果。'),
    ),
    state.error ? React.createElement(Banner, { kind: 'err', text: state.error }) : null,
    endpoints.length === 0
      ? React.createElement('div', { className: 'onm-muted' }, '暂无资源（检查 ONENAT 地址与 Key，或确认 ONENAT 客户端在线）。')
      : React.createElement('table', { className: 'onm-table' },
          React.createElement('thead', null, React.createElement('tr', null,
            React.createElement('th', null, '@ 名称'),
            React.createElement('th', null, '类型'),
            React.createElement('th', null, '状态'),
            React.createElement('th', null, '实时入口'),
            React.createElement('th', null, '隧道 / 技能'),
          )),
          React.createElement('tbody', null, endpoints.map((ep) => React.createElement('tr', { key: ep.mappingId || ep.appId },
            React.createElement('td', null, '@' + (ep.appName || ep.note || ep.mappingId)),
            React.createElement('td', null, String(ep.kind || '').toUpperCase()),
            React.createElement('td', null, React.createElement('span', { className: 'onm-tag ' + (ep.online ? 'ok' : 'off') }, ep.online ? '在线' : '离线')),
            React.createElement('td', { className: 'onm-code' }, ep.kind === 'ssh' ? `ssh -p ${ep.port} @${ep.host}` : (ep.baseUrl || `${ep.proto}://${ep.host}:${ep.port || '?'}`)),
            React.createElement('td', null, (ep.tunnelName || '') + (ep.appSkills?.length ? ` · ${ep.appSkills.length} 技能` : '')),
          ))),
        ),
  )
}

// ---- 子智能体管理 ----

const EMPTY_FORM = {
  id: '',
  name: '',
  refKind: 'mapping',
  refValue: '',
  apiBaseUrl: '',
  apiKey: '',
  agentPreset: 'cordis',
  permission: '',
  provider: '',
  model: '',
  workDir: '',
  systemPrompt: '',
  description: '',
  skills: '',
  enabled: true,
}

function AgentCard(props: { agents: any[]; endpoints: any[]; onChanged: () => void }) {
  const [form, setForm] = React.useState<any>({ ...EMPTY_FORM })
  const [message, setMessage] = React.useState<{ kind: 'ok' | 'err'; text: string } | undefined>(undefined)
  const [detail, setDetail] = React.useState<string | undefined>(undefined)
  const [busy, setBusy] = React.useState(false)
  const set = (patch: Record<string, unknown>): void => setForm((prev: any) => ({ ...prev, ...patch }))

  const edit = (agent: any): void => {
    setForm({
      id: agent.id,
      name: agent.name,
      refKind: agent.dshRef?.kind || 'mapping',
      refValue: agent.dshRef?.kind === 'app' ? agent.dshRef.appId : agent.dshRef?.mappingId || '',
      apiBaseUrl: agent.dshRef?.kind === 'direct' ? agent.dshRef.apiBaseUrl : '',
      apiKey: agent.apiKey || '',
      agentPreset: agent.agentPreset || 'cordis',
      permission: agent.permission || '',
      provider: agent.provider || '',
      model: agent.model || '',
      workDir: agent.workDir || '',
      systemPrompt: agent.systemPrompt || '',
      description: agent.description || '',
      skills: (agent.skills || []).join(', '),
      enabled: agent.enabled !== false,
    })
    setDetail(undefined)
  }

  const save = (): void => {
    if (!form.name.trim()) {
      setMessage({ kind: 'err', text: '请填写子智能体名称（@ 菜单里显示的名字）' })
      return
    }
    const dshRef = form.refKind === 'direct'
      ? { kind: 'direct', apiBaseUrl: form.apiBaseUrl.trim() }
      : form.refKind === 'app'
        ? { kind: 'app', appId: form.refValue }
        : { kind: 'mapping', mappingId: form.refValue }
    if (dshRef.kind !== 'direct' && !form.refValue) {
      setMessage({ kind: 'err', text: '请选择绑定的 DSH 实体（ONENAT 映射 / 应用）' })
      return
    }
    setBusy(true)
    consoleApi.agentsSave({
      id: form.id || undefined,
      name: form.name.trim(),
      dshRef,
      apiKey: form.apiKey || undefined,
      agentPreset: form.agentPreset || undefined,
      permission: form.permission || undefined,
      provider: form.provider || undefined,
      model: form.model || undefined,
      workDir: form.workDir || undefined,
      systemPrompt: form.systemPrompt || undefined,
      description: form.description || undefined,
      skills: form.skills.split(',').map((s: string) => s.trim()).filter(Boolean),
      enabled: form.enabled,
    })
      .then(() => {
        setMessage({ kind: 'ok', text: '已保存。输入框 @ 菜单会立即出现该子智能体。' })
        setForm({ ...EMPTY_FORM })
        props.onChanged()
      })
      .catch((err) => setMessage({ kind: 'err', text: String(err?.message || err) }))
      .finally(() => setBusy(false))
  }

  const ping = (agent: any): void => {
    setDetail('探测中…')
    consoleApi.agentsPing(agent.id)
      .then((data) => setDetail(`[${agent.name}] 解析入口 ${data?.resolved?.baseUrl || '-'}\n` + JSON.stringify(data?.ping, null, 2)))
      .catch((err) => setDetail(String(err?.message || err)))
  }

  const preview = (agent: any): void => {
    setDetail('生成中…')
    consoleApi.agentsPreview(agent.id)
      .then((data) => setDetail(`[${agent.name}] 派发提示词预览（脱敏）\n\n${data?.prompt || ''}`))
      .catch((err) => setDetail(String(err?.message || err)))
  }

  const remove = (agent: any): void => {
    if (form.id !== agent.id) {
      // 两段确认：第一次点击把该行切到"待删除"状态
      setForm((prev: any) => ({ ...prev, id: agent.id, name: agent.name }))
      setMessage({ kind: 'err', text: `再次点击「删除」确认删除子智能体「${agent.name}」` })
      return
    }
    consoleApi.agentsDelete(agent.id)
      .then(() => {
        setMessage({ kind: 'ok', text: `已删除「${agent.name}」` })
        setForm({ ...EMPTY_FORM })
        props.onChanged()
      })
      .catch((err) => setMessage({ kind: 'err', text: String(err?.message || err) }))
  }

  const dshEndpoints = props.endpoints.filter((ep: any) => ep.kind === 'dsh')
  const refOptions = form.refKind === 'app'
    ? props.endpoints.filter((ep: any) => ep.appId)
    : form.refKind === 'mapping'
      ? props.endpoints
      : []

  return React.createElement(
    'div',
    { className: 'onm-card' },
    React.createElement('h3', null, '③ 子智能体管理', React.createElement('span', { className: 'onm-tag' }, String(props.agents.length))),
    React.createElement('div', { className: 'onm-muted' },
      '子智能体 = ONENAT 上的一个 DSH 实体（只存稳定 ID，端口漂移免疫）。绑好后在输入框打 @ 就能指名派发。',
      dshEndpoints.length > 0 ? ` 已识别 ${dshEndpoints.length} 个 DSH 实体。` : ' 暂未在资源目录里识别到 DSH 实体（app.type=http-api 且带 dsh 技能）。',
    ),
    message ? React.createElement(Banner, message) : null,
    props.agents.length === 0
      ? React.createElement('div', { className: 'onm-muted' }, '还没有子智能体，用下面的表单新建一个。')
      : React.createElement('table', { className: 'onm-table' },
          React.createElement('thead', null, React.createElement('tr', null,
            React.createElement('th', null, '@ 名称'),
            React.createElement('th', null, '绑定实体'),
            React.createElement('th', null, '模型 / preset'),
            React.createElement('th', null, '工作目录'),
            React.createElement('th', null, '技能 / 资源'),
            React.createElement('th', null, '操作'),
          )),
          React.createElement('tbody', null, props.agents.map((agent) => React.createElement('tr', { key: agent.id },
            React.createElement('td', null, '@' + agent.name, agent.enabled === false ? React.createElement('span', { className: 'onm-tag off' }, '停用') : null),
            React.createElement('td', { className: 'onm-code' }, agent.dshRef?.kind === 'direct' ? agent.dshRef.apiBaseUrl : (agent.dshRef?.kind === 'app' ? agent.dshRef.appId : agent.dshRef?.mappingId)),
            React.createElement('td', null, `${agent.model || '远端默认'}${agent.agentPreset ? ' · ' + agent.agentPreset : ''}`),
            React.createElement('td', { className: 'onm-code' }, agent.workDir || '—'),
            React.createElement('td', null, `${(agent.skills || []).length} 技能 · ${(agent.resources || []).length} 资源`),
            React.createElement('td', null, React.createElement('div', { className: 'onm-row' },
              React.createElement(Btn, { onClick: () => edit(agent) }, '编辑'),
              React.createElement(Btn, { onClick: () => ping(agent) }, '探测'),
              React.createElement(Btn, { onClick: () => preview(agent) }, '提示词'),
              React.createElement(Btn, { variant: 'danger', onClick: () => remove(agent) }, '删除'),
            )),
          ))),
        ),

    React.createElement('div', { className: 'onm-section-title' }, form.id ? `编辑：${form.name}` : '新增子智能体'),
    React.createElement('div', { className: 'onm-grid' },
      React.createElement(Field, { label: '@ 名称（唯一、便于指名）', value: form.name, onChange: (v: string) => set({ name: v }), placeholder: '例如 kb-136-builder' }),
      React.createElement('label', { className: 'onm-field' },
        React.createElement('span', null, 'DSH 实体绑定方式'),
        React.createElement('select', { value: form.refKind, onChange: (e: any) => set({ refKind: e.target.value, refValue: '' }) },
          React.createElement('option', { value: 'mapping' }, 'ONENAT 映射（mappingId，推荐）'),
          React.createElement('option', { value: 'app' }, 'ONENAT 应用（appId）'),
          React.createElement('option', { value: 'direct' }, '直连 URL（兜底）'),
        ),
      ),
      form.refKind === 'direct'
        ? React.createElement(Field, { label: 'API Base URL', value: form.apiBaseUrl, onChange: (v: string) => set({ apiBaseUrl: v }), placeholder: 'http://host:port/api/v1' })
        : React.createElement('label', { className: 'onm-field' },
            React.createElement('span', null, form.refKind === 'app' ? '选择应用' : '选择映射'),
            React.createElement('select', { value: form.refValue, onChange: (e: any) => set({ refValue: e.target.value }) },
              React.createElement('option', { value: '' }, '— 请选择 —'),
              refOptions.map((ep: any) => React.createElement('option', {
                key: form.refKind === 'app' ? ep.appId : ep.mappingId,
                value: form.refKind === 'app' ? ep.appId : ep.mappingId,
              }, `${ep.appName || ep.note || ep.mappingId} · ${String(ep.kind).toUpperCase()} · ${ep.online ? '在线' : '离线'}`)),
            ),
          ),
      React.createElement(Field, { label: 'Agent Preset', value: form.agentPreset, onChange: (v: string) => set({ agentPreset: v }), placeholder: 'cordis' }),
      React.createElement(Field, { label: '模型（provider/model 或 model）', value: form.model, onChange: (v: string) => set({ model: v }) }),
      React.createElement(Field, { label: '运行权限', value: form.permission, onChange: (v: string) => set({ permission: v }), placeholder: 'danger-full-access / workspace-write / read-only' }),
      React.createElement(Field, { label: '远端工作目录（绝对路径）', value: form.workDir, onChange: (v: string) => set({ workDir: v }) }),
      React.createElement(Field, { label: '远端已装技能（逗号分隔，派发时写 /名 手势）', value: form.skills, onChange: (v: string) => set({ skills: v }) }),
      React.createElement(Field, { label: '一句话说明（@ 菜单副标题）', value: form.description, onChange: (v: string) => set({ description: v }) }),
    ),
    React.createElement('div', { className: 'onm-field', style: { marginTop: 8 } },
      React.createElement('span', null, '角色提示词（systemPrompt，派发时置于任务之前）'),
      React.createElement('textarea', { value: form.systemPrompt, onChange: (e: any) => set({ systemPrompt: e.target.value }) }),
    ),
    React.createElement('div', { className: 'onm-row', style: { marginTop: 10 } },
      React.createElement(Btn, { variant: 'primary', onClick: save }, busy ? '保存中…' : (form.id ? '更新子智能体' : '新增子智能体')),
      form.id ? React.createElement(Btn, { onClick: () => setForm({ ...EMPTY_FORM }) }, '取消编辑') : null,
      React.createElement('label', { className: 'onm-row' },
        React.createElement('input', { type: 'checkbox', checked: form.enabled, onChange: (e: any) => set({ enabled: e.target.checked }) }),
        React.createElement('span', null, '启用'),
      ),
    ),
    detail ? React.createElement('pre', { className: 'onm-pre onm-code' }, detail) : null,
  )
}

// ---- 本地 SSH 资源池 ----

function SshCard(props: { onChanged: () => void }) {
  const state = useAsync(async () => (await consoleApi.sshList()) || [], [], [] as any[])
  const [form, setForm] = React.useState<any>({ id: '', name: '', host: '', port: '22', authType: 'password', username: 'root', password: '', privateKey: '', description: '' })
  const [message, setMessage] = React.useState<{ kind: 'ok' | 'err'; text: string } | undefined>(undefined)
  const [detail, setDetail] = React.useState<string | undefined>(undefined)
  const resources: any[] = Array.isArray(state.value) ? state.value : []
  const set = (patch: Record<string, unknown>): void => setForm((prev: any) => ({ ...prev, ...patch }))

  const save = (): void => {
    consoleApi.sshSave({ ...form, port: Number(form.port) || 22 })
      .then(() => {
        setMessage({ kind: 'ok', text: '已保存到本地 SSH 资源池。' })
        setForm({ id: '', name: '', host: '', port: '22', authType: 'password', username: 'root', password: '', privateKey: '', description: '' })
        state.reload()
        props.onChanged()
      })
      .catch((err) => setMessage({ kind: 'err', text: String(err?.message || err) }))
  }

  return React.createElement(
    'div',
    { className: 'onm-card' },
    React.createElement('h3', null, '④ 本地 SSH 资源池', React.createElement('span', { className: 'onm-tag' }, String(resources.length))),
    React.createElement('div', { className: 'onm-muted' }, '补充 ONENAT 之外的直连主机。@ 菜单里选中后，凭证会随资源清单一并交给执行方。'),
    message ? React.createElement(Banner, message) : null,
    resources.length === 0
      ? React.createElement('div', { className: 'onm-muted' }, '暂无本地 SSH 资源。')
      : React.createElement('div', { className: 'onm-list' }, resources.map((r) => React.createElement('div', { className: 'onm-list-item', key: r.id },
          React.createElement('span', null, `${r.name} · ${r.username}@${r.host}:${r.port}${r.lastTestOk === undefined ? '' : (r.lastTestOk ? ' · 上次连通 ✓' : ' · 上次失败 ✗')}`),
          React.createElement('div', { className: 'onm-row' },
            React.createElement(Btn, { onClick: () => { setDetail('测试中…'); consoleApi.sshTest(r.id).then((d) => setDetail(JSON.stringify(d, null, 2))).catch((e) => setDetail(String(e?.message || e))) } }, '测试'),
            React.createElement(Btn, { onClick: () => setForm({ id: r.id, name: r.name, host: r.host, port: String(r.port), authType: r.authType, username: r.username, password: '', privateKey: '', description: r.description || '' }) }, '编辑'),
            React.createElement(Btn, { variant: 'danger', onClick: () => { consoleApi.sshDelete(r.id).then(() => { state.reload(); props.onChanged() }) } }, '删除'),
          ),
        ))),
    React.createElement('div', { className: 'onm-section-title' }, form.id ? `编辑：${form.name}` : '新增 SSH 资源'),
    React.createElement('div', { className: 'onm-grid' },
      React.createElement(Field, { label: '名称（@ 菜单显示）', value: form.name, onChange: (v: string) => set({ name: v }) }),
      React.createElement(Field, { label: '主机 IP / 域名', value: form.host, onChange: (v: string) => set({ host: v }) }),
      React.createElement(Field, { label: '端口', value: form.port, onChange: (v: string) => set({ port: v }) }),
      React.createElement(Field, { label: '登录账号', value: form.username, onChange: (v: string) => set({ username: v }) }),
      React.createElement('label', { className: 'onm-field' },
        React.createElement('span', null, '认证方式'),
        React.createElement('select', { value: form.authType, onChange: (e: any) => set({ authType: e.target.value }) },
          React.createElement('option', { value: 'password' }, '密码'),
          React.createElement('option', { value: 'key' }, '私钥'),
        ),
      ),
      React.createElement(Field, { label: '说明', value: form.description, onChange: (v: string) => set({ description: v }) }),
    ),
    form.authType === 'password'
      ? React.createElement(Field, { label: '密码（留空表示不修改）', value: form.password, onChange: (v: string) => set({ password: v }) })
      : React.createElement('div', { className: 'onm-field', style: { marginTop: 8 } },
          React.createElement('span', null, '私钥（PEM，留空表示不修改）'),
          React.createElement('textarea', { value: form.privateKey, onChange: (e: any) => set({ privateKey: e.target.value }) }),
        ),
    React.createElement('div', { className: 'onm-row', style: { marginTop: 10 } },
      React.createElement(Btn, { variant: 'primary', onClick: save }, form.id ? '更新' : '新增'),
      form.id ? React.createElement(Btn, { onClick: () => setForm({ id: '', name: '', host: '', port: '22', authType: 'password', username: 'root', password: '', privateKey: '', description: '' }) }, '取消编辑') : null,
    ),
    detail ? React.createElement('pre', { className: 'onm-pre onm-code' }, detail) : null,
  )
}

// ---- 输入框下方的 @ 状态指示器 ----

/**
 * 输入框下方的一行状态：`@` 源是否已就绪 + 当前能 @ 到多少实体。
 * 它同时是这套集成的自检入口 —— 注册失败/候选拉取失败的原因直接显示在这里。
 */
function MentionStatusLine() {
  const [status, setStatus] = React.useState(STATUS.get())
  React.useEffect(() => STATUS.subscribe(() => setStatus(STATUS.get())), [])
  const [busy, setBusy] = React.useState(false)

  const tone = status.state === 'ready' ? '#16a34a' : status.state === 'error' ? '#dc2626' : '#d97706'
  const label =
    status.state === 'ready'
      ? `WorkBuddy @ 就绪 · ${status.agentCount} 个子智能体 / ${status.resourceCount} 个资源可 @`
      : `WorkBuddy @ ${status.state === 'error' ? '异常' : '等待中'}：${status.detail}`

  const refresh = (): void => {
    setBusy(true)
    void (async () => {
      try {
        const rows: any[] = (await consoleApi.candidates('')) || []
        STATUS.set({
          state: 'ready',
          sourceRegistered: STATUS.get().sourceRegistered,
          agentCount: rows.filter((r) => r.kind === 'agent').length,
          resourceCount: rows.filter((r) => r.kind === 'resource').length,
          detail: '已就绪',
        })
      } catch (err: any) {
        STATUS.set({ state: 'error', detail: String(err?.message || err) })
      } finally {
        setBusy(false)
      }
    })()
  }

  return React.createElement(
    'div',
    { className: 'onm-statusline' },
    React.createElement('span', { className: 'onm-statusdot', style: { background: tone } }),
    React.createElement('span', null, label),
    React.createElement(
      'button',
      { type: 'button', className: 'onm-btn', style: { padding: '0 8px', fontSize: '11px' }, onClick: refresh },
      busy ? '刷新中…' : '刷新',
    ),
  )
}

// ---- 页面 ----

function MentionTester() {
  const [text, setText] = React.useState('请 @kb-136-builder 帮我检查一下环境')
  const [result, setResult] = React.useState<string | undefined>(undefined)
  return React.createElement(
    'div',
    { className: 'onm-card' },
    React.createElement('h3', null, '⑤ 提及解析自检'),
    React.createElement('div', { className: 'onm-muted' }, '验证一段文本会被解析成哪些实体（用于确认 @ 名称是否唯一可辨）。'),
    React.createElement('div', { className: 'onm-row' },
      React.createElement('input', { style: { flex: 1, padding: '5px 8px', borderRadius: 6, border: '1px solid var(--dsw-alias-border-secondary, #cbd5e1)', font: 'inherit', background: 'var(--dsw-alias-bg-primary, #fff)', color: 'inherit' }, value: text, onChange: (e: any) => setText(e.target.value) }),
      React.createElement(Btn, { onClick: () => consoleApi.parse(text).then((d) => setResult(JSON.stringify(d, null, 2))).catch((e) => setResult(String(e?.message || e))) }, '解析'),
    ),
    result ? React.createElement('pre', { className: 'onm-pre onm-code' }, result) : null,
  )
}

function Section(props: { onMentionChanged?: () => void }) {
  const settings = useAsync(async () => (await consoleApi.settingsGet()) || {}, [], {} as any)
  const agents = useAsync(async () => (await consoleApi.agentsList()) || [], [], [] as any[])
  const resources = useAsync(async () => (await consoleApi.resources(false)) || {}, [], {} as any)

  const refreshAll = (): void => {
    settings.reload()
    agents.reload()
    resources.reload()
    props.onMentionChanged?.()
  }

  const endpoints: any[] = resources.value?.endpoints || []
  const agentList: any[] = Array.isArray(agents.value) ? agents.value : []

  return React.createElement(
    'div',
    { className: 'onm-root' },
    React.createElement('div', { className: 'onm-muted' },
      'OneNat WorkBuddy @ —— 在 DSH 原生输入框用 @ 指定 ONENAT 上的子智能体与资源。',
      '选中即插入胶囊，发送后由宿主把「指认指令」与「资源清单（实时入口 + 凭证策略）」注入本轮上下文；',
      '子智能体派发走 onenat_agent 工具，远端会话按本会话长持复用。',
    ),
    agents.error ? React.createElement(Banner, { kind: 'err', text: agents.error }) : null,
    React.createElement(ConnectionCard, { settings: settings.value, onSaved: refreshAll }),
    React.createElement(ResourceCard, null),
    React.createElement(AgentCard, { agents: agentList, endpoints, onChanged: refreshAll }),
    React.createElement(SshCard, { onChanged: refreshAll }),
    React.createElement(MentionTester, null),
  )
}

// ---------------------------------------------------------------------- apply

export function apply(ctx: ClientCtx): void {
  const log = (msg: string): void => {
    console.log(`[${NS}] ${msg}`)
  }

  // 1. 样式
  ctx.effect(() => insertStyles(CSS), `${NS}: styles`)

  // 2. @ 输入触发源
  //
  // 用 ctx.inject 等 inputTriggers 就绪，而不是一次性 ctx.get：
  // 客户端插件是按装填顺序并行 apply 的，不能假设 ui-input-trigger 一定先于本插件完成注册。
  // 早前一次性读取会静默跳过注册 —— @ 菜单里就完全不出现 ONENAT 三组候选。
  const mention = createMentionSource(log, (counts) => {
    STATUS.set({ state: 'ready', sourceRegistered: true, ...counts, detail: '已就绪' })
  })
  const ctxAny = ctx as any
  if (typeof ctxAny.inject === 'function') {
    ctxAny.inject(['inputTriggers'], (scope: any) => {
      const triggers = scope.inputTriggers
      if (triggers === undefined) return
      scope.effect(
        () => triggers.registerSource(mention.source),
        `${NS}: @ source`,
      )
      STATUS.set({ state: 'ready', sourceRegistered: true, detail: '已就绪' })
      log('@ 源已注册（候选：ONENAT 子智能体 / ONENAT 资源 / 本地 SSH 资源）')
      void mention.refresh()
    })
  } else {
    const inputTriggers = ctxAny.get?.('inputTriggers')
    if (inputTriggers !== undefined) {
      ctx.effect(() => inputTriggers.registerSource(mention.source), `${NS}: @ source`)
      STATUS.set({ state: 'ready', sourceRegistered: true, detail: '已就绪（即时读取）' })
    } else {
      STATUS.set({ state: 'error', sourceRegistered: false, detail: 'inputTriggers 服务不可用：@ 菜单未注册（设置页仍可用）' })
      log('inputTriggers 服务不可用：@ 菜单未注册（管理页仍可用）')
    }
  }

  // 3. 设置页（root 作用域，零替换风险）
  ctx.effect(
    () =>
      ctx.slots.inject('settings.section', () => {
        // NOTE: `{ name: ... }` 必须与 register( 同行内联——注入器骨架校验
        // 用 register\(\{ 前缀正则匹配 slot 名，换行会导致重启恢复被跳过。
        const unregister = ctx.slots.register({ name: 'settings.section', id: 'onenat-workbuddy-mention', order: 42, label: () => 'WorkBuddy @' }, () => React.createElement(Section, { onMentionChanged: () => { void mention.refresh() } }))
        return () => {
          unregister()
        }
      }),
    `${NS}: settings section`,
  )

  // 4. 输入框下方状态行（注册失败时这里会直接写出原因）
  ctx.effect(
    () =>
      ctx.slots.inject('conversation.composer.dock', () => {
        // NOTE: `{ name: ... }` 必须与 register( 同行内联——注入器骨架校验
        // 用 register\(\{ 前缀正则匹配 slot 名，换行会导致重启恢复被跳过。
        const unregister = ctx.slots.register({ name: 'conversation.composer.dock', id: 'onenat-workbuddy-mention-status', order: 60 }, MentionStatusLine)
        return () => {
          unregister()
        }
      }),
    `${NS}: composer status line`,
  )
}
