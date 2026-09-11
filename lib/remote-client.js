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
function clean(url) {
    return url.replace(/\/+$/, '');
}
/**
 * 长静默 SSE 兜底 dispatcher：长工具执行 / 上下文压缩期间流上没有任何帧，
 * undici 默认 bodyTimeout=300s 会按「chunk 间空闲」掐断连接 → 长回合必断流。
 * bodyTimeout=0 关闭该超时（headersTimeout 保留，防远端彻底失联）。undici 不可用时优雅降级为默认行为。
 */
let longIdleDispatcher = null;
async function getLongIdleDispatcher() {
    if (longIdleDispatcher !== null)
        return longIdleDispatcher ?? undefined;
    try {
        const undici = await import('undici');
        longIdleDispatcher = new undici.Agent({ bodyTimeout: 0, headersTimeout: 120_000 });
    }
    catch {
        longIdleDispatcher = undefined;
    }
    return longIdleDispatcher ?? undefined;
}
/** 从 history 消息提取纯文本（string 或 content blocks 数组） */
function messageText(raw) {
    if (typeof raw === 'string')
        return raw;
    if (Array.isArray(raw))
        return raw.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n');
    return '';
}
/** 注入型 user 消息（宿主自动注入，非真实用户输入，不能作为回合起点）：compaction checkpoint / 技能目录提醒 / 运行时上下文快照 */
const INJECTED_USER_PREFIXES = [
    'This is an automatically generated checkpoint',
    '<system-reminder>',
    'Current runtime context.',
];
/**
 * 按回合起点重建整轮 assistant 文本。
 * 优先定位「包含本次提交 prompt 片段」的最后一条 user 消息作为回合起点（注入消息不含用户文本，天然排除）；
 * 找不到时退化为最后一条非注入型 user 消息。回合内所有非空 assistant 文本按序拼接。
 */
