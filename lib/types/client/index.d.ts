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
 *
 * 视觉约定（v0.2）：
 *  - 颜色一律走 DSH 平台设计令牌（--dsw-alias-*），不再写死浅色兜底；
 *    早期版本用了不存在的令牌名（--dsw-alias-bg-primary 等），深色主题下全部退回
 *    白色兜底 + inherit 文字色 → 输入框白底白字、分隔线刺眼。
 *  - 布局面向「设置面板内容列可能很窄（移动端/窄窗）」设计：不使用横向表格，
 *    改为卡片 + 标签/值两列网格，长路径任意断行，控件按容器宽度自适应换行。
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
