/**
 * @dsh-external/onenat-workbuddy-mention - @ 提及编解码与解析
 *
 * 一个提及（mention）在两处出现：
 *   1. 输入框胶囊 → 提交时由客户端 codec 序列化为 `@[展示名](onenat-agent:<id>)`；
 *   2. 进入模型步之前 → agent/pre-step 用本模块把该文本解析回结构化身份。
 *
 * Scheme（稳定身份，不依赖展示名）:
 *   onenat-agent:<subAgentId>                  子智能体
 *   onenat-resource:<mappingId|appId>          ONENAT 映射 / 应用资源
 *   onenat-resource:ssh:<sshResourceId>        本地 SSH 直连资源
 *
 * 同时兼容纯文本 `@名字`（无 URI）：按名称/ID 精确匹配（大小写不敏感），
 * 匹配不到则忽略（不注入、不报错）——只有从 @ 菜单里选中的提及才是强身份。
 */
import { MENTION_SCHEME_AGENT, MENTION_SCHEME_RESOURCE, SSH_RESOURCE_PREFIX, } from './types.js';
/** 从 UUID / 本地 id 生成稳定 URI */
export function agentUri(agentId) {
    return MENTION_SCHEME_AGENT + agentId;
}
export function mappingUri(mappingId) {
    return MENTION_SCHEME_RESOURCE + mappingId;
}
export function sshUri(sshResourceId) {
    return MENTION_SCHEME_RESOURCE + SSH_RESOURCE_PREFIX + sshResourceId;
}
/** URI → kind/id；非法 URI 返回 undefined */
export function decodeMentionUri(uri) {
    const raw = String(uri || '').trim();
    if (raw.startsWith(MENTION_SCHEME_AGENT)) {
        const id = raw.slice(MENTION_SCHEME_AGENT.length).trim();
        return id ? { kind: 'agent', id } : undefined;
    }
    if (raw.startsWith(MENTION_SCHEME_RESOURCE)) {
        const id = raw.slice(MENTION_SCHEME_RESOURCE.length).trim();
        return id ? { kind: 'resource', id } : undefined;
    }
    return undefined;
}
/** 模型可见 / 剪贴板文本：`@[名称](uri)` */
export function mentionText(label, uri) {
    return `@[${escapeLabel(label)}](${uri})`;
}
function escapeLabel(label) {
    return String(label || '').replace(/[[\]]/g, '').trim();
}
/**
 * 结构化提及的文本形式（Markdown 链接）与裸 URI 都接受。
 * 单独成组：label 可含任意非 ']' 字符；裸 URI 用词边界截断。
 */
