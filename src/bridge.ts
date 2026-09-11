/**
 * @dsh-external/onenat-workbuddy-mention - 浏览器半边使用的主机 RPC 桥
 *
 * 本插件是普通 bundle 插件（非动态 Cordis Package），因此浏览器半边不使用
 * 包私有的 `host.call`，而是调用本插件自己注册的同源管理 API
 * （`<pathPrefix>/api/*`，见 router.ts）。桥接层保证两边共用同一份存储与服务，
 * 并统一响应信封 `{ ok, data?, error? }`。
 */

import type { OnenatDirectory } from './onenat.js'
import type { AgentResolver } from './resolver.js'
import type { AgentRunner } from './agent-runner.js'
import type { MentionParser } from './mentions.js'
import type { SshResourceStore } from './ssh-store.js'
import type { WorkStore } from './store.js'
import type { SubAgent } from './types.js'

export interface BridgeDeps {
  store: WorkStore
  directory: OnenatDirectory
  resolver: AgentResolver
  runner: AgentRunner
  parser: MentionParser
  sshStore: SshResourceStore
}

/**
 * 目前桥接层是 no-op：设置页的 `@` 候选与资源数据一律走 HTTP 管理 API
 * （router.ts），无需再注册第二条 RPC 通道。保留该函数以便后续需要
 * 包私有通道时集中落点，并在此处统一做一次能力自检日志。
 */
export function registerClientBridge(_ctx: unknown, deps: BridgeDeps, log: (msg: string) => void): void {
  const agents = deps.store.getAgents().filter((a: SubAgent) => a.enabled !== false).length
  log(`浏览器半边桥：管理 API 可用（子智能体 ${agents} 个，SSH 资源 ${deps.sshStore.list().length} 个）`)
}
