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
import type { OnenatDirectory } from './onenat.js';
import type { SshResourceStore } from './ssh-store.js';
import type { WorkStore } from './store.js';
import type { ExtractedMentions, MentionCandidate } from './types.js';
/** 从 UUID / 本地 id 生成稳定 URI */
export declare function agentUri(agentId: string): string;
export declare function mappingUri(mappingId: string): string;
export declare function sshUri(sshResourceId: string): string;
/** URI → kind/id；非法 URI 返回 undefined */
export declare function decodeMentionUri(uri: string): {
    kind: 'agent' | 'resource';
    id: string;
} | undefined;
/** 模型可见 / 剪贴板文本：`@[名称](uri)` */
export declare function mentionText(label: string, uri: string): string;
/** 用户消息里出现提及的判定（pre-step 快速短路用，零解析开销） */
export declare function containsMention(text: string): boolean;
/**
 * 提及解析器：把消息文本解析成「已知实体」的结构化身份。
 * 未知身份（本体已删除 / 名称打错）一律丢弃，由调用方按需给出提示。
 */
export declare class MentionParser {
    private store;
    private directory;
    private sshStore;
    constructor(store: WorkStore, directory: OnenatDirectory, sshStore: SshResourceStore);
    /** @ 菜单候选（Client 经包私有 RPC 拉取） */
    candidates(query?: string): MentionCandidate[];
    /** 解析一段用户文本里的全部提及（去重，保持出现顺序） */
    parse(text: string): ExtractedMentions;
    /** 按类型 + 稳定 ID 解析实体（不存在返回 undefined） */
    resolveOne(kind: 'agent' | 'resource', id: string): {
        kind: 'agent' | 'resource';
        id: string;
        name: string;
        uri: string;
    } | undefined;
    /** 名称 / ID → 实体的精确索引（纯文本回退用） */
    private exactIndex;
}
