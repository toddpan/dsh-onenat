/**
 * @dsh-external/onenat-workbuddy-mention - 模型工具
 *
 *  onenat_agent   —— 把任务派发给 ONENAT 上的子智能体（远端 DSH 会话，长持复用）
 *  onenat_manage  —— 子智能体 / ONENAT 资源 / 本地 SSH 资源池的管理面
 *
 * 资源「自身」的使用不需要专用工具：@资源 注入的清单已给出入口与凭证，
 * 模型用自带的 bash / web_fetch 即可 —— 不再新增一层转手工具。
 */

import type { Context } from 'cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'

import { DshClient } from './remote-client.js'
import type { AgentRunner, AgentRunResult } from './agent-runner.js'
import type { MentionParser } from './mentions.js'
import type { OnenatDirectory } from './onenat.js'
import type { AgentResolver } from './resolver.js'
import type { SshResourceStore } from './ssh-store.js'
import type { WorkStore } from './store.js'
import {
  SshInputError,
  execOnSshResource,
  maskSshResource,
  newSshResourceId,
  normalizeSshResource,
  testSshResource,
} from './ssh-resources.js'
import type { SubAgent } from './types.js'

/** jobs 服务的最小结构面（避免编译期依赖 @deepseek-ai/dsh-jobs 的导出名） */
interface JobHooksLike {
  cancel(reason?: string): void
  done: Promise<{ status: 'completed' | 'killed' | 'failed'; detail?: string; output?: string }>
  readOutput?(): string
}
interface JobsLike {
  start(spec: { kind: 'subagent'; label: string; owner?: Agent; run(): JobHooksLike }): string
}

export interface ToolDeps {
  store: WorkStore
  directory: OnenatDirectory
  resolver: AgentResolver
  runner: AgentRunner
  sshStore: SshResourceStore
  parser: MentionParser
  log: (msg: string) => void
}

const TEXT_OUTPUT = {
  schema: { type: 'string' } as const,
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function errText(err: any): string {
  return String(err?.message || err)
}

export function registerTools(ctx: Context, deps: ToolDeps): void {
  registerAgentTool(ctx, deps)
  registerManageTool(ctx, deps)
  registerResourceTool(ctx, deps)
  registerSshExecTool(ctx, deps)
}

// ---------------------------------------------------------------- onenat_agent

function registerAgentTool(ctx: Context, deps: ToolDeps): void {
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'onenat_agent',
          description:
            '把任务派发给 OneNat 上的子智能体（远端 DSH 节点上的独立智能体会话，有自己的文件/命令/网络工具与工作目录）。'
            + '用 onenat_manage {action:"list"} 查看可用的子智能体；用户在消息里用 @ 指定了子智能体时按其指认调用。'
            + '同一子智能体在本会话中默认复用远端会话（多轮续聊）；task 必须自包含（远端子智能体看不到本会话上下文）。'
            + '默认前台等待结果；run_in_background=true 时立即返回后台作业 ID（用 job_output 读取进度与最终结果，job_kill 终止）。',
          parameters: {
            agent: { type: 'string', description: '子智能体名称或 ID（@ 菜单里的名字，或 onenat_manage list 返回的 id）' },
            task: {
              type: 'string',
              description: '完整、自包含的任务描述：目标、约束、期望产出、必要的背景信息全部写进来（远端看不到本会话上下文）',
            },
            resources: {
              type: 'array',
              items: { type: 'string' },
              description: '本轮额外指定给子智能体的资源（ONENAT mappingId/appId，或本地 SSH 资源的 ssh:<id>；@ 菜单里选中过的资源可在此传入）',
            },
            new_session: { type: 'boolean', description: 'true = 为该子智能体开一个全新的远端会话（丢弃之前的上下文）' },
            session_scope: {
              type: 'string',
              description: '远端会话的归属作用域（默认当前会话 ID）；同一作用域 + 同一子智能体复用同一远端会话',
            },
            timeout_ms: { type: 'number', description: '单次派发超时毫秒（默认取插件设置）' },
            run_in_background: { type: 'boolean', description: 'true = 后台执行，立即返回作业 ID（长任务推荐）' },
          },
          output: TEXT_OUTPUT,
          async execute(args: any, exec: ToolRunContext): Promise<string> {
            const agentKey = String(args?.agent || '').trim()
            const task = String(args?.task || '')
            if (!agentKey) return json({ ok: false, error: '缺少 agent（子智能体名称或 ID）' })
            if (!task.trim()) return json({ ok: false, error: '缺少 task（任务描述）' })

            const resourceIds = Array.isArray(args?.resources) ? args.resources.map((x: unknown) => String(x)) : []
            const scope = args?.session_scope ? String(args.session_scope) : (exec.agent ? String(exec.agent.id) : undefined)
            const timeoutMs = Number(args?.timeout_ms) > 0 ? Number(args.timeout_ms) : undefined

            if (args?.run_in_background === true) {
              return startBackground(ctx, deps, {
                agentKey,
                task,
                resourceIds,
                scope,
                timeoutMs,
                newSession: args?.new_session === true,
                owner: exec.agent,
              })
            }

            const result = await deps.runner.run(agentKey, task, {
              resourceIds,
              scope,
              newSession: args?.new_session === true,
              timeoutMs,
              signal: exec.signal,
            })
            deps.log(`onenat_agent ${agentKey} → ${result.ok ? 'ok' : 'fail'}（${result.ms}ms, session ${result.remoteSessionId || '-'}）`)
            return json(result)
          },
        }),
      ),
    'onenat-workbuddy-mention: onenat_agent tool',
  )
}

