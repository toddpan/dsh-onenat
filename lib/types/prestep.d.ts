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
import type { Context } from 'cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { MentionParser } from './mentions.js';
import type { PromptComposer } from './prompt-composer.js';
import type { MentionResourceResolver } from './resource-bindings.js';
import type { WorkStore } from './store.js';
export interface PreStepDeps {
    store: WorkStore;
    parser: MentionParser;
    composer: PromptComposer;
    resources: MentionResourceResolver;
}
export declare function registerPreStep(ctx: Context, deps: PreStepDeps, log: (msg: string) => void): void;
/**
 * 把提及注入为本步的附加用户消息（紧跟其来源消息之后）。
 */
export declare function inject(agent: Agent, messages: readonly UserMessage[], deps: PreStepDeps, log: (msg: string) => void): Promise<UserMessage[]>;
