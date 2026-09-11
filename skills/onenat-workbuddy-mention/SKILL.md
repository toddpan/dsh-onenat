---
name: onenat-workbuddy-mention
description: 在 DSH 原生输入框用 @ 指定 ONENAT 上的子智能体与资源（子智能体管理 / 子智能调用 / 资源提示词注入）。当用户提到 @子智能体、ONENAT 子智能体、把任务交给某个远端智能体、ONENAT 资源（SSH/DSH/HTTP）、WorkBuddy @ 时使用。
---

# OneNat WorkBuddy @

把 ONENAT 资源面上的**子智能体**与**资源**接进 DSH 原生对话。

## 三条使用规则（给智能体自己看）

1. **用户 `@某人` = 指认**：消息里出现 `@[名称](onenat-agent:<id>)` 时，宿主已经注入「指认指令」，
   你应当用 `onenat_agent` 工具派发，不要自己拼 curl 或绕过工具。
2. **用户 `@资源` = 允许使用**：消息里出现 `@[名称](onenat-resource:<id>)` 时，宿主已注入该资源的
   实时入口与凭证策略（见紧随用户消息之后的 `[可用资源清单]`）。你可以自己用（bash / ssh / web_fetch），
   也可以连同任务交给子智能体。
3. **没有 `@` 也能用**：系统提示词里有子智能体花名册。用户说"让质检员看看"这类指代时，用
   `onenat_manage {action:"list"}` 确认名字后用 `onenat_agent` 派发。

## 工具速查

```
onenat_manage {action:"list"}                        # 有哪些子智能体 / 资源可 @
onenat_manage {action:"resources", refresh:true}     # ONENAT 实时资源目录
onenat_resource {action:"resolve", id:"<mappingId>"} # 端口漂移后复查入口
onenat_agent {agent:"<名字或 ID>", task:"<自包含任务>"}
onenat_agent {agent:"…", task:"…", resources:["4aacbeec","ssh:ssh-xxxx"]}   # 连带资源
onenat_agent {agent:"…", task:"…", run_in_background:true}                   # 长任务后台
onenat_ssh {action:"exec", resource:"<名称>", command:"…"}                    # 本地 SSH 池
```

## 硬约束

- `task` **必须自包含**：远端子智能体看不到本会话上下文，目标、约束、期望产出、背景都要写进去。
- 同一子智能体在本会话中**默认复用远端会话**（多轮续聊）；要丢弃上下文用 `new_session: true`。
- 派发结果里的 `remoteSessionId` 要回报给用户（便于继续追问）；失败时原样报告 `error`。
- **不要缓存资源端口**：ONENAT 公网端口会漂移，入口来自每次派发的实时解析。
- 凭证只在任务范围内使用：不得写入脚本文件、不得转发第三方、不得出现在给用户的回复里。

## 管理（设置页）

DSH Web GUI → 设置 → **WorkBuddy @**：
① ONENAT 连接与派发默认值 ② 资源目录 ③ 子智能体管理（增删改查 / 探测 / 提示词预览）
④ 本地 SSH 资源池 ⑤ 提及解析自检。

管理 API 前缀 `/onenat-workbuddy-mention`（同源）：`/api/agents`、`/api/resources`、`/api/candidates`、`/api/ssh`。
