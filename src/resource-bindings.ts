/**
 * @dsh-external/onenat-workbuddy-mention - @ 资源提及 → 资源绑定
 *
 * 两类被 @ 的资源：
 *   - ONENAT 映射 / 应用（稳定 ID = mappingId / appId）→ 交给 PromptComposer 实时解析入口，
 *     凭证策略默认 self-fetch（提示词只给"取凭证接口"，不落明文）；
 *   - 本地 SSH 资源池（mention id = `ssh:<id>`）→ 不经 ONENAT，直接渲染连接信息与凭证
 *     （本地资源池属于本机信任域，与 0.1.x 的 SSH 资源池语义一致）。
 *
 * prestep（给主智能体注入）与 AgentRunner（给远端子智能体注入）共用本模块，
 * 保证两边看到的资源清单完全一致。
 */

import type { SshResourceStore } from './ssh-store.js'
import type { AgentResourceBinding } from './types.js'

export interface ResolvedMentionResources {
  /** 交给 PromptComposer 渲染的资源绑定（ONENAT 侧） */
  bindings: AgentResourceBinding[]
  /** 已直接渲染好的资源段落（本地 SSH 池） */
  preRendered: Array<{ alias: string; markdown: string }>
  /** 本体已不存在的提及（用于向用户据实说明） */
  missing: string[]
}

export class MentionResourceResolver {
  constructor(private sshStore: SshResourceStore) {}

  /**
   * @param ids - 提及解析出的资源 ID（mappingId / appId / `ssh:<id>`）
   * @param note - 写进 bindings 的用途说明（用户当轮 @ 指定使用）
   */
  public resolve(ids: readonly string[], note = '用户当轮 @ 动态指定使用'): ResolvedMentionResources {
    const bindings: AgentResourceBinding[] = []
    const preRendered: Array<{ alias: string; markdown: string }> = []
    const missing: string[] = []
    const seen = new Set<string>()

    for (const raw of ids) {
      const id = String(raw || '').trim()
      if (!id || seen.has(id)) continue
      seen.add(id)

      if (id.startsWith('ssh:')) {
        const sshId = id.slice(4)
        const ssh = this.sshStore.get(sshId)
        if (!ssh) {
          missing.push(`本地 SSH 资源 ${sshId}`)
          continue
        }
        preRendered.push({ alias: ssh.name, markdown: renderSshResource(ssh) })
        continue
      }

      bindings.push({
        ref: { kind: 'mapping', mappingId: id },
        credentialMode: 'self-fetch',
        skillMode: 'all',
        note,
      })
    }

    return { bindings, preRendered, missing }
  }
}

/** 本地 SSH 资源 → 提示词段落（含连接命令与凭证；调用方保证只在可信提示词范围内使用） */
export function renderSshResource(ssh: {
  name: string
  host: string
  port?: number
  username: string
  authType: string
  password?: string
  privateKey?: string
  passphrase?: string
  description?: string
}): string {
  const port = ssh.port || 22
  const lines: string[] = []
  lines.push(`### 资源: ${ssh.name} (SSH · 本地直连资源池)`)
  lines.push(`- 连接: ssh -o StrictHostKeyChecking=accept-new -p ${port} ${ssh.username}@${ssh.host}`)
  if (ssh.authType === 'key') {
    lines.push(`- 认证: 私钥${ssh.passphrase ? `（私钥口令 \`${ssh.passphrase}\`）` : ''}`)
    lines.push('- 私钥（写入临时文件 chmod 600 后使用，用完删除；不要提交到仓库）:')
    lines.push('```')
    lines.push(String(ssh.privateKey || '').trim())
    lines.push('```')
  } else {
    lines.push(`- 认证: 密码 \`${ssh.password || ''}\`（※ 不要写入脚本文件、不要外传）`)
  }
  if (ssh.description) lines.push(`- 用途: ${ssh.description}`)
  return lines.join('\n')
}
