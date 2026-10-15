# ONENAT WorkBuddy 原生集成（@ 提及版）实现方案

> 目标插件（暂定名）：`@dsh-external/onenat-workbuddy` v0.2（重构版）
> 目录：`/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy`（原地重构）
> 替代对象：现有 WorkBuddy 独立控制台（iframe 面板 + 自建聊天窗口 + 自建 REST 引擎）

---

## 一、我对现有 onenat-workbuddy 的理解

### 1.1 它现在是什么

一句话：**把 ONENAT 上的隧道/应用资源，变成"可被 AI 使用的资源清单"，并把多个远程 DSH 实例变成"可被派活的子智能体"，再用一个自建控制台把这条链路跑起来。**

```
浏览器：DSH Web GUI 侧栏「WorkBuddy」入口 → 中央列 iframe 嵌入 /onenat-workbuddy 自建控制台
                                        （自建聊天窗口、自建 SSE、自建会话列表）
主控 DSH：onenat-workbuddy 插件
   ├─ OnenatDirectory    ← GET /api/v1/resources（唯一实时资源源；稳定 ID → 当前公网端口）
   ├─ WorkStore          ← agents / tasks / settings 落 ~/.dsh/onenat-workbuddy/store.json
   ├─ SshResourceStore   ← 本地直连 SSH 资源池（补充 ONENAT 之外的机器）
   ├─ AgentResolver      ← 每次派发前强刷 ONENAT，mappingId/appId → 当下 baseUrl（端口漂移免疫）
   ├─ PromptComposer     ← 「资源即提示词」：入口 + 凭证策略 + 技能手势 → 提示词块
   ├─ RemoteClient       ← 调远端 dsh-web-service：建会话 / prompt-stream(SSE) / history / files
   ├─ Planner + Engine   ← LLM 拆解 → DAG 派发 → 汇总（chat 直通 / orchestrate 编排）
   └─ Router + WebUI     ← 自建 REST + 自建前端（3719 行 web-ui.ts）
```

### 1.2 已经沉淀下来的关键能力（必须保留）

| 能力 | 实现位置 | 价值 |
|---|---|---|
| 端口漂移免疫 | `onenat.ts` + `resolver.ts`（D1） | 子智能体只存 `mappingId/appId`，每次派发前实时解析入口；ONENAT 客户端重连换端口不影响 |
| 资源即提示词 | `prompt-composer.ts`（D2） | SSH/HTTP/DSH 资源 → `[可用资源清单]` 块；凭证策略 `inline/self-fetch/omit`；技能「查询已装 → 版本比对 → 落盘安装 → `/名` 加载」自助指引 |
| 远端会话长持 | `engine.ts`（D3） | `(任务, 成员) → remoteSessionId` 持久复用，多轮续聊 |
| 远端会话驱动 | `remote-client.ts` | `POST /sessions` `POST /sessions/:id/prompt-stream`(SSE) `/history` `/cancel` `/files` `/questions` `/answers` |
| 本地 SSH 资源池 | `ssh-store.ts` + `ssh-resources.ts` | 密码/私钥、真实连通测试、`exec` 远程执行 |
| @ 语义雏形 | `engine.ts#extractMentions` + `router.ts /api/mentions/candidates` | 已经有一套「候选目录 + 文本 @ 解析（最长前缀匹配）」——**但只在 WorkBuddy 自己的聊天框里生效** |

### 1.3 现在的痛点（也是本次重构的动因）

1. **入口割裂**：资源和子智能体在 workbuddy 自己的 iframe 聊天框里才可用；在 DSH 原生对话里，主智能体完全看不见 ONENAT 的资源面。
2. **重复造轮子**：自建聊天窗口、自建 SSE 网关、自建会话列表、自建统计条 —— 这些 DSH Web GUI 原生就有，且更好（工具调用卡、思维链折叠、附件、终止、token 统计）。
3. **@ 用不起来**：`@` 只在自建输入框里是"字符串匹配"，不参与 DSH 的输入法、不产生结构化引用、模型侧拿不到结构化身份。

