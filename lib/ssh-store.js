/**
 * @dsh-external/dsh-remote-orchestrator - SSH 连接资源存储
 *
 * 独立于任务/节点存储，落盘 ~/.dsh/dsh-orchestrator-ssh.json。
 * 记录可连接的 SSH 账号与凭据（密码 / 私钥），按连接方式 + 主机 IP 组织，
 * 供模型工具（dsh_ssh_resource_manage）与编排控制台 UI 增删改查。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
export class SshResourceStore {
    filePath;
    resources = [];
    constructor(customPath) {
        const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh');
        this.filePath = customPath || join(dshHome, 'dsh-orchestrator-ssh.json');
        this.load();
    }
    load() {
        try {
            if (existsSync(this.filePath)) {
                const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8'));
                this.resources = Array.isArray(parsed.resources) ? parsed.resources : [];
            }
        }
        catch (err) {
            console.error('[dsh-remote-orchestrator] Failed to load ssh resource store:', err);
            this.resources = [];
        }
    }
    save() {
        try {
            const dir = dirname(this.filePath);
            if (!existsSync(dir))
                mkdirSync(dir, { recursive: true });
            writeFileSync(this.filePath, JSON.stringify({ resources: this.resources }, null, 2), 'utf-8');
        }
        catch (err) {
            console.error('[dsh-remote-orchestrator] Failed to save ssh resource store:', err);
        }
    }
    list() {
        return [...this.resources];
    }
    get(id) {
        return this.resources.find((r) => r.id === id);
    }
    /** 按名称精确匹配（供 AI 不记 id 时按名称取凭据） */
    getByName(name) {
        const lower = name.toLowerCase();
        return this.resources.find((r) => r.name.toLowerCase() === lower);
    }
    upsert(resource) {
        const idx = this.resources.findIndex((r) => r.id === resource.id);
        const now = Date.now();
        if (idx >= 0) {
            this.resources[idx] = { ...this.resources[idx], ...resource, updatedAt: now };
            this.save();
            return this.resources[idx];
        }
        const created = { ...resource, createdAt: now, updatedAt: now };
        this.resources.push(created);
        this.save();
        return created;
    }
    update(id, patch) {
        const idx = this.resources.findIndex((r) => r.id === id);
        if (idx < 0)
            return undefined;
        this.resources[idx] = { ...this.resources[idx], ...patch, updatedAt: Date.now() };
        this.save();
        return this.resources[idx];
    }
    delete(id) {
        const before = this.resources.length;
        this.resources = this.resources.filter((r) => r.id !== id);
        const changed = this.resources.length !== before;
        if (changed)
            this.save();
        return changed;
    }
}
//# sourceMappingURL=ssh-store.js.map