/**
 * 平台与发行资产名的映射。
 *
 * 这里的两张表是**整个引擎唯一的"资产命名真相"**：运行时从 GitHub Release
 * 里挑资产、构建期烘焙清单时挑资产，用的都是本文件里的 `assetNamesForTag`。
 *
 * 为什么强调"同源"：上游的资产名在这两年里换过好几套写法（`windows`/`win`、
 * `x86_64`/`amd64`、`.tar.gz`/裸二进制）。如果"清单判定"和"运行时选资产"
 * 各写一份，早晚会出现"清单说有、运行时找不到"或者反过来"运行时下到了清单
 * 没校验值的那份"。所以这里只允许存在一份命名规则。
 *
 * 已核实的事实（toddpan/onenat 最新 release `r2026.09.07`）：
 *
 *   onenat-client-darwin-amd64.tar.gz
 *   onenat-client-darwin-arm64.tar.gz
 *   onenat-client-linux-amd64.tar.gz
 *   onenat-client-linux-arm64.tar.gz
 *   onenat-client-linux-arm.tar.gz
 *   onenat-client-windows-amd64.zip     ← zip，本插件不支持
 *   onenat-client-windows-arm64.zip     ← zip，本插件不支持
 *   checksums.txt                       ← sha256（`<hex>  <文件名>`，两个空格）
 *
 * 归档里的可执行文件叫 `ngrok`（不是 `onenat-client`），解包后要改名 ——
 * 见 `install.ts`。
 */
/** 受支持的操作系统。 */
export type EngineOs = 'darwin' | 'linux' | 'windows';
/** 受支持的 CPU 架构（用 Go 的命名，因为上游是 Go 项目，资产名也用它）。 */
export type EngineArch = 'amd64' | 'arm64' | 'arm';
/** 平台标签：`<os>-<arch>`。同时也是构建期清单 `platforms` 的键。 */
export type PlatformTag = 'darwin-amd64' | 'darwin-arm64' | 'linux-amd64' | 'linux-arm64' | 'linux-arm' | 'windows-amd64' | 'windows-arm64';
/** 资产形态。`zip` 只用于"明确报错"——本插件不引入 zip 依赖。 */
export type AssetKind = 'binary' | 'tar.gz' | 'zip';
/** 全部受支持的平台标签（顺序即偏好顺序）。 */
export declare const SUPPORTED_TAGS: readonly PlatformTag[];
/** 平台标签的中文说明（设置页展示用）。 */
export declare const PLATFORM_LABELS: Record<PlatformTag, string>;
/**
 * Node 的 platform/arch → oneNat 资产的 os/arch。
 *
 * 映射是**收敛**的：我们只认得出上游真的发过的组合。像 darwin/arm（32 位）
 * 这种 Node 理论上有、oneNat 根本没发的组合，一律返回 null —— 与其下到一个
 * 装不起来的二进制，不如明确说"这个平台没有发行包"。
 */
export declare function detectPlatformTag(platform?: NodeJS.Platform, arch?: string): PlatformTag | null;
/** 该平台在本插件里能不能装。 */
export declare function isSupportedPlatform(tag: PlatformTag | null | undefined): boolean;
/** 该平台安装后二进制的文件名。 */
export declare function binaryFileName(tag: PlatformTag): string;
/**
 * 该平台可能存在的资产文件名，按**偏好顺序**排列。
 *
 * 裸二进制优先：省掉一次解包，也少一个能出错的环节。但上游目前实际发布的
 * 只有归档，所以归档这一路必须同时在（否则整个引擎在真实 release 上装不上）。
 *
 * Windows 的归档是 `.zip`：本插件**不引入 zip 依赖**（zip 库要么带原生
 * 依赖要么不可靠），所以 Windows 走归档这条路会明确报错，而不是静默失败。
 */
export declare function assetNamesForTag(tag: PlatformTag): string[];
/**
 * 由资产文件名反推资产形态。
 *
 * 解包器据此选解包实现。返回 null 表示"不认识这个后缀"——比猜一个默认值
 * 安全：猜错会拿 tar 去解 zip，然后报一个驴唇不对马嘴的错。
 */
export declare function assetKindForFile(file: string): AssetKind | null;
/**
 * 由资产文件名反推平台标签。
 *
 * 只认本文件定义的两套命名（下划线裸二进制 / 连字符归档），不做"猜测式"
 * 匹配 —— 猜出来的平台标签可能对应另一个架构的资产，那是 worse than nothing。
 */
export declare function platformTagForAssetFile(file: string): PlatformTag | null;
