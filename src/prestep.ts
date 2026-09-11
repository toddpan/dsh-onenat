/**
 * @dsh-external/onenat-workbuddy-mention - agent/pre-step 注入
 *
 * 用户发出 `@子智能体` / `@资源` 后，本监听器在进入模型步之前：
 *   1. 把消息里的提及解析回结构化身份（MentionParser）；
 *   2. 为「被指名的子智能体」追加一条 plugin 来源的用户消息 —— 明确要求用 onenat_agent 工具派发；
 *   3. 为「被指名的资源」追加一条 plugin 来源的用户消息 —— 注入 [可用资源清单]
 *      （实时入口 + 凭证策略 + 技能安装/加载指引 + 本地 SSH 池的连接与凭证）；
 *   4. 未命中任何 onenat 实体时不做任何改动（零 token 开销）。
 *
 * 与 @deepseek-ai/dsh-session-reference 同一范式：追加的消息紧跟被引用的用户消息之后，
 * 携带 plugin source 的 snapshot section，因此在会话日志与 Trajectory 中都可审计。
 */

import type { Context } from 'cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

import { containsMention, MentionParser } from './mentions.js'
import type { PromptComposer } from './prompt-composer.js'
import type { MentionResourceResolver } from './resource-bindings.js'
import type { WorkStore } from './store.js'

const PLUGIN = '@dsh-external/onenat-workbuddy-mention'

export interface PreStepDeps {
  store: WorkStore
  parser: MentionParser
  composer: PromptComposer
  resources: MentionResourceResolver
}

/** 提取一条用户消息里的全部文本 */
function textOf(message: UserMessage): string {
  const parts: string[] = []
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/** 一条 plugin 来源的上下文消息（snapshot 形式，可审计） */
function pluginMessage(name: string, text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN, form: 'snapshot', sections: [{ name, text }] },
  })
}

export function registerPreStep(ctx: Context, deps: PreStepDeps, log: (msg: string) => void): void {
  ctx.effect(
    () =>
      ctx.on('agent/pre-step', async (
        { agent, messages, signal }: { agent: Agent; messages: UserMessage[]; signal: AbortSignal },
        next: () => Promise<PreStepDecision>,
      ): Promise<PreStepDecision> => {
        const decision = await next()
        if (decision.kind === 'reject' || signal.aborted) return decision
        try {
          const injected = await inject(agent, decision.messages, deps, log)
          if (injected.length === decision.messages.length) return decision
          return { ...decision, messages: injected }
        } catch (err: any) {
          // 注入失败绝不影响对话本身：记录后原样放行
          log(`pre-step 注入失败（已跳过本次注入）：${err?.message || err}`)
          return decision
        }
      }, { prepend: true }),
    'onenat-workbuddy-mention: pre-step mention injection',
  )
}

/**
 * 把提及注入为本步的附加用户消息（紧跟其来源消息之后）。
 */
export async function inject(
  agent: Agent,
  messages: readonly UserMessage[],
  deps: PreStepDeps,
  log: (msg: string) => void,
): Promise<UserMessage[]> {
  const out: UserMessage[] = []
  for (const message of messages) {
    out.push(message)
    if (message.source.kind !== 'user') continue
    const text = textOf(message)
    if (!text || !containsMention(text)) continue

    const mentions = deps.parser.parse(text)
    if (mentions.agents.length === 0 && mentions.resources.length === 0) continue
    log(`命中 @ 提及（会话 ${agent.id}）：子智能体 [${mentions.agents.map((a) => a.label).join(', ')}]；资源 [${mentions.resources.map((r) => r.label).join(', ')}]`)

    if (mentions.agents.length > 0) out.push(pluginMessage('onenat-agents', renderAgentDirective(mentions.agents, deps.store)))

    if (mentions.resources.length > 0) {
      const rendered = await renderResourceBlock(mentions.resources.map((r) => r.id), deps)
      if (rendered) out.push(pluginMessage('onenat-resources', rendered))
    }
  }
  return out
}

