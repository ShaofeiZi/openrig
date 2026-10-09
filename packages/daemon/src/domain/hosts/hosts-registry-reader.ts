// OPR.0.4.4.11——后台服务侧共享的 hosts-registry 读取模块（P3/P4 接口单元，
// pm-lead 裁定 c）：P3 用它解析拓扑放置并生成校验消息；P4 的扇出聚合使用同一模块。
// 仅在此处实现一次，P4 不得重复实现。
//
// 永久只读（架构裁定 3）：注册表是操作员管理的 ~/.openrig/hosts.yaml；后台服务绝不写入。
// 本模块刻意作为 CLI packages/cli/src/host-registry.ts 的独立孪生实现，保持同一 schema
// 与校验规则（包括最多一个 bearer：无令牌后台服务可不配置，但绝不能同时配置两个）。
// 两份实现不合并，任何 schema/校验变更都必须同时落到两个孪生实现。
// packages/daemon/test/hosts-registry-parity.test.ts 逐项固定两者判定，
// 与 scope-audit 的 CLI/后台服务孪生实现采用相同纪律。

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { getDefaultOpenRigPath } from "../../openrig-compat.js";
import { VIRTUAL_DOMAIN_TOKENS } from "../session-name.js";

export interface SshHostEntry {
  id: string;
  /**
   * 此条目所指主机已观测且不可变的 self-id，即 JOIN KEY。
   *
   * `id` 是本机给该机器的标签；`hostId` 是该机器对自身的称呼，并盖印到它发送的每个信封中。
   * 该字段可选，因为现有条目均早于它：缺失表示“从未获知”，解析行为与当前完全一致。
   * 本切片不会自动填充该字段。
   */
  hostId?: string;
  transport: "ssh";
  target: string;
  user?: string;
  notes?: string;
}

export interface HttpHostEntry {
  id: string;
  /** 此条目所指主机已观测的 self-id，即 join key。见 SshHostEntry.hostId。 */
  hostId?: string;
  transport: "http";
  url: string;
  bearer_env?: string;
  bearer_file?: string;
  notes?: string;
}

export type HostEntry = SshHostEntry | HttpHostEntry;

export interface HostRegistry {
  hosts: HostEntry[];
}

export type HostRegistryLoadResult =
  | { ok: true; registry: HostRegistry }
  | { ok: false; error: string };

export type HostResolution =
  | { ok: true; host: HostEntry }
  | { ok: false; error: string };

// OPR.0.4.6.MH1 FR-7——保留主机 id，逐字镜像自 CLI 孪生实现
//（packages/cli/src/host-registry.ts 的 RESERVED_HOST_IDS；一致性测试固定两者）。
// 冲突原因见 CLI 孪生实现。M1 A1：虚拟域 token（VIRTUAL_DOMAIN_TOKENS，即 A2 闭集）
// 同样保留；名为 `external` 的主机会与 @external 分类器冲突。
export const RESERVED_HOST_IDS = new Set(["kernel", "host", "local", ...VIRTUAL_DOMAIN_TOKENS]);

const KNOWN_TRANSPORTS = new Set(["ssh", "http"]);

export function defaultHostRegistryPath(): string {
  return getDefaultOpenRigPath("hosts.yaml");
}

/** 加载并校验操作员的主机注册表（只读）。镜像 CLI 加载器的错误表面，
 * 使操作员在各处看到一致措辞。 */
