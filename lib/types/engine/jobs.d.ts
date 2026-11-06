/**
 * 后台作业：一个槽位 + 进度 + 取消。
 *
 * 为什么只允许一个作业：安装会**换掉正在跑的二进制并改写 current 指针**，
 * 启动/停止会动同一个子进程。这些操作互相之间必须串行，否则会出现"正在
 * 替换二进制时另一个作业把它启动了"这种没法排查的中间态。与其给每个操作
 * 各自加锁，不如让这一层**独占一个槽**，UI 也只需要轮询一个地方。
 *
 * 为什么完成的快照要留着：安装失败之后，用户需要看到**为什么失败**，而且
 * 这个原因必须活到用户开始下一次操作为止。所以 `current()` 一直返回上一个
 * 结果，直到新任务开始才被覆盖。
 */
/** 作业种类。 */
export type JobKind = 'install' | 'start' | 'stop' | 'restart' | 'configure' | 'enroll';
/**
 * 作业阶段。
 *
 * `done` / `failed` / `cancelled` 是终态 —— 宿主侧靠这三个值判断"作业是否
 * 还在跑"。
 */
export type JobPhase = 'queued' | 'resolving' | 'downloading' | 'verifying' | 'extracting' | 'installing' | 'starting' | 'confirming' | 'done' | 'failed' | 'cancelled';
/** 作业快照（宿主侧直接把它序列化给前端轮询）。 */
export interface JobSnapshot {
    id: string;
    kind: JobKind;
    label: string;
    phase: JobPhase;
    /** 0–100；无法量化时是 null。 */
    percent: number | null;
    bytesDone?: number;
    bytesTotal?: number;
    message?: string;
    error?: string;
    startedAt: number;
    finishedAt?: number;
    /** 是否被用户取消。 */
    cancelled?: boolean;
}
/** 作业上下文（交给作业体用）。 */
export interface JobContext {
    /** 取消信号。 */
    signal: AbortSignal;
    /** 切换阶段（可带一句说明和附加字段）。 */
    phase: (phase: JobPhase, message?: string | null, patch?: Partial<JobSnapshot>) => void;
    /** 只更新进度，不换阶段。 */
    progress: (patch: Partial<Pick<JobSnapshot, 'percent' | 'bytesDone' | 'bytesTotal' | 'message'>>) => void;
}
/** 作业体的返回值。 */
export interface JobRunResult {
    /** true = 什么也没做（例如"已经是这个版本了"）。 */
    noop?: boolean;
    /** 成功时替换掉快照里的说明。 */
    message?: string;
}
/** 作业是否已经结束。 */
export declare function isTerminalPhase(phase: JobPhase): boolean;
export declare class JobManager {
    private snapshot;
    private controller;
    private running;
    /** 当前有没有作业在跑。 */
    isBusy(): boolean;
    /**
     * 当前作业快照。
     *
     * 作业结束后**仍然返回它**（含失败原因），直到下一次作业开始。
     */
    current(): JobSnapshot | null;
    /**
     * 开始一个作业。
     *
     * 已有作业在跑时抛错：调用方应该把它翻译成 409（"另一个操作正在进行"），
     * 而不是悄悄排队 —— 两个安装作业排队的结果是用户看着界面不动。
     */
    start(kind: JobKind, label: string, run: (context: JobContext) => Promise<JobRunResult | void>): JobSnapshot;
    /** 请求取消。没有作业在跑时返回 false。 */
    cancel(): boolean;
}
