/**
 * @dsh-external/onenat-workbuddy-mention - 管理 API（设置页 UI 专用）
 *
 * 只在 DSH 本地 GUI 后面服务：设置页与模型工具共用同一份存储与服务。
 * 前缀：<pathPrefix>/api/*
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { OnenatDirectory } from './onenat.js'
import type { AgentResolver } from './resolver.js'
import type { MentionParser } from './mentions.js'
import type { AgentRunner } from './agent-runner.js'
import type { SshResourceStore } from './ssh-store.js'
import type { WorkStore } from './store.js'
import { DshClient } from './remote-client.js'
import {
  SshInputError,
  execOnSshResource,
  maskSshResource,
  newSshResourceId,
  normalizeSshResource,
  testSshResource,
} from './ssh-resources.js'
import type { SubAgent } from './types.js'

export interface RouterDeps {
  store: WorkStore
  directory: OnenatDirectory
  resolver: AgentResolver
  runner: AgentRunner
  parser: MentionParser
  sshStore: SshResourceStore
  log: (msg: string) => void
}

export class ManageRouter {
  constructor(private deps: RouterDeps) {}

  private sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
    res.statusCode = statusCode
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(data))
  }

  private async parseBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 4 * 1024 * 1024) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {})
        } catch {
          resolve({})
        }
      })
      req.on('error', () => resolve({}))
    })
  }

  /** @returns 是否已处理 */
  public async dispatch(req: IncomingMessage, res: ServerResponse, prefix: string): Promise<boolean> {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const method = (req.method || 'GET').toUpperCase()
    const path = url.pathname.slice(prefix.length) || '/'
    const { store, directory, resolver, runner, parser, sshStore } = this.deps

    try {
      if (path === '/api/settings' && method === 'GET') {
        this.sendJson(res, 200, { ok: true, data: { settings: store.getSettings(), storePath: store.path } })
        return true
      }
      if (path === '/api/settings' && (method === 'POST' || method === 'PATCH')) {
        const body = await this.parseBody(req)
        const settings = store.updateSettings(body || {})
        if (settings.onenat) {
          directory.configure(settings.onenat.baseUrl, settings.onenat.apiKey)
          directory.startAutoRefresh(settings.onenat.autoRefreshMs)
        }
        this.sendJson(res, 200, { ok: true, data: settings })
        return true
      }

      if (path === '/api/agents' && method === 'GET') {
        this.sendJson(res, 200, { ok: true, data: store.getAgents() })
        return true
      }
      if (path === '/api/agents' && method === 'POST') {
        const body = await this.parseBody(req)
        if (!body?.name) {
          this.sendJson(res, 400, { ok: false, error: '缺少 name' })
          return true
        }
        this.sendJson(res, 200, { ok: true, data: store.upsertAgent(body as Partial<SubAgent>) })
        return true
      }
      const agentMatch = /^\/api\/agents\/([^/]+)(?:\/([a-z-]+))?$/.exec(path)
      if (agentMatch) {
        const id = decodeURIComponent(agentMatch[1]!)
        const sub = agentMatch[2]
        const agent = store.findAgent(id)
        if (!sub && method === 'DELETE') {
          this.sendJson(res, 200, { ok: true, data: { deleted: store.deleteAgent(agent?.id || id) } })
          return true
        }
        if (!agent) {
          this.sendJson(res, 404, { ok: false, error: '子智能体不存在' })
          return true
        }
        if (sub === 'ping' && method === 'POST') {
          const { target, ping } = await resolver.resolveWithPing(agent)
          this.sendJson(res, 200, { ok: true, data: { ping, resolved: target } })
          return true
        }
        if (sub === 'models' && method === 'GET') {
          const target = await resolver.resolve(agent)
          const result = target.online ? await new DshClient().getModels(target) : { ok: false, error: target.error }
          this.sendJson(res, 200, { ok: true, data: result })
          return true
        }
        if (sub === 'presets' && method === 'GET') {
          const target = await resolver.resolve(agent)
          const result = target.online ? await new DshClient().getPresets(target) : { ok: false, error: target.error }
          this.sendJson(res, 200, { ok: true, data: result })
          return true
        }
        if (sub === 'preview' && method === 'GET') {
          await directory.refresh(true).catch(() => {})
          const composed = await runner.composePrompt(agent, '<任务正文将放在这里>', [], { permission: agent.permission })
          this.sendJson(res, 200, { ok: true, data: composed })
          return true
        }
        if (sub === 'session' && method === 'DELETE') {
          this.sendJson(res, 200, { ok: true, data: { cleared: store.clearSessionsForAgent(agent.id) } })
          return true
        }
      }

      if (path === '/api/resources' && method === 'GET') {
        await directory.refresh(url.searchParams.get('refresh') === '1')
        this.sendJson(res, 200, {
          ok: true,
          data: { fetchedAt: directory.current()?.fetchedAt, endpoints: directory.listEndpoints() },
        })
        return true
      }
      if (path === '/api/candidates' && method === 'GET') {
        this.sendJson(res, 200, { ok: true, data: parser.candidates(url.searchParams.get('q') || '') })
        return true
      }
      if (path === '/api/debug/parse' && method === 'POST') {
        const body = await this.parseBody(req)
        this.sendJson(res, 200, { ok: true, data: parser.parse(String(body?.text || '')) })
        return true
      }

      if (path === '/api/ssh' && method === 'GET') {
        this.sendJson(res, 200, { ok: true, data: sshStore.list().map(maskSshResource) })
        return true
      }
      if (path === '/api/ssh' && method === 'POST') {
        const body = await this.parseBody(req)
        const existing = body?.id ? sshStore.get(String(body.id)) : undefined
        const normalized = normalizeSshResource(body || {}, existing)
        if (!normalized.id) normalized.id = newSshResourceId()
        this.sendJson(res, 200, { ok: true, data: maskSshResource(sshStore.upsert(normalized)) })
        return true
      }
      const sshMatch = /^\/api\/ssh\/([^/]+)(?:\/([a-z-]+))?$/.exec(path)
      if (sshMatch) {
        const key = decodeURIComponent(sshMatch[1]!)
        const sub = sshMatch[2]
        const resource = sshStore.get(key) || sshStore.getByName(key)
        if (!resource) {
          this.sendJson(res, 404, { ok: false, error: 'SSH 资源不存在' })
          return true
        }
        if (!sub && method === 'GET') {
          this.sendJson(res, 200, { ok: true, data: resource })
          return true
        }
        if (!sub && method === 'DELETE') {
          this.sendJson(res, 200, { ok: true, data: { deleted: sshStore.delete(resource.id) } })
          return true
        }
        if (sub === 'test' && method === 'POST') {
          const result = await testSshResource(resource, 8000)
          sshStore.update(resource.id, {
            lastTestedAt: result.testedAt,
            lastTestOk: result.ok,
            lastTestError: result.ok ? undefined : result.error,
          })
          this.sendJson(res, 200, { ok: true, data: result })
          return true
        }
        if (sub === 'exec' && method === 'POST') {
          const body = await this.parseBody(req)
          const command = String(body?.command || '')
          if (!command.trim()) {
            this.sendJson(res, 400, { ok: false, error: '缺少 command' })
            return true
          }
          const result = await execOnSshResource(resource, command, Number(body?.timeoutMs) || 30_000)
          this.sendJson(res, 200, { ok: true, data: result })
          return true
        }
      }
    } catch (err: any) {
      if (err instanceof SshInputError) {
        this.sendJson(res, 400, { ok: false, error: err.message })
        return true
      }
      this.sendJson(res, 500, { ok: false, error: String(err?.message || err) })
      return true
    }

    return false
  }
}
