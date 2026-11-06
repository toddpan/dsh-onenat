---
id: TASK-1
title: 集成 oneNat 客户端引擎（GitHub Release 下载 · 安装 · 托管 · 一键配置）
status: In Progress
assignee:
  - '@panzj'
created_date: '2026-11-06T15:01:00Z'
updated_date: '2026-11-06T15:20:00Z'
labels: []
dependencies: []
references:
  - /Users/panzj/feiyanggit/onenat
  - /Users/panzj/feiyanggit/dsh-feyagate
priority: high
type: feature
ordinal: 1000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
把 oneNat **客户端（onenat-client，即隧道代理引擎）** 集成进 dsh-onenat 插件，集成形态对齐 `dsh-feyagate` 托管「FeyaGate MCP 引擎」的成熟模式（下载 → 校验 → 安装 → 进程监管 → 设置页可视化管理）。

职责切分（用户口径）：

- **onenat 侧（Go 仓 `/Users/panzj/feiyanggit/onenat`）**：负责把客户端多平台打包并发布到 **GitHub Release**；
- **dsh-onenat 侧（本仓）**：负责**下载**该「onenat 引擎」，装到本机、管起来；
- **终点体验**：用户只在 dsh-onenat 插件的设置页里就能把「onenat 客户端」与「DSH 插件」一次配置好，不再需要手工 `curl | bash` 装客户端、再手工填隧道 ID / KEY。

现状差距（已核实）：

1. 客户端**已经**在 GitHub Release 上发布（`toddpan/onenat`，tag `r2026.09.07`），资产名 `onenat-client-<os>-<arch>.tar.gz` / `.zip`，同 release 附 `checksums.txt`（sha256）。但**仓库 HEAD 已领先该 release**（`r2026.10.15/16` 才把二进制改名 `ngrok` → `onenat-client` 并加固 Windows 安装链路），**当前 HEAD 尚未产出新 release**。
2. dsh-onenat 现状是**纯控制面客户端**：只读 oneNat 的 `/api/v1/resources` 拉资源目录、按 `mappingId` 解析公网入口、派发任务到远端 DSH；**不落地、不安装、不托管** oneNat 客户端。
3. oneNat 服务端目前**没有**可供插件自助注册客户端的 API：`/api/v1/*` 是只读面（resources / apps / credentials）；拿客户端凭据要走**会话鉴权**的 `/api/tunnels` + `/api/tunnels/:id/config`，或手工粘贴 `TUNNEL_ID` + `KEY` 走 `/api/deploy?id=&key=`。
4. oneNat 服务端已用**「托管模式（managed）」**下发隧道：客户端只需 `server_addr` + `auth_token` + `tunnel_id`，隧道集合由服务端经控制通道推送。

<!-- SECTION:DESCRIPTION:END -->

## Acceptance Criteria

<!-- AC:BEGIN -->
- [x] #1 oneNat 侧产出**可复现的**客户端发布流程：一次命令产出 6 个平台资产（darwin/linux/windows × amd64/arm64）+ `checksums.txt`，并发布为 GitHub Release（tag 与版本号一致）；HEAD（含 `onenat-client` 改名）有对应 release
- [x] #2 插件能从 GitHub Release 解析「当前平台资产」：资产名/平台映射有**单一事实源**（构建期烘焙的 manifest），运行时不手工拼 URL
- [x] #3 下载走 sha256 校验（以 release 的 `checksums.txt` 或 sidecar 为期望值）；校验不通过必须拒绝安装并删除残留文件
- [x] #4 客户端安装到插件自有目录（`~/.dsh/dsh-onenat/` 下），权限 `0755`，版本目录不可变 + `current` 指针，支持多版本并存与回滚
- [x] #5 客户端进程被插件监管：启动 / 停止 / 重启 / 状态 / 健康检查；DSH 重启后能自动拉起（pid 文件 + 接管语义，避免多实例互相 kill）
- [x] #6 客户端配置（`server_addr` / `auth_token` / `tunnel_id`）以 `0600` 落盘，UI 与日志中**脱敏**，不进 `store.json`
- [x] #7 设置页新增「oneNat 客户端」分区：安装进度、版本、运行状态、启停按钮、日志、一键配置入口（与现有「连接」「子智能体」「资源」「SSH」卡片同风格）
- [x] #8 安装/升级等长任务以后台 job 表达并轮询展示进度（对齐 dsh-feyagate 的 `JobManager` 语义），失败原因保留到下一次任务开始
- [ ] #9 端到端闭环可验证：插件装好客户端 → 客户端连上 oneNat → `/api/v1/resources` 能看到本机映射 → `onenat_agent` 能派发到本机 DSH
- [x] #10 `npm run typecheck` / `npm run build` / `check:host-imports` 全绿，且 `lib/` 与源码同提交入库
- [x] #11 README / INSTALL 说明「一键配置」新流程，并明确 oneNat 服务端是否需要同步改动
<!-- AC:END -->

