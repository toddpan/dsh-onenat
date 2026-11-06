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
import { randomUUID } from 'node:crypto';
/** 作业是否已经结束。 */
export function isTerminalPhase(phase) {
    return phase === 'done' || phase === 'failed' || phase === 'cancelled';
}
export class JobManager {
    snapshot = null;
    controller = null;
    running = false;
    /** 当前有没有作业在跑。 */
    isBusy() {
        return this.running;
    }
    /**
     * 当前作业快照。
     *
     * 作业结束后**仍然返回它**（含失败原因），直到下一次作业开始。
     */
    current() {
        return this.snapshot;
    }
    /**
     * 开始一个作业。
     *
     * 已有作业在跑时抛错：调用方应该把它翻译成 409（"另一个操作正在进行"），
     * 而不是悄悄排队 —— 两个安装作业排队的结果是用户看着界面不动。
     */
    start(kind, label, run) {
        if (this.running)
            throw new Error('已有任务正在进行，请等待完成或先取消');
        const controller = new AbortController();
        this.controller = controller;
        this.running = true;
        const snapshot = {
            id: randomUUID(),
            kind,
            label,
            phase: 'queued',
            percent: null,
            startedAt: Date.now(),
        };
        this.snapshot = snapshot;
        const context = {
            signal: controller.signal,
            phase: (phase, message = null, patch = {}) => {
                snapshot.phase = phase;
                if (message !== null)
                    snapshot.message = message;
                Object.assign(snapshot, patch);
            },
            progress: (patch) => {
                Object.assign(snapshot, patch);
            },
        };
        void (async () => {
            try {
                const result = (await run(context)) ?? {};
                snapshot.phase = 'done';
                snapshot.percent = 100;
                if (result.message !== undefined)
                    snapshot.message = result.message;
                else if (result.noop === true && snapshot.message === null)
                    snapshot.message = '无需操作';
            }
            catch (error) {
                const aborted = controller.signal.aborted;
                snapshot.phase = aborted ? 'cancelled' : 'failed';
                snapshot.cancelled = aborted;
                snapshot.error = aborted ? '已取消' : (error instanceof Error ? error.message : String(error));
            }
            finally {
                snapshot.finishedAt = Date.now();
                this.running = false;
                this.controller = null;
            }
        })();
        return snapshot;
    }
    /** 请求取消。没有作业在跑时返回 false。 */
    cancel() {
        if (!this.running || this.controller === null)
            return false;
        this.controller.abort();
        return true;
    }
}
//# sourceMappingURL=jobs.js.map