interface BackgroundSpec {
  agentKey: string
  task: string
  resourceIds: string[]
  scope?: string
  timeoutMs?: number
  newSession: boolean
  owner?: Agent
}

/** 后台派发：注册 jobs 作业，进度经 job_output 增量读取 */
function startBackground(ctx: Context, deps: ToolDeps, spec: BackgroundSpec): string {
  const jobs = ctx.get('jobs') as JobsLike | undefined
  if (jobs === undefined) {
    return json({ ok: false, error: '后台作业不可用（未加载 @deepseek-ai/dsh-jobs）；请改用前台调用（省略 run_in_background）' })
  }

  const controller = new AbortController()
  const progress: string[] = []
  let cursor = 0
  let settled: AgentRunResult | undefined

  const jobId = jobs.start({
    kind: 'subagent',
    label: `onenat:${spec.agentKey}`,
    ...(spec.owner ? { owner: spec.owner } : {}),
    run: (): JobHooksLike => {
      const done = deps.runner
        .run(spec.agentKey, spec.task, {
          resourceIds: spec.resourceIds,
          scope: spec.scope,
          newSession: spec.newSession,
          timeoutMs: spec.timeoutMs,
          signal: controller.signal,
          onProgress: (event) => {
            if (event.type === 'delta' || event.type === 'reasoning') {
              // 流式增量按段落聚合，避免进度流被逐字刷屏
              const marker = event.type === 'delta' ? '▲ ' : '💭 '
              const last = progress[progress.length - 1]
              if (last !== undefined && last.startsWith(marker)) {
                progress[progress.length - 1] = (last + event.text).slice(0, 8000)
              } else {
                progress.push(marker + event.text)
              }
              return
            }
            progress.push((event.type === 'tool' ? '🔧 ' : '· ') + event.text)
          },
        })
        .then((result) => {
          settled = result
          if (!result.ok) return { status: 'failed' as const, detail: result.error || '派发失败', output: renderBackgroundResult(result) }
          return { status: 'completed' as const, output: renderBackgroundResult(result) }
        })
        .catch((err) => ({
          status: 'failed' as const,
          detail: errText(err),
          output: `onenat_agent(${spec.agentKey}) 执行异常：${errText(err)}`,
        }))
      return {
        cancel: () => controller.abort(),
        done,
        readOutput: () => {
          if (settled !== undefined) return ''
          const slice = progress.slice(cursor).join('\n')
          cursor = progress.length
          return slice
        },
      }
    },
  })

  return json({
    ok: true,
    background: true,
    jobId,
    agent: spec.agentKey,
    hint: '已后台派发。用 job_output 读取进度与最终结果；job_kill 终止。远端会话 ID 会在最终结果里给出（可继续追问）。',
  })
}

