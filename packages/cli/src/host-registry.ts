import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getDefaultOpenRigPath } from "./openrig-compat.js";
import { VIRTUAL_DOMAIN_TOKENS } from "./session-name.js";
import type { FailedStep } from "./cross-host-types.js";

export type { FailedStep };

export interface RemoteBearerResolution {
  ok: true;
  /** 匿名（仅 URL）主机缺失——无 token 的后台服务，不发送
   *  Authorization 请求头。当 bearer_env/bearer_file 解析到时存在。 */
  token?: string;
}

export interface RemoteBearerFailure {
  ok: false;
  failedStep: FailedStep;
  error: string;
}

export function resolveRemoteBearer(host: HttpHostEntry): RemoteBearerResolution | RemoteBearerFailure {
  if (host.bearer_env) {
    const token = process.env[host.bearer_env]?.trim();
    if (token) return { ok: true, token };
    return { ok: false, failedStep: "permission-gate", error: `主机 ${host.id} 的 bearer 环境变量 ${host.bearer_env} 未设置或为空` };
  }
  if (host.bearer_file) {
    try {
      const token = readFileSync(host.bearer_file, "utf-8").trim();
      if (token) return { ok: true, token };
      return { ok: false, failedStep: "permission-gate", error: `主机 ${host.id} 的 bearer 文件 ${host.bearer_file} 为空` };
    } catch {
      return { ok: false, failedStep: "permission-gate", error: `主机 ${host.id} 的 bearer 文件 ${host.bearer_file} 不可读` };
    }
  }
  // 未配置 bearer 现在是有效的匿名主机——无 token 后台服务
  // （主机+VM 是一个创始人拥有的信任域；mesh 是认证边界）。
  // 无 token 意味着下游不发送 Authorization 请求头。
  // 已配置但不可解析的指针仍在上面失败（故障关闭）。
  return { ok: true };
}

/** 为已解析的远程 bearer 构建 Authorization 请求头。匿名
 *  （仅 URL）主机解析为无 token → 无请求头（无 token 后台服务）。 */