### 1.4 环境事实（已核实）

- DSH 原生输入框已有一套成熟的 **输入触发管线**（`@deepseek-ai/dsh-client-ui-input-trigger`）：
  `ctx.inputTriggers.registerSource({ trigger: '@', name, candidates, onPick, codec, lexicon, warm })`
  现有占用者：`ui-reference`（`@文件`/`@会话` 合并源，name = `reference`）、`ui-cordis`（`@pluginId`，name = `cordis`）。
  已核实 **ui-cordis 用同一 API 在运行时注册 `@` 源**——即"能否再加一个 `@` 源"已被实证，不是推测。
- `onPick` 返回 `{ insert: ReferenceInsert }` 时插入**原子引用胶囊**；提交时由 `codec.serialize(ref)` 生成模型可见文本（异步，失败则阻断发送）。
- Host 侧有 `agent/pre-step` **waterfall**（可 `enter` 并**替换进入本步的用户消息列表**）；`@deepseek-ai/dsh-session-reference` 正是用它在 `@会话` 提及后追加"引用快照"用户消息 —— 这是官方既有范式。
- Host 侧有 `ctx.tools.register()`（注册模型工具）、`ctx.subagents`（原生委派服务，当前已挂 `subagent` / `subagent_fork` / `send_message` / `list_agents`）。
- 客户端槽位 `settings.section` 可注册**整页设置界面**（root scope，list 型，零替换风险）——管理 UI 的正规归宿。

---

## 二、我的理解（你要的"1 子智能体管理 / 2 子智能调用 / 3 @ 指定"）

你要的东西翻译成工程语言只有三件事：

| # | 你的表述 | 工程含义 |
|---|---|---|
| 1 | **子智能体管理** | 维护 `ONENAT 稳定 ID → 别名/角色/模型/工作目录/绑定资源` 的映射表，并能在 GUI 里增删改查、连通性探测、提示词预览 |
| 2 | **子智能调用** | 在**当前 DSH 会话**里，把任务委派给远端 DSH 执行，并（可选）把 SSH/HTTP 资源的连接信息交给执行者 |
| 3 | **@ 指定** | 在 **DSH 原生文本输入框**里敲 `@`，弹出「ONENAT 子智能体 + ONENAT/本地资源」候选，选中 → 插入胶囊 → 发送 → 宿主接管语义 |

**关键判断（也是与旧版最大的区别）：**

- 不再需要"第二个 DSH Web 插件"：不自建聊天窗口、不自建 SSE、不自建会话列表。
- `@` 不是"让模型去猜字符串"，而是**结构化引用**：胶囊携带 `source + ref`，宿主在提交时把它序列化成标准 mention 文本，在 `agent/pre-step` 再解析回结构化身份。
- **"资源" 与 "子智能体" 两类 `@` 的语义不同，必须分开设计**（这是旧版混在一起、也最容易做歪的地方）：

| 提及类型 | 语义 | 落地方式 |
|---|---|---|
| `@子智能体` | 「这件事交给它做」 | 注入指认指令 + 模型调用 `onenat_agent` 工具真正派发；返回结果并**锚定远端既有会话**（多轮续聊） |
| `@资源` | 「这次可以用这个资源」 | 注入 `[可用资源清单]` 块（入口 + 凭证策略 + 技能指引），模型自己用 bash/ssh 或交给子智能体 |

---

## 三、目标形态