function renderBackgroundResult(result: AgentRunResult): string {
  const lines: string[] = []
  lines.push(`[onenat_agent] 子智能体：${result.agentName}（${result.agentId}）`)
  lines.push(`状态：${result.ok ? '成功' : '失败'} · 耗时 ${result.ms}ms · 入口 ${result.entry || '-'} · 远端会话 ${result.remoteSessionId || '-'}${result.sessionReused ? '（复用）' : '（新建）'}`)
  if (result.error) lines.push(`错误：${result.error}`)
  if (result.tools.length > 0) {
    lines.push(`工具调用（${result.tools.length}）：${result.tools.map((t) => `${t.name}${t.status === 'done' ? '' : `[${t.status}]`}`).join(', ')}`)
  }
  if (result.output) {
    lines.push('')
    lines.push('--- 远端结论 ---')
    lines.push(result.output)
  }
  return lines.join('\n')
}

// --------------------------------------------------------------- onenat_manage

function registerManageTool(ctx: Context, deps: ToolDeps): void {
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'onenat_manage',
          description:
            'OneNat WorkBuddy 管理面：子智能体（list/upsert/delete/ping/preview/models/presets/sessions/session-clear）、'
            + 'ONENAT 资源目录（resources/resolve/refresh）、本地 SSH 资源池（ssh-list/ssh-get/ssh-upsert/ssh-delete/ssh-test/ssh-exec/skill）、'
            + '设置（settings-get/settings-set）。'
            + '用户在输入框用 @ 选中实体时由宿主自动注入上下文，本工具用于增删改查与连通性检查。',
          parameters: {
            action: { type: 'string', description: '操作名（见工具描述）' },
            agent: { type: 'json', description: '子智能体定义（upsert 用）: { id?, name, dshRef, apiKey?, agentPreset?, permission?, provider?, model?, workDir?, systemPrompt?, resources?, skills?, description?, enabled? }' },
            agentId: { type: 'string', description: '子智能体 ID（delete/ping/preview/models/presets/session-clear 用；也接受名称）' },
            resource: { type: 'json', description: 'SSH 资源定义（ssh-upsert 用）: { id?, name, host, port?, authType:"password"|"key", username, password?, privateKey?, passphrase?, description?, tags? }' },
            resourceId: { type: 'string', description: 'SSH 资源 ID 或名称（ssh-get/ssh-delete/ssh-test/ssh-exec 用）' },
            mappingId: { type: 'string', description: 'ONENAT 映射 ID（resolve 用）' },
            command: { type: 'string', description: 'ssh-exec 要执行的远程命令' },
            settings: { type: 'json', description: '设置补丁（settings-set 用）: { onenat?: { baseUrl?, apiKey?, autoRefreshMs? }, defaults?: { reuseSession?, timeoutMs? } }' },
            timeoutMs: { type: 'number', description: 'SSH test/exec 超时毫秒（默认 test 8000 / exec 30000）' },
            newSession: { type: 'boolean', description: 'preview: 是否预览"全新会话"提示词（默认 false）' },
          },
          output: TEXT_OUTPUT,
          async execute(args: any): Promise<string> {
            const action = String(args?.action || 'list')
            try {
              switch (action) {
                case 'list': return json(listAgents(deps))
                case 'upsert': return json(upsertAgent(deps, args?.agent))
                case 'delete': return json({ ok: deps.store.deleteAgent(resolveAgentId(deps, args?.agentId)) })
                case 'ping': return json(await pingAgent(deps, args?.agentId))
                case 'preview': return json(await previewAgent(deps, args?.agentId))
                case 'models': return json(await remoteCatalog(deps, args?.agentId, 'models'))
                case 'presets': return json(await remoteCatalog(deps, args?.agentId, 'presets'))
                case 'sessions': return json({ ok: true, sessions: deps.store.listSessions() })
                case 'session-clear': {
                  const agentId = resolveAgentId(deps, args?.agentId)
                  return json({ ok: true, cleared: deps.store.clearSessionsForAgent(agentId) })
                }
                case 'resources': return json(await listResources(deps, false))
                case 'refresh': return json(await listResources(deps, true))
                case 'resolve': return json(resolveMapping(deps, args?.mappingId))
                case 'candidates': return json({ ok: true, candidates: deps.parser.candidates(String(args?.mappingId || '')) })
                case 'skills': return json({ ok: true, skills: skillsOf(deps, args?.mappingId) })
                case 'ssh-list': return json({ ok: true, resources: deps.sshStore.list().map(maskSshResource) })
                case 'ssh-get': return json({ ok: true, resource: deps.sshStore.get(String(args?.resourceId || '')) || deps.sshStore.getByName(String(args?.resourceId || '')) })
                case 'ssh-upsert': return json(upsertSsh(deps, args?.resource))
                case 'ssh-delete': return json({ ok: deps.sshStore.delete(String(args?.resourceId || '')) })
                case 'ssh-test': return json(await testSsh(deps, args))
                case 'ssh-exec': return json(await execSsh(deps, args))
                case 'settings-get': return json({ ok: true, settings: deps.store.getSettings(), storePath: deps.store.path })
                case 'settings-set': return json({ ok: true, settings: deps.store.updateSettings(args?.settings || {}) })
                default: return json({ ok: false, error: `不支持的 action: ${action}` })
              }
            } catch (err: any) {
              return json({ ok: false, error: errText(err) })
            }
          },
        }),
      ),
    'onenat-workbuddy-mention: onenat_manage tool',
  )
}