export function bearerAuthHeaders(token: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function classifyHttpFailedStep(status: number, body?: { error?: string }): FailedStep {
  if (status >= 200 && status < 300) return "none";
  if (status === 401 || status === 403) return "permission-gate";
  if (status >= 400 && status < 600) return "remote-command-failed";
  return "remote-daemon-unreachable";
}

export function classifyHttpError(_err: unknown): FailedStep {
  return "remote-daemon-unreachable";
}

export interface SshHostEntry {
  id: string;
  /**
   * 此条目指向的主机的已观察、不可变自身 id——连接键。
   *
   * `id` 是我给那台机器的标签；`hostId` 是那台机器自称并盖在
   * 它发送的每个信封上的名称。可选，因为今天存在的每个条目都早于该字段：
   * 缺失意味着"从未学习"，解析方式与现在完全相同。本 slice 中没有任何东西
   * 自动填充它。
   */
  hostId?: string;
  transport: "ssh";
  target: string;
  user?: string;
  notes?: string;
}

export interface HttpHostEntry {
  id: string;
  /** 此条目指向的主机的已观察自身 id——连接键。见 SshHostEntry.hostId。 */
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

// OPR.0.4.6.MH1 FR-7 — 保留主机 id（廉价冲突守卫，
// 架构轨道 4）：`kernel` 和 `host` 由人类席位正则族词法声明
// （`@(kernel|host)$`——重用它们的主机 id 会使主机限定表面
// 与人类席位分类歧义），`local` 是已发布的 LOCAL_HOST_ID 常量
// （名为 "local" 的已注册远程会在每个选择/扇出表面中 shadow 本地主机）。
// 在添加/配对时拒绝，并在已有文件上作为加载时发现暴露
// （响亮失败，绝不静默）。在后台服务读取器孪生中逐字镜像（奇偶测试）。
//
// M1 A1 — 虚拟域 token（VIRTUAL_DOMAIN_TOKENS，A2 闭合集 = 唯一真相来源）
// 加入保留主机 id：注册为 `external` 的主机会使
// `<local>@external` 虚拟域分类歧义（X@Y@external）。
// rig 名铸造门禁为 rig 命名空间保留相同 token（rigspec-preflight）。
export const RESERVED_HOST_IDS = new Set(["kernel", "host", "local", ...VIRTUAL_DOMAIN_TOKENS]);

const KNOWN_TRANSPORTS = new Set(["ssh", "http"]);

export function defaultHostRegistryPath(): string {
  return getDefaultOpenRigPath("hosts.yaml");
}

/**
 * 从磁盘加载并验证主机注册表。v0 文件形状：
 *
 *     hosts:
 *       - id: remote-dev
 *         transport: ssh
 *         target: remote-dev.local
 *         user: your-username  # 可选
 *         notes: "Tart VM"     # 可选
 *
 * 操作者管理；v0 不自动写入或自动修改此文件。缺失文件返回
 * 指向规范路径的明确错误。
 */
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
    // OPR.0.4.6.MH1 rev1-r2 B1——主机 id 命名文件（配对动词的
    // bearer_file 路径嵌入 id）并在表格中渲染：带路径的 id
    // 在注册表门口被拒绝，与保留 id 同一处理。
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
    // 连接键是像其他 id 一样的 id，因此它享有 `id` 已有的相同规则——它可以
    // 同样到达表格和路径。生成的 `host-XXXXXXXX` 形式通过它们。
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
      // bearer_env / bearer_file 是可选的：两者都省略表示
      // 匿名/无 token 后台服务（不发送 Authorization）。最多可设置一个——
      // 绝不两个都设。
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

/**
 * 针对已加载的注册表解析主机 id。未知 id 返回错误，
 * 命名请求的 id 并列出最多 10 个已知 id 以便发现。
 */
export function hostDisplayTarget(host: HostEntry): string {
  return host.transport === "ssh" ? host.target : host.url;
}

export function resolveHost(
  registry: HostRegistry,
  id: string,
  learnedBindings?: Record<string, { hostId: string }>,
): HostResolution {
  // alias -> id -> transport。人类别名是有意的句柄，因此 `id` 匹配在
  // 整个注册表中先于任何连接键被尝试——这个决胜规则是定义的而非偶然的，
  // 即使与随机自身 id 碰撞几乎不可能。注册表声明的 `hostId`
  // 出于同样原因优于 sidecar 学习的绑定：操作者写下了它。
  const match = registry.hosts.find((h) => h.id === id)
    ?? registry.hosts.find((h) => h.hostId === id)
    ?? (learnedBindings ? registry.hosts.find((h) => learnedBindings[h.id]?.hostId === id) : undefined);
  if (match) return { ok: true, host: match };
  const knownIds = registry.hosts.map((h) => h.id).slice(0, 10);
  const idsHint = knownIds.length > 0
    ? ` 已知主机 id：${knownIds.join(", ")}${registry.hosts.length > knownIds.length ? `（+${registry.hosts.length - knownIds.length} 更多）` : ""}。`
    : "（注册表为空）";
  return {
    ok: false,
    error: `未知主机 id '${id}'。${idsHint}`,
  };
}

// ---------------------------------------------------------------------------
// OPR.0.4.4.13 FR-1——注册表写入路径（rig host add）。
//
// 一个验证源：候选注册表（已有条目 + 新原始条目）由加载器使用的
// 同一个 validateHostRegistry 验证——添加时错误就是加载时错误，
// 逐字（包括重复 id、传输适当字段、最多一个 bearer——
// bearer 对无 token 后台服务可选，绝不两个）。标准路径绝不
// 手动编辑 YAML；注意：add 按规范重写文件（手动编写的注释不保留——
// 手动编辑仍是特殊情况的路径）。
// ---------------------------------------------------------------------------

export type AddHostResult =
  | { ok: true; path: string; entry: HostEntry }
  | { ok: false; error: string };

/** OPR.0.4.6.MH1（架构 P3/P4）：一个注册表写入
 *  契约的 CLI 半边——后台服务孪生（packages/daemon/src/domain/hosts/
 *  hosts-registry-writer.ts）逐字镜像，字节奇偶由测试固定。
 *  并发上限（P4）：原子 tmp+rename，整文件
 *  并发 add 上的最后写入者胜——一个操作者规模的注册表
 *  文件，设计上无锁机制；丢失的并发条目通过重新运行 add 重新收敛。 */
export function addHostEntry(rawEntry: Record<string, unknown>, path: string = defaultHostRegistryPath()): AddHostResult {
  // 加载已有内容；缺失文件是 `add` 的有效起点
  // （该动词存在使操作者绝不需要手动创建 YAML），但存在但无效的
  // 文件是响亮错误——绝不静默覆盖操作者状态。
  let existing: HostEntry[] = [];
  if (existsSync(path)) {
    const loaded = loadHostRegistry(path);
    if (!loaded.ok) {
      return { ok: false, error: `拒绝修改无效注册表：${loaded.error}` };
    }
    existing = loaded.registry.hosts;
  }

  const candidate = { hosts: [...existing, rawEntry] };
  const validated = validateHostRegistry(candidate, path);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }
  const entry = validated.registry.hosts[validated.registry.hosts.length - 1]!;

  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.hosts.yaml.tmp-${process.pid}`);
    writeFileSync(tmp, stringifyYaml({ hosts: validated.registry.hosts }), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    return { ok: false, error: `写入 ${path} 的主机注册表失败：${(err as Error).message}` };
  }
  return { ok: true, path, entry };
}
