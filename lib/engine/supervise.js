/**
 * oneNat 客户端子进程的监管。
 *
 * 这个子进程和 DSH 主进程是**两种生命周期**：DSH 退出 ≠ 客户端停机。用户
 * 关掉 DSH 窗口，隧道应该继续挂着；下次打开 DSH，插件靠 pid 文件**接管**
 * 那个还在跑的客户端，而不是再起一个 —— 两个客户端抢同一条隧道的控制连接，
 * 表现是隧道反复上下线。
 *
 * 因此这里有几条反直觉但必须坚持的设计：
 *
 *  1. **子进程必须"脱离"DSH 的生命周期。** 用 `detached: true` 让它自成
 *     进程组，并且把 stdout/stderr **直接接到日志文件**（不是管道）。用管道
 *     的话，DSH 一退出管道就断，Go 程序往断掉的 stdout 写日志会吃 SIGPIPE
 *     直接死 —— 隧道会莫名其妙地跟着 DSH 一起消失。文件 fd 没有这个问题。
 *  2. **DSH 退出时不要杀客户端。** `dispose()` 只停定时器、放开句柄。
 *     真正要停得用户显式点"停止"。
 *  3. **健康判定只有"进程存活"。** 客户端跑在托管模式且 `inspect_addr:
 *     disabled`，**没有本地 HTTP 健康端点**（客户端源码 `config.go`：managed
 *     模式下 `inspect_addr` 被强制置为 `disabled`，不启 Web UI）。而客户端
 *     在连不上服务端时**不会退出**，只会自己退避重连（"control recovering
 *     from failure … Waiting 1 seconds before reconnecting"）。所以"进程活着"
 *     完全不代表"隧道通了"。隧道是否在线由宿主侧查 oneNat 的
 *     `/api/v1/resources` 里的 `tunnels[].online` 来判 —— 引擎只负责进程。
 *  4. **启动期退出不算崩溃。** 一个连配置都读不了的二进制反复重启只会烧
 *     CPU 并把日志刷满；这种情况下要停下来报错，而不是进入退避重启循环。
 */
