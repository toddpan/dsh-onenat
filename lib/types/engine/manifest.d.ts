/**
 * 发行版解析：运行时查 GitHub Releases，失败回落构建期烘焙的清单。
 *
 * 为什么运行时还要联网查：构建期烘焙的清单是**快照**。oneNat 客户端更新
 * 频率不低（上游按 `r2026.09.07` 这种日期版本发版），一份几个月前的快照
 * 会让用户永远装不上最新版。所以运行时以 GitHub API 为准，烘焙清单只做
 * 离线兜底（内网、无外网、GitHub 被限流时仍能装上"当时已知的那一版"）。
 *
 * 为什么"绝不构造下载 URL"：上游的资产名换过好几套写法，靠字符串拼 URL
 * 的代码会在某些版本上"下载成功但下到的是 404 页面"或者更糟——下到另一个
 * 平台的资产。所以**资产 URL 一律来自 GitHub API 返回的 `browser_download_url`**
 * （或构建期清单里烘焙好的同一个字段），本文件只做"读 + 匹配"，不造 URL。
 *
 * 为什么必须缓存：GitHub 未认证 API 是 **60 次/小时/IP**。而设置页会轮询
 * 状态、每次"安装"都要解析一次发行版 —— 不缓存的话，用户点几次安装就把
 * 额度耗光，之后连"看最新版本"都做不了。所以元数据落盘缓存（TTL 6 小时）。
 *
 * 缓存的是**发行版元数据**（资产列表 + checksums），不是下载好的资产文件。
 * 资产文件的缓存是另一回事（见 `install.ts`），因为它要按 sha256 校验。
 */
import { type AssetKind, type PlatformTag } from './platform.js';
/** oneNat 客户端的默认发布仓库。 */
export declare const DEFAULT_CLIENT_REPO = "toddpan/onenat";
/** 构建期烘焙清单的相对路径。 */
export declare const BAKED_MANIFEST_RELATIVE: string;
/** GitHub 发行版元数据缓存的 TTL：6 小时。 */
export declare const RELEASE_CACHE_TTL_MS: number;
/** 发行版资产。 */
export interface ReleaseAsset {
    /** 资产文件名（与上游 release 里的名字完全一致）。 */
    file: string;
    /** 下载地址。**永远来自上游元数据，不构造。** */
    url: string;
    /** 上游 `checksums.txt` 里的 sha256；上游没给就是 null。 */
    sha256: string | null;
    /** 资产形态。 */
    kind: AssetKind;
    /** 资产字节数（上游给的时候才有）。 */
    size: number | null;
}
/** 一次安装要用的发行版计划。 */
export interface ReleasePlan {
    repo: string;
    /** 上游 release tag（如 `r2026.09.07`）。 */
    tag: string;
    /** 版本目录名（等于 tag 的安全化形式）。 */
    version: string;
    asset: ReleaseAsset;
    /** 计划来源：GitHub 实时解析 还是 构建期烘焙。 */
    source: 'github' | 'baked';
}
/** 构建期烘焙清单。 */
export interface BakedClientManifest {
    repo: string;
    tag: string;
    generatedAt: string;
    /** 平台标签 → 资产。方便人看与工具消费。 */
    platforms: Record<string, {
        file: string;
        url: string;
        sha256: string | null;
        kind: AssetKind;
    }>;
    /**
     * 扁平资产列表。
     *
     * 运行时**只按资产文件名**挑资产（和 GitHub 路径完全同一套规则），
     * `platforms` 只是给人看的；保留两份是为了"同一份文件既能被人读、又能被
     * 机器用同一套规则处理"。
     */
    assets?: Array<{
        file: string;
        url: string;
        sha256: string | null;
        kind: AssetKind;
        platform?: string;
    }>;
}
/**
 * 插件包根目录（含 `package.json` 的那一层）。
 *
 * 从本文件所在目录**向上找**而不是写死层数：源码里是 `src/engine/`，
 * 编译产物里是 `lib/engine/`，两者的上两层刚好都是包根，但写死层数的话
 * 以后多一层构建目录就会静默读错文件 —— 那种 bug 只在"打包后清单读不到"
 * 时才显形，非常难查。
 */