const MD_MENTION = /@\[([^\]]*)\]\((onenat-(?:agent|resource):[^\s)]+)\)/g;
const BARE_URI = /(onenat-(?:agent|resource):[^\s)\]]+)/g;
/** 纯文本回退：@后跟一个不含空白的词 */
const PLAIN_MENTION = /@([^\s@,，。!！?？:：;；、()（）\[\]【】"'`]+)/g;
/** 用户消息里出现提及的判定（pre-step 快速短路用，零解析开销） */
export function containsMention(text) {
    return text.includes('@[') || text.includes(MENTION_SCHEME_AGENT) || text.includes(MENTION_SCHEME_RESOURCE);
}
/**
 * 提及解析器：把消息文本解析成「已知实体」的结构化身份。
 * 未知身份（本体已删除 / 名称打错）一律丢弃，由调用方按需给出提示。
 */
export class MentionParser {
    store;
    directory;
    sshStore;
    constructor(store, directory, sshStore) {
        this.store = store;
        this.directory = directory;
        this.sshStore = sshStore;
    }
    /** @ 菜单候选（Client 经包私有 RPC 拉取） */
    candidates(query = '') {
        const q = String(query || '').trim().toLowerCase();
        const agents = [];
        const resources = [];
        for (const agent of this.store.getAgents()) {
            if (agent.enabled === false)
                continue;
            const model = agent.model ? String(agent.model).split('/').pop() : '默认模型';
            agents.push({
                kind: 'agent',
                key: agent.id,
                name: agent.name,
                section: 'ONENAT 子智能体',
                description: `${describeDshRef(agent)} · ${model}`,
                uri: agentUri(agent.id),
            });
        }
        for (const ep of this.directory.listEndpoints()) {
            const name = ep.appName || ep.note || ep.mappingId;
            resources.push({
                kind: 'resource',
                key: ep.mappingId || ep.appId || name,
                name,
                section: 'ONENAT 资源',
                description: `${ep.kind.toUpperCase()} · ${ep.tunnelName || '未命名隧道'} · ${ep.online ? '在线' : '离线'}`,
                uri: mappingUri(ep.mappingId || ep.appId || name),
                resourceKind: ep.kind,
                online: ep.online,
            });
        }
        for (const ssh of this.sshStore.list()) {
            resources.push({
                kind: 'resource',
                key: `ssh:${ssh.id}`,
                name: ssh.name,
                section: '本地 SSH 资源',
                description: `SSH · ${ssh.username}@${ssh.host}:${ssh.port || 22}${ssh.description ? ' · ' + ssh.description : ''}`,
                uri: sshUri(ssh.id),
                resourceKind: 'local-ssh',
                online: true,
            });
        }
        const all = [...agents, ...resources];
        if (!q)
            return all;
        return all
            .map((row) => ({ row, score: score(row, q) }))
            .filter((x) => x.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((x) => x.row);
    }
    /** 解析一段用户文本里的全部提及（去重，保持出现顺序） */
    parse(text) {
        const agents = [];
        const resources = [];
        const seen = new Set();
        const scan = stripCode(text);
        const pushResolved = (kind, id, label, raw, uri) => {
            const dedupeKey = kind + ':' + id;
            if (seen.has(dedupeKey))
                return;
            seen.add(dedupeKey);
            const mention = { kind, uri, label: label || id, raw, id };
            if (kind === 'agent')
                agents.push(mention);
            else
                resources.push(mention);
        };
        const handledRanges = [];
        // 1. Markdown 链接形式（客户端 codec 产出的规范形式）
        for (const m of scan.matchAll(MD_MENTION)) {
            const label = m[1] ?? '';
            const uri = m[2];
            const decoded = decodeMentionUri(uri);
            if (!decoded)
                continue;
            const resolved = this.resolveOne(decoded.kind, decoded.id);
            handledRanges.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
            if (!resolved)
                continue;
            pushResolved(resolved.kind, resolved.id, label || resolved.name, m[0], uri);
        }
        // 2. 裸 URI（用户手输 / 其他系统粘贴）
        for (const m of scan.matchAll(BARE_URI)) {
            const start = m.index ?? 0;
            if (handledRanges.some(([s, e]) => start >= s && start < e))
                continue;
            const uri = m[1];
            const decoded = decodeMentionUri(uri);
            if (!decoded)
                continue;
            const resolved = this.resolveOne(decoded.kind, decoded.id);
            handledRanges.push([start, start + uri.length]);
            if (!resolved)
                continue;
            pushResolved(resolved.kind, resolved.id, resolved.name, uri, uri);
        }
        // 3. 纯文本回退（@名字 / @id 精确匹配；仅补足前两步未认出的实体）
        const exact = this.exactIndex();
        for (const m of scan.matchAll(PLAIN_MENTION)) {
            const start = m.index ?? 0;
            if (handledRanges.some(([s, e]) => start >= s && start < e))
                continue;
            const token = (m[1] ?? '').trim();
            if (!token)
                continue;
            const hit = exact.get(token.toLowerCase());
            if (!hit)
                continue;
            handledRanges.push([start, start + m[0].length]);
            pushResolved(hit.kind, hit.id, hit.name, m[0], hit.uri);
        }
        return { agents, resources };
    }
    /** 按类型 + 稳定 ID 解析实体（不存在返回 undefined） */
    resolveOne(kind, id) {
        if (kind === 'agent') {
            const agent = this.store.getAgent(id);
            if (!agent || agent.enabled === false)
                return undefined;
            return { kind, id, name: agent.name, uri: agentUri(id) };
        }
        if (id.startsWith(SSH_RESOURCE_PREFIX)) {
            const sshId = id.slice(SSH_RESOURCE_PREFIX.length);
            const ssh = this.sshStore.get(sshId);
            if (!ssh)
                return undefined;
            return { kind, id, name: ssh.name, uri: sshUri(sshId) };
        }
        const ep = this.directory.resolveMapping(id) || this.directory.resolveApp(id);
        if (!ep)
            return undefined;
        return { kind, id: ep.mappingId || ep.appId || id, name: ep.appName || ep.note || id, uri: mappingUri(ep.mappingId || ep.appId || id) };
    }
    /** 名称 / ID → 实体的精确索引（纯文本回退用） */
    exactIndex() {
        const map = new Map();
        const put = (key, value) => {
            const k = key.toLowerCase();
            if (k && !map.has(k))
                map.set(k, value);
        };
        for (const agent of this.store.getAgents()) {
            if (agent.enabled === false)
                continue;
            const value = { kind: 'agent', id: agent.id, name: agent.name, uri: agentUri(agent.id) };
            put(agent.name, value);
            put(agent.id, value);
        }
        for (const ep of this.directory.listEndpoints()) {
            const id = ep.mappingId || ep.appId;
            if (!id)
                continue;
            const value = { kind: 'resource', id, name: ep.appName || ep.note || id, uri: mappingUri(id) };
            if (ep.appName)
                put(ep.appName, value);
            if (ep.note)
                put(ep.note, value);
            put(ep.mappingId, value);
            if (ep.appId)
                put(ep.appId, value);
            if (ep.appName && ep.tunnelName)
                put(`${ep.appName} (${ep.tunnelName})`, value);
        }
        for (const ssh of this.sshStore.list()) {
            const value = { kind: 'resource', id: `ssh:${ssh.id}`, name: ssh.name, uri: sshUri(ssh.id) };
            put(ssh.name, value);
            put(ssh.id, value);
        }
        return map;
    }
}
function describeDshRef(agent) {
    if (agent.dshRef.kind === 'mapping')
        return 'DSH 实体（映射绑定）';
    if (agent.dshRef.kind === 'app')
        return 'DSH 实体（应用绑定）';
    return `直连 ${agent.dshRef.apiBaseUrl || '未配置'}`;
}
/** 模糊打分：命中越靠前、越短、越连续，分越高 */
function score(row, q) {
    const name = row.name.toLowerCase();
    const desc = row.description.toLowerCase();
    if (name === q)
        return 1000;
    if (name.startsWith(q))
        return 800 - name.length;
    const idx = name.indexOf(q);
    if (idx >= 0)
        return 600 - idx - name.length;
    let s = 0;
    let cursor = 0;
    for (const ch of q) {
        const at = name.indexOf(ch, cursor);
        if (at < 0) {
            s = 0;
            break;
        }
        s += at === cursor ? 2 : 1;
        cursor = at + 1;
    }
    if (s > 0)
        return 200 + s;
    return desc.includes(q) ? 50 : 0;
}
/** 去掉围栏代码块与行内代码，避免示例文本里的提及被误注入 */
function stripCode(text) {
    return text
        .replace(/```[\s\S]*?```/g, (m) => ' '.repeat(m.length))
        .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}
//# sourceMappingURL=mentions.js.map