## Implementation Plan

<!-- SECTION:PLAN:BEGIN -->
### 阶段 A：oneNat 侧发布链路（Go 仓）
1. 抽出「构建客户端 → 打 6 平台归档 → 算 sha256 → 出 checksums.txt → 发 Release」的脚本（沿用 `packaging/repack.py` 思路，改为覆盖客户端资产）
2. 确认资产命名唯一（当前存在两套：`dl/` 的 `onenat-client_<os>_<arch>` 裸二进制 vs Release 的 `onenat-client-<os>-<arch>.tar.gz`）——插件侧按 Release 命名，但服务端 `/dl` 仍需兼容
3. 补一个 HEAD 版本的 release，使 `ngrok` → `onenat-client` 改名进入分发物

### 阶段 B：插件侧引擎托管骨架（TS 仓，主体）
4. 移植 dsh-feyagate 的可复用骨架（**不要照抄全部**）：`paths.ts`（磁盘布局）、`util/atomic.ts`、`download/fetch.ts`（流式 + 进度 + https-only 重定向）、`download/verify.ts`（sha256）、`download/extract.ts`（tar.gz/zip + 路径穿越防护）、`jobs.ts`（后台任务）
5. `manifest/client-manifest.json`（构建期 `scripts/gen-manifest.mjs` 烘焙：repo / tag / 资产名 / sha256），运行时只查表不拼 URL
6. `client/supervise/process.ts`：spawn `onenat-client managed --config <path>`、pid 文件、健康检查、崩溃退避、看门狗、DSH 重启自动拉起
7. `src/client-*.ts`（新目录，避免与浏览器半边 `src/client/` 混淆）：安装编排、状态、配置读写

### 阶段 C：设置页与 API
8. `src/router.ts` 增 `/api/client/*`：`status` / `install` / `start` / `stop` / `restart` / `config` / `logs` / `enroll`
9. `src/client/index.ts` 增「oneNat 客户端」卡片（与 `ConnectionCard` / `SshCard` 同构），进度条 + 状态徽标 + 启停按钮

### 阶段 D：注册/凭据打通（**依赖 oneNat 侧决策**）
10. 二选一（或都支持）：
    - **A（不改 oneNat）**：设置页让用户粘贴 `TUNNEL_ID` + `KEY`，插件 GET `${baseUrl}/api/deploy?id=&key=` 拿 YAML 直接落盘；
    - **B（改 oneNat）**：新增 API-key 鉴权的自注册端点（如 `POST /api/v1/client/enroll`），插件凭平台 API Key 直接换取 `server_addr`/`auth_token`/`tunnel_id`，并可自动建隧道
11. 「一键配置」串起来：填 oneNat 地址 + API Key → 装客户端 → 写配置 → 启动 → 回读 `/api/v1/resources` 确认本机已上线

### 已知坑（来自 dsh-feyagate 的踩坑记录）
- 清单判定必须与运行时选资产**同源**（`scripts/manifest-rules.mjs` ↔ `src/manifest.ts:assetRank`），且「默认版本无校验值」必须是 **error 级门禁**
- 资产命名漂移是常态，运行时**绝不构造 URL**
- 客户端二进制与配置目录必须同目录（客户端把设备身份绑在 data 目录，挪目录等于换设备）
- 多 DSH 实例共享 install root 时的 pid 归属（`ownerPid` + 宽限期）要一起抄
- 前端 bundle 契约：tsdown 出 `window.__ModuleLoader__.load({id:'dsh-onenat', factory})` 的 CJS；裸 require 只能是平台 seed 模块
- feyagate 自身的 `POST /install` 忽略 body `reinstall`（按钮空操作）——移植时把 body 与按钮语义对齐
<!-- SECTION:PLAN:END -->

## Implementation Notes