```
DSH Web GUI 原生输入框
  输入 @  ──► 【新增输入触发源 name='onenat'】
              候选：① ONENAT 子智能体（DSH 实体） ② ONENAT 映射/应用资源 ③ 本地 SSH 资源池
              选中 → 插入原子胶囊（label = 别名，来源标记 = ONENAT/本地）
  发送 ──► codec.serialize → "@[别名](onenat-agent:<id>)" / "@[别名](onenat-resource:<mappingId|ssh:id>)"

Host: agent/pre-step（waterfall）
  解析消息里的 onenat-* mention
   ├─ 子智能体 → 追加「指认指令」用户消息（走 onenat_agent 工具，含模型/工作目录/角色）
   └─ 资源     → 追加「[可用资源清单]」用户消息（实时解析入口 + 凭证策略 + 技能指引）

模型 ──► onenat_agent 工具 ──► AgentResolver 实时解析入口（端口漂移免疫）
                               ──► RemoteClient 建/续远端会话 → prompt-stream(SSE)
                               ──► 工具卡片内实时进度 + 最终结果
```

**没有第二个聊天窗口；一切发生在 DSH 原生对话里。**

---

## 四、实现方案

### 4.1 模块清单（保留 / 重构 / 删除）

| 文件 | 处置 | 说明 |
|---|---|---|
| `src/onenat.ts` | ✅ 保留 | 资源目录与解析（已经是干净的纯逻辑） |
| `src/resolver.ts` | ✅ 保留 | 端口漂移免疫解析 + ping |
| `src/prompt-composer.ts` | ✅ 保留（轻改） | 产出资源块；新增"单资源块"入口供 pre-step 用 |
| `src/remote-client.ts` | ✅ 保留 | 远端 DSH REST/SSE 客户端 |
| `src/store.ts` | ✅ 保留（瘦身） | agents / settings（tasks 相关字段与逻辑删除；新增会话映射表 `sessions`） |
| `src/ssh-store.ts` / `ssh-resources.ts` | ✅ 保留 | 本地 SSH 资源池 |
| `src/types.ts` | ♻️ 重构 | 去掉 Task/Plan/Turn 等编排期类型；新增 Mention 直译类型 |
| `src/engine.ts` `src/planner.ts` | ❌ 删除 | 自建编排引擎与规划器（原生 `subagent`/`workflow` 已覆盖，且用户目标是"按需 @ 指定"而非"批量编排"） |
| `src/web-ui.ts` | ❌ 删除 | 3719 行自建前端 |
| `src/router.ts` | ♻️ 大幅瘦身 | 只留管理 API（供设置页 UI 调用）；删除任务/SSE/计划相关路由 |
| `src/client/index.ts` | ♻️ 重写 | 不再挂侧栏入口 + iframe 面板；改为 ① `@` 源 ② 设置页 |
| `src/tools.ts` | ♻️ 重写 | 3 个工具（下述） |
| `src/mentions.ts` | 🆕 新增 | mention 编解码（`onenat-agent:` / `onenat-resource:` URI）+ 文本解析 |
| `src/prestep.ts` | 🆕 新增 | `agent/pre-step` 监听：解析 + 注入 |
| `src/agent-runner.ts` | 🆕 新增 | 单次委派执行（解析入口 → 建/续会话 → SSE 流式 → 结果），供 `onenat_agent` 工具调用 |

### 4.2 功能一：子智能体管理

**数据模型**（沿用旧版 `SubAgent`，去掉任务相关字段）：

```ts
interface SubAgent {
  id: string                       // 本地稳定 ID（用于 mention URI）
  name: string                     // @ 菜单显示名（唯一化）
  dshRef: { kind: 'mapping', mappingId } | { kind: 'app', appId } | { kind: 'direct', apiBaseUrl }
  apiKey?: string
  agentPreset?: string             // 远端 preset，如 cordis
  permission?: string              // danger-full-access / workspace-write / read-only
  provider?: string; model?: string; reasoningEffort?: string
  systemPrompt?: string            // 角色提示词（派发时置于任务前）
  workDir?: string                 // 远端工作目录（附件落盘处 / 文件工具根）
  resources: AgentResourceBinding[]// 默认绑定资源（@资源 为其增量）
  skills?: string[]                // 远端已装技能 → 派发时写 /名 手势
  description?: string; tags?: string[]; enabled: boolean
}
```

