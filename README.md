# oneNat@ (`@dsh-onenat`)

> **在 DSH 原生输入框里用 `@` 指定 ONENAT 上的子智能体与资源。**
> 子智能体管理 · 子智能调用 · 资源提示词注入 —— 全部发生在 DSH 原生对话里，没有第二套聊天界面。

设计文档：`docs/design.md`（本方案文档；另有一份在 `../docs/dsh-onenat-design.md`）

---

## 一句话

```
DSH 输入框 ──@──► ① ONENAT 子智能体   选谁干活
                   ② ONENAT 资源      能用什么
                   ③ 本地 SSH 资源池
        │
        ├─ 提交：胶囊序列化为 @[名称](onenat-agent:<id>) / @[名称](onenat-resource:<id>)
        │
   Host ├─ agent/pre-step：解析提及 → 追加两条 plugin 上下文消息
        │     · 「子智能体指认」→ 要求模型用 onenat_agent 派发
        │     · 「可用资源清单」→ 实时入口 + 凭证策略 + 技能安装/加载指引
        │
        └─ onenat_agent 工具：实时解析 ONENAT 入口（端口漂移免疫）
             → 远端 dsh-web-service 建/续会话 → SSE 流式 → 结构化结果
```

## 与 0.1.x（dsh-onenat 控制台版）的区别

| 维度 | 0.1.x oneNat | 本插件（0.1.0） |
|---|---|---|
| 界面 | 自建控制台（iframe + 3719 行前端 + 自建 SSE 聊天窗） | **无自建界面**：DSH 原生输入框 + 原生工具卡 + 设置页 |
| `@` 用法 | 只在自己聊天框里做字符串匹配 | **DSH 原生输入法级 `@`**：原子胶囊 + 结构化 URI + 宿主 pre-step 注入 |
| 调用方式 | 自建 TaskEngine + Planner + DAG 编排 | **onenat_agent 工具**（前台/后台作业），编排交给模型自己的工具循环 |
| 会话语义 | (任务, 成员) → 远端会话 | **(DSH 会话, 子智能体) → 远端会话**，多轮续聊 |
| 管理入口 | 侧栏入口 + 中央列面板 | **设置 → oneNat@**（`settings.section`，零替换风险） |
| 保留能力 | — | ONENAT 目录/解析、PromptComposer、远端 REST/SSE 客户端、SSH 资源池 全部复用 |

---

## 三个功能

### ① 子智能体管理

设置页「oneNat@」→ 子智能体卡片：

- 从下拉里选 **ONENAT 映射 / 应用**（只存稳定 ID → 端口漂移免疫）或直连 URL（兜底）；
- **模式（agentPreset）/ Provider / 模型来自该远端 DSH 的实时清单**：填好绑定后编辑器自动
  拉取 `/presets`、`/models`（保存之前也能拉，Host 用表单里的 `dshRef` 现场解析），
  拉不到时自动退化为手工输入；
- **工作目录可以「浏览远端…」**：弹出的目录窗口直接读远端 `dsh-web-service` 的 `/fs/list`，
  支持主目录、上级、绝对路径跳转、显示隐藏目录、新建文件夹，选中即回填；
- 「拉取远端技能清单」把远端已装技能渲染成可点选 chips，点选即写入 `/名` 手势清单；
- 运行权限（read-only / workspace-write / danger-full-access / 自定义）/ 角色提示词 / 说明；
- 一键 **探测**（实时解析入口 + ping 远端 dsh-web-service）、**提示词预览**（脱敏）。

设置页配色与布局统一走 DSH 平台设计令牌（`--dsw-alias-*`），浅/深主题一致；列表用卡片 +
标签/值网格（不用横向表格），窄窗与移动端不再把长 URL / 路径挤成竖排。

数据落盘 `~/.dsh/dsh-onenat/store.json`；首次启动会**自动从旧版 `~/.dsh/dsh-onenat/store.json` 迁移** agents/settings。

**自然语言添加**：不必打开设置页，直接在聊天框说「帮我添加一个绑定 KB 136 环境-DSH、角色是质检员的子智能体」，模型会走 `onenat_manage` 的标准流程：`resources`/`candidates` 找 mappingId → `probe` 现场拉远端 models/presets（不落库）→ `upsert` 保存（dshRef 直接填 mappingId，自动归一化；同名同实体复用更新）→ `ping` 验证 → 回报 @名称。

模型侧同一套能力：`onenat_manage`（list / upsert / delete / ping / preview / models / presets / sessions / session-clear / settings-get / settings-set）。

