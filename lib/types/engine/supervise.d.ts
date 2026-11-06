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
/** 崩溃退避阶梯（毫秒）。 */
export declare const RESTART_BACKOFF_MS: readonly number[];
/** 停止时的宽限时长（SIGTERM → SIGKILL）。 */
export declare const STOP_GRACE_MS = 5000;
/**
 * 启动宽限：这段时间内退出算"启动失败"，不算"运行中崩溃"。
 *
 * 它的作用是**别把"这个二进制根本起不来"当成崩溃**——那种情况重启一万次
 * 也是同样的结果。但也不能因此把隧道彻底丢下：所以启动失败也允许重试，
 * 只是连续失败到 `MAX_STARTUP_FAILURES` 次才彻底放弃（见 `handleExit`）。
 */
export declare const STARTUP_GRACE_MS = 10000;
/** 连续启动失败多少次之后放弃自动重启。 */
export declare const MAX_STARTUP_FAILURES = 3;
/** pid 文件内容。 */
export interface PidRecord {
    pid: number;
    version: string;
    startedAt: number;
    /** 启动它的 DSH 进程 pid。用来判断"是不是别人的客户端"。 */
    ownerPid: number;
}
/** 监管器对外状态。 */
export interface SupervisorStatus {
    running: boolean;
    pid?: number;
    version?: string;
    startedAt?: number;
    uptimeMs?: number;
    /** true = 接管的是上一次 DSH 会话留下的进程。 */
    adopted: boolean;
    /** 最近一次失败原因（启动失败或崩溃）。 */
    lastError?: string;
    /** 本次运行期间的重启次数。 */
    restarts: number;
}
/** 监管器选项。 */
export interface EngineSupervisorOptions {
    /** 引擎根目录。 */
    root: string;
    /** 二进制文件名（`onenat-client` 或 `onenat-client.exe`）。 */
    binaryName: string;
    /** 日志回调（**不要在这里打印任何密钥**）。 */
    log?: (message: string) => void;
    /** 状态变化回调（设置页可以据此刷新）。 */
    onChange?: () => void;
    /** 启动命令模板（测试用；默认 `<binary> managed -config=<yml>`）。 */
    buildArgs?: (binaryPath: string, configPath: string) => string[];
}
export declare class EngineSupervisor {
    private readonly root;
    private readonly binaryName;
    private readonly log;
    private readonly onChange;
    private readonly buildArgs;
    private child;
    private adoptedPid;
    private adoptedVersion;
    private startedAt;
    private stopping;
    private disposed;
    private spawnTime;
    private restartTimer;
    private tickTimer;
    private restartCount;
    /** 退避阶梯下标：每次意外退出都前进一格。 */
    private backoffIndex;
    /** 连续启动失败次数。 */
    private startupFailures;
    private lastError;
    /** 正在停：抑制"这是崩溃"的判定。 */
    private stopRequested;
    /** exit 事件已经处理过（防止巡检与 exit 事件重复判定）。 */
    private childExitHandled;
    constructor(options: EngineSupervisorOptions);
    private pidFile;
    private readPidFile;
    private currentVersion;
    /** 当前版本对应的二进制路径。 */
    private binaryPath;
    /** 进程是否还活着（并且是我们有权发信号的）。 */
    private isAlive;
    /**
     * 读出某个 pid 的命令行（尽力而为）。
     *
     * 用途只有一个：**识别 pid 回收**。机器重启后 pid 会被复用，pid 文件里的
     * pid 可能已经是另一个毫不相干的进程。不做这个检查的话，我们会"接管"一个
     * 别人的进程，然后报告"客户端运行中"—— 而隧道根本没通。
     *
     * 拿不到命令行时返回 null，表示"无法判断"（此时信任 pid 文件）。
     */
    private commandLineOf;
    /** 这个 pid 看起来是我们的客户端吗？null = 无法判断。 */
    private looksLikeClient;
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
    liveClientProcesses(): Promise<Array<{
        pid: number;
        command: string;
    }>>;
    /**
     * 确保客户端在跑。幂等：已经在跑就什么都不做。
     *
     * 顺序是"先接管、再启动"：pid 文件里的进程如果还活着，就接管它。直接
     * 无脑启动第二个客户端会让两个进程抢同一条隧道。
     */
    ensureStarted(): Promise<{
        started: boolean;
        pid?: number;
        error?: string;
    }>;
    /**
     * 找出「别的安装通道起来的、还没被本插件管理」的客户端进程。
     *
     * 判定「不是我的」：pid 不在 pid 文件里，且 pid 不等于本实例的 child /
     * 已接管 pid。本插件起自己的进程时总会先写 pid 文件，所以只要不在册就是外来的。
     */
    findForeignClient(): Promise<{
        pid: number;
        command: string;
    } | null>;
    /**
     * 尝试接管 pid 文件记录的进程。
     *
     * 只接管"进程还活着 + 命令行确实是我们的客户端"的。命令行读不出来时
     * （Windows）才退而信任 pid 文件 —— 那也比"起第二个"强。
     */
    private tryAdopt;
    /** 起一个客户端子进程。 */
    private spawnChild;
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
    private handleExit;
    /** 按退避阶梯安排一次重启。 */
    private scheduleRestart;
    /**
     * 存活巡检。
     *
     * 主要是为**接管的进程**准备的：接管来的进程不是我们的子进程，没有
     * `exit` 事件可听，只能定期看它还在不在。自己的子进程由 exit 事件负责。
     */
    private startLivenessTick;
    private stopLivenessTick;
    /** 停止客户端：SIGTERM → 5 秒宽限 → SIGKILL。 */
    stop(): Promise<{
        stopped: boolean;
        error?: string;
    }>;
    /** 重启：先停再起。 */
    restart(): Promise<{
        restarted: boolean;
        pid?: number;
        error?: string;
    }>;
    /**
     * 释放资源。
     *
     * **刻意不杀子进程**：DSH 卸载/退出不等于用户要停隧道。下次启动时靠 pid
     * 文件接管即可（见 `tryAdopt`）。
     */
    dispose(): Promise<void>;
    /** 当前状态。 */
    status(): SupervisorStatus;
    /**
     * pid 文件里记录的进程还活着就返回它（仅用于状态展示，**不做接管**）。
     * 接管要校验命令行与版本，属于 `tryAdopt` 的职责，不能在这里偷偷做。
     */
    private alivePidFromFile;
    /** SIGTERM，宽限期内不死就 SIGKILL。 */
    private killPid;
    /** 日志尾部若干行（用于把"为什么起不来"带到错误信息里）。 */
    private logTail;
    /** 日志太大就轮转一次（保留最后一份）。 */
    private rotateLogIfNeeded;
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
export declare function defaultBuildArgs(_binaryPath: string, configPath: string): string[];
/**
 * 把「别的通道已经在跑客户端」翻译成一句用户能照着做的中文。
 *
 * 这不是技术错误，是一处**需要用户决策**的冲突：同一个 tunnel_id 只能有一个
 * 客户端在连。要么用户自己停掉外部的（launchd/systemd），要么放弃插件托管。
 *
 * 托管方式无法从命令行字符串判断（launchd 起的进程命令行里根本没有 plist
 * 标签），所以这里查**实际存在的单元文件**，再给出对应命令。
 */
export declare function describeForeignConflict(conflict: {
    pid: number;
    command: string;
}): string;
