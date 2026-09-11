/**
 * @dsh-external/onenat-workbuddy - 子智能体运行时解析器（D1 端口漂移免疫）
 *
 * SubAgent.dshRef（稳定 ID）→ ResolvedDshTarget（当下 baseUrl + apiKey）
 * 每次派发前调用，绝不缓存公网 URL。
 */
import type { WorkStore } from './store.js';
import { OnenatDirectory } from './onenat.js';
import type { ResolvedDshTarget, SubAgent } from './types.js';
export declare class AgentResolver {
    private store;
    private directory;
    constructor(store: WorkStore, directory: OnenatDirectory);
    /** 解析单个子智能体；失败时返回 online=false + error（不抛错，调用方决定跳过或报错） */
    resolve(agent: SubAgent): Promise<ResolvedDshTarget>;
    /** 解析 + 探活（/system/status），返回带健康信息的目标 */
    resolveWithPing(agent: SubAgent): Promise<{
        target?: ResolvedDshTarget;
        ping?: {
            ok: boolean;
            name?: string;
            version?: string;
            providers?: string[];
            error?: string;
        };
    }>;
    /** 任务成员批量解析；返回成功目标 + 问题清单（离线成员跳过不阻断） */
    resolveMembers(agentIds: string[]): Promise<{
        targets: Map<string, ResolvedDshTarget>;
        issues: Array<{
            agentId: string;
            name: string;
            error: string;
        }>;
    }>;
}
