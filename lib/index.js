/**
 * @dsh-external/onenat-workbuddy-mention
 *
 * OneNat WorkBuddy @ —— 让 DSH 原生对话直接使用 ONENAT 上的子智能体与资源：
 *   1. 子智能体管理：绑定 ONENAT 稳定 ID（mappingId/appId），端口漂移免疫，设置页可视化管理；
 *   2. 子智能调用：onenat_agent 工具把任务派发给远端 DSH 会话并长持复用；
 *   3. @ 指定：DSH 输入框敲 @ 选择子智能体 / 资源 → 原子胶囊 → 宿主在 agent/pre-step 注入上下文。
 *
 * 本插件不提供第二套聊天界面：对话、工具卡、思维链、统计全部复用 DSH 原生能力。
 */
import z from 'schemastery';
import { OnenatDirectory } from './onenat.js';
import { WorkStore } from './store.js';
import { SshResourceStore } from './ssh-store.js';
import { AgentResolver } from './resolver.js';
import { PromptComposer } from './prompt-composer.js';
import { MentionParser } from './mentions.js';
import { MentionResourceResolver } from './resource-bindings.js';
import { AgentRunner } from './agent-runner.js';
import { registerPreStep } from './prestep.js';
import { ManageRouter } from './router.js';
import { registerTools, renderAgentRoster } from './tools.js';
import { registerClientBridge } from './bridge.js';
export const name = '@dsh-external/onenat-workbuddy-mention';
export const inject = ['tools'];
export const Config = z.object({
    pathPrefix: z.string().default('/onenat-workbuddy-mention').description('管理 API 路由前缀'),
    storagePath: z.string().default('').description('本地存储文件绝对路径（留空则 ~/.dsh/onenat-workbuddy-mention/store.json）'),
    onenatBaseUrl: z.string().default('').description('ONENAT 服务地址（留空用存储中的设置）'),
    onenatApiKey: z.string().default('').description('ONENAT API Key（onk-…，留空用存储中的设置）'),
    autoRefreshMs: z.number().default(60_000).description('资源目录自动刷新间隔（毫秒）'),
});
/** Client 侧经包私有 RPC 调用的方法名（设置页 UI 与 @ 菜单共用） */
export const CLIENT_RPC = {
    candidates: 'onenat.candidates',
    parse: 'onenat.parse',
    settingsGet: 'onenat.settings.get',
    settingsSave: 'onenat.settings.save',
    agentsList: 'onenat.agents.list',
    agentsSave: 'onenat.agents.save',
    agentsDelete: 'onenat.agents.delete',
    agentsPing: 'onenat.agents.ping',
    agentsPreview: 'onenat.agents.preview',
    agentsModels: 'onenat.agents.models',
    agentsPresets: 'onenat.agents.presets',
    resources: 'onenat.resources',
    resolve: 'onenat.resolve',
    sshList: 'onenat.ssh.list',
    sshSave: 'onenat.ssh.save',
    sshDelete: 'onenat.ssh.delete',
    sshTest: 'onenat.ssh.test',
};
export function apply(ctx, config) {
    const prefix = (config.pathPrefix || '/onenat-workbuddy-mention').replace(/\/+$/, '');
    const log = (msg) => {
        console.log(`[onenat-workbuddy-mention] ${msg}`);
    };
    const store = new WorkStore(config.storagePath || undefined);
    const sshStore = new SshResourceStore();
    // 显式配置覆盖存储设置
    const settings = store.getSettings();
    if (config.onenatBaseUrl)
        settings.onenat.baseUrl = config.onenatBaseUrl;
    if (config.onenatApiKey)
        settings.onenat.apiKey = config.onenatApiKey;
    if (config.autoRefreshMs)
        settings.onenat.autoRefreshMs = config.autoRefreshMs;
    store.updateSettings(settings);
    const directory = new OnenatDirectory(settings.onenat.baseUrl, settings.onenat.apiKey, log);
    directory.startAutoRefresh(settings.onenat.autoRefreshMs);
    ctx.effect(() => () => {
        directory.stopAutoRefresh();
    }, 'onenat-workbuddy-mention: auto refresh');
    const resolver = new AgentResolver(store, directory);
    const composer = new PromptComposer(directory);
    const parser = new MentionParser(store, directory, sshStore);
    const resources = new MentionResourceResolver(sshStore);
    const runner = new AgentRunner(store, resolver, composer, resources);
    const router = new ManageRouter({ store, directory, resolver, runner, parser, sshStore, log });
    const webServer = ctx.get('webServer');
    if (webServer === undefined) {
        log('webServer 服务不可用：管理 API 与设置页未挂载（模型工具仍可用）');
    }
    else {
        ctx.effect(() => webServer.register({
            kind: 'prefix',
            path: prefix,
            handler: async (req, res) => {
                const handled = await router.dispatch(req, res, prefix);
                if (!handled && !res.headersSent) {
                    res.statusCode = 404;
                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                    res.end(JSON.stringify({ ok: false, error: `Endpoint not found: ${req.url}` }));
                }
            },
        }), 'onenat-workbuddy-mention: management api');
        // 把管理 API 前缀注入页面：浏览器半边（设置页/@ 候选）据此同源调用
        if (typeof webServer.tapIndex === 'function') {
            ctx.effect(() => webServer.tapIndex((html) => html.replace('</head>', `<script>globalThis.__DSH_ONENAT_WORKBUDDY__ = ${JSON.stringify({ pathPrefix: prefix })}</script></head>`)), 'onenat-workbuddy-mention: index injection');
        }
    }
    registerTools(ctx, { store, directory, resolver, runner, sshStore, parser, log });
    registerClientBridge(ctx, { store, directory, resolver, runner, parser, sshStore }, log);
    // 提示词花名册：让模型在**没有** @ 的情况下也知道有哪些子智能体可用
    const systemPrompt = ctx.get('systemPrompt');
    if (systemPrompt !== undefined) {
        ctx.effect(() => systemPrompt.section({
            name: 'onenat-workbuddy-mention',
            order: 2810,
            text: () => {
                const roster = renderAgentRoster(store);
                const endpoints = directory.listEndpoints();
                if (!roster && endpoints.length === 0)
                    return '';
                const lines = [];
                lines.push('# OneNat WorkBuddy（ONENAT 资源面 + 远端 DSH 子智能体）');
                lines.push('');
                lines.push('用户可以在输入框用 `@` 指定 ONENAT 上的子智能体或资源：');
                lines.push('- `@子智能体` → 用户在指认"这件事交给它做"，请用 `onenat_agent` 工具派发（task 必须自包含）。');
                lines.push('- `@资源`（SSH / HTTP / DSH 应用）→ 宿主会把该资源的实时入口与凭证策略注入本轮上下文，你可以自己使用，也可以连同任务交给子智能体。');
                lines.push('- 用户明确 @ 指定时按其指认执行，不要另起一套方案绕开。');
                if (roster) {
                    lines.push('');
                    lines.push('## 可用的 ONENAT 子智能体');
                    lines.push(roster);
                }
                if (endpoints.length > 0) {
                    const online = endpoints.filter((e) => e.online).length;
                    lines.push('');
                    lines.push(`## ONENAT 资源目录：共 ${endpoints.length} 个映射/应用（${online} 个在线）`);
                    lines.push('用 `onenat_resource`（list/resolve/skills/candidates）查询实时入口；用户在消息里 @ 之前，不要凭空猜测端口或地址。');
                }
                return lines.join('\n');
            },
        }), 'onenat-workbuddy-mention: prompt roster');
    }
    registerPreStep(ctx, { store, parser, composer, resources }, log);
    const port = webServer?.port || 3080;
    log(`Mounted. 管理 API: http://127.0.0.1:${port}${prefix}/api/settings  ONENAT: ${directory.endpoint || '(未配置)'}`);
}
//# sourceMappingURL=index.js.map