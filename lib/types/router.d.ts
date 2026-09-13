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
    /**
     * 表单校验：把 UI 传来的 dshRef 归一化成稳定引用（防注入 / 防脏值）。
     * 只接受三种合法形态，其余一律 undefined（由调用方报 400）。
     */
    private normalizeDshRef;
    /**
     * 用「表单当前值」直接解析远端目标 —— 设置页在**保存之前**就要能拉
     * 远端模型 / 模式预设 / 目录，因此不能依赖已落库的子智能体。
     * 走同一条 AgentResolver（ONENAT 稳定 ID → 当下 baseUrl + 凭证），
     * 只是挂一个不落库的合成 agent。
     */
    private resolveProbeTarget;
    /** @returns 是否已处理 */
    dispatch(req: IncomingMessage, res: ServerResponse, prefix: string): Promise<boolean>;
}
