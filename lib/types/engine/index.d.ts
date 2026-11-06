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
import { type JobSnapshot } from './jobs.js';
export type { JobContext, JobKind, JobPhase, JobRunResult, JobSnapshot } from './jobs.js';
export { JobManager, isTerminalPhase } from './jobs.js';
/** 引擎状态（宿主侧直接序列化给前端）。 */
export interface EngineStatus {
    /** 是否已安装（current 指针存在且二进制在位）。 */
    installed: boolean;
    /** client.yml 是否就绪。 */
    configured: boolean;
    /** 当前版本。 */
    version?: string;
    /** 子进程是否存活。 */
    running: boolean;
    pid?: number;
    uptimeMs?: number;
    lastError?: string;
    /** 当前版本的二进制文件名。 */
    assetFile?: string;
    /** 发行版来源。 */
    source?: 'github' | 'baked';
    /** 从 client.yml 解析出的隧道 ID（宿主侧据此判在线）。 */
    tunnelId?: string;
    /** 服务端侧隧道是否在线（宿主侧注入；拿不到就是 undefined）。 */
    tunnelOnline?: boolean;
    /**
     * 本机上有**别的安装通道**起来的 oneNat 客户端进程（如一键安装脚本 + launchd）。
     * 有值时插件不会重复启动 —— 同一个 tunnel_id 只能有一个客户端在连。
     */
    foreignClientPid?: number;
}
/** 宿主侧注入的依赖。 */
export interface EngineServiceDeps {
    /** 引擎日志出口。**不要在这里打印密钥。** */
    log: (message: string) => void;
    /** 宿主侧判定隧道在 oneNat 服务端是否在线；拿不到返回 undefined。 */
    isTunnelOnline?: (tunnelId: string | undefined) => boolean | undefined;
    /** GitHub Release 仓库（owner/repo），默认 `toddpan/onenat`。 */
    repo?: string;
    /** 引擎根目录（默认 `~/.dsh/dsh-onenat/engine`，可用 `DSH_ONENAT_HOME` 覆盖）。 */
    root?: string;
}
/** `configure` 的入参。 */
export interface ConfigureOptions {
    /** oneNat 服务端地址（http/https 绝对地址）。 */
    baseUrl: string;
    /** 隧道 ID。 */
    tunnelId: string;
    /** 隧道 KEY（**绝不回传、不进日志**）。 */
    key: string;
}
export declare class EngineService {
    private readonly deps;
    private readonly root;
    private readonly repo;
    private readonly jobs;
    private readonly supervisor;
    private readonly platform;
    private readonly binaryName;
    constructor(deps: EngineServiceDeps);
    /** 引擎根目录（宿主侧想展示路径时用）。 */
    get engineDir(): string;
    /**
     * 汇总状态。
     *
     * **不触网**：读配置、读 pid、判进程存活，加上宿主侧注入的隧道在线判定。
     * 设置页会频繁轮询它，触网会把 oneNat 服务端的限速额度烧光。
     */
    status(): Promise<EngineStatus>;
    /**
     * 安装 / 升级。
     *
     * **同步返回作业快照，作业在后台跑** —— 宿主 API 直接把它回给前端轮询。
     * 已有作业在跑时抛错（宿主侧应翻译成 409）。
     */
    install(opts?: {
        version?: string;
        force?: boolean;
    }): JobSnapshot;
    /** 启动客户端。 */
    start(): Promise<{
        started: boolean;
        pid?: number;
        error?: string;
    }>;
    /** 停止客户端。 */
    stop(): Promise<{
        stopped: boolean;
        error?: string;
    }>;
    /** 重启客户端。 */
    restart(): Promise<{
        restarted: boolean;
        pid?: number;
        error?: string;
    }>;
    /**
     * 拉取 oneNat 托管配置并落盘（0600）。
     *
     * 走服务端 `GET {baseUrl}/api/deploy?id=<tunnelId>&key=<key>`（公开端点，
     * 限速 30 次/分/IP）。返回只带掩码，**绝不回传明文 KEY**。
     *
     * 注意这里用的是普通的 `fetch` 而不是引擎里的 `fetchText`：后者强制 https，
     * 而 oneNat 服务端可能部署在 http 的内网地址上。
     */
    configure(opts: ConfigureOptions): Promise<{
        ok: boolean;
        masked?: string;
        error?: string;
    }>;
    /** 读客户端日志尾部。 */
    logs(opts?: {
        limit?: number;
    }): Promise<{
        lines: string[];
    }>;
    /**
     * 当前作业快照。
     *
     * 作业结束后**仍然返回它**（含失败原因），直到下一次作业开始才被覆盖 ——
     * 安装失败之后用户需要看到"为什么失败"。
     * 从未跑过作业时返回 null。
     */
    currentJob(): JobSnapshot | null;
    /** 取消当前作业；没有作业在跑时返回 false。 */
    cancelJob(): boolean;
    /**
     * 宿主卸载时调用。
     *
     * **不要杀子进程**：DSH 退出 ≠ 客户端停机。下次启动时靠 pid 文件接管即可。
     */
    dispose(): void;
}