**管理入口（正规槽位，不是第二个控制台）**：客户端 `slots.register({ name: 'settings.section', id: 'onenat-workbuddy' })`
→ 设置页内一页 `ONENAT WorkBuddy`：资源目录（在线状态/当前入口）· 子智能体 CRUD（含连通探测、模型/preset 拉取、**资源绑定的提示词预览**）· 本地 SSH 资源池 · ONENAT 连接设置。

**模型工具** `onenat_manage`：与设置页共享同一存储与同一 API ——
`action: list|upsert|delete|ping|preview|resources|resolve|ssh-list|ssh-upsert|ssh-test|ssh-exec`。

### 4.3 功能二：子智能调用

**新增工具 `onenat_agent`**（模型面）：

```
onenat_agent({
  agent: string,            // @ 菜单里的名字 或 子智能体 ID
  task: string,             // 完整、自包含的任务描述
  agent_session?: string,   // 远端会话 ID：续聊（默认复用上次会话 → 多轮）
  new_session?: boolean,    // 强制开新会话
  resources?: string[],     // 本轮额外指定资源（名字/ID）
  timeout_ms?: number
})
→ { ok, agent, entry, sessionId, sessionReused, output, reasoning?, tools[], usage?, error? }
```

执行链（`agent-runner.ts`）：

```
1. resolveAgent(agent)             ← 别名/ID → SubAgent 定义
2. AgentResolver.resolve(agent)    ← 强刷 ONENAT → 当下 baseUrl（D1 端口漂移免疫）
3. store.getSession(agentKey)      ← (会话, 子智能体) → remoteSessionId（D3 会话长持）
   无则 RemoteClient.createSession({ preset, model, permission, cwd: workDir })
4. PromptComposer.compose(...)     ← 角色提示词 + [可用资源清单] + 技能指引 + 任务
5. RemoteClient.promptStream(...)  ← SSE：delta / reasoning / tool_call / tool_result / turn_end
6. 结果回填：output + 工具调用摘要 + usage + 远端会话 ID（可在工具卡展开查看）
```

失败兜底：SSE 不可用（旧远端）→ 同步 `POST /prompt` + 轮询 history；远端离线 → 结构化错误（含 ONENAT 解析结果，便于审计）。

> 是否再做一层「实现 `ctx.subagents` 的 Provider，让远端 DSH 出现在原生 `subagent` 工具的 provider 列表里」——见 §6 选项 B，本方案**默认不做**，理由是收益/风险比不划算（原生 provider 面向同进程 Agent，`localAgent` 语义、continuable 生命周期都难对齐），但接口上会预留。

### 4.4 功能三：@ 指定（核心）

#### (a) 客户端 `@` 源（`name: 'onenat'`, `trigger: '@'`, `order: 2`）

```ts
const source = {
  trigger: '@', name: 'onenat', order: 2, showGroupTitle: true,
  async candidates(session, { query, signal }) {
    const rows = await host.call('onenat.candidates', { query })   // 本地缓存 + Host 实时数据
    return rows.map(r => ({
      name: r.name,
      description: r.description,        // "子智能体 · 在线 · deepseek-chat" / "SSH · root@host:port · 在线"
      section: r.type === 'agent' ? 'ONENAT 子智能体' : 'ONENAT / 本地资源',
    }))
  },
  warm: () => host.call('onenat.candidates', { query: '' }).catch(() => {}),
  async onPick({ candidate }) {
    const row = rowOf(candidate)                       // 客户端持有的 row 快照
    return { insert: {
      source: 'onenat',                                // 自有 codec，见下
      ref: row.uri,                                    // onenat-agent:<id> / onenat-resource:<mappingId|ssh:id>
      label: row.name,
      clipboardText: `@[${row.name}](${row.uri})`,
    } }
  },
  codec: {
    clipboardText: ref => `@[${labelOf(ref)}](${ref})`,
    serialize: ref => Promise.resolve(`@[${labelOf(ref)}](${ref})`),
  },
}
```