<!-- SECTION:NOTES:BEGIN -->
### 已核实的事实（2026-11-06）

**GitHub Release 现状**（`toddpan/onenat`，实测拉取）：
```
r2026.09.07/
  checksums.txt                      # sha256，8 行
  oneNat-r2026.09.07.tar.gz          # 服务端发行包
  onenat-client-darwin-amd64.tar.gz
  onenat-client-darwin-arm64.tar.gz
  onenat-client-linux-amd64.tar.gz
  onenat-client-linux-arm.tar.gz
  onenat-client-linux-arm64.tar.gz
  onenat-client-windows-amd64.zip
  onenat-client-windows-arm64.zip
```
实测：`onenat-client-darwin-arm64.tar.gz` = 7.63 MB，sha256 与 `checksums.txt` 一致；**包内只有一个名为 `ngrok` 的可执行文件**（14.5 MB，未改名前的产物）。

**客户端配置格式**（`src/ngrok/client/config.go` + `src/ngrok/server/dashboard/api.go`）：
```yaml
server_addr: <oneNat 隧道监听地址 host:port>
trust_host_root_certs: false
auth_token: <隧道 KEY>
inspect_addr: disabled
tunnel_id: <隧道 ID>
```
启动命令：`onenat-client managed --config <path>`（`managed` 子命令；隧道集合由服务端经控制通道推送）。

**oneNat 服务端 API 分层**：
| 面 | 鉴权 | 用途 |
|---|---|---|
| `/api/v1/resources`、`/api/v1/apps`、`/api/v1/mappings/:id/credentials` | 平台 API Key（Bearer） | 只读，插件现有依赖 |
| `/api/tunnels`（GET/POST）、`/api/tunnels/:id/config` | **会话 cookie**（用户名/密码登录） | 建隧道、取客户端 YAML 配置 |
| `/api/deploy?id=<TUNNEL_ID>&key=<KEY>` | id+key 本身即凭据 | 渲染托管客户端 YAML（现为一键安装脚本所用） |

**磁盘与命名现状**：服务端 `dl/` 目录用 `onenat-client_<os>_<arch>`（Makefile `release-clients`），Release 用 `onenat-client-<os>-<arch>` —— 两套命名并存，插件需明确只认哪一套。

**用户口径修正**：参考对象应为 `dsh-feyagate`（`/Users/panzj/feiyanggit/dsh-feyagate`），它才是「在 DSH Cordis 插件内托管外部原生二进制」的现成实现；`dsh-xiaozhi` 全仓无 feyagate 相关代码。

### 待用户决策（阻塞项）
1. **注册/凭据来源**：粘贴 `TUNNEL_ID`+`KEY`（不动 oneNat），还是给 oneNat 加自助注册 API（一站式，但要改 Go 仓）？
2. **进程托管形态**：插件内子进程监管（对齐 dsh-feyagate，跨平台简单、DSH 退出即停），还是注册成系统服务（launchd/systemd/Windows 服务，DSH 退出仍在，跨平台实现成本高）？
3. **客户端跑在哪**：只在本机（DSH 所在机器）跑，还是也要支持经已有 SSH 资源池在远端机器安装？
4. **本次范围**：是否同时改 `/Users/panzj/feiyanggit/onenat`（Go 仓）的发布脚本与新 release，还是只做 dsh-onenat 插件侧（假定 Release 已就绪）？

### 用户决策（2026-11-06 已确认）
1. **注册/凭据来源** → **粘贴 `TUNNEL_ID` + `KEY`**。插件走 oneNat 服务端公开端点 `GET {baseUrl}/api/deploy?id=&key=` 换托管配置 YAML，落盘为 0600 的 `client.yml`。**不改 oneNat 的 API 面**。
2. **进程托管形态** → **插件内子进程监管**（对齐 dsh-feyagate）：`<binary> managed --config <client.yml>`，pid 文件 + 接管 + 崩溃退避 + 看门狗；DSH 重启后自动拉起。**不注册 launchd/systemd/Windows 服务**。
3. **客户端跑在哪** → **仅本机**。不做「经 SSH 资源池在远端装客户端」。
4. **本次范围** → **同时改 onenat 仓**：补客户端发布链路（`-tags release` 修正 + 资产产出 + sha256 checksums + 发版脚本/CI）。

