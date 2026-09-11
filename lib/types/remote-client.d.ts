/**
 * @dsh-external/onenat-workbuddy - DSH 远程客户端（面向解析后的 ResolvedDshTarget）
 *
 * 相比 dsh-remote-orchestrator 的 RemoteDshClient 升级:
 *  1. 一切调用吃 { baseUrl, apiKey }（由 ResourceDirectory 实时解析而来），不再吃裸 agent（D1）
 *  2. 新增 streamPrompt: 消费远端 /sessions/:id/prompt-stream SSE（delta/reasoning/tool_call/turn_end）
 *     —— fetch 挂 undici dispatcher（bodyTimeout=0）：长工具执行 / 上下文压缩期间无 SSE 帧的静默段
 *        不再触发 undici 默认 300s「chunk 间超时」把连接掐断（长回合 SSE 断流的根因）
 *  3. 保留同步 prompt + waitForSessionResult 轮询兜底（远端不支持 SSE 或流中断时降级，D5）
 *     —— 轮询对账升级：按回合起点重建整轮文本（reconstructTurnFromHistory），不再只取最后一条 assistant 消息
 *  4. 新增 chat: OpenAI 兼容 /chat/completions（LLM Planner 用）
 */
import type { SubtaskLogEntry } from './types.js';
export interface DshTarget {
    baseUrl: string;
    apiKey?: string;
}
export interface PingResult {
    ok: boolean;
    name?: string;
    version?: string;
    port?: number;
    uptime?: number;
    providers?: string[];
    error?: string;
}
export interface RemoteModelEntry {
    id: string;
    provider: string;
    name: string;
    isDefault?: boolean;
    description?: string;
    reasoning?: boolean;
}
export interface StreamEventHandlers {
    onDelta?: (delta: string) => void;
    onReasoning?: (delta: string) => void;
    onToolCall?: (info: {
        id?: string;
        name?: string;
        arguments?: any;
    }) => void;
    onToolResult?: (info: {
        id?: string;
        name?: string;
        result?: any;
        isError?: boolean;
    }) => void;
    onUsage?: (usage: Record<string, number>) => void;
    onLog?: (msg: string, level?: SubtaskLogEntry['level']) => void;
}
export interface PromptResult {
    ok: boolean;
    content?: string;
    reasoning?: string;
    error?: string;
    timedOut?: boolean;
    /** 实际生效的派发通道 */
    via?: 'sse' | 'sync' | 'poll';
    /** SSE 是否收到 turn_end（false = 流提前终结，content 可能不完整，调用方应对账兜底） */
    complete?: boolean;
    /** 远端不支持 prompt-stream（旧版）⇒ 调用方降级同步 prompt */
    sseUnsupported?: boolean;
    /** 远端返回的真实 token 账本（含缓存命中），供前端展示缓存率 */
    usage?: Record<string, number>;
}
/**
 * 按回合起点重建整轮 assistant 文本。
 * 优先定位「包含本次提交 prompt 片段」的最后一条 user 消息作为回合起点（注入消息不含用户文本，天然排除）；
 * 找不到时退化为最后一条非注入型 user 消息。回合内所有非空 assistant 文本按序拼接。
 */
