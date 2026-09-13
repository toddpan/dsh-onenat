/**
 * @dsh-external/onenat-workbuddy-mention - 管理 API（设置页 UI 专用）
 *
 * 只在 DSH 本地 GUI 后面服务：设置页与模型工具共用同一份存储与服务。
 * 前缀：<pathPrefix>/api/*
 */
import { DshClient } from './remote-client.js';
import { SshInputError, execOnSshResource, maskSshResource, newSshResourceId, normalizeSshResource, testSshResource, } from './ssh-resources.js';
/** 探测用合成子智能体 ID（resolve 只读 dshRef/apiKey，不落库、不参与 @ 候选） */
const PROBE_AGENT_ID = '__probe__';
/** 表单输入错误：携带 HTTP 状态码，由 dispatch 的统一 catch 转为 { ok:false, error } */
class InputError extends Error {
    statusCode;
    constructor(message, statusCode = 400) {
        super(message);
        this.statusCode = statusCode;
    }
}
export class ManageRouter {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    sendJson(res, statusCode, data) {
        res.statusCode = statusCode;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(data));
    }
    async parseBody(req) {
        return new Promise((resolve) => {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk;
                if (body.length > 4 * 1024 * 1024)
                    req.destroy();
            });
            req.on('end', () => {
                try {
                    resolve(body ? JSON.parse(body) : {});
                }
                catch {
                    resolve({});
                }
            });
            req.on('error', () => resolve({}));
        });
    }
    /**
     * 表单校验：把 UI 传来的 dshRef 归一化成稳定引用（防注入 / 防脏值）。
     * 只接受三种合法形态，其余一律 undefined（由调用方报 400）。
     */
    normalizeDshRef(raw) {
        if (!raw || typeof raw !== 'object')
            return undefined;
        if (raw.kind === 'mapping' && String(raw.mappingId || '').trim()) {
            return { kind: 'mapping', mappingId: String(raw.mappingId).trim() };
        }
        if (raw.kind === 'app' && String(raw.appId || '').trim()) {
            return { kind: 'app', appId: String(raw.appId).trim() };
        }
        if (raw.kind === 'direct' && String(raw.apiBaseUrl || '').trim()) {
            return { kind: 'direct', apiBaseUrl: String(raw.apiBaseUrl).trim() };
        }
        return undefined;
    }
    /**
     * 用「表单当前值」直接解析远端目标 —— 设置页在**保存之前**就要能拉
     * 远端模型 / 模式预设 / 目录，因此不能依赖已落库的子智能体。
     * 走同一条 AgentResolver（ONENAT 稳定 ID → 当下 baseUrl + 凭证），
     * 只是挂一个不落库的合成 agent。
     */
    async resolveProbeTarget(dshRefRaw, apiKey) {
        const dshRef = this.normalizeDshRef(dshRefRaw);
        if (!dshRef)
            throw new InputError('请先选择 DSH 实体绑定（dshRef 无效）');
        const probe = {
            id: PROBE_AGENT_ID,
            name: PROBE_AGENT_ID,
            dshRef,
            apiKey: apiKey && String(apiKey).trim() ? String(apiKey).trim() : undefined,
            resources: [],
            enabled: true,
            createdAt: 0,
            updatedAt: 0,
        };
        const target = await this.deps.resolver.resolve(probe);
        if (!target.online || !target.baseUrl)
            throw new InputError(target.error || '远端 DSH 节点不可达', 502);
        return target;
    }
    /** @returns 是否已处理 */
    async dispatch(req, res, prefix) {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const method = (req.method || 'GET').toUpperCase();
        const path = url.pathname.slice(prefix.length) || '/';
        const { store, directory, resolver, runner, parser, sshStore } = this.deps;
        try {
            if (path === '/api/settings' && method === 'GET') {
                this.sendJson(res, 200, { ok: true, data: { settings: store.getSettings(), storePath: store.path } });
                return true;
            }
            if (path === '/api/settings' && (method === 'POST' || method === 'PATCH')) {
                const body = await this.parseBody(req);
                const settings = store.updateSettings(body || {});
                if (settings.onenat) {
                    directory.configure(settings.onenat.baseUrl, settings.onenat.apiKey);
                    directory.startAutoRefresh(settings.onenat.autoRefreshMs);
                }
                this.sendJson(res, 200, { ok: true, data: settings });
                return true;
            }
            // ---- 远端探测（设置页在保存之前就能拉远端选项 / 浏览远端目录） ----
            if (path === '/api/probe/options' && method === 'POST') {
                const body = await this.parseBody(req);
                const target = await this.resolveProbeTarget(body?.dshRef, body?.apiKey);
                const client = new DshClient();
                const [modelResult, presetResult] = await Promise.all([client.getModels(target), client.getPresets(target)]);
                const models = modelResult.models || [];
                const providers = [];
                for (const m of models) {
                    if (m.provider && !providers.includes(m.provider))
                        providers.push(m.provider);
                }
                this.sendJson(res, 200, {
                    ok: true,
                    data: {
                        baseUrl: target.baseUrl,
                        models,
                        providers,
                        presets: presetResult.presets || [],
                        defaultModel: modelResult.defaultModel,
                        modelsError: modelResult.ok ? undefined : modelResult.error,
                        presetsError: presetResult.ok ? undefined : presetResult.error,
                    },
                });
                return true;
            }
            if (path === '/api/probe/skills' && method === 'POST') {
                const body = await this.parseBody(req);
                const target = await this.resolveProbeTarget(body?.dshRef, body?.apiKey);
                const result = await new DshClient().listSkills(target, {
                    cwd: typeof body?.cwd === 'string' && body.cwd ? body.cwd : undefined,
                });
                this.sendJson(res, result.ok ? 200 : 502, result.ok
                    ? { ok: true, data: { skills: result.skills.map((s) => ({ name: s.name, description: s.description })) } }
                    : { ok: false, error: result.unsupported ? '远端 dsh-web-service 未安装 /skills 端点（请升级远端服务）' : result.error });
                return true;
            }
            if (path === '/api/probe/fs' && method === 'POST') {
                const body = await this.parseBody(req);
                const target = await this.resolveProbeTarget(body?.dshRef, body?.apiKey);
                const dirPath = typeof body?.path === 'string' && body.path.trim() ? body.path.trim() : undefined;
                const result = await new DshClient().fsList(target, dirPath);
                this.sendJson(res, result.ok ? 200 : 400, result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error });
                return true;
            }
            if (path === '/api/probe/mkdir' && method === 'POST') {
                const body = await this.parseBody(req);
                const target = await this.resolveProbeTarget(body?.dshRef, body?.apiKey);
                const parent = String(body?.path || '').trim();
                const name = String(body?.name || '').trim();
                if (!parent || !name)
                    throw new InputError('缺少目录路径或名称');
                const result = await new DshClient().fsMkdir(target, parent, name);
                this.sendJson(res, result.ok ? 200 : 400, result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error });
                return true;
            }
            if (path === '/api/agents' && method === 'GET') {
                this.sendJson(res, 200, { ok: true, data: store.getAgents() });
                return true;
            }
            if (path === '/api/agents' && method === 'POST') {
                const body = await this.parseBody(req);
                if (!body?.name) {
                    this.sendJson(res, 400, { ok: false, error: '缺少 name' });
                    return true;
                }
                this.sendJson(res, 200, { ok: true, data: store.upsertAgent(body) });
                return true;
            }
            const agentMatch = /^\/api\/agents\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
            if (agentMatch) {
                const id = decodeURIComponent(agentMatch[1]);
                const sub = agentMatch[2];
                const agent = store.findAgent(id);
                if (!sub && method === 'DELETE') {
                    this.sendJson(res, 200, { ok: true, data: { deleted: store.deleteAgent(agent?.id || id) } });
                    return true;
                }
                if (!agent) {
                    this.sendJson(res, 404, { ok: false, error: '子智能体不存在' });
                    return true;
                }
                if (sub === 'ping' && method === 'POST') {
                    const { target, ping } = await resolver.resolveWithPing(agent);
                    this.sendJson(res, 200, { ok: true, data: { ping, resolved: target } });
                    return true;
                }
                if (sub === 'models' && method === 'GET') {
                    const target = await resolver.resolve(agent);
                    const result = target.online ? await new DshClient().getModels(target) : { ok: false, error: target.error };
                    this.sendJson(res, 200, { ok: true, data: result });
                    return true;
                }
                if (sub === 'presets' && method === 'GET') {
                    const target = await resolver.resolve(agent);
                    const result = target.online ? await new DshClient().getPresets(target) : { ok: false, error: target.error };
                    this.sendJson(res, 200, { ok: true, data: result });
                    return true;
                }
                if (sub === 'preview' && method === 'GET') {
                    await directory.refresh(true).catch(() => { });
                    const composed = await runner.composePrompt(agent, '<任务正文将放在这里>', [], { permission: agent.permission });
                    this.sendJson(res, 200, { ok: true, data: composed });
                    return true;
                }
                if (sub === 'session' && method === 'DELETE') {
                    this.sendJson(res, 200, { ok: true, data: { cleared: store.clearSessionsForAgent(agent.id) } });
                    return true;
                }
            }
            if (path === '/api/resources' && method === 'GET') {
                await directory.refresh(url.searchParams.get('refresh') === '1');
                this.sendJson(res, 200, {
                    ok: true,
                    data: { fetchedAt: directory.current()?.fetchedAt, endpoints: directory.listEndpoints() },
                });
                return true;
            }
            if (path === '/api/candidates' && method === 'GET') {
                this.sendJson(res, 200, { ok: true, data: parser.candidates(url.searchParams.get('q') || '') });
                return true;
            }
            if (path === '/api/debug/parse' && method === 'POST') {
                const body = await this.parseBody(req);
                this.sendJson(res, 200, { ok: true, data: parser.parse(String(body?.text || '')) });
                return true;
            }
            if (path === '/api/ssh' && method === 'GET') {
                this.sendJson(res, 200, { ok: true, data: sshStore.list().map(maskSshResource) });
                return true;
            }
            if (path === '/api/ssh' && method === 'POST') {
                const body = await this.parseBody(req);
                const existing = body?.id ? sshStore.get(String(body.id)) : undefined;
                const normalized = normalizeSshResource(body || {}, existing);
                if (!normalized.id)
                    normalized.id = newSshResourceId();
                this.sendJson(res, 200, { ok: true, data: maskSshResource(sshStore.upsert(normalized)) });
                return true;
            }
            const sshMatch = /^\/api\/ssh\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
            if (sshMatch) {
                const key = decodeURIComponent(sshMatch[1]);
                const sub = sshMatch[2];
                const resource = sshStore.get(key) || sshStore.getByName(key);
                if (!resource) {
                    this.sendJson(res, 404, { ok: false, error: 'SSH 资源不存在' });
                    return true;
                }
                if (!sub && method === 'GET') {
                    this.sendJson(res, 200, { ok: true, data: resource });
                    return true;
                }
                if (!sub && method === 'DELETE') {
                    this.sendJson(res, 200, { ok: true, data: { deleted: sshStore.delete(resource.id) } });
                    return true;
                }
                if (sub === 'test' && method === 'POST') {
                    const result = await testSshResource(resource, 8000);
                    sshStore.update(resource.id, {
                        lastTestedAt: result.testedAt,
                        lastTestOk: result.ok,
                        lastTestError: result.ok ? undefined : result.error,
                    });
                    this.sendJson(res, 200, { ok: true, data: result });
                    return true;
                }
                if (sub === 'exec' && method === 'POST') {
                    const body = await this.parseBody(req);
                    const command = String(body?.command || '');
                    if (!command.trim()) {
                        this.sendJson(res, 400, { ok: false, error: '缺少 command' });
                        return true;
                    }
                    const result = await execOnSshResource(resource, command, Number(body?.timeoutMs) || 30_000);
                    this.sendJson(res, 200, { ok: true, data: result });
                    return true;
                }
            }
        }
        catch (err) {
            if (err instanceof InputError) {
                this.sendJson(res, err.statusCode, { ok: false, error: err.message });
                return true;
            }
            if (err instanceof SshInputError) {
                this.sendJson(res, 400, { ok: false, error: err.message });
                return true;
            }
            this.sendJson(res, 500, { ok: false, error: String(err?.message || err) });
            return true;
        }
        return false;
    }
}
//# sourceMappingURL=router.js.map