import { execFile, spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { clientConfigPath, clientLogPath, clientPidPath, ensureLayout, ensureDir, logsDir, readCurrentPointer, readJson, versionBinaryPath, writeJsonAtomic, } from './paths.js';
/** 崩溃退避阶梯（毫秒）。 */
export const RESTART_BACKOFF_MS = [1000, 2000, 5000, 10_000, 20_000, 30_000];
/** 停止时的宽限时长（SIGTERM → SIGKILL）。 */
export const STOP_GRACE_MS = 5000;
/**
 * 启动宽限：这段时间内退出算"启动失败"，不算"运行中崩溃"。
 *
 * 它的作用是**别把"这个二进制根本起不来"当成崩溃**——那种情况重启一万次
 * 也是同样的结果。但也不能因此把隧道彻底丢下：所以启动失败也允许重试，
 * 只是连续失败到 `MAX_STARTUP_FAILURES` 次才彻底放弃（见 `handleExit`）。
 */
export const STARTUP_GRACE_MS = 10_000;
/** 连续启动失败多少次之后放弃自动重启。 */
export const MAX_STARTUP_FAILURES = 3;
/** 进程稳定运行超过这个时长就算"启动成功"，退避阶梯归零。 */
const STABLE_RUN_MS = 60_000;
/** 存活巡检间隔（毫秒）。用于接管来的进程（没有 exit 事件可听）。 */
const LIVENESS_TICK_MS = 5000;
/** 日志文件大小上限（超过就轮转一次）。 */
const MAX_LOG_BYTES = 8 * 1024 * 1024;
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
export class EngineSupervisor {
    root;
    binaryName;
    log;
    onChange;
    buildArgs;
    child = null;
    adoptedPid = null;
    adoptedVersion = null;
    startedAt = null;
    stopping = false;
    disposed = false;
    spawnTime = 0;
    restartTimer = null;
    tickTimer = null;
    restartCount = 0;
    /** 退避阶梯下标：每次意外退出都前进一格。 */
    backoffIndex = 0;
    /** 连续启动失败次数。 */
    startupFailures = 0;
    lastError = null;
    /** 正在停：抑制"这是崩溃"的判定。 */
    stopRequested = false;
    /** exit 事件已经处理过（防止巡检与 exit 事件重复判定）。 */
    childExitHandled = false;
    constructor(options) {
        this.root = options.root;
        this.binaryName = options.binaryName;
        this.log = options.log ?? (() => { });
        this.onChange = options.onChange ?? (() => { });
        this.buildArgs = options.buildArgs ?? defaultBuildArgs;
    }
    // ───────────────────────────────────────────────────────────── 路径与元信息
    pidFile() {
        return clientPidPath(this.root);
    }
    readPidFile() {
        const record = readJson(this.pidFile(), null);
        if (record === null)
            return null;
        if (typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid <= 0)
            return null;
        return record;
    }
    currentVersion() {
        return readCurrentPointer(this.root);
    }
    /** 当前版本对应的二进制路径。 */
    binaryPath(version) {
        return versionBinaryPath(this.root, version, this.binaryName);
    }
    // ───────────────────────────────────────────────────────────── 进程存活判定
    /** 进程是否还活着（并且是我们有权发信号的）。 */
    isAlive(pid) {
        try {
            process.kill(pid, 0);
            return true;
        }
        catch {
            // ESRCH = 进程不存在；EPERM = 进程存在但属于别的用户（我们发不了信号，
            // 管不了它）。两种都按"不是我们的客户端"处理。
            return false;
        }
    }
    /**
     * 读出某个 pid 的命令行（尽力而为）。
     *
     * 用途只有一个：**识别 pid 回收**。机器重启后 pid 会被复用，pid 文件里的
     * pid 可能已经是另一个毫不相干的进程。不做这个检查的话，我们会"接管"一个
     * 别人的进程，然后报告"客户端运行中"—— 而隧道根本没通。
     *
     * 拿不到命令行时返回 null，表示"无法判断"（此时信任 pid 文件）。
     */
    async commandLineOf(pid) {
        if (process.platform === 'linux') {
            try {
                const raw = await readFile(`/proc/${pid}/cmdline`);
                return raw.toString('utf8').replace(/\0/g, ' ').trim();
            }
            catch {
                return null;
            }
        }
        if (process.platform === 'darwin') {
            return new Promise((resolve_) => {
                execFile('ps', ['-p', String(pid), '-o', 'command='], { timeout: 5000 }, (error, stdout) => {
                    if (error) {
                        resolve_(null);
                        return;
                    }
                    const text = stdout.trim();
                    resolve_(text === '' ? null : text);
                });
            });
        }
        return null;
    }
    /** 这个 pid 看起来是我们的客户端吗？null = 无法判断。 */
    async looksLikeClient(pid) {
        const command = await this.commandLineOf(pid);
        if (command === null)
            return null;
        const base = basename(this.binaryName).toLowerCase();
        const lower = command.toLowerCase();
        // 上游归档里的可执行文件叫 `ngrok`，装好后我们改名成 `onenat-client`，
        // 但接管旧版本时可能还是旧名字，两个都认。
        return lower.includes(base) || lower.includes('ngrok');
    }
    /**
     * 找出**本机所有** onenat 客户端进程（不只 pid 文件里那一个）。
     *
     * 为什么必须做这件事：插件不是这台机器上唯一的安装通道。用户此前很可能
     * 用过 oneNat 后台的一键安装脚本（`curl … /install.sh | bash`），那样装出来的
     * 客户端由 launchd / systemd 托管、配置在 `~/.onenat-client/`，
     * 和插件的 `~/.dsh/dsh-onenat/engine/` 完全无关。插件再起一个连同一个
     * tunnel_id，两个进程就会抢同一条控制连接：服务端把旧连接踢掉、客户端
     * 互相重连、隧道状态翻来翻去。所以起进程前先看一眼全机。
     *
     * 返回的是「已知进程 + 它的命令行」，交给上层判断是否同一个隧道。
     */
    async liveClientProcesses() {
        if (process.platform === 'win32')
            return lookupWindowsClients(this.binaryName);
        // 必须用 `-x`（精确匹配**可执行文件名**），不能用 `-f`（匹配整条命令行）。
        //
        // 踩过的坑：`pgrep -fl onenat-client` 会命中任何命令行里**顺带**含有这个
        // 字符串的进程 —— 用户开个 `tail -f ~/.onenat-client/onenat-client.log`、
        // 用编辑器打开配置、甚至在他自己的终端里敲一句含该词的命令，都会被当成
        // "外部客户端在跑"，于是插件谎报冲突并拒绝启动。实测中连我自己的调试
        // shell 都被误判过（pid 每次不同、下一秒就消失）。
        //
        // `-x` 只比对进程名（argv[0] 的 basename），能精确命中真正的客户端；
        // 命令行细节另外用 `ps` 取，既准确又不会误伤。
        const names = ['onenat-client', 'ngrok'];
        const found = new Map();
        await Promise.all(names.map((name) => new Promise((done) => {
            execFile('pgrep', ['-x', name], { timeout: 5000 }, (error, stdout) => {
                if (error || stdout.trim() === '') {
                    done();
                    return;
                }
                for (const line of stdout.split(/\r?\n/)) {
                    const pid = Number(line.trim());
                    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid)
                        continue;
                    found.set(pid, name);
                }
                done();
            });
        })));
        const rows = [];
        for (const [pid, name] of found) {
            rows.push({ pid, command: (await this.commandLineOf(pid)) ?? name });
        }
        return rows;
    }
    // ───────────────────────────────────────────────────────────── 生命周期
    /**
     * 确保客户端在跑。幂等：已经在跑就什么都不做。
     *
     * 顺序是"先接管、再启动"：pid 文件里的进程如果还活着，就接管它。直接
     * 无脑启动第二个客户端会让两个进程抢同一条隧道。
     */
    async ensureStarted() {
        if (this.disposed)
            return { started: false, error: '插件已卸载' };
        const version = this.currentVersion();
        if (version === null)
            return { started: false, error: '尚未安装客户端（没有 current 指针）' };
        const binary = this.binaryPath(version);
        const config = clientConfigPath(this.root);
        if (!existsSyncSafe(config)) {
            return { started: false, error: '尚未配置隧道（缺少 client.yml）' };
        }
        if (!existsSyncSafe(binary)) {
            return { started: false, error: `未找到可执行文件：${binary}` };
        }
        // 已经在跑？
        if (this.child !== null && this.child.exitCode === null && !this.child.killed) {
            return { started: true, pid: this.child.pid ?? undefined };
        }
        if (this.adoptedPid !== null && this.isAlive(this.adoptedPid)) {
            return { started: true, pid: this.adoptedPid };
        }
        // 接管上一次会话留下的进程。
        const adopted = await this.tryAdopt(version);
        if (adopted !== null) {
            this.log(`已接管此前运行中的 oneNat 客户端（pid ${adopted.pid}，版本 ${adopted.version}）`);
            this.startLivenessTick();
            this.onChange();
            return { started: true, pid: adopted.pid };
        }
        // 还有别处装好的客户端在跑吗？（一键安装脚本 + launchd/systemd 那条路径）
        // 有的话**拒绝启动**，绝不两个人抢同一条控制连接。
        const conflict = await this.findForeignClient();
        if (conflict !== null) {
            return { started: false, error: describeForeignConflict(conflict) };
        }
        return this.spawnChild(version, binary, config);
    }
    /**
     * 找出「别的安装通道起来的、还没被本插件管理」的客户端进程。
     *
     * 判定「不是我的」：pid 不在 pid 文件里，且 pid 不等于本实例的 child /
     * 已接管 pid。本插件起自己的进程时总会先写 pid 文件，所以只要不在册就是外来的。
     */
    async findForeignClient() {
        const record = this.readPidFile();
        const mine = new Set();
        if (record !== null)
            mine.add(record.pid);
        if (this.child?.pid !== undefined)
            mine.add(this.child.pid);
        if (this.adoptedPid !== null)
            mine.add(this.adoptedPid);
        const live = await this.liveClientProcesses();
        for (const process_ of live) {
            if (mine.has(process_.pid))
                continue;
            return process_;
        }
        return null;
    }
    /**
     * 尝试接管 pid 文件记录的进程。
     *
     * 只接管"进程还活着 + 命令行确实是我们的客户端"的。命令行读不出来时
     * （Windows）才退而信任 pid 文件 —— 那也比"起第二个"强。
     */
    async tryAdopt(version) {
        const record = this.readPidFile();
        if (record === null)
            return null;
        if (!this.isAlive(record.pid)) {
            rmSync(this.pidFile(), { force: true });
            return null;
        }
        const looks = await this.looksLikeClient(record.pid);
        if (looks === false) {
            // pid 被系统回收了：这个进程不是我们的客户端。清掉 pid 文件，重新起。
            this.log(`pid 文件指向的进程 ${record.pid} 不是 oneNat 客户端（pid 已被回收），已清理`);
            rmSync(this.pidFile(), { force: true });
            return null;
        }
        // 版本对不上：跑的是旧版本，升级后必须换成新的。
        if (record.version !== version) {
            this.log(`正在运行的客户端版本 ${record.version} 与当前版本 ${version} 不一致，将重启`);
            await this.killPid(record.pid);
            rmSync(this.pidFile(), { force: true });
            return null;
        }
        this.adoptedPid = record.pid;
        this.adoptedVersion = record.version;
        this.startedAt = record.startedAt > 0 ? record.startedAt : Date.now();
        return record;
    }
    /** 起一个客户端子进程。 */
    spawnChild(version, binary, config) {
        ensureLayout(this.root);
        this.rotateLogIfNeeded();
        const args = this.buildArgs(binary, config);
        const logFile = clientLogPath(this.root);
        // stdout/stderr 直接接日志文件（不是管道）：管道在 DSH 退出后会断，
        // Go 客户端往断掉的 stdout 写日志会吃 SIGPIPE 而死。
        const fd = openSync(logFile, 'a');
        let child;
        try {
            child = spawn(binary, args, {
                cwd: this.root,
                detached: true,
                windowsHide: true,
                stdio: ['ignore', fd, fd],
            });
        }
        catch (error) {
            closeSync(fd);
            const message = `启动 oneNat 客户端失败：${describe(error)}`;
            this.lastError = message;
            this.log(message);
            this.onChange();
            return { started: false, error: message };
        }
        closeSync(fd);
        this.child = child;
        this.stopRequested = false;
        this.spawnTime = Date.now();
        this.adoptedPid = null;
        this.adoptedVersion = null;
        this.lastError = null;
        this.childExitHandled = false;
        child.once('error', (error) => {
            this.lastError = `oneNat 客户端异常：${error.message}`;
            this.log(this.lastError);
            this.onChange();
        });
        child.once('exit', (code, signal) => {
            this.handleExit(code, signal);
        });
        // 不让 Node 的事件循环被子进程句柄吊住：DSH 该退出时要退得干净，
        // 而客户端要继续活着（detached 之后它不受我们退出影响）。
        child.unref();
        if (child.pid !== undefined) {
            this.startedAt = Date.now();
            const record = { pid: child.pid, version, startedAt: this.startedAt, ownerPid: process.pid };
            writeJsonAtomic(this.pidFile(), record);
            this.log(`oneNat 客户端已启动（pid ${child.pid}，版本 ${version}）：${binary} ${args.join(' ')}`);
        }
        this.startLivenessTick();
        this.onChange();
        return { started: true, pid: child.pid };
    }
    /**
     * 子进程退出了。
     *
     * 分三种情况：正在停（正常的 stop）、启动宽限期内（启动失败）、运行中崩溃
     * （退避重启）。
     *
     * 启动失败**也允许重试**（只是不算"崩溃"）：客户端连不上 oneNat 服务端时
     * 自己会退避重连、不会退出；能退出的一般是配置读不了或二进制没权限 ——
     * 但那也可能是"服务端刚好在重启"。连续失败 `MAX_STARTUP_FAILURES` 次才
     * 彻底放弃，否则一个瞬时故障就会让隧道永远起不来。
     */
    handleExit(code, signal) {
        if (this.childExitHandled)
            return;
        this.childExitHandled = true;
        const exitedAt = Date.now();
        const ranFor = exitedAt - this.spawnTime;
        this.child = null;
        this.adoptedPid = null;
        this.adoptedVersion = null;
        this.startedAt = null;
        rmSync(this.pidFile(), { force: true });
        if (this.disposed || this.stopRequested) {
            this.log(`oneNat 客户端已停止（code ${code ?? '-'}，signal ${signal ?? '-'}）`);
            this.onChange();
            return;
        }
        if (ranFor < STARTUP_GRACE_MS) {
            this.startupFailures += 1;
            const detail = this.logTail();
            this.lastError =
                `oneNat 客户端启动后立即退出（code ${code ?? '-'}，signal ${signal ?? '-'}，第 ${this.startupFailures} 次）` +
                    (detail === null ? '' : `：${detail}`);
            this.log(this.lastError);
            if (this.startupFailures >= MAX_STARTUP_FAILURES) {
                this.log(`连续 ${this.startupFailures} 次启动失败，已停止自动重启；请检查配置与网络后手动重启`);
                this.onChange();
                return;
            }
            this.scheduleRestart();
            this.onChange();
            return;
        }
        // 起来了就说明之前的启动失败不算数了（连续失败计数归零）。
        this.startupFailures = 0;
        // 稳定运行过：退避阶梯归零（长稳一次之后再崩，不该还按老账退避）。
        if (ranFor > STABLE_RUN_MS) {
            this.backoffIndex = 0;
        }
        this.lastError = `oneNat 客户端异常退出（code ${code ?? '-'}，signal ${signal ?? '-'}）`;
        this.log(this.lastError);
        this.scheduleRestart();
        this.onChange();
    }
    /** 按退避阶梯安排一次重启。 */
    scheduleRestart() {
        if (this.disposed)
            return;
        if (this.restartTimer !== null)
            clearTimeout(this.restartTimer);
        const index = Math.min(this.backoffIndex, RESTART_BACKOFF_MS.length - 1);
        const delay = RESTART_BACKOFF_MS[index] ?? 30_000;
        this.backoffIndex += 1;
        this.restartCount += 1;
        this.log(`${delay / 1000} 秒后重启 oneNat 客户端（第 ${this.restartCount} 次）`);
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            void this.ensureStarted();
        }, delay);
        this.restartTimer.unref?.();
    }
    /**
     * 存活巡检。
     *
     * 主要是为**接管的进程**准备的：接管来的进程不是我们的子进程，没有
     * `exit` 事件可听，只能定期看它还在不在。自己的子进程由 exit 事件负责。
     */
    startLivenessTick() {
        if (this.tickTimer !== null)
            clearInterval(this.tickTimer);
        this.tickTimer = setInterval(() => {
            if (this.disposed)
                return;
            // 兜底：子进程句柄被 unref 过（否则 DSH 退不干净），极端情况下 exit
            // 事件可能与巡检错开，这里用 exitCode 再确认一次。
            if (this.child !== null && this.child.exitCode !== null && !this.childExitHandled) {
                this.handleExit(this.child.exitCode, this.child.signalCode);
                return;
            }
            if (this.adoptedPid === null)
                return;
            if (this.isAlive(this.adoptedPid))
                return;
            const pid = this.adoptedPid;
            this.adoptedPid = null;
            this.startedAt = null;
            rmSync(this.pidFile(), { force: true });
            this.lastError = `接管的 oneNat 客户端（pid ${pid}）已消失`;
            this.log(this.lastError);
            this.scheduleRestart();
            this.onChange();
        }, LIVENESS_TICK_MS);
        this.tickTimer.unref?.();
    }
    stopLivenessTick() {
        if (this.tickTimer !== null)
            clearInterval(this.tickTimer);
        this.tickTimer = null;
    }
    /** 停止客户端：SIGTERM → 5 秒宽限 → SIGKILL。 */
    async stop() {
        this.stopRequested = true;
        if (this.restartTimer !== null) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        this.stopLivenessTick();
        const pid = this.child?.pid ?? this.adoptedPid;
        if (pid !== undefined && pid !== null) {
            this.log(`正在停止 oneNat 客户端（pid ${pid}）`);
            await this.killPid(pid);
        }
        this.child = null;
        this.adoptedPid = null;
        this.adoptedVersion = null;
        this.startedAt = null;
        this.stopRequested = false;
        rmSync(this.pidFile(), { force: true });
        this.onChange();
        return { stopped: true };
    }
    /** 重启：先停再起。 */
    async restart() {
        await this.stop();
        this.restartCount = 0;
        const outcome = await this.ensureStarted();
        if (!outcome.started)
            return { restarted: false, error: outcome.error };
        return { restarted: true, pid: outcome.pid };
    }
    /**
     * 释放资源。
     *
     * **刻意不杀子进程**：DSH 卸载/退出不等于用户要停隧道。下次启动时靠 pid
     * 文件接管即可（见 `tryAdopt`）。
     */
    async dispose() {
        this.disposed = true;
        if (this.restartTimer !== null) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        this.stopLivenessTick();
        // 放开子进程句柄，但让进程继续跑（detached 之后它与我们无关了）。
        this.child = null;
        this.adoptedPid = null;
        this.onChange();
    }
    /** 当前状态。 */
    status() {
        const runningChild = this.child !== null && this.child.exitCode === null && !this.child.killed;
        const runningAdopted = this.adoptedPid !== null && this.isAlive(this.adoptedPid);
        // pid 文件里的进程也算数 **即使本实例还没接管它**。
        //
        // 为什么：DSH 重启后新实例还没调过 start()（或插件被禁用后又启用），
        // 此时客户端仍在后台跑着。只认「本实例的 child / 已接管 pid」会让状态显示
        // 「未运行」——用户看到假的停止状态，然后点「启动」再起第二个进程抢同一条隧道。
        // 所以这里把 pid 文件也当成运行证据：能读到、进程活着，就是 running。
        const untracked = runningChild || runningAdopted ? null : this.alivePidFromFile();
        const running = runningChild || runningAdopted || untracked !== null;
        const pid = runningChild ? (this.child?.pid ?? undefined) : (this.adoptedPid ?? untracked ?? undefined);
        const status = {
            running,
            adopted: !runningChild && running,
            restarts: this.restartCount,
        };
        if (pid !== undefined)
            status.pid = pid;
        if (this.startedAt !== null) {
            status.startedAt = this.startedAt;
            status.uptimeMs = Date.now() - this.startedAt;
        }
        const version = this.currentVersion();
        if (version !== null)
            status.version = version;
        if (this.lastError !== null)
            status.lastError = this.lastError;
        return status;
    }
    /**
     * pid 文件里记录的进程还活着就返回它（仅用于状态展示，**不做接管**）。
     * 接管要校验命令行与版本，属于 `tryAdopt` 的职责，不能在这里偷偷做。
     */
    alivePidFromFile() {
        const record = this.readPidFile();
        if (record === null)
            return null;
        return this.isAlive(record.pid) ? record.pid : null;
    }
    // ───────────────────────────────────────────────────────────── 内部工具
    /** SIGTERM，宽限期内不死就 SIGKILL。 */
    async killPid(pid) {
        try {
            process.kill(pid, 'SIGTERM');
        }
        catch {
            return;
        }
        const deadline = Date.now() + STOP_GRACE_MS;
        while (Date.now() < deadline) {
            if (!this.isAlive(pid))
                return;
            await new Promise((resolve_) => setTimeout(resolve_, 200));
        }
        try {
            process.kill(pid, 'SIGKILL');
        }
        catch {
            /* 已经没了 */
        }
        await new Promise((resolve_) => setTimeout(resolve_, 200));
    }
    /** 日志尾部若干行（用于把"为什么起不来"带到错误信息里）。 */
    logTail(lines = 5) {
        try {
            const text = readFileSync(clientLogPath(this.root), 'utf8');
            const all = text.split('\n').filter((line) => line.trim() !== '');
            if (all.length === 0)
                return null;
            return all.slice(-lines).join(' / ');
        }
        catch {
            return null;
        }
    }
    /** 日志太大就轮转一次（保留最后一份）。 */
    rotateLogIfNeeded() {
        const file = clientLogPath(this.root);
        ensureDir(logsDir(this.root));
        try {
            if (statSync(file).size < MAX_LOG_BYTES)
                return;
        }
        catch {
            return;
        }
        try {
            renameSync(file, `${file}.1`);
        }
        catch {
            /* 轮转失败就继续写同一个文件 */
        }
    }
}
/**
 * 默认的启动参数。
 *
 * `-log=stdout` 是**必须的**：客户端默认 `-log=none`，但只要不是 stdout，
 * 它就会去初始化 termbox 终端 UI —— 在没有 TTY 的环境（systemd / 后台 /
 * 无人值守）里 termbox 初始化会失败并卡住消息循环，隧道根本建不起来
 * （上游 r2026.09.07 的 release notes 里就记了这个 bug）。托管模式必须显式
 * 走纯日志模式。
 *
 * `-config=<路径>` 用 Go flag 的 `=` 写法：路径里有空格也不怕被拆开。
 * 子命令 `managed` 放最后：客户端的 CLI 会先把 `managed` 摘出来，剩下的按
 * Go flag 解析，位置在哪都能认。
 */
