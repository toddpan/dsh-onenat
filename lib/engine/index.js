/**
 * 引擎门面：宿主侧（router / 设置页）唯一需要打交道的东西。
 *
 * 对外只有这一层。里面怎么下载、怎么解包、怎么监管子进程都是内部实现，
 * 宿主侧只关心"现在是什么状态""让它干点什么"。
 *
 * 两条贯穿全模块的规矩：
 *
 *  1. **密钥不外泄。** `auth_token` 只存在于 `client.yml`（0600）里。任何
 *     返回值、日志、错误信息里出现的都只有掩码（`ngk-****abcd`）。`configure`
 *     收到的 KEY 甚至不会出现在它自己的错误消息里 —— 错误只说"隧道 ID 或
 *     KEY 错误"。
 *  2. **健康 = 进程存活 && 服务端侧隧道在线。** 前一半由引擎负责（子进程监管），
 *     后一半由宿主侧通过 `deps.isTunnelOnline` 注入 —— oneNat 服务端才是
 *     隧道状态的唯一权威（客户端连不上服务端时不会退出，只会自己退避重连，
 *     所以"进程活着"完全不代表"隧道通了"）。
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { clientConfigExists, parseAuthToken, parseTunnelId, readClientConfig, writeClientConfig } from './config.js';
import { installClient, readInstallMeta } from './install.js';
import { JobManager } from './jobs.js';
import { detectPlatformTag, binaryFileName } from './platform.js';
import { clientLogPath, ensureLayout, engineRoot, readCurrentPointer, versionBinaryPath, } from './paths.js';
import { EngineSupervisor } from './supervise.js';
export { JobManager, isTerminalPhase } from './jobs.js';
/** 确认进程存活时的观察时长（毫秒）。 */
const CONFIRM_SETTLE_MS = 1500;
export class EngineService {
    deps;
    root;
    repo;
    jobs = new JobManager();
    supervisor;
    platform;
    binaryName;
    constructor(deps) {
        this.deps = deps;
        this.root = deps.root ?? engineRoot();
        this.repo = deps.repo ?? 'toddpan/onenat';
        this.platform = detectPlatformTag();
        this.binaryName = this.platform === null ? 'onenat-client' : binaryFileName(this.platform);
        ensureLayout(this.root);
        this.supervisor = new EngineSupervisor({
            root: this.root,
            binaryName: this.binaryName,
            log: (message) => this.deps.log(`[engine] ${message}`),
        });
    }
    /** 引擎根目录（宿主侧想展示路径时用）。 */
    get engineDir() {
        return this.root;
    }
    /**
     * 汇总状态。
     *
     * **不触网**：读配置、读 pid、判进程存活，加上宿主侧注入的隧道在线判定。
     * 设置页会频繁轮询它，触网会把 oneNat 服务端的限速额度烧光。
     */
    async status() {
        const version = readCurrentPointer(this.root);
        const installed = version !== null &&
            this.platform !== null &&
            existsQuietly(versionBinaryPath(this.root, version, this.binaryName));
        const config = readClientConfig(this.root);
        const tunnelId = config === null ? undefined : parseTunnelId(config);
        const status = {
            installed,
            configured: clientConfigExists(this.root),
            running: false,
        };
        if (version !== null)
            status.version = version;
        status.assetFile = this.binaryName;
        const meta = version === null ? null : readInstallMeta(this.root, version);
        if (meta !== null)
            status.source = meta.source;
        const running = this.supervisor.status();
        status.running = running.running;
        if (running.pid !== undefined)
            status.pid = running.pid;
        if (running.uptimeMs !== undefined)
            status.uptimeMs = running.uptimeMs;
        if (running.lastError !== undefined)
            status.lastError = running.lastError;
        if (tunnelId !== undefined)
            status.tunnelId = tunnelId;
        const online = this.deps.isTunnelOnline?.(tunnelId);
        if (online !== undefined)
            status.tunnelOnline = online;
        // 外部安装通道的客户端也在跑？让界面能主动提示，而不是等用户点了启动才报错。
        // 只在「插件自己没在跑」时才查：两者都在跑本身也是问题，但那时进程状态就暴露了。
        if (!status.running) {
            const foreign = await this.supervisor.findForeignClient();
            if (foreign !== null)
                status.foreignClientPid = foreign.pid;
        }
        return status;
    }
    /**
     * 安装 / 升级。
     *
     * **同步返回作业快照，作业在后台跑** —— 宿主 API 直接把它回给前端轮询。
     * 已有作业在跑时抛错（宿主侧应翻译成 409）。
     */
    install(opts) {
        const version = opts?.version;
        const force = opts?.force === true;
        const label = version === undefined ? '安装 oneNat 客户端' : `安装 oneNat 客户端 ${version}`;
        return this.jobs.start('install', label, async (context) => {
            const wasRunning = this.supervisor.status().running;
            const previousVersion = readCurrentPointer(this.root);
            // 强制重装同一个版本时必须先停进程：Windows 上正在运行的 exe 换不掉。
            if (force && wasRunning) {
                context.phase('starting', '正在停止当前客户端（强制重装）');
                await this.supervisor.stop();
            }
            const result = await installClient({
                root: this.root,
                repo: this.repo,
                version,
                force,
                platform: this.platform,
                signal: context.signal,
                onProgress: (progress) => {
                    context.phase(progress.phase, progress.message ?? null, {
                        percent: progress.percent ?? null,
                        bytesDone: progress.bytesDone,
                        bytesTotal: progress.bytesTotal ?? undefined,
                    });
                },
            });
            this.deps.log(`[engine] oneNat 客户端 ${result.noop ? '无需更新' : '已安装'}：${result.version}` +
                `（资产 ${result.assetFile}，来源 ${result.source}，sha256 ${result.sha256 === null ? '未提供' : result.sha256.slice(0, 12)}…）`);
            if (!clientConfigExists(this.root)) {
                return { noop: result.noop, message: `已安装 v${result.version}，尚未配置隧道（缺少 client.yml）` };
            }
            // 版本变了就必须换进程：跑的还是旧二进制。
            const running = this.supervisor.status();
            if (running.running && running.version !== undefined && running.version !== result.version) {
                context.phase('starting', '正在切换到新版本');
                await this.supervisor.stop();
            }
            context.phase('starting', '正在启动 oneNat 客户端');
            const started = await this.supervisor.ensureStarted();
            if (!started.started) {
                throw new Error(started.error ?? 'oneNat 客户端启动失败');
            }
            context.phase('confirming', '正在确认客户端进程存活');
            await sleep(CONFIRM_SETTLE_MS);
            const after = this.supervisor.status();
            if (!after.running) {
                throw new Error(after.lastError ?? 'oneNat 客户端启动后未能保持运行');
            }
            // 旧版本回滚指针：如果装的是新版本但没能跑起来，指针还指着新版本，
            // 用户会看到"已安装但没运行"。这里如实报错，由用户决定是否回退。
            void previousVersion;
            return { noop: result.noop, message: `v${result.version} 已安装并运行（pid ${after.pid ?? '-'}）` };
        });
    }
    /** 启动客户端。 */
    async start() {
        if (this.jobs.isBusy())
            return { started: false, error: '已有任务正在进行，请稍候' };
        const outcome = await this.supervisor.ensureStarted();
        if (!outcome.started) {
            const error = outcome.error ?? '启动失败';
            this.deps.log(`[engine] ${error}`);
            return { started: false, error };
        }
        return outcome.started ? { started: true, pid: outcome.pid } : { started: false, error: '启动失败' };
    }
    /** 停止客户端。 */
    async stop() {
        if (this.jobs.isBusy())
            return { stopped: false, error: '已有任务正在进行，请稍候' };
        return this.supervisor.stop();
    }
    /** 重启客户端。 */
    async restart() {
        if (this.jobs.isBusy())
            return { restarted: false, error: '已有任务正在进行，请稍候' };
        return this.supervisor.restart();
    }
    /**
     * 拉取 oneNat 托管配置并落盘（0600）。
     *
     * 走服务端 `GET {baseUrl}/api/deploy?id=<tunnelId>&key=<key>`（公开端点，
     * 限速 30 次/分/IP）。返回只带掩码，**绝不回传明文 KEY**。
     *
     * 注意这里用的是普通的 `fetch` 而不是引擎里的 `fetchText`：后者强制 https，
     * 而 oneNat 服务端可能部署在 http 的内网地址上。
     */
    async configure(opts) {
        const baseUrl = normalizeBaseUrl(opts.baseUrl);
        if (baseUrl === null) {
            return { ok: false, error: 'baseUrl 必须是 http(s) 绝对地址' };
        }
        const tunnelId = String(opts.tunnelId ?? '').trim();
        const key = String(opts.key ?? '').trim();
        if (tunnelId === '')
            return { ok: false, error: '隧道 ID 不能为空' };
        if (key === '')
            return { ok: false, error: '隧道 KEY 不能为空' };
        const url = new URL('/api/deploy', baseUrl);
        url.searchParams.set('id', tunnelId);
        url.searchParams.set('key', key);
        let response;
        try {
            response = await fetch(url.toString(), {
                headers: { accept: 'text/yaml, text/plain, */*' },
                signal: AbortSignal.timeout(15_000),
            });
        }
        catch (error) {
            // 错误信息里绝不能出现带 key 的 URL。
            return { ok: false, error: `连接 oneNat 服务端失败：${error instanceof Error ? error.message : String(error)}` };
        }
        if (!response.ok) {
            // 403/400 是"隧道 ID 或 KEY 错误"；服务端原文就是这么说的，
            // 但我们再统一一遍措辞，避免把 key 相关的细节带出去。
            if (response.status === 400 || response.status === 403) {
                return { ok: false, error: '隧道 ID 或 KEY 错误' };
            }
            if (response.status === 404) {
                return { ok: false, error: 'oneNat 服务端没有 /api/deploy 接口（请确认 baseUrl 指向 oneNat 服务端）' };
            }
            if (response.status === 429) {
                return { ok: false, error: 'oneNat 服务端限速（30 次/分/IP），请稍后再试' };
            }
            return { ok: false, error: `拉取托管配置失败：HTTP ${response.status}` };
        }
        const yaml = await response.text();
        if (!yaml.includes('auth_token')) {
            return { ok: false, error: 'oneNat 服务端返回的内容不是托管客户端配置（缺少 auth_token）' };
        }
        let written;
        try {
            written = await writeClientConfig(yaml, this.root);
        }
        catch (error) {
            return { ok: false, error: `写入客户端配置失败：${error instanceof Error ? error.message : String(error)}` };
        }
        // 日志里只出现隧道 ID，不出现明文 KEY；回给前端的也只是一句话摘要。
        this.deps.log(`[engine] 已写入客户端配置（隧道 ${tunnelId}），路径 ${written.path}`);
        // 配置变了，已经在跑的客户端还在用旧配置 —— 重启一次让它生效。
        if (this.supervisor.status().running) {
            const restarted = await this.supervisor.restart();
            if (!restarted.restarted) {
                this.deps.log(`[engine] 客户端重启失败（配置已更新，需手动重启）：${restarted.error ?? '未知原因'}`);
            }
        }
        return { ok: true, masked: written.masked };
    }
    /** 读客户端日志尾部。 */
    async logs(opts) {
        const limit = Math.max(1, Math.min(2000, opts?.limit ?? 200));
        const file = clientLogPath(this.root);
        const text = readTail(file, 512 * 1024);
        if (text === null)
            return { lines: [] };
        // 万一客户端把 token 打进日志了，出口再挡一次。
        const token = readClientConfig(this.root) ?? '';
        const authToken = parseAuthToken(token);
        const lines = text.split('\n').filter((line) => line.trim() !== '');
        const redacted = authToken === undefined
            ? lines
            : lines.map((line) => line.split(authToken).join('ngk-****'));
        return { lines: redacted.slice(-limit) };
    }
    /**
     * 当前作业快照。
     *
     * 作业结束后**仍然返回它**（含失败原因），直到下一次作业开始才被覆盖 ——
     * 安装失败之后用户需要看到"为什么失败"。
     * 从未跑过作业时返回 null。
     */
    currentJob() {
        return this.jobs.current();
    }
    /** 取消当前作业；没有作业在跑时返回 false。 */
    cancelJob() {
        return this.jobs.cancel();
    }
    /**
     * 宿主卸载时调用。
     *
     * **不要杀子进程**：DSH 退出 ≠ 客户端停机。下次启动时靠 pid 文件接管即可。
     */
    dispose() {
        void this.supervisor.dispose();
    }
}
/** 规整 baseUrl：必须是 http(s) 绝对地址。 */
function normalizeBaseUrl(raw) {
    const text = String(raw ?? '').trim();
    if (text === '')
        return null;
    let url;
    try {
        url = new URL(text);
    }
    catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
        return null;
    if (url.hostname === '')
        return null;
    return url.toString().replace(/\/+$/, '');
}
/** 判断路径是否存在。 */
function existsQuietly(path) {
    try {
        statSync(path);
        return true;
    }
    catch {
        return false;
    }
}
/** 读文件尾部（最多 maxBytes 字节），文件不存在返回 null。 */
function readTail(file, maxBytes) {
    try {
        const size = statSync(file).size;
        if (size <= maxBytes)
            return readFileSync(file, 'utf8');
        // 大文件只读尾部：日志动辄几 MB，全读会让每次轮询都做无用功。
        const buffer = Buffer.alloc(maxBytes);
        const fd = openSync(file, 'r');
        try {
            readSync(fd, buffer, 0, buffer.length, size - maxBytes);
        }
        finally {
            closeSync(fd);
        }
        return buffer.toString('utf8');
    }
    catch {
        return null;
    }
}
/** 睡一会儿。 */
function sleep(ms) {
    return new Promise((resolve_) => setTimeout(resolve_, ms));
}
//# sourceMappingURL=index.js.map