### 实施中的关键修正（实测得出）
- **参考对象是 `dsh-feyagate`，不是 `dsh-xiaozhi`**：后者全仓无 feyagate 相关代码。
- **GitHub Release 已有客户端资产**（`toddpan/onenat` tag `r2026.09.07`）：`onenat-client-<os>-<arch>.tar.gz`（Windows `.zip`）+ `checksums.txt`（**sha256**，两空格分隔）。但**仓库内无任何发布自动化**（无 `.github/`、无 goreleaser），且**该 release 的包内二进制仍叫 `ngrok`**（改名之前的老产物）—— HEAD 已改名但未发版。
- **两套资产命名并存**：服务端 `dl/` 用 `onenat-client_<os>_<arch>`（下划线），Release 用 `onenat-client-<os>-<arch>`（连字符）。插件认 Release 那套；新 release 同时发**裸二进制**（与 `dl/` 同名）与归档两种形态，裸二进制免解包。
- **`make release-clients` 的 build tag 陷阱**：它没覆盖 `BUILDTAGS`，默认 `-tags debug`，而 `client/debug.go` 会置 `useInsecureSkipVerify() == true`（客户端跳过服务端证书校验）。**对外分发必须 `-tags release`**。
- **客户端无本地健康端点**：`managed` 模式 + `inspect_addr: disabled` ⇒ 健康判定 = 子进程存活（引擎管） + 服务端侧隧道在线（宿主侧用已有 `OnenatDirectory` 查 `/api/v1/resources` 的 `tunnels[].online`）。
- **本机没有 Go 工具链** ⇒ onenat 侧的产出只能是「脚本 + Makefile + CI + 文档」，实际发版需在有 Go 的机器或 CI 上执行。

### 环境前置
- 本机当前**没有 DSH 源码 checkout**（`DSH_CHECKOUT` 未定位到含 `packages/` 的目录），`scripts/build.sh` 需要它来跑 `tsc`。**已绕过**：用 npm 上的 `@deepseek-ai/dsh-*@0.2.2-rc.1` + `node_modules/cordis` 符号链接到 `@deepseek-ai/cordis`（复刻 checkout 里 `vendor/cordis` 的模块同一性），`npx tsc -p tsconfig.json --noEmit` **零错误**，`npm run build:client` 与 `check:host-imports` 均通过。
- profile 已装 `dsh-onenat@0.2.1`（desktop profile），本仓 `package.json` 为 0.2.2 未发布。
<!-- SECTION:NOTES:END -->

### 2026-11-06 16:30 执行记录

**结论：插件侧（dsh-onenat）引擎托管已完整落地并实测通过；oneNat 侧发布链路已补齐但新 release 尚未发出（本机无 Go 工具链），因此 #1 与 #9 未勾选。**

#### 已实测通过的部分

| 验证项 | 方式 | 结果 |
|---|---|---|
| 从 GitHub Release 真下载 | `EngineService.install({force:true})` 打 `toddpan/onenat` r2026.09.07 | 7.63 MB 下载 → sha256 校验 → 解包 → 落位，进度 2%→100% |
| 二进制可执行 | `versions/r2026.09.07/onenat-client version` | `1.7`（Mach-O arm64） |
| 进程监管 | 起真实二进制 + 假托管配置（指向不可达的 `127.0.0.1:4443`） | 起来、写 pid、日志落 `logs/client.log`、SIGTERM 停干净 |
| DSH 重启接管 | 新 `EngineService` 实例读同一 root | `status()` 报 `running:true` + 同一 pid；`start()` 走接管不起第二个 |
| 配置注册 | 本地假 oneNat 服务端返回 `/api/deploy` YAML | 落盘 `client.yml` **mode 0600**，回传掩码摘要、`tunnelId` 解析正确 |
| 密钥不外泄 | 故意传错 baseUrl / 空 ID / 不可达 host | 错误信息里**从不出现** key；`masked` 只给 `auth_token=ngk-****cdef` |
| 管理 API | 真起 `ManageRouter` + HTTP | `status/job/logs` 200；configure 参数错 400；跨源写 403；并发 install 409；cancel 200 |
| 构建门禁 | `npm run typecheck` / `build:client` / `check:host-imports` | **0 error / 通过 / 16 文件 OK** |

#### 执行中发现并修掉的 3 个真实缺陷

