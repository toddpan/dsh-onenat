/**
 * @dsh-external/onenat-workbuddy-mention - WorkStore
 *
 * 持久化：子智能体池 + (DSH 会话, 子智能体) → 远端会话长持映射 + 设置。
 * 落盘 ~/.dsh/onenat-workbuddy-mention/store.json。
 *
 * 从 0.1.x（onenat-workbuddy）升级时：首次启动自动从旧路径
 * ~/.dsh/onenat-workbuddy/store.json 迁移 agents / settings（tasks 段忽略并保留旧文件）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type {
  AgentResourceBinding,
  DshRef,
  RemoteSessionBinding,
  StorageData,
  SubAgent,
  WorkBuddySettings,
} from './types.js'

function defaultSettings(): WorkBuddySettings {
  return {
    onenat: {
      baseUrl: 'https://onenat.sooncore.com',
      apiKey: 'onk-2d483fbaf1dffe489223cd1fb34dc14c4f38c5fb',
      autoRefreshMs: 60_000,
    },
    defaults: {
      reuseSession: true,
      timeoutMs: 900_000,
    },
  }
}

/** 判断两个 DSH 实体引用是否指向同一个目标（用于同实体去重防重复新增） */
function sameDshRef(a: DshRef | undefined, b: DshRef): boolean {
  if (!a) return false
  if (a.kind === 'direct' && b.kind === 'direct') return normalizeUrl(a.apiBaseUrl || '') === normalizeUrl(b.apiBaseUrl || '')
  if (a.kind === 'mapping' && b.kind === 'mapping') return a.mappingId === b.mappingId
  if (a.kind === 'app' && b.kind === 'app') return a.appId === b.appId
  return false
}

function normalizeUrl(u: string): string {
  return u.trim().replace(/\/+$/, '').toLowerCase()
}

/** 工作目录规范化：去空白与尾斜杠；空值 → undefined */
export function normalizeWorkDir(v: unknown): string | undefined {
  const s = String(v ?? '').trim().replace(/\/+$/, '')
  return s || undefined
}

export class WorkStore {
  private filePath: string
  private legacyPath: string
  private data: StorageData

  constructor(customPath?: string) {
    const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
    this.filePath = customPath || join(dshHome, 'onenat-workbuddy-mention', 'store.json')
    this.legacyPath = join(dshHome, 'onenat-workbuddy', 'store.json')
    this.data = { agents: [], sessions: {}, settings: defaultSettings() }
    this.load()
  }

  private load(): void {
    try {
      const source = existsSync(this.filePath) ? this.filePath : (existsSync(this.legacyPath) ? this.legacyPath : undefined)
      if (source) {
        const parsed = JSON.parse(readFileSync(source, 'utf-8'))
        this.data = {
          agents: Array.isArray(parsed.agents) ? parsed.agents : [],
          sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
          settings: {
            onenat: { ...defaultSettings().onenat, ...(parsed.settings?.onenat || {}) },
            defaults: { ...defaultSettings().defaults, ...(parsed.settings?.defaults || {}) },
          },
        }
      }
      this.save()
    } catch (err) {
      console.error('[onenat-workbuddy-mention] Failed to load store:', err)
    }
  }

  public get path(): string {
    return this.filePath
  }

