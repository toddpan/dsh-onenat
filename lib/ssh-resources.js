/**
 * @dsh-external/dsh-remote-orchestrator - SSH 连接资源服务逻辑
 *
 * - normalizeSshResource: 表单/工具入参校验与归一化（新增与更新共用）
 * - maskSshResource:      列表场景脱敏（不回传明文密码/私钥）
 * - testSshResource:      真实 SSH 连接测试（TCP + 认证握手，经 ssh2；不可用时降级为 TCP 探测）
 * - execOnSshResource:    用已存凭据在远程主机执行命令，回传 stdout/stderr/exitCode
 */
import * as net from 'node:net';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
export class SshInputError extends Error {
}
/** 生成短随机 id（ssh- 前缀） */
export function newSshResourceId() {
    return `ssh-${Math.random().toString(36).slice(2, 10)}`;
}
/** 校验并归一化 SSH 资源输入（upsert 用；id 由调用方保证） */
export function normalizeSshResource(input, existing) {
    const authType = input.authType === 'key' ? 'key' : 'password';
    const host = String(input.host ?? existing?.host ?? '').trim();
    const username = String(input.username ?? existing?.username ?? '').trim();
    const name = String(input.name ?? existing?.name ?? '').trim();
    if (!name)
        throw new SshInputError('缺少必填字段 name（资源名称）');
    if (!host)
        throw new SshInputError('缺少必填字段 host（连接 IP 或主机名）');
    if (!username)
        throw new SshInputError('缺少必填字段 username（SSH 登录账号）');
    const portNum = Number(input.port ?? existing?.port ?? 22);
    const port = Number.isInteger(portNum) && portNum > 0 && portNum < 65536 ? portNum : 22;
    // 空串 = 不修改（表单「留空表示不修改」的语义）。用 ?? 会把空串当成新值，
    // 导致编辑一条已有密码的资源必然报「必须提供 password」。
    const keep = (next, prev) => next !== undefined && String(next).trim() !== '' ? next : prev;
    const password = keep(input.password, existing?.password);
    const privateKey = keep(input.privateKey, existing?.privateKey);
    const passphrase = keep(input.passphrase, existing?.passphrase);
    if (authType === 'password' && !password) {
        throw new SshInputError('连接方式为 password 时必须提供 password');
    }
    if (authType === 'key' && !privateKey) {
        throw new SshInputError('连接方式为 key 时必须提供 privateKey（PEM 私钥内容）');
    }
    const now = Date.now();
    return {
        id: input.id || existing?.id || newSshResourceId(),
        name,
        host,
        port,
        authType,
        username,
        ...(password ? { password } : {}),
        ...(privateKey ? { privateKey } : {}),
        ...(passphrase ? { passphrase } : {}),
        ...(input.description !== undefined ? { description: String(input.description) } : existing?.description ? { description: existing.description } : {}),
        ...(input.tags !== undefined ? { tags: Array.isArray(input.tags) ? input.tags.map(String) : [] } : existing?.tags ? { tags: existing.tags } : {}),
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
    };
}
/** 脱敏视图：列表/搜索不回传明文凭据 */
export function maskSshResource(r) {
    const { password, privateKey, passphrase, ...rest } = r;
    return {
        ...rest,
        hasPassword: Boolean(password),
        hasPrivateKey: Boolean(privateKey),
        hasPassphrase: Boolean(passphrase),
    };
}
/** ssh2 的连接配置（密码 / 私钥二选一） */
function sshConnectConfig(r, readyTimeoutMs) {
    const config = {
        host: r.host,
        port: r.port,
        username: r.username,
        readyTimeout: readyTimeoutMs,
        keepaliveCountMax: 1,
    };
    if (r.authType === 'key') {
        config.privateKey = r.privateKey;
        if (r.passphrase)
            config.passphrase = r.passphrase;
    }
    else {
        config.password = r.password;
    }
    return config;
}
/**
 * 加载 ssh2（CJS 包）。用 createRequire 做标准 CJS 解析（比 ESM 动态 import
 * 更稳：不受 harness 的 tsx/loader 钩子影响）。依次尝试：
 *   1. 本插件自身 node_modules（build.sh 会 junction 链接）；
 *   2. DSH profile 的 node_modules（dsh-ssh 等生态插件自带）；
 * 都不可用返回 undefined（test 降级 TCP 探测、exec 报缺依赖）。
 */
