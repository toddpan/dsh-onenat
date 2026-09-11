/**
 * @dsh-external/onenat-workbuddy - 资源提示词合成引擎（D2 资源即提示词）
 *
 * 派发子任务时合成结构化提示词块，注入子智能体上下文。技能装载语义（方案 B：
 * 信任远端 DSH 原生技能体系，workbuddy 不搬运正文）：
 *  - 子智能体绑定的技能：均为目标节点已安装技能 → 提示词写入空白符边界的
 *    /name 手势，由远端宿主 tool-skill pre-step 原生加载技能正文（与 DSH web
 *    用户手输 /技能名 同一路径），不内联全文；
 *  - 资源（ONENAT SSH / DSH / HTTP 应用）侧分发的技能：远端未预装 → 提示词
 *    给出自助指引：先查本地 ~/.dsh/skills/<名>/SKILL.md，已装则比对资源侧版本
 *    （大小/内容）覆盖升级，未装则下载落盘安装（远端智能体自身的文件/bash 工具，
 *    技能目录 watcher 自动生效），最后用 /<名> 手势加载使用；已装且一致不重复安装。
 * 输出协议见设计文档 §6.2。
 */
import type { OnenatDirectory } from './onenat.js';
import type { AgentResourceBinding, SubAgent } from './types.js';
export interface ComposeContext {
    /** 派发时刻的时间戳标记（写进提示词，提醒 AI 端口是实况） */
    resolvedAt: number;
    /** 脱敏预览模式（UI 提示词预览用：凭证打码；技能段无敏感信息，保持全量展示） */
    mask?: boolean;
    /** 用户本轮通过 @ 动态提及注入的临时资源列表 */
    extraResources?: AgentResourceBinding[];
}
export interface ComposeResult {
    block: string;
    resources: Array<{
        alias: string;
        kind: string;
        online: boolean;
        error?: string;
    }>;
    warnings: string[];
}
export declare class PromptComposer {
    private directory;
    constructor(directory: OnenatDirectory);
    /** 资源引用的稳定去重键 */
    private static refKey;
    compose(agent: SubAgent, ctx: ComposeContext): Promise<ComposeResult>;
}
