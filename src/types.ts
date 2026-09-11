/**
 * @dsh-external/onenat-workbuddy-mention - 数据模型
 *
 * 与 0.1.x（onenat-workbuddy 控制台版）的差别：
 *  - 删除 Task / Plan / Turn / 编排引擎相关类型（不再自建聊天会话与 DAG 编排）
 *  - 新增 @ 提及（mention）类型：URI 编解码、候选行、解析结果
 *  - 新增 (DSH 会话, 子智能体) → 远端会话 的长持映射（替代原 (任务, 成员) 语义）
 *
 * 核心决策沿用 D1：子智能体/资源绑定一律引用 ONENAT 稳定 ID（mappingId/appId/appId），
 * 运行时经 ResourceDirectory 解析当下公网入口 —— 端口漂移免疫。
 */

// ---------- ONENAT 资源面 ----------

/** /api/v1/resources 返回的原始映射（字段子集） */
export interface OnenatMapping {
  id: string
  proto: 'tcp' | 'http'
  public_url?: string
  local: string
  note?: string
  auth_override?: boolean
  auth_type?: string
  app?: OnenatApp
}

export interface OnenatApp {
  id: string
  name: string
  type: string
  description?: string
  internal_url?: string
  auth_type?: string
  username?: string
  skills?: Array<{ name: string; size?: number; url: string }>
}

export interface OnenatTunnel {
  id: string
  name: string
  note?: string
  online: boolean
  mappings: OnenatMapping[]
}

/** 解析后的资源端点（同一映射在客户端重连后 host:port 会变，ID 不变） */
export interface ResolvedEndpoint {
  mappingId: string
  appId?: string
  tunnelId: string
  tunnelName: string
  note?: string
  online: boolean
  proto: 'tcp' | 'http'
  host: string
  port?: number
  local: string
  /** tcp 隧道承载 HTTP 或 http 映射时合成的 web 入口（路径不变） */
  baseUrl?: string
  kind: 'ssh' | 'dsh' | 'http' | 'tcp' | 'unknown'
  appName?: string
  appType?: string
  appSkills?: Array<{ name: string; size?: number; url: string }>
  resolvedAt: number
}

export interface ResourceSnapshot {
  fetchedAt: number
  baseUrl: string
  tunnels: OnenatTunnel[]
}

export interface OnenatCredentials {
  ok: boolean
  authType?: string
  username?: string
  password?: string
  apiKey?: string
  token?: string
  resolvedFrom?: string
  error?: string
}

// ---------- SSH 连接资源（本地直连资源池，补充 ONENAT 之外的资源） ----------

export type SshAuthType = 'password' | 'key'

export interface SshResource {
  id: string
  name: string
  host: string
  port: number
  authType: SshAuthType
  username: string
  password?: string
  privateKey?: string
  passphrase?: string
  description?: string
  tags?: string[]
  lastTestedAt?: number
  lastTestOk?: boolean
  lastTestError?: string
  createdAt: number
  updatedAt: number
}

export type SshResourceMasked = Omit<SshResource, 'password' | 'privateKey' | 'passphrase'> & {
  hasPassword: boolean
  hasPrivateKey: boolean
  hasPassphrase: boolean
}

// ---------- 子智能体 ----------

/** DSH 实体引用 —— 稳定 ID；direct 仅作手工兜底（D1） */
export type DshRef =
  | { kind: 'mapping'; mappingId: string }
  | { kind: 'app'; appId: string }
  | { kind: 'direct'; apiBaseUrl: string }

export type CredentialMode = 'inline' | 'self-fetch' | 'omit'

export interface AgentResourceBinding {
  ref: { kind: 'mapping'; mappingId: string } | { kind: 'app'; appId: string }
  alias?: string
  /** 凭证注入策略：inline=写进提示词；self-fetch=给 ONENAT 凭证接口让 AI 自取；omit=不给 */
  credentialMode: CredentialMode
  /** 技能文件注入：all=全部内联；names=指定清单；none=只给目录让 AI 按需拉取 */
  skillMode: 'all' | { names: string[] } | 'none'
  note?: string
}