function resolveAgentId(deps: ToolDeps, key: unknown): string {
  const raw = String(key || '').trim()
  if (!raw) return ''
  return deps.store.findAgent(raw)?.id || raw
}

function listAgents(deps: ToolDeps): unknown {
  return {
    ok: true,
    count: deps.store.getAgents().length,
    agents: deps.store.getAgents().map((a) => ({
      id: a.id,
      name: a.name,
      enabled: a.enabled,
      dshRef: a.dshRef,
      model: a.model,
      workDir: a.workDir,
      skills: a.skills || [],
      resources: (a.resources || []).length,
      description: a.description,
      mention: `@${a.name}`,
    })),
    hint: '用户在输入框输入 @ 可从菜单直接选择这些子智能体。',
  }
}

function upsertAgent(deps: ToolDeps, input: unknown): unknown {
  const agent = typeof input === 'string' ? JSON.parse(input) : input
  if (!agent || typeof agent !== 'object') return { ok: false, error: '缺少 agent 定义' }
  if (!(agent as any).name) return { ok: false, error: '缺少 name' }
  const saved = deps.store.upsertAgent(agent as Partial<SubAgent>)
  return { ok: true, agent: saved }
}

async function pingAgent(deps: ToolDeps, key: unknown): Promise<unknown> {
  const agent = deps.store.findAgent(String(key || ''))
  if (!agent) return { ok: false, error: '子智能体不存在' }
  const { target, ping } = await deps.resolver.resolveWithPing(agent)
  return { ok: Boolean(ping?.ok), agent: agent.name, resolvedEntry: target?.baseUrl, ping }
}

async function previewAgent(deps: ToolDeps, key: unknown): Promise<unknown> {
  const agent = deps.store.findAgent(String(key || ''))
  if (!agent) return { ok: false, error: '子智能体不存在' }
  await deps.directory.refresh(true).catch(() => {})
  const { prompt, warnings } = await deps.runner.composePrompt(agent, '<任务正文将放在这里>', [], {
    permission: agent.permission,
  })
  return { ok: true, agent: agent.name, prompt, warnings }
}

async function remoteCatalog(deps: ToolDeps, key: unknown, kind: 'models' | 'presets'): Promise<unknown> {
  const agent = deps.store.findAgent(String(key || ''))
  if (!agent) return { ok: false, error: '子智能体不存在' }
  const target = await deps.resolver.resolve(agent)
  if (!target.online || !target.baseUrl) return { ok: false, error: target.error || '入口解析失败' }
  const client = new DshClient()
  const result = kind === 'models' ? await client.getModels(target) : await client.getPresets(target)
  return { ...result, ok: result.ok, target: target.baseUrl }
}