1. **`status()` 看不到「已在后台跑但本实例未接管」的客户端**，DSH 重启后界面会显示「已停止」，用户点启动就会起第二个进程抢同一条隧道。→ `supervise.status()` 增加 pid 文件存活兜底（只用于展示，接管仍走校验命令行+版本的 `tryAdopt`）。
2. **GitHub API 全程匿名**（`gen-client-manifest.mjs` 与运行时 `manifest.ts` 都不发认证头）。未认证额度 60 次/时/IP，实测已被打满 → 烘焙出空壳清单。→ 两处都支持 `GITHUB_TOKEN`/`GH_TOKEN`，脚本另回退 `gh auth token`；运行时只读环境变量（不 exec 外部命令）。运行时另补 `fetchText({headers})` 透传，且**认证头只在首跳附加**（跳到 CDN 时带上 token 既无用又危险）。
3. **`config.maskSecret` 里一行死代码**（`trailing` 恒为空串），且把整段 YAML 回给前端。→ 新增 `summariseConfig()` 只回一句话摘要，暴露面压到最小。

#### oneNat 仓（Go）侧的改动

`packaging/release_client.py`（资产产出 + sha256 + 自检）、`packaging/publish_release.sh`（发版）、`.github/workflows/release-client.yml`（CI）、`packaging/fetch_gopath_deps.sh`、`Makefile`（**`release-clients` 强制 `-tags release`**，已 `make -n` 确认 7/7 平台展开正确；新增 `debug-clients` 写 `dl-debug/` 不污染 `/dl/`）、`packaging/README.md` / `repack.py` / `smoke_release.sh` 命名漂移修正。

**两个额外发现（比 build tag 更致命）**：
- Go 1.22+ 在 GOPATH 模式下**移除了 `go get`**，原 Makefile 的 `deps` / `go-bindata` 目标在 Go 1.24 上必然失败 → 已改为 git 钉 commit + module 模式 `go install`。
- `make assets` 之前不产出 `assets_release.go`，而 `-tags release` 编译依赖它 → 已给 `release-clients` 补 `deps` 前置。

#### 仍需在有 Go 的机器上完成（阻塞 #1 / #9）

```bash
cd /path/to/onenat
bash packaging/fetch_gopath_deps.sh
make release-clients                       # 7 平台，-tags release
make release-assets TAG=r2026.11.NN        # 产出裸二进制 + 归档 + checksums.txt
bash packaging/publish_release.sh --tag r2026.11.NN
git push origin r2026.11.NN
```
发版后 `node scripts/gen-client-manifest.mjs` 重新烘焙，插件即可取到含 `onenat-client` 改名的新产物。
#9 需要一条真实的 oneNat 隧道 KEY 才能做端到端闭环验证（本机无凭据）。

#### 环境绕过说明

本机无 DSH 源码 checkout。新增 `scripts/link-published-deps.mjs`（`npm run link:deps`）：从 npm 取 `@deepseek-ai/dsh-*@0.2.2-rc.1` 并把 `node_modules/cordis` 链到 `@deepseek-ai/cordis`，复刻 checkout 里 `vendor/cordis` 的模块同一性，从而在无 checkout 时也能跑真实 `tsc`。**注意 npm 的 latest dist-tag 指向 0.0.1-rc.\*，用它会报出一堆假错误**（Events 里没有 `agent/pre-step`、Context 上没有 `tools`）。

### 2026-11-06 16:50 补充：与「一键安装脚本」装的那份客户端互斥

**在本机实测时发现的真实冲突场景**：这台机器上已经有一个用 oneNat 后台
`curl … /install.sh | bash` 装好的客户端在跑 ——

```
pid 5658  /Users/panzj/.local/bin/onenat-client -config ~/.onenat-client/onenat-client.yml managed
          ↑ 由 launchd 托管（~/Library/LaunchAgents/com.onenat.client.plist，KeepAlive），
            tunnel_id=bZEG6B9wzZ，指向 natpass.yikaihui.com:4443
```

改动前：插件 `status()` 报 `installed:false / running:false`（它只认自己
`~/.dsh/dsh-onenat/engine/` 下的东西），用户装完插件、填上同一个 tunnel_id 一点启动，
就会**两个进程抢同一条控制连接** —— 服务端把旧连接踢掉、两边互相重连、隧道状态来回跳。

修复（两层）：

1. **`EngineSupervisor.findForeignClient()`**：`pgrep -fl onenat-client`（Windows 用
   `tasklist`）找出全机进程，减去 pid 文件 / 自己的 child / 已接管 pid，剩下的就是外来的。
   `ensureStarted()` 在 spawn 前**先查**，命中就拒绝启动并返回可操作的中文说明。