export function loadHostRegistry(path: string = defaultHostRegistryPath()): HostRegistryLoadResult {
  if (!existsSync(path)) {
    return {
      ok: false,
      error: `在 ${path} 未找到主机注册表。请用 'hosts:' 数组创建；transport: ssh（target + user）或 http（url；可选 bearer_env 或 bearer_file——无 token 后台服务则两者都省略）。`,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    return { ok: false, error: `读取 ${path} 的主机注册表失败：${(err as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    return { ok: false, error: `解析 ${path} 的主机注册表 YAML 失败：${(err as Error).message}` };
  }
  return validateHostRegistry(parsed, path);
}

export function validateHostRegistry(parsed: unknown, sourcePath: string): HostRegistryLoadResult {
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, error: `${sourcePath} 的主机注册表必须是带 'hosts' 数组的 YAML 对象` };
  }
  const obj = parsed as Record<string, unknown>;
  const hosts = obj["hosts"];
  if (!Array.isArray(hosts)) {
    return { ok: false, error: `${sourcePath} 的主机注册表：'hosts' 必须是数组` };
  }

  const seenIds = new Set<string>();
  const validated: HostEntry[] = [];
  for (let i = 0; i < hosts.length; i++) {
    const raw = hosts[i];
    const prefix = `${sourcePath} 的主机注册表：hosts[${i}]`;
    if (raw === null || typeof raw !== "object") {
      return { ok: false, error: `${prefix}：必须是带 id/transport/target 的对象` };
    }
    const entry = raw as Record<string, unknown>;
    const id = entry["id"];
    if (typeof id !== "string" || id.trim() === "") {
      return { ok: false, error: `${prefix}.id：必需的非空字符串` };
    }
    if (seenIds.has(id)) {
      return { ok: false, error: `${prefix}.id：重复的主机 id '${id}'（每个主机 id 在注册表内必须唯一）` };
    }
    if (RESERVED_HOST_IDS.has(id)) {
      return {
        ok: false,
        error: `${prefix}.id：'${id}' 是保留主机 id（保留集：${[...RESERVED_HOST_IDS].sort().join(", ")}）。'kernel' 和 'host' 与人类席位会话分类冲突（@kernel/@host），'local' 是本地主机本身——请选择不同的 id。`,
      };
    }
    // OPR.0.4.6.MH1 rev1-r2 B1——主机 id 会命名文件（pair verb 的 bearer_file 路径嵌入 id），
    // 也会渲染到表格；因此在注册表入口拒绝带路径含义的 id，与保留 id 在同一处校验。
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      return {
        ok: false,
        error: `${prefix}.id：'${id}' 不是有效的主机 id——允许：字母、数字、点、下划线、短横线（以字母或数字开头）。主机 id 命名凭据文件；不允许路径字符。`,
      };
    }
    seenIds.add(id);
    const transport = entry["transport"];
    if (typeof transport !== "string" || !KNOWN_TRANSPORTS.has(transport)) {
      return {
        ok: false,
        error: `${prefix}.transport：必须是 ${[...KNOWN_TRANSPORTS].sort().join(", ")} 之一（收到 ${JSON.stringify(transport)}）`,
      };
    }
    const notes = entry["notes"];
    if (notes !== undefined && typeof notes !== "string") {
      return { ok: false, error: `${prefix}.notes：可选，但如果存在必须是字符串` };
    }
    // join key 和其他 id 一样，也可能进入表格或路径，因此必须遵守与 `id` 完全相同的规则。
    // 生成的 `host-XXXXXXXX` 形式符合这些规则。
    const hostId = entry["hostId"];
    if (hostId !== undefined) {
      if (typeof hostId !== "string" || hostId.trim() === "") {
        return { ok: false, error: `${prefix}.hostId：可选，但如果存在必须是非空字符串` };
      }
      if (RESERVED_HOST_IDS.has(hostId)) {
        return {
          ok: false,
          error: `${prefix}.hostId：'${hostId}' 是保留主机 id（保留集：${[...RESERVED_HOST_IDS].sort().join(", ")}）——连接键命名真实机器自身的身份，绝不能是其中之一。`,
        };
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(hostId)) {
        return {
          ok: false,
          error: `${prefix}.hostId：'${hostId}' 不是有效的主机 id——允许：字母、数字、点、下划线、短横线（以字母或数字开头）。`,
        };
      }
    }

    if (transport === "ssh") {
      const target = entry["target"];
      if (typeof target !== "string" || target.trim() === "") {
        return { ok: false, error: `${prefix}.target：必需的非空字符串（ssh 目标）` };
      }
      const user = entry["user"];
      if (user !== undefined && (typeof user !== "string" || user.trim() === "")) {
        return { ok: false, error: `${prefix}.user：可选，但如果存在必须是非空字符串` };
      }
      validated.push({
        id,
        ...(hostId !== undefined ? { hostId: hostId as string } : {}),
        transport: "ssh",
        target,
        ...(user !== undefined ? { user: user as string } : {}),
        ...(notes !== undefined ? { notes: notes as string } : {}),
      });
    } else if (transport === "http") {
      const url = entry["url"];
      if (typeof url !== "string" || url.trim() === "") {
        return { ok: false, error: `${prefix}.url：必需的非空字符串（远程后台服务的 base URL）` };
      }
      const bearerEnv = entry["bearer_env"];
      const bearerFile = entry["bearer_file"];
      const hasEnv = bearerEnv !== undefined;
      const hasFile = bearerFile !== undefined;
      // bearer_env / bearer_file 均可选：匿名或无令牌后台服务可同时省略（不发送 Authorization）。
      // 最多只能设置一个，绝不能同时设置。此规则镜像 CLI 孪生实现 host-registry.ts。
      if (hasEnv && hasFile) {
        return { ok: false, error: `${prefix}：最多指定 bearer_env 或 bearer_file 之一，不要两者都指定（匿名/无 token 后台服务则两者都省略）` };
      }
      if (hasEnv && (typeof bearerEnv !== "string" || bearerEnv.trim() === "")) {
        return { ok: false, error: `${prefix}.bearer_env：必须是非空环境变量名` };
      }
      if (hasFile && (typeof bearerFile !== "string" || bearerFile.trim() === "")) {
        return { ok: false, error: `${prefix}.bearer_file：必须是非空文件路径` };
      }
      validated.push({
        id,
        ...(hostId !== undefined ? { hostId: hostId as string } : {}),
        transport: "http",
        url: url as string,
        ...(hasEnv ? { bearer_env: bearerEnv as string } : {}),
        ...(hasFile ? { bearer_file: bearerFile as string } : {}),
        ...(notes !== undefined ? { notes: notes as string } : {}),
      });
    }
  }
  return { ok: true, registry: { hosts: validated } };
}

/** 解析用于放置的主机 id。未知 id 的错误会指出请求值，并最多列出 10 个已知 id；
 * FR-4 的逐条校验消息由此产生，在尝试启动前提供问题、原因与修复方式。 */
export function resolveHost(registry: HostRegistry, id: string): HostResolution {
  // alias -> id -> transport。人工设置的 alias 是有意选择的句柄，因此先在整个注册表中尝试匹配
  // `id`，再尝试任何 join key。该优先级是明确规则，不依赖偶然结果，即使随机 self-id 冲突几乎不可能。
  //
  // 有意保留的孪生差异：CLI 孪生实现的 resolveHost 还接受 sidecar 学习到的绑定
  //（host-bindings.json），使以已知 self-id 结尾的粘贴回复提示可在 CLI 边缘解析。
  // 后台服务副本刻意不接受该参数：它服务于放置流程，只解析拓扑 manifest 中操作员编写的 alias；
  // 后台服务也看不到三段式目标（BR-1：CLI 边缘已去除主机限定符）。在这里镜像学习绑定合并只会形成
  // 无效表面。若放置流程将来增加 self-id 查询，应采用 CLI 孪生实现的结构。
  const match = registry.hosts.find((h) => h.id === id)
    ?? registry.hosts.find((h) => h.hostId === id);
  if (match) return { ok: true, host: match };
  const knownIds = registry.hosts.map((h) => h.id).slice(0, 10);
  const idsHint = knownIds.length > 0
    ? ` 已知主机 ID：${knownIds.join(", ")}${registry.hosts.length > knownIds.length ? `（另有 ${registry.hosts.length - knownIds.length} 个）` : ""}。`
    : "（注册表为空）";
  return {
    ok: false,
    error: `未知主机 ID '${id}'。${idsHint}`,
  };
}

/** FR-4：放置要求 transport 能承载 remote-up。v0 中只有 http transport 满足要求
 *（已交付的远程单工作组叶节点通过 runRemoteHttpOp 调用 POST /api/up）；
 * ssh transport 主机可用于发送/捕获，但不能承载 remote-up，因此返回结构化逐条错误，
 * 不尝试启动。 */
export function resolvePlacementHost(registry: HostRegistry, id: string): HostResolution {
  const res = resolveHost(registry, id);
  if (!res.ok) return res;
  if (res.host.transport !== "http") {
    return {
      ok: false,
      error: `主机 '${id}' 使用传输方式 '${res.host.transport}'，无法承载远程工作组启动。放置要求使用 HTTP 传输主机（url；可选 bearer_env 或 bearer_file）；请更新注册表条目，或在本地启动该工作组。`,
    };
  }
  return res;
}
