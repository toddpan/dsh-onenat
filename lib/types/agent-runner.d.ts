/**
 * @dsh-external/onenat-workbuddy-mention - 单次远端派发执行器
 *
 * 一次派发 = 一个「自包含任务」交给某个 ONENAT 子智能体：
 *   1. 解析：AgentResolver 强刷 ONENAT → 当下 baseUrl（D1 端口漂移免疫）
 *   2. 会话长持：(本地 DSH 会话, 子智能体) → 远端会话复用；工作目录/入口变化则重建
 *   3. 组装：角色提示词 + [可用资源清单]（PromptComposer）+ 本轮 @ 指定的资源 + 任务正文
 *   4. 执行：远端 dsh-web-service `POST /sessions/:id/prompt-stream`（SSE），
 *            旧远端降级同步 prompt + 轮询对账
 *   5. 回填：正文 / 思维链 / 工具调用摘要 / token 用量 / 远端会话 ID（可继续追问）
 */
import type { AgentResolver } from './resolver.js';
import type { PromptComposer } from './prompt-composer.js';
import type { MentionResourceResolver } from './resource-bindings.js';
import type { WorkStore } from './store.js';
import type { AgentResourceBinding, SubAgent } from './types.js';
export interface ToolCallSummary {
    name: string;
    status: 'running' | 'done' | 'error';
    ms?: number;
    args?: string;
    result?: string;
}
export interface RunProgressEvent {
    type: 'log' | 'reasoning' | 'delta' | 'tool';
    text: string;
}
export interface AgentRunResult {
    ok: boolean;
    agentId: string;
    agentName: string;
    /** 本次实际使用的公网入口（审计：端口漂移免疫的解析结果） */
    entry: string;
    remoteSessionId?: string;
    sessionReused: boolean;
    output: string;
    reasoning?: string;
    tools: ToolCallSummary[];
    usage?: Record<string, number>;
    /** 实际生效的通道：sse / sync / poll */
    via?: string;
    error?: string;
    ms: number;
}
export interface RunOptions {
    /** 归属的本地 DSH 会话 ID（远端会话按它隔离） */
    scope?: string;
    /** 本轮 @ 提及额外指定的资源（mappingId / appId / ssh:<id>） */
    resourceIds?: string[];
    /** 强制开新远端会话 */
    newSession?: boolean;
    timeoutMs?: number;
    signal?: AbortSignal;
    onProgress?: (event: RunProgressEvent) => void;
}
export declare class AgentRunner {
    private store;
    private resolver;
    private composer;
    private resources;
    private client;
    constructor(store: WorkStore, resolver: AgentResolver, composer: PromptComposer, resources: MentionResourceResolver);
    /**
     * 把 @ 提及里的资源 ID 解析成资源绑定 + 预渲染段（实现见 MentionResourceResolver：
     * ONENAT 侧走 PromptComposer 实时解析，本地 SSH 池直接渲染连接与凭证）。
     */
    bindingsFromResourceIds(ids: string[] | undefined): {
        bindings: AgentResourceBinding[];
        preRendered: Array<{
            alias: string;
            markdown: string;
        }>;
        warnings: string[];
    };
    /** 解析子智能体（名称 / ID / 提及 URI） */
    resolveAgent(key: string): SubAgent | undefined;
    /** 组装派发提示词（角色 + 资源块 + 技能手势 + 任务正文） */
    composePrompt(agent: SubAgent, task: string, extra: AgentResourceBinding[], ctx: {
        permission?: string;
        preRendered?: Array<{
            alias: string;
            markdown: string;
        }>;
    }): Promise<{
        prompt: string;
        warnings: string[];
    }>;
    /**
     * 执行一次派发。失败以 ok=false + error 返回（不抛错），便于工具层原样呈现。
     */
    run(agentKey: string, task: string, options?: RunOptions): Promise<AgentRunResult>;
}
