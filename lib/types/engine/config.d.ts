/**
 * 运行时客户端配置的读写。
 *
 * 配置内容来自 oneNat 服务端的 `GET /api/deploy?id=<TUNNEL_ID>&key=<KEY>`，
 * 服务端直接返回一段托管模式（managed）的 YAML，**原样落盘**即可 —— 客户端
 * 自己会解析它，我们不重新生成、不改字段名、不加自己的东西。
 *
 * 这段 YAML 里有 `auth_token`，它是隧道密钥。所以：
 *
 *  1. 文件权限必须是 **0600**（只有属主可读写）。写完之后再显式 `chmod`
 *     一次：`writeFileSync` 的 `mode` 会被 umask 掩掉，显式 chmod 才能保证
 *     "至少不更宽"。
 *  2. **明文绝不进日志、绝不进 `store.json`、绝不进任何返回值。** UI 只能看
 *     到掩码（`ngk-****abcd`）。这条约束落在 `maskSecret` 这一个函数上：
 *     所有会碰到配置文本的出口都先过它。
 *
 * 配置里其它几个字段（`server_addr` / `tunnel_id` / `inspect_addr`）都不是
 * 密钥，可以原样显示。
 */
/** 一行 YAML 键值对。 */
export interface ConfigField {
    key: string;
    value: string;
}
/**
 * 把一行 `key: value` 拆开。
 *
 * 只处理"平坦标量"这种形态 —— 服务端给的配置就是这种（`key: value`，值里
 * 没有换行）。不做通用 YAML 解析：一来没有依赖，二来通用解析器容易在
 * "值以 `#` 开头"这种细节上和 Go 的 `gopkg.in/yaml.v1` 产生分歧，而客户端
 * 读的是 Go 的解析结果 —— **我们读到的必须和客户端读到的一致**，所以这里
 * 刻意用和 Go YAML 一致的朴素规则（`#` 只有在前导空白之后才算注释）。
 */
export declare function parseConfigLines(yaml: string): ConfigField[];
/** 取某个键的值（大小写不敏感）；没有则返回 undefined。 */
export declare function configValue(yaml: string, key: string): string | undefined;
/** 从配置里解析隧道 ID（宿主侧据此向 oneNat 查在线状态）。 */
export declare function parseTunnelId(yaml: string): string | undefined;
/**
 * 从配置里解析 auth_token。
 *
 * **仅供内部判断"配置是否完整"，不要把返回值写进日志或返回值。**
 */
export declare function parseAuthToken(yaml: string): string | undefined;
/**
 * 判断一段 YAML 是否具备托管模式必须的字段。
 *
 * 客户端在 `managed` 模式下会自己校验：`server_addr` 与 `auth_token` 缺一
 * 就直接退出（`managed 模式配置必须包含 server_addr 与 auth_token`）。我们
 * 在落盘之前先判一遍，好过"配置写进去了、客户端起来就死"。
 */
export declare function hasManagedFields(yaml: string): boolean;
/**
 * 把密钥掩码成可以安全显示的样子。
 *
 * 形如 `ngk-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxx` → `ngk-****abcd`：保留前缀
 * （便于用户确认"这是哪个 KEY"）与末 4 位（便于和 oneNat 后台对照），中间的
 * 一律打码。
 */
export declare function maskToken(value: string): string;
/**
 * 把一段配置里的所有密钥字段换成掩码。
 *
 * **所有会碰到配置文本的出口都要先过这个函数**：日志、UI、错误信息。
 * 没有第二处可以绕过它 —— 这就是"密钥绝不外泄"这条约束的落点。
 */
export declare function maskSecret(yaml: string): string;
/**
 * 给 UI 回调用的**一句话**摘要：`server_addr=… · tunnel_id=… · auth_token=ngk-****cdef`。
 *
 * 为什么不把整段（已打码的）YAML 回给前端：托管配置里的密钥字段会随服务端
 * 版本变化增减，只靠正则打码是"默认信任白名单"；而 UI 其实只需要确认
 * 「是哪条隧道、连哪个地址」，用摘要就把暴露面压到最小。
 */
export declare function summariseConfig(yaml: string): string;
/** 写客户端配置（0600，原子）。 */
export declare function writeClientConfig(yaml: string, root: string): Promise<{
    path: string;
    masked: string;
}>;
/**
 * 读客户端配置。
 *
 * 没有配置文件时返回 null（"尚未配置"是一个正常状态，不是错误）。
 */
export declare function readClientConfig(root: string): string | null;
/** 配置文件是否存在（不读内容，状态查询用）。 */
export declare function clientConfigExists(root: string): boolean;