2. **`EngineStatus.foreignClientPid`**：`status()` 主动暴露，设置页直接显示红条提示，
   不必等用户点了启动才看到错误。

**文案不是猜的**：launchd 起的进程，命令行里**没有** plist 标签（实测确认），
所以改成查真实存在的单元文件（`~/Library/LaunchAgents/com.onenat.client.plist`、
`/etc/systemd/system/onenat-client.service`）再给出对应命令。第一版按命令行匹配标签，
实测输出里没有那半句，已修正。

**验证**：借本机真实客户端二进制造一份插件侧「已安装+已配置」状态 →
`start()` 正确拒绝并返回 pid 5658 + `launchctl unload` 命令；
`status()` 返回 `foreignClientPid: 5658`。**全程未触碰用户真实的 launchd 服务**（进程 5658 一直在跑）。

### 2026-11-06 18:00 执行记录（第二轮：真的把 release 发出来了）

上一轮卡在「本机无 Go 工具链」。这轮装上了 **Go 1.27.3（Homebrew）**，把整条链路跑通了。

#### 发布结果

**`toddpan/onenat` release `r2026.11.06` 已公开** — 15 个资产：
7 平台裸二进制（`onenat-client_<os>_<arch>`）+ 7 个归档 + `checksums.txt`(sha256)。

- 仓库 commit `02076dd` 已推送（`git push origin main`，之前本地 HEAD 未推导致 release target 无效）
- 构建命令：`make release-clients`（7/7 平台 `-tags release`）→ `python3 packaging/release_client.py --tag r2026.11.06` → `publish_release.sh`
- `go version -m` 确认发布物内部：`build -tags=release`（这条最关键 —— debug 版会跳过服务端证书校验）

#### 这轮修掉的 3 个构建/发布缺陷

1. **`fetch_gopath_deps.sh` 依赖表缺 3 个传递依赖** —— 真实编译时才暴露：
   `kardianos/osext`、`kr/binarydist`、`mattn/go-runewidth`（`go-update.v0` 与 `termbox-go` 依赖它们）。
   已补进依赖表并钉死 commit。
2. **`publish_release.sh` 发布必失败** —— 资产在 `cd "$DIST_DIR"` 后按 basename 传给 `gh`，
   而 `--notes-file` 仍是相对 `REPO_ROOT` 的路径，两者基准不同 ⇒ `open …: no such file or directory`。
   已把 `DIST_DIR` / `NOTES_FILE` 统一转绝对路径，dry-run 打印的也是真实路径。
3. **`workdir` 里残留的自检假二进制挡住真实构建** —— `dl/` 里 7 个 `FAKE-ONENAT-CLIENT` ASCII 文件
   让 `go build` 报 `output already exists and is not an object file`。已删除。

#### 插件侧端到端验证（真实网络）

```
EngineService.install({force:true})
  → 解析 r2026.11.06 → 选 onenat-client_darwin_arm64（kind=binary，免解包）
  → 下载 → sha256 校验通过 → 直接落位（不走 tar）→ chmod 0755 → current 指针
  → ./versions/r2026.11.06/onenat-client version → 1.7
  → go version -m: build -tags=release  ✓
```

烘焙清单 `manifest/client-manifest.json` 已按 r2026.11.06 重新生成，7/7 平台都是 `binary` 形态
（插件优先选裸二进制，免解包 —— 这是本轮新增资产形态带来的实质改进）。

**草稿 release 不可见（本题实测）**：`/releases/tags/<tag>` 对草稿返回 404，`/releases/latest` 也不返回草稿。
只能按数字 id 取。所以「先发草稿、再转公开」这个流程里，**插件在公开前拿不到**；已公开。

#### 仍未完成：仅 #9

`#9` 需要**一条真实的隧道 ID + KEY** 才能做闭环（插件装好 → 客户端连上 → 资源目录看到本机映射 → 派发）。
本机已有一条外部客户端在跑（pid 5658，tunnel_id `bZEG6B9wzZ`，launchd 托管），
但它由外部通道管理，插件按设计**不会**去接管或复用它的 KEY（那属于用户凭据）。
要闭环需要用户提供 KEY，或按 README 的互斥说明先停掉外部服务再走插件托管。