> 注：胶囊的 `source` 用**本插件自有名 `onenat`**（并与触发源 name 一致），这样 `serialize` 由本插件 codec 负责，不和 `ui-reference` 的 `reference` 源耦合。

#### (b) 模型可见文本（提交时由 codec 生成）

```
@[kb-136-builder](onenat-agent:ag_7f3a)
@[测试 B 环境 SSH](onenat-resource:map_<id>)
@[内网跳板机](onenat-resource:ssh_local_2b)
```
- 人看：DSH 消息渲染成 `@kb-136-builder` 可读胶囊；
- 模型看：同时拿到**结构化 URI**（身份不靠猜名字）；
- 兼容：`@名字` 纯文本（无 URI）也识别 —— 回落旧版「最长前缀匹配」逻辑，只是匹配不到就不生效并给出提示。

#### (c) Host `agent/pre-step` 注入（`prestep.ts`）

```
1. 扫描本步 user 消息 → 提取 { agents[], resources[] }
2. 子智能体 → 追加一条 plugin 来源的用户消息：
     「用户在本次消息中指定了子智能体 <名字>（ID/模型/工作目录/角色）。
       请用 onenat_agent 工具把相应工作委派给它；除非需要多次往返，否则一次调用完成。」
3. 资源 → 追加另一条 plugin 来源的用户消息，正文 = PromptComposer 产出的
     [可用资源清单]（入口为 pre-step 时刻实时解析结果 + 凭证策略 + 技能安装/加载指引）
4. 未提及任何 onenat 实体 → 不注入任何 token（零开销）
5. ONENAT 离线 / 资源不存在 → 不阻断发送，改为注入一行告警让模型据此说明
```
**Token/KV 影响**：仅在命中 `@` 时追加消息，且追加在队尾，不影响历史缓存前缀。

### 4.5 UI 卡片与可观测性

- `onenat_agent` 用默认工具卡（`tool.call.toolview` key = 工具名即为默认渲染，无需自定义）；参数走 `render` 摘要（agent + task 头 80 字），结果含远端会话 ID、耗时、工具调用次数。
- 可选（第二批）：为 `onenat_agent` 注册自定义 `tool.call.toolview` 卡片，展示"远端会话 / 流式进度 / 折叠思维链"。
- 客户端不再有任何 iframe / 侧栏劫持 / 面板互斥逻辑。

### 4.6 兼容与迁移

- **数据兼容**：沿用 `~/.dsh/onenat-workbuddy/store.json`（agents / settings 原样可读；tasks 段保留但不加载，首次启动备份为 `store.v1.bak.json`）。
- **与旧版共存**：若旧版仍注入在运行，两者都注册 `@` 源会各占一组（name 不同不冲突）；建议验完新版后 `dev_uninject_plugin onenat-workbuddy` 卸旧版、再注入新版。
- **构建/注入路径不变**：`bash scripts/build.sh` → `npm run build:client`(tsdown) → `dev_build_plugin` → `dev_inject_plugin`。

### 4.7 交付物与验收

