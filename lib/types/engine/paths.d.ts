/**
 * 引擎的磁盘布局。
 *
 * 引擎（oneNat 客户端二进制 + 运行时配置 + 日志）与插件本体（`store.json` 里
 * 的子智能体、绑定、会话）是**两套生命周期**：插件可以被卸载重装、被多实例
 * 共用，而客户端二进制一旦装好就该留着 —— 卸载插件不该让用户的隧道断掉。
 * 所以引擎的一切都落在 `~/.dsh/dsh-onenat/engine/` 下，与 `store.json` 分开：
 *
 *   <root>/
 *     versions/<version>/onenat-client   不可变的版本目录（Windows 是 .exe）
 *     versions/<version>/install.json     该版本的安装元信息（来源/校验值）
 *     current                            文本指针，存当前版本号
 *     cache/                             下载缓存与发行版元数据缓存
 *     client.yml                         运行时客户端配置（0600，含 auth_token）
 *     client.pid                         pid 文件（JSON）
 *     logs/client.log                    子进程 stdout/stderr
 *
 * 两个刻意的选择：
 *
 *  1. **`current` 是文本文件而不是符号链接。** 符号链接在 Windows 上要靠
 *     目录联接（junction）才能模拟，而目录联接不是符号链接，Node 的
 *     `symlinkSync` 在非管理员下还会失败。文本指针没有这些问题，代价只是
 *     读的时候多一次 `readFileSync`。
 *  2. **配置与二进制不在同一个版本目录里。** `client.yml` 会被反复重写
 *     （换隧道、换 KEY），而 `versions/<version>/` 的语义是"这个版本装好后
 *     不再改动"。把可变的配置放进不可变目录，会让"版本目录不可变"这条约定
 *     失效。
 *
 * 权限：`client.yml` 里有 `auth_token`，落盘必须是 0600。其它文件（如 pid）
 * 不含密钥，用默认权限即可。
 */
/** 引擎根目录的环境变量覆盖名。**直接替换引擎根目录**（默认 `~/.dsh/dsh-onenat/engine`）。 */
export declare const ENGINE_HOME_ENV = "DSH_ONENAT_HOME";
/** 客户端配置文件名（固定名，客户端与配置必须同目录约定之外的独立文件）。 */
export declare const CLIENT_CONFIG_FILE = "client.yml";
/** pid 文件名。 */
export declare const CLIENT_PID_FILE = "client.pid";
/** 子进程日志文件名。 */
export declare const CLIENT_LOG_FILE = "client.log";
/** 运行时配置与 pid 文件的权限：只有属主可读写（`auth_token` 在里面）。 */
export declare const SECRET_FILE_MODE = 384;
/**
 * DSH 主目录（`$DSH_HOME`，否则 `~/.dsh`）。
 *
 * 与 `src/store.ts` 用的是同一套推导：插件的 `store.json` 和引擎目录必须
 * 落在同一个 DSH 主目录下，否则用户在测试 profile 里改了 `DSH_HOME` 之后
 * 引擎会去动真实环境的二进制。
 */
export declare function dshHome(): string;
/**
 * 引擎根目录。
 *
 * `DSH_ONENAT_HOME` 会**整体替换**这个根目录（不是替换它的父目录），这样
 * 测试与"多套引擎并存"都能一句话搞定：`DSH_ONENAT_HOME=/tmp/e1` 即得
 * `/tmp/e1/versions/...`。
 */
export declare function engineRoot(): string;
/** 版本目录的父目录。 */
export declare function versionsDir(root: string): string;
/**
 * 把版本号变成安全的目录名。
 *
 * 版本号来自 GitHub release tag（如 `r2026.09.07`），本来就没有危险字符；
 * 但它是外部输入，必须假设有人会传 `../../etc`。只保留字母数字与 `.`/`-`/`_`，
 * 其余换成 `_`，并挡掉 `.`/`..` 这类相对路径。
 */
export declare function sanitizeVersionName(version: string): string;
/** 某个版本的不可变安装目录。 */
export declare function versionDir(root: string, version: string): string;
/** 某个版本目录内的二进制路径。 */
export declare function versionBinaryPath(root: string, version: string, binaryName: string): string;
/** 某个版本目录内的安装元信息文件。 */
export declare function versionMetaPath(root: string, version: string): string;
/** 当前版本指针文件。 */
export declare function currentPointerPath(root: string): string;
/** 下载缓存目录（发行版元数据缓存 + 下载到的资产）。 */
export declare function cacheDir(root: string): string;
/** 运行时客户端配置路径（含 `auth_token`，权限 0600）。 */
export declare function clientConfigPath(root: string): string;
/** pid 文件路径。 */
export declare function clientPidPath(root: string): string;
/** 日志目录。 */
export declare function logsDir(root: string): string;
/** 子进程 stdout/stderr 日志。 */
export declare function clientLogPath(root: string): string;
/** 建目录（幂等），返回该目录。 */
export declare function ensureDir(path: string): string;
/**
 * 建出引擎需要的全部目录。
 *
 * 幂等：每次都调用是安全的。放在 `ensureStarted()` 之前做，可以避免"目录
 * 不存在导致启动失败"这种低级错误在用户第一次点"启动"时才暴露。
 */
export declare function ensureLayout(root: string): void;
/**
 * 原子写文件：先写同目录临时文件，再 rename。
 *
 * 为什么必须原子：`current` 指针与 `client.pid` 都在进程崩溃/断电的窗口里
 * 被读写。写一半的 `current` 会让插件认为"没装任何版本"，写一半的
 * `client.pid` 解析失败后会被当成"没有进程"从而重复起一个客户端 —— 后者
 * 会和服务端抢同一个隧道的控制连接。`rename` 在同一文件系统内是原子的，
 * 所以读者只会看到旧文件或完整的新文件。
 */
export declare function writeFileAtomic(file: string, content: string, mode?: number): void;
/** 原子写 JSON（缩进 + 结尾换行，便于人肉排查与 diff）。 */
export declare function writeJsonAtomic(file: string, value: unknown, mode?: number): void;
/**
 * 读 JSON；文件不存在/读不了/不是合法 JSON 时返回 `fallback`。
 *
 * 故意不抛异常：pid 文件、install.json 这类文件损坏时的正确反应是"当作没有"
 * 然后重建，而不是让整个插件启动失败。
 */
export declare function readJson<T>(file: string, fallback: T): T;
/** 读当前版本指针；没有指针/指针为空/读失败都返回 null。 */
export declare function readCurrentPointer(root: string): string | null;
/** 写当前版本指针（原子）。 */
export declare function writeCurrentPointer(root: string, version: string): void;
/** 清掉当前版本指针（卸载/重装失败回滚时用）。 */
export declare function clearCurrentPointer(root: string): void;
/**
 * 列出已安装的版本目录名（只列真正放了二进制的）。
 *
 * 只看目录名是不够的：安装过程可能在写指针之前就崩了，留下一个空目录。
 * 那种目录不算"已安装"。
 */
export declare function listInstalledVersions(root: string, binaryName: string): string[];
/** 判断路径是否是一个存在的普通文件。 */
export declare function isFile(path: string): boolean;