async function listResources(deps: ToolDeps, force: boolean): Promise<unknown> {
  try {
    await deps.directory.refresh(force)
  } catch (err: any) {
    return { ok: false, error: `ONENAT 资源刷新失败: ${errText(err)}` }
  }
  const endpoints = deps.directory.listEndpoints()
  return {
    ok: true,
    fetchedAt: deps.directory.current()?.fetchedAt,
    count: endpoints.length,
    endpoints: endpoints.map((e) => ({
      mappingId: e.mappingId,
      appId: e.appId,
      name: e.appName || e.note || e.mappingId,
      kind: e.kind,
      online: e.online,
      entry: e.kind === 'ssh' ? `ssh -p ${e.port} @${e.host}` : (e.baseUrl || `${e.proto}://${e.host}:${e.port ?? '?'}`),
      tunnel: e.tunnelName,
      skills: e.appSkills?.map((s) => s.name),
      mention: `@${e.appName || e.note || e.mappingId}`,
    })),
  }
}

function resolveMapping(deps: ToolDeps, mappingId: unknown): unknown {
  const id = String(mappingId || '')
  if (!id) return { ok: false, error: '缺少 mappingId' }
  const ep = deps.directory.resolveMapping(id) || deps.directory.resolveApp(id)
  return { ok: Boolean(ep), endpoint: ep }
}

function skillsOf(deps: ToolDeps, mappingId: unknown): unknown {
  const id = String(mappingId || '')
  const ep = id ? (deps.directory.resolveMapping(id) || deps.directory.resolveApp(id)) : undefined
  return (ep?.appSkills || []).map((s) => ({ name: s.name, size: s.size, url: s.url }))
}

function upsertSsh(deps: ToolDeps, input: unknown): unknown {
  const raw = typeof input === 'string' ? JSON.parse(input) : input
  if (!raw || typeof raw !== 'object') return { ok: false, error: '缺少 resource 定义' }
  const id = String((raw as any).id || '').trim()
  const existing = id ? deps.sshStore.get(id) : undefined
  const normalized = normalizeSshResource(raw as any, existing)
  if (!normalized.id) normalized.id = newSshResourceId()
  const saved = deps.sshStore.upsert(normalized)
  return { ok: true, resource: maskSshResource(saved), mention: `@${saved.name}` }
}

function findSsh(deps: ToolDeps, key: unknown): ReturnType<SshResourceStore['get']> {
  const raw = String(key || '')
  return deps.sshStore.get(raw) || deps.sshStore.getByName(raw)
}

async function testSsh(deps: ToolDeps, args: any): Promise<unknown> {
  const resource = findSsh(deps, args?.resourceId)
  if (!resource) return { ok: false, error: 'SSH 资源不存在' }
  const timeoutMs = Number(args?.timeoutMs) > 0 ? Number(args.timeoutMs) : 8000
  const result = await testSshResource(resource, timeoutMs)
  deps.sshStore.update(resource.id, {
    lastTestedAt: result.testedAt,
    lastTestOk: result.ok,
    lastTestError: result.ok ? undefined : result.error,
  })
  return { ok: result.ok, resource: resource.name, result }
}

async function execSsh(deps: ToolDeps, args: any): Promise<unknown> {
  const resource = findSsh(deps, args?.resourceId)
  if (!resource) return { ok: false, error: 'SSH 资源不存在' }
  const command = String(args?.command || '')
  if (!command.trim()) return { ok: false, error: '缺少 command' }
  const timeoutMs = Number(args?.timeoutMs) > 0 ? Number(args.timeoutMs) : 30_000
  const result = await execOnSshResource(resource, command, timeoutMs)
  return { ok: result.exitCode === 0, resource: resource.name, result }
}

// ------------------------------------------------------------- onenat_resource

/**
 * 资源「拉取式」查询：@ 注入是推送式的（提及即注入），本工具供模型主动查证——
 * 例如：资源清单里的端口连不上时重新解析、或列出某资源附带的技能。
 */