| 交付物 | 验收标准 |
|---|---|
| 插件包（host + client 两半） | `dev_build_plugin` 出 tgz，`dev_inject_plugin` 后无报错 |
| `@` 菜单 | DSH 原生输入框敲 `@` 出现「ONENAT 子智能体 / ONENAT·本地资源」两组候选；输入关键字可过滤；中英文名均可命中 |
| 胶囊与序列化 | 选中插入胶囊；发送后消息渲染为 `@别名`；模型消息体含 `(onenat-agent:…)` |
| 子智能调用 | `@子智能体 + 任务` 发送 → 工具卡出现 → 返回远端结果；**同一子智能体第二次对话复用远端会话**（远端 history 可见上文） |
| 资源注入 | `@资源` 发送 → pre-step 注入实测入口（含端口）；ONENAT 侧换端口后再发，注入端口随之改变（端口漂移免疫回归） |
| 管理 UI | 设置页可增删改查子智能体、探测连通、预览提示词、管理本地 SSH 资源 |
| 零侵入 | 卸载插件后 DSH 原生输入框无残留（`@` 源、设置页、工具全部消失）；ONENAT 服务端与 dsh-web-service 均未改动 |

---

## 五、代码规模预估

| 部分 | 新增/改写 | 复用 |
|---|---|---|
| Host 核心 | `mentions.ts` ~180 / `prestep.ts` ~150 / `agent-runner.ts` ~260 / `tools.ts` ~320 | onenat/resolver/composer/remote-client/ssh-* 基本原样 |
| 客户端 | `@` 源 ~220 / 设置页 UI(管理) ~500 / codec ~60 | 无 |
| Router | 瘦身至 ~400（管理 API） | 复用现有 handler 风格 |
| 删除 | `web-ui.ts` 3719 / `engine.ts` 1253 / `planner.ts` 355 | — |

净效果：**代码量下降约 45%**，能力面扩大（原生输入法集成 + 原生工具卡 + 原生设置页）。

---

## 六、需要你确认的选项

| # | 选项 | 建议 |
|---|---|---|
| A | **子智能调用实现层**：① 自建 `onenat_agent` 工具（本方案默认）② 进一步实现 `ctx.subagents` Provider，让远端 DSH 变成原生 `subagent` 工具的一个 provider ③ 只做提示词注入（模型自己用 bash/HTTP 调远端） | **①**：语义清晰、可控、可观测；②作为后续增强；③太脆弱 |
| B | **`@资源` 的凭证注入**：`inline`（直接把密码写进 pre-step 消息，模型可见、也进入会话历史）/ `self-fetch`（只给凭据接口让 AI 自取）/ `omit` | **按资源逐个配置，默认 SSH 用 `inline`、HTTP 用 `self-fetch`**（与旧版一致；注意 inline 会落进会话历史） |
| C | **是否保留旧版 WorkBuddy 控制台**：① 完全替换（删除 web-ui/engine/planner，本方案默认）② 新版与旧控制台共存（双轨） | **①**：你要的就是"不再单独写一个 DSH WEB 插件式的功能" |
| D | **管理 UI 落点**：① 设置页 `settings.section`（整页，root 槽位，零替换风险）② 输入区小面板 ③ 保留独立控制台 | **①** |
| E | **插件名与目录**：原地重构 `/Users/tsbj/feyanggit/DHS-test/onenat-workbuddy`（包名沿用 `@dsh-external/onenat-workbuddy`，版本升 0.2.0） | **是**（git 历史保留，删除的模块可回溯） |

---

## 七、执行顺序（你确认后开始）

1. `editing-cordis-compositions` / `cordis-plugin-development` 技能装载 + 关键接口二次核实（`agent/pre-step` 在插件上下文的可用性、`AgentResolver` 强刷时机、`codec.serialize` 异步失败路径）。
2. Host：`mentions.ts` → `prestep.ts` → `agent-runner.ts` → `tools.ts` → `router.ts` 瘦身；删除 engine/planner/web-ui。
3. Client：`@` 源（含 codec）→ 设置页管理 UI。
4. 构建 + 注入 + 端到端验收（按 §4.7 表逐条过）：`@` 菜单 → 胶囊 → 序列化 → pre-step 注入 → `onenat_agent` 派发 → 远端会话长持 → 端口漂移回归。
5. 出一份 `README` 更新（新架构、@ 用法、API 变更、从 0.1.x 迁移说明）。
```