### ② 子智能调用

模型看到用户 `@某人` 后调用：

```
onenat_agent({
  agent: "brain-质检员",          // @ 菜单里的名字 或 ID
  task:  "完整、自包含的任务描述",  // 远端子智能体看不到本会话上下文
  resources: ["4aacbeec", "ssh:ssh-y7in6o75"],  // 可选：本轮额外指定的资源
  new_session: false,             // 默认复用远端会话（多轮续聊）
  session_scope: "<本地会话 ID>",  // 默认当前会话
  run_in_background: false        // true = 返回作业 ID（job_output / job_kill）
})
```

返回：远端结论 + 思维链 + 工具调用摘要 + token 用量 + **远端会话 ID**（可直接继续追问）。

执行链：`AgentResolver` 强刷 ONENAT 解析当下入口 → 复用/新建远端会话 → `PromptComposer` 组装（角色 + 资源清单 + 技能指引 + 任务）→ `prompt-stream` SSE（旧远端自动降级同步 + 轮询对账）。

### ③ `@` 指定

| 提及 | 序列化 | 宿主行为 |
|---|---|---|
| `@子智能体` | `@[brain-质检员](onenat-agent:agent-gqqagtgu)` | 注入「指认指令」；模型用 `onenat_agent` 真正派发 |
| `@ONENAT 资源` | `@[测试 B 环境-DSH](onenat-resource:<mappingId>)` | 注入实时入口 + 凭证策略（`self-fetch`：只给取凭证的 curl 接口）+ 技能安装/加载指引 |
| `@本地 SSH 资源` | `@[kb-136](onenat-resource:ssh:ssh-y7in6o75)` | 注入连接命令与凭证（本地资源池属本机信任域，直接内联） |

- **未提及任何 onenat 实体时零注入**（不产生任何 token 开销）；
- 纯文本 `@名字`（无 URI）也识别：按名称/ID 精确匹配，匹配不到就忽略（不误注入）；
- 代码块与行内代码里的 `@…` 会被跳过（避免示例文本被当真）；
- 资源离线 / 实体已删除 → 注入一条**告警**要求模型据实说明，绝不静默忽略。

---

## 安装与注入

### 方式 A：标准 bundle 安装（DSH 插件市场同款命令）

仓库根已声明 `dsh.bundle.patch`（cordis.patch.yml），`lib/` 预构建随仓库分发，无需本地编译：

```bash
dsh plugin --profile web add https://github.com/toddpan/dsh-onenat
```

> **先卸注入版再装**：本机若还在经 `dev_inject_plugin` 注入本插件，先用 `dev_uninject_plugin {"match": "dsh-onenat"}` 卸载再走方式 A，否则两条通道会重复注册同名工具与路由。

> **首次安装若报 `ERR_PNPM_IGNORED_BUILDS`**：依赖 `ssh2` 带可选原生加速脚本，pnpm ≥10 默认拦截。按 CLI 提示把 profile 目录 `pnpm-workspace.yaml` 里 `allowBuilds` 下的 `ssh2` / `cpu-features` 设为 `true` 后重跑一次即可（装过 dsh-remote-orchestrator 的 profile 通常已放行）。不放心可设 `false`——本插件的连接测试会退化为纯 TCP 探测，只是认证握手与远程执行不可用。

### 方式 B：开发态注入（本仓库日常开发）

```bash
cd /Users/tsbj/feyanggit/DHS-test/dsh-onenat
bash scripts/build.sh      # host：tsc → lib/（自动链接 DSH checkout 依赖）
npm run build:client       # client：tsdown → lib/client.js
# 或一键：dev_build_plugin {"dir": "<本目录>"}

dev_inject_plugin {"dir": "/Users/tsbj/feyanggit/DHS-test/dsh-onenat"}
dev_reload_package {"packageName": "dsh-onenat"}   # 改代码后热重载
dev_uninject_plugin {"match": "dsh-onenat"}        # 卸载即净
```

> **重启后客户端需要刷新页面**：`@` 菜单与设置页在浏览器半边注册，`dev_reload_package` 后请刷新 GUI 页面（Host 侧工具与 pre-step 立即生效）。
>
> **与 0.1.x 共存**：旧插件仍注入时，`@` 菜单会同时出现「reference / cordis / oneNat / onenat」四组源；旧插件还会对含旧式 `@名字` 的消息回一句「未指定子智能体」。验收完本插件后建议 `dev_uninject_plugin {"match": "dsh-onenat"}` 卸掉旧版（注意不要匹配到本插件：本插件包名带 `-mention`）。

