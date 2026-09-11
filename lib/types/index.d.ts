/**
 * @dsh-external/onenat-workbuddy-mention
 *
 * OneNat WorkBuddy @ —— 让 DSH 原生对话直接使用 ONENAT 上的子智能体与资源：
 *   1. 子智能体管理：绑定 ONENAT 稳定 ID（mappingId/appId），端口漂移免疫，设置页可视化管理；
 *   2. 子智能调用：onenat_agent 工具把任务派发给远端 DSH 会话并长持复用；
 *   3. @ 指定：DSH 输入框敲 @ 选择子智能体 / 资源 → 原子胶囊 → 宿主在 agent/pre-step 注入上下文。
 *
 * 本插件不提供第二套聊天界面：对话、工具卡、思维链、统计全部复用 DSH 原生能力。
 */
import type { Context } from 'cordis';
import z from 'schemastery';
import type { PluginConfig } from './types.js';
export declare const name = "@dsh-external/onenat-workbuddy-mention";
export declare const inject: string[];
export interface Config extends PluginConfig {
}
export declare const Config: z<Config>;
/** Client 侧经包私有 RPC 调用的方法名（设置页 UI 与 @ 菜单共用） */
export declare const CLIENT_RPC: {
    readonly candidates: "onenat.candidates";
    readonly parse: "onenat.parse";
    readonly settingsGet: "onenat.settings.get";
    readonly settingsSave: "onenat.settings.save";
    readonly agentsList: "onenat.agents.list";
    readonly agentsSave: "onenat.agents.save";
    readonly agentsDelete: "onenat.agents.delete";
    readonly agentsPing: "onenat.agents.ping";
    readonly agentsPreview: "onenat.agents.preview";
    readonly agentsModels: "onenat.agents.models";
    readonly agentsPresets: "onenat.agents.presets";
    readonly resources: "onenat.resources";
    readonly resolve: "onenat.resolve";
    readonly sshList: "onenat.ssh.list";
    readonly sshSave: "onenat.ssh.save";
    readonly sshDelete: "onenat.ssh.delete";
    readonly sshTest: "onenat.ssh.test";
};
export declare function apply(ctx: Context, config: Config): void;