export function reconstructTurnFromHistory(messages, promptFragment) {
    const isInjected = (t) => INJECTED_USER_PREFIXES.some((p) => t.startsWith(p));
    let startIdx = -1;
    if (promptFragment) {
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m?.role !== 'user')
                continue;
            const t = messageText(m.content);
            if (t && t.includes(promptFragment)) {
                startIdx = i;
                break;
            }
        }
    }
    if (startIdx < 0) {
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m?.role !== 'user')
                continue;
            const t = messageText(m.content);
            if (t && !isInjected(t)) {
                startIdx = i;
                break;
            }
        }
    }
    if (startIdx < 0)
        return { text: '', matched: false };
    const parts = [];
    for (let j = startIdx + 1; j < messages.length; j++) {
        const m = messages[j];
        if (m?.role !== 'assistant')
            continue;
        const t = messageText(m.content).trim();
        if (t)
            parts.push(t);
    }
    return { text: parts.join('\n\n'), matched: true };
}
function toQuery(opts) {
    const q = [];
    if (opts?.root)
        q.push(`root=${encodeURIComponent(opts.root)}`);
    if (opts?.cwd)
        q.push(`cwd=${encodeURIComponent(opts.cwd)}`);
    return q.length ? '?' + q.join('&') : '';
}
export class DshClient {
    headers(apiKey) {
        const h = { 'Content-Type': 'application/json', Accept: 'application/json' };
        if (apiKey && apiKey.trim())
            h.Authorization = `Bearer ${apiKey.trim()}`;
        return h;
    }
    /** 无 Content-Type 的鉴权头（FormData/流式场景） */
    headersAuth(apiKey) {
        const h = { Accept: 'application/json' };
        if (apiKey && apiKey.trim())
            h.Authorization = `Bearer ${apiKey.trim()}`;
        return h;
    }
    /** 上传文件到远端会话工作区（远端 DSH 需 dsh-web-service >= 0.1.0） */
    async uploadFiles(target, sessionId, files) {
        try {
            const fd = new FormData();
            for (const f of files) {
                const blob = new Blob([new Uint8Array(f.data)], { type: f.mimeType || 'application/octet-stream' });
                fd.append('files', blob, f.filename);
            }
            const res = await fetch(`${clean(target.baseUrl)}/sessions/${sessionId}/files`, {
                method: 'POST',
                headers: this.headersAuth(target.apiKey),
                body: fd,
                signal: AbortSignal.timeout(120_000),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json?.ok)
                return { ok: false, error: json?.error || `HTTP ${res.status}` };
            return { ok: true, files: json.data?.files || [], cwd: json.data?.cwd };
        }
        catch (err) {
            return { ok: false, error: err?.message || '上传失败' };
        }
    }
    /** 远端目录浏览（对齐 DSH directory-picker-browse：只返回目录行，hidden 标记） */
    async fsList(target, dirPath) {
        try {
            const url = `${clean(target.baseUrl)}/fs/list${dirPath ? `?path=${encodeURIComponent(dirPath)}` : ''}`;
            const res = await fetch(url, { headers: this.headers(target.apiKey), signal: AbortSignal.timeout(15_000) });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json?.ok)
                return { ok: false, error: json?.error || `HTTP ${res.status}` };
            return { ok: true, data: json.data };
        }
        catch (err) {
            return { ok: false, error: err?.message || '目录浏览失败' };
        }
    }
    /** 远端新建目录 */
    async fsMkdir(target, parent, name) {
        try {
            const res = await fetch(`${clean(target.baseUrl)}/fs/mkdir`, {
                method: 'POST',
                headers: this.headers(target.apiKey),
                body: JSON.stringify({ path: parent, name }),
                signal: AbortSignal.timeout(15_000),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json?.ok)
                return { ok: false, error: json?.error || `HTTP ${res.status}` };
            return { ok: true, data: json.data };
        }
        catch (err) {
            return { ok: false, error: err?.message || '新建目录失败' };
        }
    }
    /** 查询远端会话信息（cwd 用于把 AI 报告的绝对路径换算成工作区相对路径） */
    async getSessionInfo(target, sessionId) {
        try {
            const res = await fetch(`${clean(target.baseUrl)}/sessions/${sessionId}`, {
                headers: this.headers(target.apiKey),
                signal: AbortSignal.timeout(10_000),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json?.ok)
                return { ok: false, error: json?.error || `HTTP ${res.status}` };
            return { ok: true, cwd: json.data?.cwd, title: json.data?.title, status: json.data?.status };
        }
        catch (err) {
            return { ok: false, error: err?.message || '查询会话失败' };
        }
    }
    /** 下载远端会话工作区文件，返回原始 Response 供流式转发 */
    async downloadFile(target, sessionId, relPath) {
        try {
            const url = `${clean(target.baseUrl)}/sessions/${sessionId}/files/download?path=${encodeURIComponent(relPath)}`;
            const res = await fetch(url, { headers: this.headersAuth(target.apiKey), signal: AbortSignal.timeout(120_000) });
            if (!res.ok || !res.body) {
                const json = await res.json().catch(() => ({}));
                return { ok: false, error: json?.error || `HTTP ${res.status}` };
            }
            return { ok: true, res, name: relPath.split('/').pop() };
        }
        catch (err) {
            return { ok: false, error: err?.message || '下载失败' };
        }
    }
    // ---------- 技能管理（dsh-web-service /skills） ----------
    /** 技能条目（远端 /skills 列表返回） */
    async listSkills(target, opts) {
        try {
            const q = [];
            if (opts?.root)
                q.push(`root=${encodeURIComponent(opts.root)}`);
            if (opts?.cwd)
                q.push(`cwd=${encodeURIComponent(opts.cwd)}`);
            if (opts?.search)
                q.push(`search=${encodeURIComponent(opts.search)}`);
            const url = `${clean(target.baseUrl)}/skills${q.length ? '?' + q.join('&') : ''}`;
            const res = await fetch(url, { headers: this.headers(target.apiKey), signal: AbortSignal.timeout(15_000) });
            if (res.status === 404 || res.status === 501)
                return { ok: false, skills: [], unsupported: true, error: '远端 dsh-web-service 未安装 /skills 端点' };
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json?.ok)
                return { ok: false, skills: [], error: json?.error || `HTTP ${res.status}` };
            return { ok: true, root: json.data?.root, count: json.data?.count, skills: Array.isArray(json.data?.skills) ? json.data.skills : [] };
        }
        catch (err) {
            return { ok: false, skills: [], error: err?.message || '获取技能列表失败' };
        }
    }
    /** 单技能详情（含正文 content 与全文 raw） */
    async getSkill(target, name, opts) {
        const q = toQuery(opts);
        try {
            const res = await fetch(`${clean(target.baseUrl)}/skills/${encodeURIComponent(name)}${q}`, {
                headers: this.headers(target.apiKey),
                signal: AbortSignal.timeout(15_000),
            });
            if (res.status === 404 || res.status === 501)
                return { ok: false, unsupported: true, error: '远端 dsh-web-service 未安装 /skills 端点' };
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json?.ok)
                return { ok: false, error: json?.error || `HTTP ${res.status}` };
            return { ok: true, skill: json.data };
        }
        catch (err) {
            return { ok: false, error: err?.message || '获取技能详情失败' };
        }
    }
    /** 获取 SKILL.md 全文（预览/下载） */
    async getSkillBody(target, name, opts) {
        const q = toQuery(opts);
        try {
            const res = await fetch(`${clean(target.baseUrl)}/skills/${encodeURIComponent(name)}/body${q}`, {
                headers: this.headersAuth(target.apiKey),
                signal: AbortSignal.timeout(20_000),
            });
            if (res.status === 404 || res.status === 501)
                return { ok: false, unsupported: true, error: '远端 dsh-web-service 未安装 /skills 端点' };
            if (!res.ok) {
                const json = await res.json().catch(() => ({}));
                return { ok: false, error: json?.error || `HTTP ${res.status}` };
            }
            return { ok: true, content: await res.text() };
        }
        catch (err) {
            return { ok: false, error: err?.message || '获取技能全文失败' };
        }
    }
    /** 下载整个技能目录归档 (.tgz)，返回原始 Response 供流式转发 */
    async downloadSkillArchive(target, name, opts) {
        const q = toQuery(opts);
        try {
            const res = await fetch(`${clean(target.baseUrl)}/skills/${encodeURIComponent(name)}/archive${q}`, {
                headers: this.headersAuth(target.apiKey),
                signal: AbortSignal.timeout(120_000),
            });
            if (res.status === 404 || res.status === 501)
                return { ok: false, unsupported: true, error: '远端 dsh-web-service 未安装 /skills 端点' };
            if (!res.ok || !res.body) {
                const json = await res.json().catch(() => ({}));
                return { ok: false, error: json?.error || `HTTP ${res.status}` };
            }
            return { ok: true, res, name: `${name}.tgz` };
        }
        catch (err) {
            return { ok: false, error: err?.message || '下载技能归档失败' };
        }
    }
    /** 上传技能（multipart：file=技能压缩包 .zip/.tgz，字段 root/name） */
    async uploadSkill(target, file, fields) {
        try {
            const fd = new FormData();
            fd.append('file', new Blob([new Uint8Array(file.data)]), file.filename);
            if (fields?.root)
                fd.append('root', fields.root);
            if (fields?.name)
                fd.append('name', fields.name);
            if (fields?.cwd)
                fd.append('cwd', fields.cwd);
            const res = await fetch(`${clean(target.baseUrl)}/skills`, {
                method: 'POST',
                headers: this.headersAuth(target.apiKey),
                body: fd,
                signal: AbortSignal.timeout(120_000),
            });
            if (res.status === 404 || res.status === 501)
                return { ok: false, unsupported: true, error: '远端 dsh-web-service 未安装 /skills 端点' };
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json?.ok)
                return { ok: false, error: json?.error || `HTTP ${res.status}` };
            return { ok: true, name: json.data?.name, path: json.data?.path };
        }
        catch (err) {
            return { ok: false, error: err?.message || '上传技能失败' };
        }
    }
    /** 更新技能元数据/正文（JSON） */
    async updateSkill(target, name, payload, opts) {
        const q = toQuery(opts);
        try {
            const res = await fetch(`${clean(target.baseUrl)}/skills/${encodeURIComponent(name)}${q}`, {
                method: 'PUT',
                headers: this.headers(target.apiKey),
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(15_000),
            });
            if (res.status === 404 || res.status === 501)
                return { ok: false, error: '远端 dsh-web-service 未安装 /skills 端点' };
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json?.ok)
                return { ok: false, error: json?.error || `HTTP ${res.status}` };
            return { ok: true };
        }
        catch (err) {
            return { ok: false, error: err?.message || '更新技能失败' };
        }
    }
    /** 删除技能 */
    async deleteSkill(target, name, opts) {
        const q = toQuery(opts);
        try {
            const res = await fetch(`${clean(target.baseUrl)}/skills/${encodeURIComponent(name)}${q}`, {
                method: 'DELETE',
                headers: this.headers(target.apiKey),
                signal: AbortSignal.timeout(15_000),
            });
            if (res.status === 404 || res.status === 501)
                return { ok: false, error: '远端 dsh-web-service 未安装 /skills 端点' };
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json?.ok)
                return { ok: false, error: json?.error || `HTTP ${res.status}` };
            return { ok: true };
        }
        catch (err) {
            return { ok: false, error: err?.message || '删除技能失败' };
        }
    }
    async ping(target) {
        try {
            const res = await fetch(`${clean(target.baseUrl)}/system/status`, {
                headers: this.headers(target.apiKey),
                signal: AbortSignal.timeout(10_000),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json?.ok)
                return { ok: false, error: json?.error || `HTTP ${res.status}` };
            return {
                ok: true,
                name: json.data?.name,
                version: json.data?.version,
                port: json.data?.port,
                uptime: json.data?.uptime,
                providers: json.data?.providers || [],
            };
        }
        catch (err) {
            return { ok: false, error: err?.message || '连接失败' };
        }
    }
    async getModels(target) {
        try {
            const res = await fetch(`${clean(target.baseUrl)}/models`, {
                headers: this.headers(target.apiKey),
                signal: AbortSignal.timeout(10_000),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json?.ok)
                return { ok: false, models: [], error: json?.error || `HTTP ${res.status}` };
            return { ok: true, defaultModel: json.data?.defaultModel, models: Array.isArray(json.data?.models) ? json.data.models : [] };
        }
        catch (err) {
            return { ok: false, models: [], error: err?.message || '获取模型失败' };
        }
    }
    async getPresets(target) {
        try {
            const res = await fetch(`${clean(target.baseUrl)}/presets`, {
                headers: this.headers(target.apiKey),
                signal: AbortSignal.timeout(10_000),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json?.ok)
                return { ok: false, presets: [], error: json?.error || `HTTP ${res.status}` };
            return { ok: true, presets: Array.isArray(json.data?.presets) ? json.data.presets : [] };
        }
        catch (err) {
            return { ok: false, presets: [], error: err?.message || '获取预设失败' };
        }
    }
    async createSession(target, title, options) {
        const payload = { title, agentPreset: options?.agentPreset || 'cordis' };
        if (options?.provider)
            payload.provider = options.provider;
        if (options?.model)
            payload.model = options.model;
        if (options?.cwd)
            payload.cwd = options.cwd;
        try {
            const res = await fetch(`${clean(target.baseUrl)}/sessions`, {
                method: 'POST',
                headers: this.headers(target.apiKey),
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(20_000),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json?.ok)
                return { ok: false, error: json?.error || `HTTP ${res.status}` };
            return { ok: true, sessionId: json.data?.sessionId };
        }
        catch (err) {
            return { ok: false, error: err?.message || '创建会话失败' };
        }
    }
    async cancelSession(target, sessionId) {
        try {
            // 1. 尝试专用的 /cancel 路由
            const cancelRes = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/cancel`, {
                method: 'POST',
                headers: this.headers(target.apiKey),
                signal: AbortSignal.timeout(6000),
            }).catch(() => null);
            if (cancelRes && cancelRes.ok)
                return { ok: true };
            // 2. 尝试标准 RESTful DELETE /sessions/:id 终止远端会话
            const delRes = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}`, {
                method: 'DELETE',
                headers: this.headers(target.apiKey),
                signal: AbortSignal.timeout(6000),
            }).catch(() => null);
            if (delRes && delRes.ok)
                return { ok: true };
            return { ok: false, error: '远端会话未响应终止请求' };
        }
        catch (err) {
            return { ok: false, error: err?.message || '中止失败' };
        }
    }
    async getSession(target, sessionId) {
        try {
            const res = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}`, {
                headers: this.headers(target.apiKey),
                signal: AbortSignal.timeout(10_000),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json?.ok)
                return { ok: false, error: json?.error || `HTTP ${res.status}` };
            return { ok: true, status: json.data?.status };
        }
        catch (err) {
            return { ok: false, error: err?.message || '查询会话失败' };
        }
    }
    /**
     * 会话作用域技能目录（对齐 harness skills/list：按会话 cwd 解析技能根）。
     * 需要 dsh-web-service ≥ 0.1.5（GET /sessions/:id/skills）；旧版返回 supported=false。
     * 「装载到上下文」由远端 DSH 核心完成：用户消息中空白符边界的 /name 手势
     * （tool-skill pre-step）会注入技能正文，这里只取清单。
     */
    async getSessionSkills(target, sessionId, q) {
        try {
            const query = q ? `?search=${encodeURIComponent(q)}` : '';
            const res = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/skills${query}`, {
                headers: this.headers(target.apiKey),
                signal: AbortSignal.timeout(12_000),
            });
            const json = await res.json().catch(() => ({}));
            if (res.status === 404 || res.status === 501)
                return { ok: false, supported: false, error: '远端 dsh-web-service 版本过低，无会话技能目录' };
            if (!res.ok || !json?.ok)
                return { ok: false, error: json?.error || `HTTP ${res.status}` };
            return {
                ok: true,
                supported: true,
                cwd: json.data?.cwd,
                skills: Array.isArray(json.data?.skills) ? json.data.skills : [],
            };
        }
        catch (err) {
            return { ok: false, error: err?.message || '查询会话技能失败' };
        }
    }
    /**
     * 会话实时统计（轮/步/LLM 与工具耗时/首 token/吞吐/token 账本）。
     * 需要 dsh-web-service ≥ 0.1.5（GET /sessions/:id/stats）；旧版返回 supported=false 供调用方降级隐藏。
     */
    async getSessionStats(target, sessionId) {
        try {
            const res = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/stats`, {
                headers: this.headers(target.apiKey),
                signal: AbortSignal.timeout(12_000),
            });
            const json = await res.json().catch(() => ({}));
            if (res.status === 404 || res.status === 501)
                return { ok: false, supported: false, error: '远端 dsh-web-service 版本过低，不含统计接口' };
            if (!res.ok || !json?.ok)
                return { ok: false, error: json?.error || `HTTP ${res.status}` };
            const d = json.data || {};
            const stats = {
                turns: d.turns || 0,
                steps: d.steps || 0,
                llmMs: d.llmMs || 0,
                toolMs: d.toolMs || 0,
                ttftMs: d.ttftMs || 0,
                ttftSteps: d.ttftSteps || 0,
                decodeMs: d.decodeMs || 0,
                decodeTokens: d.decodeTokens || 0,
                inputTokens: d.usage?.inputTokens || 0,
                cacheReadTokens: d.usage?.cacheReadTokens || 0,
                cacheWriteTokens: d.usage?.cacheWriteTokens || 0,
                outputTokens: d.usage?.outputTokens || 0,
            };
            return { ok: true, supported: true, stats };
        }
        catch (err) {
            return { ok: false, error: err?.message || '查询会话统计失败' };
        }
    }
    /**
     * 提交 ask_user_question 挂起问题的答复（远端宿主 waterfall 桥）。
     * 需要 dsh-web-service ≥ 0.1.6（POST /sessions/:id/answers）；旧版返回 supported=false。
     */
    async answerQuestion(target, sessionId, answers) {
        try {
            const res = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/answers`, {
                method: 'POST',
                headers: this.headers(target.apiKey),
                body: JSON.stringify({ answers }),
                signal: AbortSignal.timeout(12_000),
            });
            const json = await res.json().catch(() => ({}));
            if (res.status === 404 || res.status === 501)
                return { ok: false, supported: false, error: '远端 dsh-web-service 版本过低，无问题答复接口' };
            if (!res.ok || !json?.ok)
                return { ok: false, error: json?.error || `HTTP ${res.status}` };
            return { ok: true, supported: true };
        }
        catch (err) {
            return { ok: false, error: err?.message || '提交问题答复失败' };
        }
    }
    /**
     * SSE 流式派发 prompt。解析 `event: X\ndata: Y` 帧。
     * 远端返回 404/501（旧版无此路由）时返回 sseUnsupported=true 供调用方降级。
     */
    async streamPrompt(target, sessionId, prompt, handlers, options) {
        let content = '';
        let reasoning = '';
        try {
            const dispatcher = await getLongIdleDispatcher();
            const res = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/prompt-stream`, {
                method: 'POST',
                headers: this.headers(target.apiKey),
                body: JSON.stringify({ prompt, timeoutMs: options?.remoteTimeoutMs ?? 1_800_000 }),
                signal: options?.signal,
                // bodyTimeout=0：长工具执行/压缩期间无帧的静默段不断流（undici 缺失时无此键，退回默认）
                ...(dispatcher ? { dispatcher } : {}),
            });
            if (res.status === 404 || res.status === 501) {
                return { ok: false, error: `远端不支持 prompt-stream (HTTP ${res.status})`, sseUnsupported: true };
            }
            if (!res.ok || !res.body) {
                const text = await res.text().catch(() => '');
                return { ok: false, error: `prompt-stream HTTP ${res.status}: ${text.slice(0, 200)}` };
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let done = false;
            let sawTurnEnd = false;
            let loggedFirstReasoning = false;
            let usage;
            handlers.onLog?.('远端 SSE 流已连接，指令已提交', 'info');
            while (!done) {
                const chunk = await reader.read();
                if (chunk.done)
                    break;
                buffer += decoder.decode(chunk.value, { stream: true });
                let idx;
                while ((idx = buffer.indexOf('\n\n')) >= 0) {
                    const frame = buffer.slice(0, idx);
                    buffer = buffer.slice(idx + 2);
                    const evName = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim();
                    const dataRaw = /^data:\s*([\s\S]*)$/m.exec(frame)?.[1] ?? '';
                    let data = dataRaw;
                    try {
                        data = JSON.parse(dataRaw);
                    }
                    catch {
                        /* 保留原始字符串（如 [DONE]） */
                    }
                    switch (evName) {
                        case 'delta':
                            if (typeof data?.delta === 'string' && data.delta) {
                                content += data.delta;
                                handlers.onDelta?.(data.delta);
                            }
                            break;
                        case 'reasoning':
                            if (typeof data?.delta === 'string' && data.delta) {
                                reasoning += data.delta;
                                if (!loggedFirstReasoning) {
                                    loggedFirstReasoning = true;
                                    handlers.onLog?.('远端开始推理…', 'info');
                                }
                                handlers.onReasoning?.(data.delta);
                            }
                            break;
                        case 'tool_call':
                            handlers.onToolCall?.(data || {});
                            handlers.onLog?.(`工具调用: ${data?.name || 'unknown'}`, 'tool');
                            break;
                        case 'tool_result':
                            handlers.onToolResult?.(data || {});
                            break;
                        case 'usage':
                            // 远端透传的真实 token 账本（含缓存命中）
                            if (data?.usage && typeof data.usage === 'object') {
                                const u = { ...data.usage };
                                usage = u;
                                handlers.onUsage?.(u);
                            }
                            break;
                        case 'error':
                            return { ok: false, content, reasoning, complete: false, error: data?.message || '远端执行错误' };
                        case 'turn_end': {
                            const r = data?.reason;
                            const reason = typeof r === 'string' ? r : r && typeof r === 'object' && typeof r.kind === 'string' ? r.kind : r != null ? JSON.stringify(r) : 'completed';
                            sawTurnEnd = true;
                            handlers.onLog?.(`远端轮次结束 (${reason})`, 'info');
                            break;
                        }
                        case 'done':
                            done = true;
                            break;
                    }
                    if (sawTurnEnd && evName === 'done')
                        break;
                }
            }
            if (!sawTurnEnd && !content) {
                return { ok: false, error: 'SSE 流在产出任何内容前结束', sseUnsupported: false };
            }
            // complete=false：流被远端/网络提前收掉且未收到 turn_end，内容可能缺尾，交由调用方对账
            return { ok: true, content, reasoning: reasoning || undefined, via: 'sse', usage, complete: sawTurnEnd };
        }
        catch (err) {
            if (err?.name === 'AbortError')
                return { ok: false, content, reasoning, complete: false, error: '已中止', timedOut: true };
            return { ok: false, content, reasoning, complete: false, error: err?.message || 'SSE 流失败' };
        }
    }
    /** 同步派发（降级路径，沿用 orchestrator 的双窗口超时策略） */
    async prompt(target, sessionId, prompt, options) {
        const localTimeoutMs = options?.timeoutMs ?? 300_000;
        try {
            const res = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/prompt`, {
                method: 'POST',
                headers: this.headers(target.apiKey),
                body: JSON.stringify({ prompt, timeoutMs: options?.remoteTimeoutMs ?? 1_800_000 }),
                signal: options?.signal ?? AbortSignal.timeout(localTimeoutMs),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json?.ok)
                return { ok: false, error: json?.error || `HTTP ${res.status}` };
            const usage = json.data?.usage && typeof json.data.usage === 'object' ? { ...json.data.usage } : undefined;
            return { ok: true, content: json.data?.content || '', reasoning: json.data?.reasoning, via: 'sync', usage };
        }
        catch (err) {
            const msg = err?.message || 'prompt 失败';
            const isTimeout = err?.name === 'AbortError' || /abort|timeout/i.test(msg);
            return { ok: false, error: msg, timedOut: isTimeout };
        }
    }
    async getHistory(target, sessionId, maxMessages = 100) {
        try {
            const res = await fetch(`${clean(target.baseUrl)}/sessions/${encodeURIComponent(sessionId)}/history?maxMessages=${maxMessages}`, { headers: this.headers(target.apiKey), signal: AbortSignal.timeout(15_000) });
            const json = await res.json().catch(() => ({}));
            if (!res.ok || !json?.ok)
                return { ok: false, error: json?.error || `HTTP ${res.status}` };
            const data = json.data;
            const messages = Array.isArray(data) ? data : Array.isArray(data?.messages) ? data.messages : [];
            return { ok: true, messages };
        }
        catch (err) {
            return { ok: false, error: err?.message || '获取历史失败' };
        }
    }
    /** 轮询远端会话直到结束并提取最后一条助手回复（同步超时兜底） */
    async waitForSessionResult(target, sessionId, options) {
        const maxMs = options?.maxMs ?? 1_800_000;
        const intervalMs = options?.intervalMs ?? 15_000;
        const deadline = Date.now() + maxMs;
        let lastStatus = '';
        options?.onLog?.(`转入轮询模式（最长 ${Math.round(maxMs / 60_000)} 分钟）...`, 'info');
        while (Date.now() < deadline) {
            if (options?.signal?.aborted)
                return { ok: false, error: '已中止' };
            await new Promise((r) => setTimeout(r, intervalMs));
            const st = await this.getSession(target, sessionId);
            if (!st.ok)
                return { ok: false, error: st.error };
            if (st.status !== lastStatus) {
                options?.onLog?.(`远端会话状态: ${st.status || 'unknown'}`, 'info');
                lastStatus = st.status || '';
            }
            if (st.status && st.status !== 'running') {
                const hist = await this.getHistory(target, sessionId, 200);
                if (!hist.ok)
                    return { ok: false, error: hist.error };
                const messages = hist.messages || [];
                // 优先按回合起点重建整轮文本：回合内往往有多条 assistant 消息（逐步叙述），
                // 只取最后一条会把整轮压缩成结尾总结，造成与远端会话展示不一致
                const rec = reconstructTurnFromHistory(messages, options?.promptFragment);
                if (rec.text.trim())
                    return { ok: true, content: rec.text, via: 'poll' };
                // 退化：取最后一条非空 assistant 消息（旧行为）
                for (let i = messages.length - 1; i >= 0; i--) {
                    const m = messages[i];
                    if (m?.role !== 'assistant')
                        continue;
                    const text = messageText(m.content);
                    if (text && text.trim())
                        return { ok: true, content: text, reasoning: m.reasoning, via: 'poll' };
                }
                return { ok: false, error: '会话已结束但未提取到助手回复' };
            }
        }
        return { ok: false, error: `等待远程会话完成超时 (>${Math.round(maxMs / 60_000)} 分钟)` };
    }
    /** OpenAI 兼容 /chat/completions（Planner 用，非流式） */
    async chat(target, messages, options) {
        try {
            const res = await fetch(`${clean(target.baseUrl)}/chat/completions`, {
                method: 'POST',
                headers: this.headers(target.apiKey),
                body: JSON.stringify({
                    messages,
                    stream: false,
                    ...(options?.model && options.model.includes('/') ? { model: options.model } : {}),
                }),
                signal: options?.signal ?? AbortSignal.timeout(options?.timeoutMs ?? 300_000),
            });
            const json = await res.json().catch(() => ({}));
            if (!res.ok)
                return { ok: false, error: json?.error || `HTTP ${res.status}` };
            const choice = json?.choices?.[0];
            const content = choice?.message?.content ?? '';
            if (!content.trim())
                return { ok: false, error: 'chat/completions 返回空内容' };
            return { ok: true, content, reasoning: choice?.message?.reasoning_content, sessionId: json?.sessionId };
        }
        catch (err) {
            return { ok: false, error: err?.message || 'chat/completions 失败' };
        }
    }
}
//# sourceMappingURL=remote-client.js.map