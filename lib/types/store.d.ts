/**
 * dsh-onenat - WorkStore
 *
 * 持久化：子智能体池 + (DSH 会话, 子智能体) → 远端会话长持映射 + 设置。
 * 落盘 ~/.dsh/dsh-onenat/store.json。
 *
 * 从 0.1.x（dsh-onenat）升级时：首次启动自动从旧路径
 * ~/.dsh/dsh-onenat/store.json 迁移 agents / settings（tasks 段忽略并保留旧文件）。
 */
import type { DshRef, RemoteSessionBinding, SubAgent, oneNatSettings } from './types.js';
/**
 * 把用户传入的 dshRef 归一化为稳定的 DshRef 对象。
 * 接受三种正规形态（mapping/app/direct 对象），并把裸字符串当作 mappingId
 * —— 因为 onenat_resource list 返回的 mappingId 字段就是字符串，
 * 模型/UI 直接从菜单拷过来时最自然；与 router.normalizeDshRef 行为一致。
 */
export declare function normalizeDshRefInput(raw: unknown): DshRef | undefined;
/** 工作目录规范化：去空白与尾斜杠；空值 → undefined */
export declare function normalizeWorkDir(v: unknown): string | undefined;
export declare class WorkStore {
    private filePath;
    private legacyPath;
    private data;
    constructor(customPath?: string);
    private load;
    get path(): string;
    save(): void;
    getSettings(): oneNatSettings;
    updateSettings(patch: Partial<oneNatSettings>): oneNatSettings;
    getAgents(): SubAgent[];
    getAgent(id: string): SubAgent | undefined;
    /** 按名称或 ID 查找（@ 提及解析用；名称大小写不敏感） */
    findAgent(key: string): SubAgent | undefined;
    upsertAgent(input: Partial<SubAgent>): SubAgent;
    deleteAgent(id: string): boolean;
    private sessionKey;
    getSession(scope: string | undefined, agentId: string): RemoteSessionBinding | undefined;
    setSession(scope: string | undefined, agentId: string, binding: RemoteSessionBinding): void;
    clearSession(scope: string | undefined, agentId: string): boolean;
    /** 清掉某个子智能体的全部远端会话绑定（所有作用域）；返回清掉的条数 */
    clearSessionsForAgent(agentId: string): number;
    listSessions(): Array<RemoteSessionBinding & {
        key: string;
    }>;
}