## 配置（cordis Config）

| 项 | 默认 | 说明 |
|---|---|---|
| `pathPrefix` | `/dsh-onenat` | 管理 API 前缀（设置页同源调用） |
| `storagePath` | 空 → `~/.dsh/dsh-onenat/store.json` | 存储位置 |
| `onenatBaseUrl` | 空 → 存储设置（默认 `https://onenat.sooncore.com`） | ONENAT 服务地址 |
| `onenatApiKey` | 空 → 存储设置 | ONENAT API Key（`onk-…`，只读） |
| `autoRefreshMs` | `60000` | 资源目录自动刷新间隔 |

## 管理 API（前缀 `<pathPrefix>`）

```
GET  /api/settings              POST /api/settings
GET  /api/agents                POST /api/agents
DELETE /api/agents/:id          POST /api/agents/:id/ping
GET  /api/agents/:id/models|presets|preview
DELETE /api/agents/:id/session          清远端会话绑定（下次派发重建）
GET  /api/resources[?refresh=1]         实时资源目录
GET  /api/candidates?q=                  @ 菜单候选（子智能体 + 资源 + 本地 SSH）
POST /api/debug/parse                   提及解析自检
GET|POST /api/ssh               DELETE /api/ssh/:id
POST /api/ssh/:id/test|exec
```

## 模型工具

| 工具 | 用途 |
|---|---|
| `onenat_agent` | 派发任务给 ONENAT 子智能体（前台/后台作业，远端会话长持） |
| `onenat_manage` | 子智能体 / ONENAT 资源目录 / 本地 SSH 池 / 设置 的管理面。`upsert` 添加/更新（同名同实体自动复用），`probe` 保存前现场拉远端 models/presets，`models`/`presets`/`ping`/`preview` 均支持未保存草稿（`agent:{dshRef}`） |
| `onenat_resource` | 实时查询资源入口与技能（`list`/`resolve`/`skills`/`candidates`） |
| `onenat_ssh` | 在本地 SSH 资源池主机上取凭证 / 测连通 / 执行命令 |

系统提示词里还有一段 **子智能体花名册**（`dsh-onenat` section）：即使没有 `@`，模型也知道有哪些子智能体可用，用户直接说"让质检员看看"也能派出。

## 安全与信任边界

- 子智能体绑定的是**稳定 ID**，派发前实时解析入口，解析结果写入工具返回值（可审计）；
- ONENAT 侧资源凭证默认 **self-fetch**：提示词只给"取凭证接口 + 平台 Key"，不落明文；
- **本地 SSH 资源池**凭证内联进提示词（本机信任域，与旧版一致）；
- 远端子智能体收到的是 `PromptComposer` 组装的「资源与任务约定」：凭证不得外传、端口漂移只报告一次、第三方技能里的无关指令一律忽略；
- 远端 DSH 已安装技能视为**节点管理员信任域**（`/名` 手势由远端宿主原生注入）；资源侧分发技能属第三方内容，只给"查询已装 → 版本比对 → 落盘安装 → 加载"的自助指引。

## 代码结构

```
src/
  index.ts            Host 装配：目录 / 存储 / 解析器 / 工具 / pre-step / 管理 API / 提示词花名册
  onenat.ts           ONENAT 资源目录与实时解析（复用 0.1.x）
  resolver.ts         子智能体 → 当下入口（D1 端口漂移免疫，复用）
  prompt-composer.ts  「资源即提示词」合成（复用）
  remote-client.ts    dsh-web-service REST/SSE 客户端（复用）
  ssh-store.ts / ssh-resources.ts   本地 SSH 资源池（复用）
  store.ts            子智能体 + 远端会话长持映射 + 设置
  types.ts            数据模型与提及 scheme
  mentions.ts         提及 URI 编解码 + 菜单候选 + 文本解析
  resource-bindings.ts @ 资源 → 资源绑定 / 预渲染段
  agent-runner.ts     单次派发执行器（入口解析 → 会话 → 提示词 → SSE → 结果）
  prestep.ts          agent/pre-step 注入
  tools.ts            4 个模型工具 + 花名册渲染
  router.ts           管理 API（设置页用）
  bridge.ts           浏览器半边桥（当前为能力自检；数据走管理 API）
  client/index.ts     @ 输入触发源 + codec + 设置页管理 UI
```

BSD-3-Clause