function loadSsh2() {
    const tryRequire = (base) => {
        try {
            const mod = createRequire(base)('ssh2');
            const Client = mod?.Client ?? mod?.default?.Client;
            return Client ? { Client } : undefined;
        }
        catch {
            return undefined;
        }
    };
    // import.meta.url 的 ESM 真实路径（编译后 lib/ssh-resources.js）
    let selfBase;
    try {
        selfBase = import.meta.url;
    }
    catch {
        selfBase = undefined;
    }
    if (selfBase) {
        const found = tryRequire(selfBase);
        if (found)
            return found;
    }
    const profileBase = join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@dsh-external', 'dsh-remote-orchestrator', 'lib', 'index.js');
    return tryRequire(profileBase);
}
/** TCP 端口连通性探测（毫秒级超时） */
function tcpProbe(host, port, timeoutMs) {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        const done = (err) => {
            socket.removeAllListeners();
            socket.destroy();
            if (err)
                reject(err);
            else
                resolve();
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => done());
        socket.once('timeout', () => done(new Error(`TCP 连接超时（${timeoutMs}ms）`)));
        socket.once('error', (err) => done(err));
        socket.connect(port, host);
    });
}
/** 连接测试：先 TCP 探测，再尽力做真实 SSH 认证握手 */
export async function testSshResource(r, timeoutMs = 8000) {
    const testedAt = Date.now();
    const base = {
        ok: false,
        host: r.host,
        port: r.port,
        username: r.username,
        authType: r.authType,
        tcpReachable: false,
        testedAt,
    };
    try {
        await tcpProbe(r.host, r.port, timeoutMs);
    }
    catch (err) {
        return { ...base, error: `TCP 不可达: ${err?.message || String(err)}` };
    }
    base.tcpReachable = true;
    const ssh2 = loadSsh2();
    if (!ssh2) {
        // 环境缺少 ssh2 依赖：降级为端口可达性结论
        return { ...base, ok: true, degraded: true, error: undefined };
    }
    return new Promise((resolve) => {
        const conn = new ssh2.Client();
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            try {
                conn.end();
            }
            catch {
                /* ignore */
            }
            resolve(result);
        };
        const timer = setTimeout(() => {
            finish({ ...base, error: `SSH 握手超时（${timeoutMs}ms）` });
        }, timeoutMs);
        conn
            .on('ready', () => {
            clearTimeout(timer);
            finish({ ...base, ok: true, authOk: true });
        })
            .on('banner', (banner) => {
            base.serverBanner = banner;
        })
            .on('error', (err) => {
            clearTimeout(timer);
            finish({ ...base, authOk: false, error: `SSH 认证/握手失败: ${err.message}` });
        })
            .connect(sshConnectConfig(r, timeoutMs));
    });
}
/** 用已存凭据在远程主机执行一条命令 */
export async function execOnSshResource(r, command, timeoutMs = 30000) {
    const startedAt = Date.now();
    const ssh2 = loadSsh2();
    if (!ssh2) {
        return {
            ok: false,
            host: r.host,
            port: r.port,
            username: r.username,
            command,
            error: '运行环境缺少 ssh2 依赖，无法执行远程命令（请安装 ssh2 或改用系统 ssh 工具）',
            durationMs: Date.now() - startedAt,
        };
    }
    return new Promise((resolve) => {
        const conn = new ssh2.Client();
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            try {
                conn.end();
            }
            catch {
                /* ignore */
            }
            resolve({
                ok: Boolean(result.stdout !== undefined || result.exitCode !== undefined) && !result.error,
                host: r.host,
                port: r.port,
                username: r.username,
                command,
                stdout: result.stdout,
                stderr: result.stderr,
                exitCode: result.exitCode,
                error: result.error,
                durationMs: Date.now() - startedAt,
            });
        };
        const timer = setTimeout(() => finish({ error: `执行超时（${timeoutMs}ms）` }), timeoutMs);
        conn
            .on('ready', () => {
            conn.exec(command, (err, stream) => {
                if (err) {
                    finish({ error: `exec 失败: ${err.message}` });
                    return;
                }
                let stdout = '';
                let stderr = '';
                stream.on('close', (code) => {
                    finish({ stdout, stderr, exitCode: code });
                })
                    .on('data', (data) => {
                    stdout += data.toString('utf-8');
                })
                    .stderr.on('data', (data) => {
                    stderr += data.toString('utf-8');
                });
            });
        })
            .on('error', (err) => {
            finish({ error: `SSH 连接失败: ${err.message}` });
        })
            .connect(sshConnectConfig(r, Math.min(timeoutMs, 15000)));
    });
}
//# sourceMappingURL=ssh-resources.js.map