export interface SubAgent {
  id: string
  name: string
  dshRef: DshRef
  /** direct 引用时的 API Key；mapping/app 引用时优先经 ONENAT 映射凭证接口解析 */
  apiKey?: string
  agentPreset?: string
  permission?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  systemPrompt?: string
  /** 远端工作目录（绝对路径）：该成员所有远端会话的 cwd，即其文件工具根目录；留空用远端默认 */
  workDir?: string
  resources: AgentResourceBinding[]
  /** 绑定的「已安装」技能名（kebab-case）；派发时在提示词写入 /名 手势，由远端宿主原生加载技能正文 */
  skills?: string[]
  tags?: string[]
  description?: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** 运行时解析出的 DSH 调用目标 */
export interface ResolvedDshTarget {
  baseUrl: string
  apiKey?: string
  agentId: string
  mappingId?: string
  resolvedAt: number
  /** 资源面健康状态 */
  online: boolean
  error?: string
}

export interface ResolveIssue {
  agentId: string
  name: string
  error: string
}

/** 引擎日志条目（远端客户端回调复用） */
export interface SubtaskLogEntry {
  ts: number
  level: 'info' | 'warn' | 'error' | 'tool'
  msg: string
}

// ---------- @ 提及（Mentions） ----------

/**
 * 提及 URI scheme：
 *   onenat-agent:<subAgentId>                  子智能体（本地定义 ID）
 *   onenat-resource:<mappingId|appId>          ONENAT 映射 / 应用资源
 *   onenat-resource:ssh:<sshResourceId>        本地 SSH 资源池条目
 */
export const MENTION_SCHEME_AGENT = 'onenat-agent:'
export const MENTION_SCHEME_RESOURCE = 'onenat-resource:'
export const SSH_RESOURCE_PREFIX = 'ssh:'

export type MentionKind = 'agent' | 'resource'

/** 解析出的单条提及 */
export interface ParsedMention {
  kind: MentionKind
  /** 模型可见 / 胶囊携带的 URI，如 onenat-agent:agent-3f2a */
  uri: string
  /** 展示名（markdown label） */
  label: string
  /** 原始提及文本（用于从消息里消去） */
  raw: string
  /** agent: 本地子智能体 ID；resource: mappingId / appId / ssh:<id> */
  id: string
}

export interface ExtractedMentions {
  agents: ParsedMention[]
  resources: ParsedMention[]
}

/** @ 菜单候选行（Host → Client，经包私有 RPC 传输；纯 JSON） */
export interface MentionCandidate {
  kind: MentionKind
  /** 稳定唯一键（onPick 时回传给 Host 解析） */
  key: string
  /** 菜单显示名 */
  name: string
  /** 菜单副标题 */
  description: string
  /** 分组标题 */
  section: string
  /** 提及 URI */
  uri: string
  /** 资源种类（仅 resource） */
  resourceKind?: 'ssh' | 'dsh' | 'http' | 'tcp' | 'unknown' | 'local-ssh'
  /** 是否在线（仅 resource） */
  online?: boolean
}

// ---------- 会话长持（D3 的 @ 版语义） ----------

/** (DSH 会话, 子智能体) → 远端会话 */
export interface RemoteSessionBinding {
  /** 远端 dsh-web-service 会话 ID */
  remoteSessionId: string
  /** 建会话时的 baseUrl 与 cwd（用于检测入口/工作目录变化后重建） */
  baseUrl: string
  cwd?: string
  /** 最近一次使用时间 */
  usedAt: number
  /** 归属的本地 DSH 会话（用于隔离不同对话的子智能体会话；空 = 全局共享） */
  scope?: string
}

// ---------- 存储 ----------

export interface WorkBuddySettings {
  onenat: {
    baseUrl: string
    apiKey: string
    autoRefreshMs: number
  }
  /** 派发默认值 */
  defaults: {
    /** @ 提及未指定时是否复用上次远端会话（会话长持） */
    reuseSession: boolean
    /** 单次派发超时（毫秒） */
    timeoutMs: number
  }
}

export interface StorageData {
  agents: SubAgent[]
  /** `${scope}::${agentId}` → binding */
  sessions: Record<string, RemoteSessionBinding>
  settings: WorkBuddySettings
}

export interface PluginConfig {
  pathPrefix?: string
  storagePath?: string
  onenatBaseUrl?: string
  onenatApiKey?: string
  autoRefreshMs?: number
}
