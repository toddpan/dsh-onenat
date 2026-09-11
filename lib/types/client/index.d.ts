/**
 * @dsh-external/onenat-workbuddy-mention — DSH Web GUI 集成
 *
 * 只有两件事，都在 DSH 原生界面里：
 *   1. `@` 输入触发源（ctx.inputTriggers）：候选 = ONENAT 子智能体 + ONENAT 资源 + 本地 SSH 资源；
 *      选中插入原子胶囊，提交时由本插件的 codec 序列化为 `@[名称](onenat-agent:…)`，
 *      宿主在 agent/pre-step 解析回结构化身份。
 *   2. 设置页 management UI（settings.section）：子智能体 / 资源目录 / 本地 SSH 资源池 的可视化管理。
 *
 * 不注册侧栏入口、不劫持中央列、不内嵌 iframe —— 对话与工具卡全部复用 DSH 原生能力。
 */
export declare const inject: string[];
type ClientCtx = {
    slots: {
        inject(slot: string, factory: () => (() => void) | void): () => void;
        register(config: Record<string, unknown>, component: unknown): () => void;
    };
    effect(fn: () => () => void, name: string): () => void;
};
export declare function apply(ctx: ClientCtx): void;
export {};
