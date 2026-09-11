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
import { DshClient } from './remote-client.js';
const MAX_TOOL_SUMMARIES = 60;
const MAX_TEXT = 120_000;
function clip(text, max = 2000) {
    const s = String(text ?? '');
    return s.length > max ? s.slice(0, max) + '…' : s;
}
export class AgentRunner {
    store;
    resolver;
    composer;
    resources;
    client = new DshClient();
    constructor(store, resolver, composer, resources) {
        this.store = store;
        this.resolver = resolver;
        this.composer = composer;
        this.resources = resources;
    }
    /**
     * 把 @ 提及里的资源 ID 解析成资源绑定 + 预渲染段（实现见 MentionResourceResolver：
     * ONENAT 侧走 PromptComposer 实时解析，本地 SSH 池直接渲染连接与凭证）。
     */
    bindingsFromResourceIds(ids) {
        const resolved = this.resources.resolve(ids || []);
        return {
            bindings: resolved.bindings,
            preRendered: resolved.preRendered,
            warnings: resolved.missing.map((m) => `${m} 已不存在，本轮未注入`),
        };
    }
    /** 解析子智能体（名称 / ID / 提及 URI） */
    resolveAgent(key) {
        const raw = String(key || '').trim();
        if (!raw)
            return undefined;
        const stripped = raw.replace(/^onenat-agent:/, '');
        return this.store.findAgent(stripped);
    }
    /** 组装派发提示词（角色 + 资源块 + 技能手势 + 任务正文） */
    async composePrompt(agent, task, extra, ctx) {
        const composed = await this.composer.compose(agent, { resolvedAt: Date.now(), extraResources: extra });
        const parts = [];
        if (agent.systemPrompt?.trim())
            parts.push('[角色与职责]', agent.systemPrompt.trim(), '');
        if (composed.block)
            parts.push(composed.block, '');
        for (const item of ctx.preRendered || [])
            parts.push(item.markdown, '');
        parts.push('[由 OneNat WorkBuddy 派发的任务]');
        parts.push(`- 执行方：${agent.name}（远端 DSH 节点上的独立会话，拥有自己的文件/命令/网络工具）`);
        if (ctx.permission)
            parts.push(`- 运行权限：${ctx.permission}`);
        if (agent.workDir)
            parts.push(`- 工作目录：${agent.workDir}（相对路径一律以此为根）`);
        parts.push('- 你无法访问发起方（主智能体）会话的上下文；任务所需信息以本消息为准，缺失时用 ask_user_question 提问或在结论中报告缺口。');
        parts.push('');
        parts.push('[任务]');
        parts.push(task.trim());
        return { prompt: parts.join('\n'), warnings: composed.warnings };
    }
    /**
     * 执行一次派发。失败以 ok=false + error 返回（不抛错），便于工具层原样呈现。
     */
    async run(agentKey, task, options = {}) {
        const started = Date.now();
        const agent = this.resolveAgent(agentKey);
        if (!agent) {
            return failure(started, agentKey, String(agentKey || ''), '', false, `子智能体「${agentKey}」不存在（可能已删除，请在设置页或 @ 菜单里确认）`);
        }
        if (agent.enabled === false) {
            return failure(started, agent.id, agent.name, '', false, `子智能体「${agent.name}」已停用`);
        }
        if (!task || !task.trim()) {
            return failure(started, agent.id, agent.name, '', false, '缺少任务描述（task）');
        }
        const log = (text, type = 'log') => {
            options.onProgress?.({ type, text });
        };
        // 1. 实时解析入口（D1）
        const target = await this.resolver.resolve(agent);
        if (!target.online || !target.baseUrl) {
            return failure(started, agent.id, agent.name, '', false, target.error || 'ONENAT 入口解析失败');
        }
        log(`ONENAT 入口解析：${target.baseUrl}${target.mappingId ? `（mapping ${target.mappingId}）` : ''}`);
        // 2. 会话长持（D3）
        const settings = this.store.getSettings();
        const reuse = options.newSession ? false : settings.defaults.reuseSession;
        let binding = reuse ? this.store.getSession(options.scope, agent.id) : undefined;
        if (binding && (binding.baseUrl !== target.baseUrl || (binding.cwd || '') !== (agent.workDir || ''))) {
            log('入口或工作目录已变化，重建远端会话');
            binding = undefined;
        }
        let sessionReused = Boolean(binding?.remoteSessionId);
        let remoteSessionId = binding?.remoteSessionId;
        if (!remoteSessionId) {
            const created = await this.client.createSession(target, `WorkBuddy · ${agent.name}`, {
                agentPreset: agent.agentPreset || 'cordis',
                provider: agent.provider,
                model: agent.model,
                cwd: agent.workDir,
            });
            if (!created.ok || !created.sessionId) {
                return failure(started, agent.id, agent.name, target.baseUrl, false, `远端会话创建失败：${created.error}`);
            }
            remoteSessionId = created.sessionId;
            sessionReused = false;
            log(`远端会话已创建：${remoteSessionId}`);
        }
        else {
            log(`复用远端会话：${remoteSessionId}（多轮续聊）`);
        }
        this.store.setSession(options.scope, agent.id, {
            remoteSessionId,
            baseUrl: target.baseUrl,
            cwd: agent.workDir,
            usedAt: Date.now(),
            scope: options.scope,
        });
        // 3. 资源绑定 + 提示词组装
        const extra = this.bindingsFromResourceIds(options.resourceIds);
        for (const warning of extra.warnings)
            log(warning);
        const composed = await this.composePrompt(agent, task, extra.bindings, {
            permission: agent.permission,
            preRendered: extra.preRendered,
        });
        for (const warning of composed.warnings)
            log(warning);
        // 4. 执行（SSE 优先，旧远端降级）
        const tools = [];
        const toolIndex = new Map();
        const usageBox = {};
        let reasoning = '';
        let streamed = '';
        const settleTool = (id, name, patch) => {
            const key = id || name || `t${tools.length}`;
            let entry = toolIndex.get(key);
            if (!entry) {
                entry = { name: name || 'tool', status: 'running' };
                toolIndex.set(key, entry);
                if (tools.length < MAX_TOOL_SUMMARIES)
                    tools.push(entry);
            }
            if (name)
                entry.name = name;
            Object.assign(entry, patch);
            if (patch.status && patch.status !== 'running' && entry.ms === undefined)
                entry.ms = Date.now() - started;
            options.onProgress?.({ type: 'tool', text: `工具 ${entry.name} ${entry.status}${entry.ms !== undefined ? ` (${entry.ms}ms)` : ''}` });
        };
        const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : settings.defaults.timeoutMs;
        const result = await this.client.streamPrompt(target, remoteSessionId, composed.prompt, {
            onDelta: (delta) => {
                streamed += delta;
                options.onProgress?.({ type: 'delta', text: delta });
            },
            onReasoning: (delta) => {
                reasoning += delta;
                options.onProgress?.({ type: 'reasoning', text: delta });
            },
            onToolCall: (info) => settleTool(info.id, info.name, { status: 'running', args: clip(safeJson(info.arguments), 400) }),
            onToolResult: (info) => settleTool(info.id, info.name, { status: info.isError ? 'error' : 'done', result: clip(safeJson(info.result), 400) }),
            onUsage: (usage) => {
                usageBox.value = usage;
            },
            onLog: (msg) => log(msg),
        }, { remoteTimeoutMs: timeoutMs, signal: options.signal });
        if (!result.ok) {
            const hint = result.sseUnsupported ? '（远端不支持流式，已尝试同步降级）' : '';
            return {
                ...failure(started, agent.id, agent.name, target.baseUrl, sessionReused, `${result.error || '远端执行失败'}${hint}`),
                remoteSessionId,
                output: streamed,
                reasoning: reasoning || undefined,
                tools,
            };
        }
        const output = (result.content || streamed || '').trim();
        return {
            ok: true,
            agentId: agent.id,
            agentName: agent.name,
            entry: target.baseUrl,
            remoteSessionId,
            sessionReused,
            output: clip(output, MAX_TEXT),
            ...(reasoning ? { reasoning: clip(reasoning, MAX_TEXT) } : {}),
            tools,
            ...(result.usage ? { usage: result.usage } : usageBox.value ? { usage: usageBox.value } : {}),
            via: result.via,
            ms: Date.now() - started,
        };
    }
}
function failure(started, agentId, agentName, entry, sessionReused, error) {
    return {
        ok: false,
        agentId,
        agentName,
        entry,
        sessionReused,
        output: '',
        tools: [],
        error,
        ms: Date.now() - started,
    };
}
function safeJson(value) {
    if (value === undefined || value === null)
        return '';
    if (typeof value === 'string')
        return value;
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
//# sourceMappingURL=agent-runner.js.map