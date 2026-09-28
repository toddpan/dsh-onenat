/**
 * @dsh-external/onenat-workbuddy-mention - agent/pre-step 注入
 *
 * 用户发出 `@子智能体` / `@资源` 后，本监听器在进入模型步之前：
 *   1. 把消息里的提及解析回结构化身份（MentionParser）；
 *   2. 为「被指名的子智能体」追加一条本插件来源的用户消息 —— 明确要求用 onenat_agent 工具派发；
 *   3. 为「被指名的资源」追加一条本插件来源的用户消息 —— 注入 [可用资源清单]
 *      （实时入口 + 凭证策略 + 技能安装/加载指引 + 本地 SSH 池的连接与凭证）；
 *   4. 未命中任何 onenat 实体时不做任何改动（零 token 开销）。
 *
 * 与 @deepseek-ai/dsh-session-reference 同一范式：追加的消息紧跟被引用的用户消息之后，
 * 携带专属 producer kind 的 snapshot source，因此在会话日志与 Trajectory 中都可审计。
 */
import type { Context } from 'cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
import { MentionParser } from './mentions.js';
import type { PromptComposer } from './prompt-composer.js';
import type { MentionResourceResolver } from './resource-bindings.js';
import type { WorkStore } from './store.js';
/**
 * 本插件注入消息的来源身份。DSH 会话格式 v4 起废除了共享的 `kind: 'plugin'`
 * 杂类来源（持久层对原生 v4 消息直接拒绝，见 @deepseek-ai/dsh-session-format-v3-to-v4
 * 的 "format v4 message requires a producer-owned source kind"），要求每个 producer
 * 声明自己的 kind。这里按平台范式声明专属 kind 并扩充 MessageSourceMap；
 * 旧 v3 会话里的 plugin 来源行由宿主迁移为 `plugin:<包名>`，与本 kind 并存可读。
 */
export interface OnenatMentionSource {
    kind: 'onenat-workbuddy-mention';
    form: 'snapshot';
    sections: readonly {
        name: string;
        text: string;
    }[];
}
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'onenat-workbuddy-mention': OnenatMentionSource;
    }
}
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