function registerResourceTool(ctx: Context, deps: ToolDeps): void {
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'onenat_resource',
          description:
            '查询 OneNat 资源目录（实时公网入口）。action=list 列出全部资源；action=resolve 解析单个映射/app 的当前入口（端口漂移后复查用）；'
            + 'action=skills 列出某资源自带技能清单；action=candidates 按关键字搜索可 @ 的实体（子智能体 + 资源）。',
          parameters: {
            action: { type: 'string', description: 'list / resolve / skills / candidates' },
            id: { type: 'string', description: 'mappingId / appId / ssh:<id>（resolve、skills 用）' },
            query: { type: 'string', description: '搜索关键字（candidates 用）' },
          },
          output: TEXT_OUTPUT,
          async execute(args: any): Promise<string> {
            const action = String(args?.action || 'list')
            try {
              if (action === 'candidates') {
                return json({ ok: true, candidates: deps.parser.candidates(String(args?.query || '')) })
              }
              if (action === 'resolve') {
                await deps.directory.refresh(true)
                const id = String(args?.id || '')
                if (id.startsWith('ssh:')) {
                  const ssh = deps.sshStore.get(id.slice(4))
                  return json({ ok: Boolean(ssh), resource: ssh ? { id, name: ssh.name, host: ssh.host, port: ssh.port } : undefined })
                }
                const ep = deps.directory.resolveMapping(id) || deps.directory.resolveApp(id)
                return json({ ok: Boolean(ep), endpoint: ep })
              }
              if (action === 'skills') {
                return json({ ok: true, skills: skillsOf(deps, args?.id) })
              }
              return json(await listResources(deps, false))
            } catch (err: any) {
              return json({ ok: false, error: errText(err) })
            }
          },
        }),
      ),
    'onenat-workbuddy-mention: onenat_resource tool',
  )
}

/** ssh-exec 兼容入口：部分场景模型更愿意直接"在这个资源上跑条命令" */
function registerSshExecTool(ctx: Context, deps: ToolDeps): void {
  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'onenat_ssh',
          description:
            '在本地 SSH 资源池中的主机上执行命令（用已存凭据，无需自己拼 ssh 参数）：'
            + 'action=exec 执行命令、action=list 列出资源、action=test 测连通、action=get 取完整凭据（含密码/私钥）。',
          parameters: {
            action: { type: 'string', description: 'exec / list / test / get' },
            resource: { type: 'string', description: 'SSH 资源名称或 ID' },
            command: { type: 'string', description: 'exec 要执行的命令' },
            timeoutMs: { type: 'number', description: '超时毫秒（默认 exec 30000 / test 8000）' },
          },
          output: TEXT_OUTPUT,
          async execute(args: any): Promise<string> {
            const action = String(args?.action || 'list')
            try {
              if (action === 'list') return json({ ok: true, resources: deps.sshStore.list().map(maskSshResource) })
              if (action === 'get') {
                const resource = findSsh(deps, args?.resource)
                return json({ ok: Boolean(resource), resource })
              }
              if (action === 'test') return json(await testSsh(deps, { resourceId: args?.resource, timeoutMs: args?.timeoutMs }))
              if (action === 'exec') return json(await execSsh(deps, { resourceId: args?.resource, command: args?.command, timeoutMs: args?.timeoutMs }))
              return json({ ok: false, error: `不支持的 action: ${action}` })
            } catch (err: any) {
              if (err instanceof SshInputError) return json({ ok: false, error: err.message })
              return json({ ok: false, error: errText(err) })
            }
          },
        }),
      ),
    'onenat-workbuddy-mention: onenat_ssh tool',
  )
}

/** 供 system-prompt 段复用的子智能体花名册渲染 */
export function renderAgentRoster(store: WorkStore, max = 20): string {
  const agents = store.getAgents().filter((a) => a.enabled !== false)
  if (agents.length === 0) return ''
  const lines = agents.slice(0, max).map((a) => `- ${a.name}：${a.description || a.model || '远端 DSH 子智能体'}（id ${a.id}）`)
  if (agents.length > max) lines.push(`- …另有 ${agents.length - max} 个（onenat_manage {action:"list"} 查看全部）`)
  return lines.join('\n')
}