export declare function reconstructTurnFromHistory(messages: any[], promptFragment?: string): {
    text: string;
    matched: boolean;
};
/** 远端 /skills 列表条目 */
export interface RemoteSkillEntry {
    name: string;
    description: string;
    whenToUse?: string;
    modelInvocable: boolean;
    userInvocable: boolean;
    source: string;
    path: string;
    root: string;
    size: number;
}
/** 远端 /skills/:name 详情 */
export interface RemoteSkillDetail {
    name: string;
    description: string;
    whenToUse?: string;
    modelInvocable: boolean;
    userInvocable: boolean;
    path: string;
    root: string;
    content: string;
    raw: string;
    size: number;
}
export declare class DshClient {
    private headers;
    /** 无 Content-Type 的鉴权头（FormData/流式场景） */
    private headersAuth;
    /** 上传文件到远端会话工作区（远端 DSH 需 dsh-web-service >= 0.1.0） */
    uploadFiles(target: DshTarget, sessionId: string, files: Array<{
        filename: string;
        data: Buffer;
        mimeType?: string;
    }>): Promise<{
        ok: boolean;
        files?: Array<{
            name: string;
            path: string;
            size: number;
            mimeType?: string;
        }>;
        cwd?: string;
        error?: string;
    }>;
    /** 远端目录浏览（对齐 DSH directory-picker-browse：只返回目录行，hidden 标记） */
    fsList(target: DshTarget, dirPath?: string): Promise<{
        ok: boolean;
        error?: string;
        data?: {
            path: string;
            home: string;
            parent?: string;
            entries: Array<{
                name: string;
                path: string;
                hidden: boolean;
            }>;
            truncated: boolean;
        };
    }>;
    /** 远端新建目录 */
    fsMkdir(target: DshTarget, parent: string, name: string): Promise<{
        ok: boolean;
        error?: string;
        data?: {
            path: string;
            name: string;
        };
    }>;
    /** 查询远端会话信息（cwd 用于把 AI 报告的绝对路径换算成工作区相对路径） */
    getSessionInfo(target: DshTarget, sessionId: string): Promise<{
        ok: boolean;
        cwd?: string;
        title?: string;
        status?: string;
        error?: string;
    }>;
    /** 下载远端会话工作区文件，返回原始 Response 供流式转发 */
    downloadFile(target: DshTarget, sessionId: string, relPath: string): Promise<{
        ok: boolean;
        res?: Response;
        name?: string;
        error?: string;
    }>;
    /** 技能条目（远端 /skills 列表返回） */
    listSkills(target: DshTarget, opts?: {
        root?: string;
        cwd?: string;
        search?: string;
    }): Promise<{
        ok: boolean;
        root?: {
            kind: string;
            path: string;
        };
        skills: Array<RemoteSkillEntry>;
        count?: number;
        error?: string;
        unsupported?: boolean;
    }>;
    /** 单技能详情（含正文 content 与全文 raw） */
    getSkill(target: DshTarget, name: string, opts?: {
        root?: string;
        cwd?: string;
    }): Promise<{
        ok: boolean;
        skill?: RemoteSkillDetail;
        error?: string;
        unsupported?: boolean;
    }>;
    /** 获取 SKILL.md 全文（预览/下载） */
    getSkillBody(target: DshTarget, name: string, opts?: {
        root?: string;
        cwd?: string;
    }): Promise<{
        ok: boolean;
        content?: string;
        error?: string;
        unsupported?: boolean;
    }>;
    /** 下载整个技能目录归档 (.tgz)，返回原始 Response 供流式转发 */
    downloadSkillArchive(target: DshTarget, name: string, opts?: {
        root?: string;
        cwd?: string;
    }): Promise<{
        ok: boolean;
        res?: Response;
        name?: string;
        error?: string;
        unsupported?: boolean;
    }>;
    /** 上传技能（multipart：file=技能压缩包 .zip/.tgz，字段 root/name） */
    uploadSkill(target: DshTarget, file: {
        filename: string;
        data: Buffer;
    }, fields?: {
        root?: string;
        name?: string;
        cwd?: string;
    }): Promise<{
        ok: boolean;
        name?: string;
        path?: string;
        error?: string;
        unsupported?: boolean;
    }>;
    /** 更新技能元数据/正文（JSON） */
    updateSkill(target: DshTarget, name: string, payload: {
        description?: string;
        whenToUse?: string;
        content?: string;
        modelInvocable?: boolean;
        userInvocable?: boolean;
    }, opts?: {
        root?: string;
        cwd?: string;
    }): Promise<{
        ok: boolean;
        error?: string;
    }>;
    /** 删除技能 */
    deleteSkill(target: DshTarget, name: string, opts?: {
        root?: string;
        cwd?: string;
    }): Promise<{
        ok: boolean;
        error?: string;
    }>;
    ping(target: DshTarget): Promise<PingResult>;
    getModels(target: DshTarget): Promise<{
        ok: boolean;
        defaultModel?: any;
        models: RemoteModelEntry[];
        error?: string;
    }>;
    getPresets(target: DshTarget): Promise<{
        ok: boolean;
        presets: Array<{
            id: string;
            name?: string;
            description?: string;
        }>;
        error?: string;
    }>;
    createSession(target: DshTarget, title: string, options?: {
        agentPreset?: string;
        provider?: string;
        model?: string;
        cwd?: string;
    }): Promise<{
        ok: boolean;
        sessionId?: string;
        error?: string;
    }>;
    cancelSession(target: DshTarget, sessionId: string): Promise<{
        ok: boolean;
        error?: string;
    }>;
    getSession(target: DshTarget, sessionId: string): Promise<{
        ok: boolean;
        status?: string;
        error?: string;
    }>;
    /**
     * 会话作用域技能目录（对齐 harness skills/list：按会话 cwd 解析技能根）。
     * 需要 dsh-web-service ≥ 0.1.5（GET /sessions/:id/skills）；旧版返回 supported=false。
     * 「装载到上下文」由远端 DSH 核心完成：用户消息中空白符边界的 /name 手势
     * （tool-skill pre-step）会注入技能正文，这里只取清单。
     */
    getSessionSkills(target: DshTarget, sessionId: string, q?: string): Promise<{
        ok: boolean;
        supported?: boolean;
        cwd?: string;
        skills?: Array<{
            name: string;
            description?: string;
            whenToUse?: string;
            modelInvocable?: boolean;
            userInvocable?: boolean;
        }>;
        error?: string;
    }>;
    /**
     * 会话实时统计（轮/步/LLM 与工具耗时/首 token/吞吐/token 账本）。
     * 需要 dsh-web-service ≥ 0.1.5（GET /sessions/:id/stats）；旧版返回 supported=false 供调用方降级隐藏。
     */
    getSessionStats(target: DshTarget, sessionId: string): Promise<{
        ok: boolean;
        supported?: boolean;
        stats?: Record<string, number>;
        error?: string;
    }>;
    /**
     * 提交 ask_user_question 挂起问题的答复（远端宿主 waterfall 桥）。
     * 需要 dsh-web-service ≥ 0.1.6（POST /sessions/:id/answers）；旧版返回 supported=false。
     */
    answerQuestion(target: DshTarget, sessionId: string, answers: Array<{
        id: string;
        selected: string[];
        custom?: string;
    }>): Promise<{
        ok: boolean;
        supported?: boolean;
        error?: string;
    }>;
    /**
     * SSE 流式派发 prompt。解析 `event: X\ndata: Y` 帧。
     * 远端返回 404/501（旧版无此路由）时返回 sseUnsupported=true 供调用方降级。
     */
    streamPrompt(target: DshTarget, sessionId: string, prompt: string, handlers: StreamEventHandlers, options?: {
        remoteTimeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<PromptResult>;
    /** 同步派发（降级路径，沿用 orchestrator 的双窗口超时策略） */
    prompt(target: DshTarget, sessionId: string, prompt: string, options?: {
        timeoutMs?: number;
        remoteTimeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<PromptResult>;
    getHistory(target: DshTarget, sessionId: string, maxMessages?: number): Promise<{
        ok: boolean;
        messages?: any[];
        error?: string;
    }>;
    /** 轮询远端会话直到结束并提取最后一条助手回复（同步超时兜底） */
    waitForSessionResult(target: DshTarget, sessionId: string, options?: {
        maxMs?: number;
        intervalMs?: number;
        signal?: AbortSignal;
        onLog?: (msg: string, level?: SubtaskLogEntry['level']) => void;
        promptFragment?: string;
    }): Promise<PromptResult>;
    /** OpenAI 兼容 /chat/completions（Planner 用，非流式） */
    chat(target: DshTarget, messages: Array<{
        role: 'system' | 'user' | 'assistant';
        content: string;
    }>, options?: {
        model?: string;
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<{
        ok: boolean;
        content?: string;
        reasoning?: string;
        sessionId?: string;
        error?: string;
    }>;
}
