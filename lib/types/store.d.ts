/**
 * @dsh-external/onenat-workbuddy-mention - WorkStore
 *
 * 持久化：子智能体池 + (DSH 会话, 子智能体) → 远端会话长持映射 + 设置。
 * 落盘 ~/.dsh/onenat-workbuddy-mention/store.json。
 *
 * 从 0.1.x（onenat-workbuddy）升级时：首次启动自动从旧路径
 * ~/.dsh/onenat-workbuddy/store.json 迁移 agents / settings（tasks 段忽略并保留旧文件）。
 */
import type { RemoteSessionBinding, SubAgent, WorkBuddySettings } from './types.js';
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
    getSettings(): WorkBuddySettings;
    updateSettings(patch: Partial<WorkBuddySettings>): WorkBuddySettings;
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