  public save(): void {
    try {
      const dir = dirname(this.filePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
    } catch (err) {
      console.error('[onenat-workbuddy-mention] Failed to save store:', err)
    }
  }

  // ---- Settings ----

  public getSettings(): WorkBuddySettings {
    return JSON.parse(JSON.stringify(this.data.settings))
  }

  public updateSettings(patch: Partial<WorkBuddySettings>): WorkBuddySettings {
    if (patch.onenat) this.data.settings.onenat = { ...this.data.settings.onenat, ...patch.onenat }
    if (patch.defaults) this.data.settings.defaults = { ...this.data.settings.defaults, ...patch.defaults }
    this.save()
    return this.getSettings()
  }

  // ---- SubAgents ----

  public getAgents(): SubAgent[] {
    return [...this.data.agents]
  }

  public getAgent(id: string): SubAgent | undefined {
    return this.data.agents.find((a) => a.id === id)
  }

  /** 按名称或 ID 查找（@ 提及解析用；名称大小写不敏感） */
  public findAgent(key: string): SubAgent | undefined {
    const k = String(key || '').trim().toLowerCase()
    if (!k) return undefined
    return this.data.agents.find((a) => a.id.toLowerCase() === k)
      || this.data.agents.find((a) => a.name.toLowerCase() === k)
  }

  public upsertAgent(input: Partial<SubAgent>): SubAgent {
    const now = Date.now()
    const existing = input.id ? this.data.agents.find((a) => a.id === input.id) : undefined
    const dshRef: DshRef = (input.dshRef as DshRef) || existing?.dshRef || { kind: 'direct', apiBaseUrl: '' }
    const resources: AgentResourceBinding[] = (input.resources as AgentResourceBinding[]) || existing?.resources || []
    // 防重复兜底：无 id 新建时，若已存在「同名 + 相同 DSH 实体」的智能体，则复用该条目（更新而非新增）。
    let target = existing
    if (!target) {
      target = this.data.agents.find((a) => a.name === String(input.name) && sameDshRef(a.dshRef, dshRef))
    }
    const agent: SubAgent = {
      id: target?.id || `agent-${Math.random().toString(36).slice(2, 10)}`,
      name: String(input.name ?? target?.name ?? '未命名子智能体'),
      dshRef,
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : target?.apiKey ? { apiKey: target.apiKey } : {}),
      agentPreset: input.agentPreset ?? target?.agentPreset,
      permission: input.permission ?? target?.permission,
      provider: input.provider ?? target?.provider,
      model: input.model ?? target?.model,
      reasoningEffort: input.reasoningEffort ?? target?.reasoningEffort,
      systemPrompt: input.systemPrompt ?? target?.systemPrompt,
      workDir: input.workDir !== undefined ? normalizeWorkDir(input.workDir) : target?.workDir,
      resources,
      skills: input.skills !== undefined ? input.skills : target?.skills,
      ...(input.tags !== undefined ? { tags: input.tags } : target?.tags ? { tags: target.tags } : {}),
      description: input.description ?? target?.description,
      enabled: input.enabled ?? target?.enabled ?? true,
      createdAt: target?.createdAt ?? now,
      updatedAt: now,
    }
    const idx = this.data.agents.findIndex((a) => a.id === agent.id)
    if (idx >= 0) this.data.agents[idx] = agent
    else this.data.agents.push(agent)
    this.save()
    return agent
  }

  public deleteAgent(id: string): boolean {
    const before = this.data.agents.length
    this.data.agents = this.data.agents.filter((a) => a.id !== id)
    for (const key of Object.keys(this.data.sessions)) {
      if (key.endsWith('::' + id)) delete this.data.sessions[key]
    }
    const changed = this.data.agents.length !== before
    if (changed) this.save()
    return changed
  }

  // ---- 远端会话长持 ----

  private sessionKey(scope: string | undefined, agentId: string): string {
    return `${scope || 'global'}::${agentId}`
  }

  public getSession(scope: string | undefined, agentId: string): RemoteSessionBinding | undefined {
    return this.data.sessions[this.sessionKey(scope, agentId)]
  }

  public setSession(scope: string | undefined, agentId: string, binding: RemoteSessionBinding): void {
    this.data.sessions[this.sessionKey(scope, agentId)] = binding
    this.save()
  }

  public clearSession(scope: string | undefined, agentId: string): boolean {
    const key = this.sessionKey(scope, agentId)
    if (!(key in this.data.sessions)) return false
    delete this.data.sessions[key]
    this.save()
    return true
  }

  /** 清掉某个子智能体的全部远端会话绑定（所有作用域）；返回清掉的条数 */
  public clearSessionsForAgent(agentId: string): number {
    const suffix = '::' + agentId
    let cleared = 0
    for (const key of Object.keys(this.data.sessions)) {
      if (key.endsWith(suffix)) {
        delete this.data.sessions[key]
        cleared += 1
      }
    }
    if (cleared > 0) this.save()
    return cleared
  }

  public listSessions(): Array<RemoteSessionBinding & { key: string }> {
    return Object.entries(this.data.sessions).map(([key, value]) => ({ key, ...value }))
  }
}
