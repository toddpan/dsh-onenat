/**
 * dsh-onenat - 管理 API（设置页 UI 专用）
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
import type { EngineService } from './engine/index.js';
export interface RouterDeps {
    store: WorkStore;
    directory: OnenatDirectory;
    resolver: AgentResolver;
    runner: AgentRunner;
    parser: MentionParser;
    sshStore: SshResourceStore;
    engine: EngineService;
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
    /**
     * 同源检查：浏览器发起的写请求带 Origin，其 host 必须与 Host 一致。
     * 不带 Origin（curl / 脚本 / 非浏览器客户端）一律放行 —— 本地管理面不对外服务。
     * 只用在引擎写接口上：那些接口能落盘客户端凭据，跨源页面不该能触发。
     */
    private sameOrigin;
    /** 引擎作业是否仍在跑（安装是全局单任务槽，并发提交要挡在服务端） */
    private engineBusy;
    /** @returns 是否已处理 */
    dispatch(req: IncomingMessage, res: ServerResponse, prefix: string): Promise<boolean>;
}
