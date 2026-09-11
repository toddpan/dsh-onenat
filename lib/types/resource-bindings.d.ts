/**
 * @dsh-external/onenat-workbuddy-mention - @ 资源提及 → 资源绑定
 *
 * 两类被 @ 的资源：
 *   - ONENAT 映射 / 应用（稳定 ID = mappingId / appId）→ 交给 PromptComposer 实时解析入口，
 *     凭证策略默认 self-fetch（提示词只给"取凭证接口"，不落明文）；
 *   - 本地 SSH 资源池（mention id = `ssh:<id>`）→ 不经 ONENAT，直接渲染连接信息与凭证
 *     （本地资源池属于本机信任域，与 0.1.x 的 SSH 资源池语义一致）。
 *
 * prestep（给主智能体注入）与 AgentRunner（给远端子智能体注入）共用本模块，
 * 保证两边看到的资源清单完全一致。
 */
import type { SshResourceStore } from './ssh-store.js';
import type { AgentResourceBinding } from './types.js';
export interface ResolvedMentionResources {
    /** 交给 PromptComposer 渲染的资源绑定（ONENAT 侧） */
    bindings: AgentResourceBinding[];
    /** 已直接渲染好的资源段落（本地 SSH 池） */
    preRendered: Array<{
        alias: string;
        markdown: string;
    }>;
    /** 本体已不存在的提及（用于向用户据实说明） */
    missing: string[];
}
export declare class MentionResourceResolver {
    private sshStore;
    constructor(sshStore: SshResourceStore);
    /**
     * @param ids - 提及解析出的资源 ID（mappingId / appId / `ssh:<id>`）
     * @param note - 写进 bindings 的用途说明（用户当轮 @ 指定使用）
     */
    resolve(ids: readonly string[], note?: string): ResolvedMentionResources;
}
/** 本地 SSH 资源 → 提示词段落（含连接命令与凭证；调用方保证只在可信提示词范围内使用） */
export declare function renderSshResource(ssh: {
    name: string;
    host: string;
    port?: number;
    username: string;
    authType: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
    description?: string;
}): string;
