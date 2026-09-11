/**
 * @dsh-external/dsh-remote-orchestrator - SSH 连接资源存储
 *
 * 独立于任务/节点存储，落盘 ~/.dsh/dsh-orchestrator-ssh.json。
 * 记录可连接的 SSH 账号与凭据（密码 / 私钥），按连接方式 + 主机 IP 组织，
 * 供模型工具（dsh_ssh_resource_manage）与编排控制台 UI 增删改查。
 */
import type { SshResource } from './types.js';
export declare class SshResourceStore {
    private filePath;
    private resources;
    constructor(customPath?: string);
    private load;
    private save;
    list(): SshResource[];
    get(id: string): SshResource | undefined;
    /** 按名称精确匹配（供 AI 不记 id 时按名称取凭据） */
    getByName(name: string): SshResource | undefined;
    upsert(resource: SshResource): SshResource;
    update(id: string, patch: Partial<SshResource>): SshResource | undefined;
    delete(id: string): boolean;
}
