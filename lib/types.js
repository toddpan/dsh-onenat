/**
 * @dsh-external/onenat-workbuddy-mention - 数据模型
 *
 * 与 0.1.x（onenat-workbuddy 控制台版）的差别：
 *  - 删除 Task / Plan / Turn / 编排引擎相关类型（不再自建聊天会话与 DAG 编排）
 *  - 新增 @ 提及（mention）类型：URI 编解码、候选行、解析结果
 *  - 新增 (DSH 会话, 子智能体) → 远端会话 的长持映射（替代原 (任务, 成员) 语义）
 *
 * 核心决策沿用 D1：子智能体/资源绑定一律引用 ONENAT 稳定 ID（mappingId/appId/appId），
 * 运行时经 ResourceDirectory 解析当下公网入口 —— 端口漂移免疫。
 */
// ---------- @ 提及（Mentions） ----------
/**
 * 提及 URI scheme：
 *   onenat-agent:<subAgentId>                  子智能体（本地定义 ID）
 *   onenat-resource:<mappingId|appId>          ONENAT 映射 / 应用资源
 *   onenat-resource:ssh:<sshResourceId>        本地 SSH 资源池条目
 */
export const MENTION_SCHEME_AGENT = 'onenat-agent:';
export const MENTION_SCHEME_RESOURCE = 'onenat-resource:';
export const SSH_RESOURCE_PREFIX = 'ssh:';
//# sourceMappingURL=types.js.map