/** 子智能体指认段 */
function renderAgentDirective(
  mentions: Array<{ id: string; label: string }>,
  store: WorkStore,
): string {
  const lines: string[] = ['[OneNat WorkBuddy] 用户在本次消息中用 @ 指定了子智能体，请按下列指认派发：', '']
  for (const mention of mentions) {
    const sub = store.getAgent(mention.id)
    if (!sub) {
      lines.push(`- @${mention.label}：该子智能体已不存在，请据实说明并请用户重新选择。`)
      continue
    }
    const facts = [
      `ID=${sub.id}`,
      sub.model ? `模型=${sub.model}` : '模型=远端默认',
      sub.agentPreset ? `preset=${sub.agentPreset}` : '',
      sub.workDir ? `工作目录=${sub.workDir}` : '',
      sub.description ? `说明=${sub.description}` : '',
    ].filter(Boolean)
    lines.push(`- @${sub.name}：${facts.join('，')}`)
  }
  lines.push('')
  lines.push('执行方式：')
  lines.push('1. 用 onenat_agent 工具派发：agent 传上面给出的名字或 ID，task 传完整、自包含的任务描述')
  lines.push('   （远端 DSH 上的子智能体看不到本会话上下文，任务所需信息必须全部写进 task）。')
  lines.push('2. 多个子智能体被指名时逐个调用；互不依赖可以并发调用。')
  lines.push('3. 同一子智能体在本次对话中是持续会话：onenat_agent 默认复用远端会话，后续追问直接再调用即可；')
  lines.push('   不要绕过工具（例如自己 curl 远端 HTTP API）。')
  lines.push('4. 派发返回后向用户汇报：远端结论要点 + 远端会话 ID（便于继续追问）；失败时原样报告工具返回的 error。')
  lines.push('5. 除非用户明确要求，不要自行改写或压缩用户对子智能体的指令。')
  return lines.join('\n')
}

/** 资源清单段（ONENAT 实时入口 + 本地 SSH 池），无可渲染内容时返回空串 */
async function renderResourceBlock(ids: string[], deps: PreStepDeps): Promise<string> {
  const resolved = deps.resources.resolve(ids)
  const composed = await deps.composer.compose(
    {
      id: '__mention__',
      name: '当前会话',
      dshRef: { kind: 'direct', apiBaseUrl: '' },
      resources: [],
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    },
    { resolvedAt: Date.now(), extraResources: resolved.bindings },
  )

  const sections: string[] = []
  if (composed.block) sections.push(composed.block)
  for (const item of resolved.preRendered) sections.push(item.markdown)
  if (sections.length === 0 && composed.warnings.length === 0 && resolved.missing.length === 0) return ''

  const lines: string[] = ['[OneNat WorkBuddy] 用户在本次消息中用 @ 指定了下列资源，本轮可以使用它们：', '']
  lines.push(sections.join('\n\n'))

  const problems = [...resolved.missing.map((m) => `${m} 已不存在`), ...composed.warnings]
  if (problems.length > 0) {
    if (sections.length > 0) lines.push('')
    lines.push('[本次不可用的 @ 资源]（请在回复中据实说明，不要静默忽略）：')
    for (const problem of problems) lines.push(`- ${problem}`)
  }

  if (sections.length > 0) {
    lines.push('')
    lines.push('使用说明：')
    lines.push('1. 上述资源条目由 OneNat 平台实时解析（公网端口为本次注入时刻实况），不要缓存或猜测端口；')
    lines.push('2. 你可以自己使用这些资源（bash / ssh / HTTP 工具），也可以连同任务一起交给 onenat_agent 的子智能体；')
    lines.push('3. 交派时请把资源名称写进 task，子智能体会收到同一份资源清单。')
  }
  return lines.join('\n')
}
