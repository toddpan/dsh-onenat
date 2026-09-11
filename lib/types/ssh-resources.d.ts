/**
 * @dsh-external/dsh-remote-orchestrator - SSH 连接资源服务逻辑
 *
 * - normalizeSshResource: 表单/工具入参校验与归一化（新增与更新共用）
 * - maskSshResource:      列表场景脱敏（不回传明文密码/私钥）
 * - testSshResource:      真实 SSH 连接测试（TCP + 认证握手，经 ssh2；不可用时降级为 TCP 探测）
 * - execOnSshResource:    用已存凭据在远程主机执行命令，回传 stdout/stderr/exitCode
 */
import type { SshAuthType, SshResource, SshResourceMasked } from './types.js';
export declare class SshInputError extends Error {
}
/** 生成短随机 id（ssh- 前缀） */
export declare function newSshResourceId(): string;
/** 校验并归一化 SSH 资源输入（upsert 用；id 由调用方保证） */
export declare function normalizeSshResource(input: Partial<SshResource>, existing?: SshResource): SshResource;
/** 脱敏视图：列表/搜索不回传明文凭据 */
export declare function maskSshResource(r: SshResource): SshResourceMasked;
export interface SshTestResult {
    ok: boolean;
    host: string;
    port: number;
    username: string;
    authType: SshAuthType;
    tcpReachable: boolean;
    authOk?: boolean;
    serverBanner?: string;
    degraded?: boolean;
    error?: string;
    testedAt: number;
}
/** 连接测试：先 TCP 探测，再尽力做真实 SSH 认证握手 */
export declare function testSshResource(r: SshResource, timeoutMs?: number): Promise<SshTestResult>;
export interface SshExecResult {
    ok: boolean;
    host: string;
    port: number;
    username: string;
    command: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    error?: string;
    durationMs: number;
}
/** 用已存凭据在远程主机执行一条命令 */
export declare function execOnSshResource(r: SshResource, command: string, timeoutMs?: number): Promise<SshExecResult>;
