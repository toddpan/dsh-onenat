/**
 * @dsh-external/onenat-workbuddy-mention - 模型工具
 *
 *  onenat_agent   —— 把任务派发给 ONENAT 上的子智能体（远端 DSH 会话，长持复用）
 *  onenat_manage  —— 子智能体 / ONENAT 资源 / 本地 SSH 资源池的管理面
 *
 * 资源「自身」的使用不需要专用工具：@资源 注入的清单已给出入口与凭证，
 * 模型用自带的 bash / web_fetch 即可 —— 不再新增一层转手工具。
 */
import type { Context } from 'cordis';
import type { AgentRunner } from './agent-runner.js';
import type { MentionParser } from './mentions.js';
import type { OnenatDirectory } from './onenat.js';
import type { AgentResolver } from './resolver.js';
import type { SshResourceStore } from './ssh-store.js';
import type { WorkStore } from './store.js';
export interface ToolDeps {
    store: WorkStore;
    directory: OnenatDirectory;
    resolver: AgentResolver;
    runner: AgentRunner;
    sshStore: SshResourceStore;
    parser: MentionParser;
    log: (msg: string) => void;
}
export declare function registerTools(ctx: Context, deps: ToolDeps): void;
/** 供 system-prompt 段复用的子智能体花名册渲染 */
export declare function renderAgentRoster(store: WorkStore, max?: number): string;