export declare function packageRoot(): string;
/** 构建期清单的绝对路径。 */
export declare function bakedManifestPath(): string;
/**
 * 读取构建期烘焙清单。
 *
 * 读不到/坏了都返回 null（而不是抛异常）：它是**兜底**，兜底本身出问题不该
 * 把"走 GitHub 实时解析"这条主路径一起带崩。
 */
export declare function loadClientManifest(): BakedClientManifest | null;
/**
 * 解析上游 `checksums.txt`。
 *
 * 格式是 GNU coreutils 的默认文本模式输出：`<hex>  <文件名>`（**两个**空格）。
 * 也兼容 `sha256sum -b` 的二进制模式（`<hex> *<文件名>`）与单空格。
 * 认不出来的行直接跳过 —— 校验文件里混进注释行是正常的。
 */
export declare function parseChecksums(text: string): Map<string, string>;
/** GitHub release 的资产。 */
interface GithubAsset {
    name: string;
    url: string;
    size: number | null;
}
/** GitHub release 的元数据。 */
interface GithubRelease {
    tag: string;
    assets: GithubAsset[];
}
/**
 * 解析 GitHub Releases API 的响应。
 *
 * 全部字段都按"可能缺失"处理：GitHub 会给 `draft`/`prerelease` 的 release
 * 返回不同的字段集，一个字段的缺失不该让整次解析崩掉。
 */
export declare function parseGithubRelease(payload: unknown): GithubRelease;
/**
 * 从资产列表里挑出该平台的那一份。
 *
 * 挑选规则来自 `platform.ts` 的 `assetNamesForTag` —— **与构建期清单同一套
 * 规则**。这是"清单判定与运行时选资产同源"那条铁律的落点。
 */
export declare function pickAssetForTag(assets: Array<{
    file: string;
    url: string;
    size?: number | null;
}>, tag: PlatformTag, checksums: Map<string, string>): ReleaseAsset | null;
/** 解析发行版计划。 */
export interface ResolveReleasePlanOptions {
    /** GitHub 仓库（`owner/repo`），默认 `toddpan/onenat`。 */
    repo?: string;
    /** 指定 release tag；不给就是 latest。 */
    tag?: string;
    /** 目标平台；默认按当前进程推断。 */
    platform?: PlatformTag | null;
    /** 是否允许联网（false = 只用构建期清单）。 */
    allowNetwork?: boolean;
    /** 取消信号。 */
    signal?: AbortSignal;
    /** 引擎根目录（缓存落盘位置）。 */
    root?: string;
    /** 强制绕过缓存重新拉发行版。 */
    forceRefresh?: boolean;
    /** 缓存 TTL（毫秒）。 */
    ttlMs?: number;
    /** 当前时间（测试注入）。 */
    now?: number;
}
/**
 * 解析出"这次要装哪个文件"。
 *
 * 顺序：**GitHub 实时 → 构建期烘焙**。实时拿不到（离线 / 限流 / 该 tag 不
 * 存在）就回落烘焙清单；两边都没有才报错，并且错误信息里把两个原因都说清楚
 * —— 只说"安装失败"的话，用户根本不知道该检查网络还是该升级插件。
 */
export declare function resolveReleasePlan(options?: ResolveReleasePlanOptions): Promise<ReleasePlan>;
/** 判断构建期清单是否可用（设置页可以据此提示"当前处于离线兜底模式"）。 */
export declare function bakedManifestAvailable(): boolean;
/** 构建期清单里烘焙的版本号（没有清单时返回 null）。 */
export declare function bakedManifestTag(): string | null;
/** 供诊断用：构建期清单文件的修改时间（不存在返回 null）。 */
export declare function bakedManifestMtime(): number | null;
export {};