export function defaultBuildArgs(_binaryPath, configPath) {
    return ['managed', `-config=${configPath}`, '-log=stdout', '-log-level=INFO'];
}
/**
 * 把「别的通道已经在跑客户端」翻译成一句用户能照着做的中文。
 *
 * 这不是技术错误，是一处**需要用户决策**的冲突：同一个 tunnel_id 只能有一个
 * 客户端在连。要么用户自己停掉外部的（launchd/systemd），要么放弃插件托管。
 *
 * 托管方式无法从命令行字符串判断（launchd 起的进程命令行里根本没有 plist
 * 标签），所以这里查**实际存在的单元文件**，再给出对应命令。
 */
export function describeForeignConflict(conflict) {
    const hints = [];
    const home = homedir();
    const plist = join(home, 'Library', 'LaunchAgents', 'com.onenat.client.plist');
    if (existsSyncSafe(plist)) {
        hints.push('`launchctl unload ~/Library/LaunchAgents/com.onenat.client.plist`');
    }
    if (existsSyncSafe('/etc/systemd/system/onenat-client.service') ||
        existsSyncSafe('/lib/systemd/system/onenat-client.service')) {
        hints.push('`sudo systemctl disable --now onenat-client`');
    }
    const remedy = hints.length > 0 ? `它由系统服务托管，停掉的办法：${hints.join(' 或 ')}` : '请手动结束该进程';
    return (`本机已有一个不是由本插件管理的 oneNat 客户端在运行（pid ${conflict.pid}）：${conflict.command}。`
        + `同一条隧道只能有一个客户端在连，插件不会重复启动。${remedy}；或者干脆继续用外部那个，插件只用它的能力。`);
}
/** 判断路径是否存在（同步小工具）。 */
function existsSyncSafe(path) {
    try {
        statSync(path);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Windows 上没有 pgrep，用 `tasklist` 按映像名找。
 *
 * 拿不到完整命令行（`tasklist /fo csv` 只给映像名），所以这里只能回答
 * 「有没有进程叫这个名字」，够用来提示冲突，不足以判断是哪个隧道 —— 因此
 * 上层在 Windows 上一律按「可能冲突」处理，让用户自己确认。
 */
function lookupWindowsClients(binaryName) {
    const image = basename(binaryName).toLowerCase();
    return new Promise((resolve_) => {
        execFile('tasklist', ['/fo', 'csv', '/nh'], { timeout: 5000 }, (error, stdout) => {
            if (error || stdout.trim() === '') {
                resolve_([]);
                return;
            }
            const rows = [];
            for (const line of stdout.split(/\r?\n/)) {
                const cells = line.split('","').map((cell) => cell.replace(/^"|"$/g, ''));
                if (cells.length < 2)
                    continue;
                const imageName = cells[0].toLowerCase();
                if (!imageName.includes(image) && !imageName.includes('ngrok'))
                    continue;
                const pid = Number(cells[1]);
                if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid)
                    continue;
                // 只有映像名，没有参数 —— 用映像名冒充命令行，下游会当成"无法判断隧道"。
                rows.push({ pid, command: imageName });
            }
            resolve_(rows);
        });
    });
}
//# sourceMappingURL=supervise.js.map