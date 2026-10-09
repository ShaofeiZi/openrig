// OPR.0.4.6.MH1 FR-1/FR-2 — 持久化主机选择读取 + 所选主机路由垫片。
//
// 写入路径：`rig host select` → 后台服务 `POST /api/config/host.selected`
// （唯一的写入路径——CLI 动词是一个薄客户端；架构 FR-1 裁定）。
// 读取路径（本模块）：本地 ConfigStore 解析
// （环境变量 OPENRIG_HOST_SELECTED > ~/.openrig/config.json > 默认 "local"）
// ——后台服务写入 CLI 读取的同一个 config.json，因此读取不需要任何后台服务查找
// （FR-2 零回归姿态：从未做过选择时，每个命令的行为与 MH1 之前字节一致——
// "local" 解析为 undefined，不运行新代码路径）。
//
// 命令的优先级：显式 `--host` > 选择上下文 > local。
// 有自己远程语义的命令自行守卫垫片：
// ps 在 `--all-hosts`/`--hosts` 下抑制它（扇出是显式范围），
// up 对拓扑源抑制它（每条目的 `host:` 是唯一的拓扑放置机制——0.4.4 发布规则）。

import { ConfigStore } from "./config-store.js";

/** 持久化选择（"local" ≡ 无远程选择）。绝不抛异常：
 *  格式错误的配置文件回退到 "local"（读取路径不得中断）。 */
export function readSelectedHost(): string {
  try {
    const resolved = new ConfigStore().resolve() as unknown as { host?: { selected?: string } };
    const v = resolved.host?.selected;
    return typeof v === "string" && v.trim() !== "" ? v : "local";
  } catch {
    return "local";
  }
}

/** FR-2：已支持 `--host` 的命令的有效主机。
 *  显式 flag 优先；否则使用持久化选择（当不是 "local" 时）；
 *  否则 undefined（= 今天的本地路径，不动）。 */
export function resolveEffectiveHost(explicitHost: string | undefined): string | undefined {
  if (explicitHost) return explicitHost;
  const selected = readSelectedHost();
  return selected === "local" ? undefined : selected;
}

/** OPR.0.4.6.MH1 FR-4 — 自身主机显示名（默认 "localhost"；
 *  架构裁定 1：home = 设置孪生）。与 readSelectedHost 相同的读取纪律：
 *  本地 ConfigStore，绝不抛异常。 */
export function readOwnHostName(): string {
  try {
    const resolved = new ConfigStore().resolve() as unknown as { host?: { name?: string } };
    const v = resolved.host?.name;
    return typeof v === "string" && v.trim() !== "" ? v : "localhost";
  } catch {
    return "localhost";
  }
}
