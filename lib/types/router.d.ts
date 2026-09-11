/**
 * @dsh-external/onenat-workbuddy-mention - 管理 API（设置页 UI 专用）
 *
 * 只在 DSH 本地 GUI 后面服务：设置页与模型工具共用同一份存储与服务。
 * 前缀：<pathPrefix>/api/*
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OnenatDirectory } from './onenat.js';
import type { AgentResolver } from './resolver.js';
import type { MentionParser } from './mentions.js';
import type { AgentRunner } from './agent-runner.js';
import type { SshResourceStore } from './ssh-store.js';
import type { WorkStore } from './store.js';
export interface RouterDeps {
    store: WorkStore;
    directory: OnenatDirectory;
    resolver: AgentResolver;
    runner: AgentRunner;
    parser: MentionParser;
    sshStore: SshResourceStore;
    log: (msg: string) => void;
}
export declare class ManageRouter {
    private deps;
    constructor(deps: RouterDeps);
    private sendJson;
    private parseBody;
    /** @returns 是否已处理 */
    dispatch(req: IncomingMessage, res: ServerResponse, prefix: string): Promise<boolean>;
}
