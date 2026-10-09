// OPR gateway M1 A3——人类 spec：每个人一个片段文件 + 生成的注册表投影。schema 已在
// GATEWAY-M1-A3-ENTITY-SCHEMA（b2a2594b，取代 e499dab6）中封闭：prefs 按实体设置
//（每个人一套提醒强度），`role` 按 binding 设置（路由/默认交付通道），二者是不同维度。
//
// 事实模型（design-record §7 / plan §1）：每个人对应一个 YAML 片段，位于
// <home>/gateway/humans/<entityId>.yaml。注册表是这些片段生成的投影
//（humans.generated.yaml），绝不能手改；片段才是事实源。投影携带 DO-NOT-EDIT 头部和
// 漂移校验值（沿用 attestation-lineage.generated 代码生成约定）。准入/解析由 A1/A4
// gateway 负责；本模块只负责片段 + 投影契约。
//
// 校验遵循添加时 == 加载时（hosts-registry 条目模式）：`add` 与加载都运行同一个
// validateHumanFragment，因此已存在但无效的片段会明确报错，绝不静默投影。

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { getOpenRigHome } from "../../openrig-compat.js";
import { DispatchBuffer } from "./dispatch-buffer.js";
import { parseSessionName } from "../session-name.js";

// ── Schema（封闭枚举；只能在契约后以增量方式扩展）──
export const HUMAN_ENTITY_CLASSES = new Set(["human"]);          // M1 唯一支持的 class
export const HUMAN_CONNECTOR_KINDS = new Set(["slack"]);          // M1 唯一支持的 kind
export const HUMAN_BINDING_ROLES = new Set(["primary", "secondary"]);
export const HUMAN_DELIVERY_CLASSES = new Set(["A", "B", "C", "D"]);
// entityId 是片段键和文件名：平台重命名后仍稳定的 slug。只允许小写字母数字和分隔符，
// 不允许路径字符，因为它会被拼入路径。
export const ENTITY_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
// 已注册 @external 引用结构（section2 注册模式）。按约定，注册表片段地址为
// <entityId>@external；带字面 scheme 的地址（slack:U...@external）是一次性地址，
// 绝不是注册表条目。
export const ADDRESS_DOMAIN = "external";

// 封闭键集合——字段拼写错误必须明确失败，绝不能静默降级行为。
const ALLOWED_FRAGMENT_KEYS = new Set(["entityId", "class", "displayName", "address", "connectorBindings", "prefs"]);
const ALLOWED_BINDING_KEYS = new Set(["kind", "connectorRef", "secretsRef", "role", "handle"]);
// connector handle（M1 A6 v3 schema 9e468b2f）：该人在对应 connector 上的平台原生 ID
//（例如 Slack 用户 ID）。约束它不能伪造会话引用（不含 ':'、'@' 或空白）；它会与入站
// 发送者 ID 比较，并拼入指导文本。
export const HANDLE_PATTERN = /^[A-Za-z0-9._-]+$/;
const ALLOWED_PREFS_KEYS = new Set(["deliveryClass", "away", "availability"]);
// OPR.0.5.6.1——交付规则引擎消费的 availability 枚举。只有当 availability 整个字段缺失时
//（D1 约定），旧版 `away: true` 才解释为 availability=away；若两者同时存在且冲突，
// 校验会拒绝，绝不静默选择。
export const HUMAN_AVAILABILITY_MODES = new Set(["available", "focus", "away", "off"]);
function unknownKey(obj: Record<string, unknown>, allowed: Set<string>): string | undefined {
  for (const k of Object.keys(obj)) if (!allowed.has(k)) return k;
  return undefined;
}

export interface HumanConnectorBinding {
  kind: "slack";
  connectorRef: string;
  /** 指向 connector 密钥库的指针（secrets-on-connector），绝不是密钥本身。 */
  secretsRef: string;
  /** 按 binding 路由：每个实体恰好一个 primary，作为默认通道。 */
  role: "primary" | "secondary";
  /** A6 v3：此人在 connector 上的平台原生 ID（例如 Slack 用户 ID）。可选；没有 handle 的
   * binding 只能出站（可交付，但无法解析入站，因此其入站事件会明确拒绝准入）。若需解析入站
   * 则必填。每种 kind 在所有人的全部 binding 中必须唯一（一个平台 ID 恰好对应一个人；
   * 重复即注册冲突，会被拒绝）。 */
  handle?: string;
}

export interface HumanPrefs {
  /** 按实体设置的提醒强度——从 notifications 注册表中选择（spec §6）；A3 只携带、不重新定义。
   * 注册表扩展时保持向前兼容。 */
  deliveryClass: "A" | "B" | "C" | "D";
  /** AWAY 预设（可选；旧拼写，已由 availability=away 取代）。通过引擎的
   * resolveAvailability 读取，仅在 `availability` 整个字段缺失时使用。 */
  away?: boolean;
  /** OPR.0.5.6.1——availability 模式（available | focus | away | off）。 */
  availability?: "available" | "focus" | "away" | "off";
}

export interface HumanFragment {
  entityId: string;
  class: "human";
  displayName: string;
  /** 已注册的 @external 引用；按约定等于 <entityId>@external。 */
  address: string;
  connectorBindings: HumanConnectorBinding[];
  prefs: HumanPrefs;
}

export type ValidateResult =
  | { ok: true; fragment: HumanFragment }
  | { ok: false; error: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 添加时 == 加载时校验。返回类型化片段或明确错误。覆盖结构、封闭枚举和两个跨字段不变量
 *（至少一个 binding、每实体恰好一个 primary）。不访问文件系统。 */
export function validateHumanFragment(raw: unknown): ValidateResult {
  if (!isObj(raw)) return { ok: false, error: "人类片段必须是映射" };
  const uk = unknownKey(raw, ALLOWED_FRAGMENT_KEYS);
  if (uk) return { ok: false, error: `未知片段键 "${uk}"——允许值：${[...ALLOWED_FRAGMENT_KEYS].join(", ")}（拼写错误不能静默降级）` };
  const { entityId, class: cls, displayName, address, connectorBindings, prefs } = raw;

  if (typeof entityId !== "string" || !ENTITY_ID_PATTERN.test(entityId)) {
    return { ok: false, error: `entityId "${String(entityId)}" 必须是小写 slug（a-z0-9._-，首尾不能是分隔符）` };
  }
  if (cls !== "human") {
    return { ok: false, error: `class "${String(cls)}" 不是已知实体类别（M1：${[...HUMAN_ENTITY_CLASSES].join(", ")}）` };
  }
  if (typeof displayName !== "string" || displayName.length === 0) {
    return { ok: false, error: "displayName 必须是非空字符串" };
  }
  if (typeof address !== "string" || address.length === 0) {
    return { ok: false, error: "address 必须是非空字符串（已注册的 @external 引用）" };
  }
  // 注册模式固定规则：地址为 <entityId>@external，无冲突且引用与片段键绑定。不是宽松匹配
  // @external；mike@externalx 不属于此类引用。
  if (address !== `${entityId}@${ADDRESS_DOMAIN}`) {
    return { ok: false, error: `address "${address}" 必须是已注册引用 "${entityId}@${ADDRESS_DOMAIN}"（<entityId>@external 约定）` };
  }
  if (!Array.isArray(connectorBindings) || connectorBindings.length < 1) {
    return { ok: false, error: "connectorBindings 必须是非空列表（>=1）" };
  }

  const bindings: HumanConnectorBinding[] = [];
  let primaryCount = 0;
  for (let i = 0; i < connectorBindings.length; i++) {
    const b = connectorBindings[i];
    if (!isObj(b)) return { ok: false, error: `connectorBindings[${i}] 必须是映射` };
    const ubk = unknownKey(b, ALLOWED_BINDING_KEYS);
    if (ubk) return { ok: false, error: `connectorBindings[${i}] 包含未知键 "${ubk}"——允许值：${[...ALLOWED_BINDING_KEYS].join(", ")}` };
    if (!HUMAN_CONNECTOR_KINDS.has(String(b.kind))) {
      return { ok: false, error: `connectorBindings[${i}].kind "${String(b.kind)}" 不是已知 connector 类型（M1：${[...HUMAN_CONNECTOR_KINDS].join(", ")}）` };
    }
    if (typeof b.connectorRef !== "string" || b.connectorRef.length === 0) {
      return { ok: false, error: `connectorBindings[${i}].connectorRef 必须是非空字符串` };
    }
    if (typeof b.secretsRef !== "string" || b.secretsRef.length === 0) {
      return { ok: false, error: `connectorBindings[${i}].secretsRef 必须是指向密钥库的非空指针，绝不能是密钥本身` };
    }
    if (!HUMAN_BINDING_ROLES.has(String(b.role))) {
      return { ok: false, error: `connectorBindings[${i}].role "${String(b.role)}" 必须是 primary|secondary` };
    }
    if (b.role === "primary") primaryCount++;
    // A6 v3：handle 可选；提供时必须是干净的平台 ID，以防伪造引用。
    let handle: string | undefined;
    if (b.handle !== undefined) {
      if (typeof b.handle !== "string" || !HANDLE_PATTERN.test(b.handle)) {
        return { ok: false, error: `connectorBindings[${i}].handle "${String(b.handle)}" 必须匹配 ${HANDLE_PATTERN}（平台 ID 不得包含 ':'、'@' 或空白，以免伪造引用）` };
      }
    }
    const binding: HumanConnectorBinding = { kind: "slack", connectorRef: b.connectorRef, secretsRef: b.secretsRef, role: b.role as "primary" | "secondary" };
    if (b.handle !== undefined) { handle = b.handle as string; binding.handle = handle; }
    bindings.push(binding);
  }
  // 每个实体恰好一个 primary binding，作为默认交付通道。
  if (primaryCount !== 1) {
    return { ok: false, error: `必须恰好有一个 connectorBinding 的 role 为 "primary"（实际 ${primaryCount} 个）；它是默认交付通道` };
  }
  // A6 v3 pin-1（片段内）：此人的全部 binding 中，每种 kind 的 handle 必须唯一；同一个人
  // 不能重复认领相同平台 ID。跨片段唯一性由能同时看到所有人的 projectHumans 执行。
  const seenHandles = new Set<string>();
  for (const b of bindings) {
    if (b.handle === undefined) continue;
    const key = `${b.kind}:${b.handle}`;
    if (seenHandles.has(key)) {
      return { ok: false, error: `此人的 binding 中 ${b.kind} handle "${b.handle}" 重复——每种 kind 的 handle 必须唯一（一个平台 ID = 一个人）` };
    }
    seenHandles.add(key);
  }

  if (!isObj(prefs)) return { ok: false, error: "prefs 必须是映射 { deliveryClass, away? }" };
  const upk = unknownKey(prefs, ALLOWED_PREFS_KEYS);
  if (upk) return { ok: false, error: `prefs 包含未知键 "${upk}"——允许值：${[...ALLOWED_PREFS_KEYS].join(", ")}（notifications 注册表选项）` };
  if (!HUMAN_DELIVERY_CLASSES.has(String(prefs.deliveryClass))) {
    return { ok: false, error: `prefs.deliveryClass "${String(prefs.deliveryClass)}" 必须是 A|B|C|D 之一（notifications 注册表）` };
  }
  if (prefs.away !== undefined && typeof prefs.away !== "boolean") {
    return { ok: false, error: "提供 prefs.away 时必须是布尔值" };
  }
  if (prefs.availability !== undefined && !HUMAN_AVAILABILITY_MODES.has(String(prefs.availability))) {
    return { ok: false, error: `prefs.availability "${String(prefs.availability)}" 必须是 available|focus|away|off 之一` };
  }
  // 同一事实的两种拼写发生冲突时必须拒绝：已提供的 availability 是权威值；旧版 away 只能
  // 与其一致（away:true + availability=away）。
  if (prefs.availability !== undefined && prefs.away === true && prefs.availability !== "away") {
    return { ok: false, error: `prefs.away=true 与 prefs.availability "${String(prefs.availability)}" 冲突——请只设置 availability（away 是旧版拼写）` };
  }
  const validatedPrefs: HumanPrefs = { deliveryClass: prefs.deliveryClass as HumanPrefs["deliveryClass"] };
  if (prefs.away !== undefined) validatedPrefs.away = prefs.away;
  if (prefs.availability !== undefined) validatedPrefs.availability = prefs.availability as HumanPrefs["availability"];

  return {
    ok: true,
    fragment: { entityId, class: "human", displayName, address, connectorBindings: bindings, prefs: validatedPrefs },
  };
}

// ── 路径（位于 getOpenRigHome() 下；`home` 可注入以实现隔离测试）──
export function humansDir(home: string = getOpenRigHome()): string {
  return join(home, "gateway", "humans");
}
export function projectionPath(home: string = getOpenRigHome()): string {
  return join(home, "gateway", "humans.generated.yaml");
}

/** @deprecated 历史拼写，仅供读取旧记录。绝不能作为路由默认值：地址必须解析到真实注册实体。 */
export const OPERATOR_HUMAN_DEFAULT_SLOT = "human-operator@kernel";

const PROJECTION_HEADER =
  "# GENERATED FILE — DO NOT EDIT.\n" +
  "# Projection of the human fragments under gateway/humans/<entityId>.yaml.\n" +
  "# The fragment is truth: add/edit a human via its fragment (or `rig gateway human\n" +
  "# add`), then re-project. A hand-edit here is REFUSED at load.\n";
const PROJECTION_V2_HEADER = PROJECTION_HEADER + "# Projection format: v2 content-addressed\n";
const PROJECTION_DIGEST_PREFIX = "# projection-body-sha256: ";

function projectionBody(entities: readonly HumanFragment[]): string {
  const entityBody = stringifyYaml({ entities });
  const digest = createHash("sha256").update(entityBody).digest("hex");
  return `${PROJECTION_V2_HEADER}${PROJECTION_DIGEST_PREFIX}${digest}\n${entityBody}`;
}

function validateEntityCollection(entities: readonly HumanFragment[]): string | undefined {
  const entityIds = new Set<string>();
  const handleOwner = new Map<string, string>();
  for (const entity of entities) {
    if (entityIds.has(entity.entityId)) {
      return `人类 entityId "${entity.entityId}" 重复——一个片段只能拥有一个身份`;
    }
    entityIds.add(entity.entityId);
    for (const binding of entity.connectorBindings) {
      if (binding.handle === undefined) continue;
      const key = `${binding.kind}:${binding.handle}`;
      const prior = handleOwner.get(key);
      if (prior !== undefined && prior !== entity.entityId) {
        return `${binding.kind} handle "${binding.handle}" 同时被 "${prior}" 和 "${entity.entityId}" 认领——一个 handle 只能映射到一个人（注册冲突）`;
      }
      handleOwner.set(key, entity.entityId);
    }
  }
  return undefined;
}

export type ProjectResult =
  | { ok: true; body: string; entities: HumanFragment[] }
  | { ok: false; error: string };

/** 根据片段生成规范注册表投影。写入路径和漂移/加载检查共用这一个生成器；加载时和添加时
 * 使用同一个 validateHumanFragment。文件名必须等于 <entityId>.yaml（无冲突键）。实体按
 * entityId 排序，以产生稳定、可比较的正文。 */
export function projectHumans(home: string = getOpenRigHome()): ProjectResult {
  const dir = humansDir(home);
  const entities: HumanFragment[] = [];
  if (existsSync(dir)) {
    const files = readdirSync(dir).filter((f) => f.endsWith(".yaml") && !f.startsWith(".")).sort();
    for (const f of files) {
      let raw: unknown;
      try {
        raw = parseYaml(readFileSync(join(dir, f), "utf8"));
      } catch (err) {
        return { ok: false, error: `解析人类片段 ${f} 失败：${(err as Error).message}` };
      }
      const v = validateHumanFragment(raw);
      if (!v.ok) return { ok: false, error: `人类片段 ${f} 无效：${v.error}` };
      if (`${v.fragment.entityId}.yaml` !== f) {
        return { ok: false, error: `人类片段 ${f} 声明 entityId "${v.fragment.entityId}"——文件名必须是 <entityId>.yaml` };
      }
      entities.push(v.fragment);
    }
  }
  entities.sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
  // A6 v3 pin-1（跨片段）：所有人的全部 binding 中，每种 kind 的 handle 必须唯一。一个平台
  // ID 只映射到一个人，入站解析才无歧义。两个片段冲突即注册冲突，在投影时拒绝，因而
  // add/load/drift 都能发现。
  const collectionError = validateEntityCollection(entities);
  if (collectionError) return { ok: false, error: collectionError };
  return { ok: true, body: projectionBody(entities), entities };
}

export type SlackHandleResolution =
  | { kind: "registered"; entityId: string; address: string }
  | { kind: "unregistered"; handle: string; error: string };

/** A6 v3 pins 2+3——将入站 connector handle 解析到其已注册人类。遍历每个人的
 * `connectorKind` binding，查找 `handle` 相等项：
 *   - 匹配 → registered（以该实体准入，其 address 是人类类别来源）
 *   - 不匹配 → unregistered，并给出明确指导（仅注册后准入；绝不从原始平台 ID 伪造人类
 *     席位；无 handle 的 binding 只能出站，永不匹配，因此入站在此明确失败）。
 * projectHumans 执行的跨片段唯一性保证最多一个匹配。 */
export function resolveSlackHandle(
  handle: string,
  entities: readonly HumanFragment[],
  connectorKind: "slack" = "slack",
): SlackHandleResolution {
  for (const e of entities) {
    for (const b of e.connectorBindings) {
      if (b.kind === connectorKind && b.handle !== undefined && b.handle === handle) {
        return { kind: "registered", entityId: e.entityId, address: e.address };
      }
    }
  }
  return {
    kind: "unregistered",
    handle,
    error:
      `入站 ${connectorKind} 发送者 "${handle}" 不是已注册人类（不存在 handle 为 "${handle}" 的 binding）。` +
      `请先注册该人及其 handle：zrig gateway human add <entityId> --display-name … ` +
      `--binding ${connectorKind}:<connectorRef>:<secretsRef>:primary:handle=${handle} --delivery-class …; ` +
      `在此之前拒绝此消息（不会将其作为伪造的人类席位落地）。`,
  };
}

function atomicWrite(path: string, body: string): { ok: true } | { ok: false; error: string } {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `写入 ${path} 失败：${(err as Error).message}` };
  }
}

/** 根据当前片段重新写入生成投影；原子操作。 */
export function writeProjection(home: string = getOpenRigHome()): { ok: true; path: string } | { ok: false; error: string } {
  const proj = projectHumans(home);
  if (!proj.ok) return { ok: false, error: proj.error };
  const path = projectionPath(home);
  const w = atomicWrite(path, proj.body);
  return w.ok ? { ok: true, path } : w;
}

export type AddHumanResult =
  | { ok: true; path: string; fragment: HumanFragment }
  | { ok: false; error: string };

/** add 动词写入器：添加时校验 → 原子写入唯一片段文件 → 重新投影。操作者不手工创建片段
 * YAML，由该动词负责。绝不静默覆盖（与 hosts-registry addHostEntry 一致）：已有 entityId
 * 会被拒绝，除非显式传入 `replace`；重复执行不能静默替换人类数据（托管配置数据安全类别）。 */
export function addHumanFragment(
  raw: unknown,
  home: string = getOpenRigHome(),
  opts: { replace?: boolean } = {},
): AddHumanResult {
  const v = validateHumanFragment(raw);
  if (!v.ok) return { ok: false, error: v.error };
  const file = join(humansDir(home), `${v.fragment.entityId}.yaml`);
  if (!opts.replace && existsSync(file)) {
    return { ok: false, error: `人类 "${v.fragment.entityId}" 已存在于 ${file}——请显式传入 replace 进行更新（不允许静默覆盖）` };
  }
  // A6 v3 pin-1：写入前拒绝已被其他人认领的 handle，绝不能在磁盘留下冲突片段后才让
  // 重新投影失败。projectHumans 是加载时的后备检查。
  const existing = projectHumans(home);
  if (!existing.ok) return { ok: false, error: `无法校验 handle 唯一性——现有注册表无效：${existing.error}` };
  const claimed = new Map<string, string>();
  for (const e of existing.entities) {
    if (e.entityId === v.fragment.entityId) continue; // 可以替换同一个人。
    for (const b of e.connectorBindings) if (b.handle !== undefined) claimed.set(`${b.kind}:${b.handle}`, e.entityId);
  }
  for (const b of v.fragment.connectorBindings) {
    if (b.handle === undefined) continue;
    const owner = claimed.get(`${b.kind}:${b.handle}`);
    if (owner !== undefined) {
      return { ok: false, error: `${b.kind} handle "${b.handle}" 已注册给人类 "${owner}"——一个 handle 只能映射到一个人（注册冲突）` };
    }
  }
  const w = atomicWrite(file, stringifyYaml(v.fragment));
  if (!w.ok) return { ok: false, error: w.error };
  const proj = writeProjection(home);
  if (!proj.ok) return { ok: false, error: `片段已写入，但重新投影失败：${proj.error}` };
  return { ok: true, path: file, fragment: v.fragment };
}

// ── S12：add 之外的生命周期 list / show / set / remove（OPR.0.5.5.12）──
// RED 提交：将接口声明为 UNWIRED，使固定测试在行为层失败，而不是 module-not-found。GREEN
// 通过与 add 相同的 fragment→validate→atomic-write→re-project 主干实现这些操作。

/** 阻止干净移除人类的一条进行中项。注册表不拥有这些来源（队列行位于后台服务之后，会话
 * 位于 dispatch buffer 中），由调用方组合列表；`pendingConversationsFor` 负责 buffer 部分。 */
export interface InflightItem {
  kind: "open-conversation" | "queue-row";
  id: string;
  detail: string;
}

export interface HumanBindingsSummary {
  count: number;
  primary: { kind: string; connectorRef: string };
  /** 当且仅当某个 binding 携带 handle 时为 true；否则只能出站。 */
  inboundResolvable: boolean;
}

export interface HumanSummary {
  entityId: string;
  displayName: string;
  address: string;
  deliveryClass: HumanPrefs["deliveryClass"];
  /** 实际生效的 availability 预设；未编写时默认为 false。 */
  away: boolean;
  bindings: HumanBindingsSummary;
  fragmentPath: string;
}

export type ListHumansResult =
  | { ok: true; humans: HumanSummary[]; advisory?: string }
  | { ok: false; error: string };

/** 修订 A1（创建者 R5）：0.5.5 界面只管理单个人类。多个片段会如实展示，但枚举只用于
 * 显示而非管理；提示会明确指出该边界。 */
export const MULTI_HUMAN_ADVISORY =
  "存在多个人类片段；当前版本界面只支持单人管理——多人管理属于 0.5.7 范围（片段会如实显示，但尚无复数管理命令）";

/** 带来源信息的字段值：由片段编写，或由默认值填充。 */
export interface ProvenancedValue<T> {
  value: T;
  source: "authored" | "default";
}

export interface EffectiveHumanRecord {
  entityId: string;
  address: string;
  displayName: string;
  fragmentPath: string;
  prefs: {
    deliveryClass: ProvenancedValue<HumanPrefs["deliveryClass"]>;
    away: ProvenancedValue<boolean>;
  };
  connectorBindings: Array<HumanConnectorBinding & { inboundResolvable: boolean }>;
}

export type ShowHumanResult =
  | { ok: true; record: EffectiveHumanRecord }
  | { ok: false; error: string };

export type SetHumanFieldResult =
  | { ok: true; path: string; fragment: HumanFragment }
  | { ok: false; error: string };

export type RemoveHumanResult =
  | { ok: true; removed: string; archivedPath: string; orphanRecordPath?: string }
  | { ok: false; error: string; inflight?: InflightItem[] };

/** --binding / set-binding 规格：kind:connectorRef:secretsRef:role[:handle=<id>]。secretsRef 是
 * 密钥库指针，自身可能包含 ':'，因此 kind/connectorRef 是前两个字段，role 是最后一个位置
 * 字段，中间全部属于 secretsRef。可选 handle= token 可出现在任意位置。add（CLI）和 set
 * 共用这一个解析源。 */
export function parseBindingSpec(spec: string):
  | { ok: true; binding: { kind: string; connectorRef: string; secretsRef: string; role: string; handle?: string } }
  | { ok: false; error: string } {
  const all = spec.split(":");
  const handleTokens = all.filter((p) => p.startsWith("handle="));
  if (handleTokens.length > 1) return { ok: false, error: `binding 规格最多携带一个 handle= token（收到 "${spec}"）` };
  const handle = handleTokens.length === 1 ? handleTokens[0]!.slice("handle=".length) : undefined;
  if (handle !== undefined && handle.length === 0) return { ok: false, error: `binding handle= 不能为空（收到 "${spec}"）` };
  const parts = all.filter((p) => !p.startsWith("handle="));
  if (parts.length < 4) return { ok: false, error: `binding 规格必须是 kind:connectorRef:secretsRef:role[:handle=<id>]（收到 "${spec}"）` };
  const kind = parts[0]!;
  const connectorRef = parts[1]!;
  const role = parts[parts.length - 1]!;
  const secretsRef = parts.slice(2, -1).join(":");
  if (!kind || !connectorRef || !secretsRef || !role) {
    return { ok: false, error: `binding 规格字段不能为空：kind:connectorRef:secretsRef:role[:handle=<id>]（收到 "${spec}"）` };
  }
  return { ok: true, binding: handle !== undefined ? { kind, connectorRef, secretsRef, role, handle } : { kind, connectorRef, secretsRef, role } };
}

function fragmentPathFor(entityId: string, home: string): string {
  return join(humansDir(home), `${entityId}.yaml`);
}

function knownEntityIds(home: string): string[] {
  const dir = humansDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") && !f.startsWith("."))
    .map((f) => f.slice(0, -".yaml".length))
    .sort();
}

function unknownHumanError(entityId: string, home: string): string {
  const known = knownEntityIds(home);
  return `未注册人类 "${entityId}"——已知人类：${known.length ? known.join(", ") : "（无）"}`;
}

export function listHumans(home: string = getOpenRigHome()): ListHumansResult {
  const proj = projectHumans(home);
  if (!proj.ok) return { ok: false, error: proj.error };
  const humans: HumanSummary[] = proj.entities.map((e) => {
    const primary = e.connectorBindings.find((b) => b.role === "primary")!;
    return {
      entityId: e.entityId,
      displayName: e.displayName,
      address: e.address,
      deliveryClass: e.prefs.deliveryClass,
      away: e.prefs.away === true,
      bindings: {
        count: e.connectorBindings.length,
        primary: { kind: primary.kind, connectorRef: primary.connectorRef },
        inboundResolvable: e.connectorBindings.some((b) => b.handle !== undefined),
      },
      fragmentPath: fragmentPathFor(e.entityId, home),
    };
  });
  return humans.length > 1 ? { ok: true, humans, advisory: MULTI_HUMAN_ADVISORY } : { ok: true, humans };
}

/** 读取一个原始片段（用于区分编写值和默认值），并执行校验。 */
function readFragment(entityId: string, home: string):
  | { ok: true; raw: Record<string, unknown>; fragment: HumanFragment; path: string }
  | { ok: false; error: string } {
  const path = fragmentPathFor(entityId, home);
  if (!existsSync(path)) return { ok: false, error: unknownHumanError(entityId, home) };
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    return { ok: false, error: `解析人类片段 ${entityId}.yaml 失败：${(err as Error).message}` };
  }
  const v = validateHumanFragment(raw);
  if (!v.ok) return { ok: false, error: `人类片段 ${entityId}.yaml 无效：${v.error}` };
  return { ok: true, raw: raw as Record<string, unknown>, fragment: v.fragment, path };
}

export function showHuman(entityId: string, home: string = getOpenRigHome()): ShowHumanResult {
  const f = readFragment(entityId, home);
  if (!f.ok) return f;
  const rawPrefs = isObj(f.raw.prefs) ? (f.raw.prefs as Record<string, unknown>) : {};
  return {
    ok: true,
    record: {
      entityId: f.fragment.entityId,
      address: f.fragment.address,
      displayName: f.fragment.displayName,
      fragmentPath: f.path,
      prefs: {
        deliveryClass: { value: f.fragment.prefs.deliveryClass, source: "authored" },
        away: {
          value: f.fragment.prefs.away === true,
          source: rawPrefs.away !== undefined ? "authored" : "default",
        },
      },
      connectorBindings: f.fragment.connectorBindings.map((b) => ({ ...b, inboundResolvable: b.handle !== undefined })),
    },
  };
}

const SETTABLE_FIELDS_TEACHING =
  "可设置字段：display-name、delivery-class、away、binding.<n>（binding.<n> 接受完整 kind:connectorRef:secretsRef:role[:handle=<id>] 规格）";

/** 跨片段 handle 唯一性：提取 add 使用的同一写前检查（一个平台 ID = 一个人），使 set
 * 完全一致地执行该规则。 */
function handleConflict(fragment: HumanFragment, home: string): string | undefined {
  const existing = projectHumans(home);
  if (!existing.ok) return `无法校验 handle 唯一性——现有注册表无效：${existing.error}`;
  const claimed = new Map<string, string>();
  for (const e of existing.entities) {
    if (e.entityId === fragment.entityId) continue;
    for (const b of e.connectorBindings) if (b.handle !== undefined) claimed.set(`${b.kind}:${b.handle}`, e.entityId);
  }
  for (const b of fragment.connectorBindings) {
    if (b.handle === undefined) continue;
    const owner = claimed.get(`${b.kind}:${b.handle}`);
    if (owner !== undefined) {
      return `${b.kind} handle "${b.handle}" 已注册给人类 "${owner}"——一个 handle 只能映射到一个人（注册冲突）`;
    }
  }
  return undefined;
}

export function setHumanField(
  entityId: string,
  field: string,
  value: string,
  home: string = getOpenRigHome(),
): SetHumanFieldResult {
  const f = readFragment(entityId, home);
  if (!f.ok) return f;
  // 编辑原始映射而非规范化片段，使未编写的可选字段继续保持未编写；show 的来源判断依赖
  // 编辑后仍保留原始编写结构。
  const raw = f.raw;
  const rawPrefs = isObj(raw.prefs) ? (raw.prefs as Record<string, unknown>) : {};

  if (field === "display-name") {
    if (value.length === 0) return { ok: false, error: "display-name 必须是非空字符串" };
    raw.displayName = value;
  } else if (field === "delivery-class") {
    rawPrefs.deliveryClass = value; // 下方使用同一个添加时校验器验证 enum。
    raw.prefs = rawPrefs;
  } else if (field === "away") {
    if (value !== "true" && value !== "false") {
      return { ok: false, error: `away 必须是 true|false（收到 "${value}"）` };
    }
    rawPrefs.away = value === "true";
    raw.prefs = rawPrefs;
  } else if (field.startsWith("binding.")) {
    const idxRaw = field.slice("binding.".length);
    const idx = /^\d+$/.test(idxRaw) ? Number.parseInt(idxRaw, 10) : NaN;
    const bindings = Array.isArray(raw.connectorBindings) ? (raw.connectorBindings as unknown[]) : [];
    if (!Number.isInteger(idx) || idx < 0 || idx >= bindings.length) {
      const valid = bindings.map((_, i) => `binding.${i}`).join(", ");
      return { ok: false, error: `"${field}" 超出范围——此人有 ${bindings.length} 个 binding：${valid || "（无）"}` };
    }
    const parsed = parseBindingSpec(value);
    if (!parsed.ok) return parsed;
    bindings[idx] = parsed.binding;
    raw.connectorBindings = bindings;
  } else {
    return { ok: false, error: `未知字段 "${field}"——${SETTABLE_FIELDS_TEACHING}` };
  }

  // 与添加时完全一致：结构 + 封闭枚举 + 跨字段不变量。
  const v = validateHumanFragment(raw);
  if (!v.ok) return { ok: false, error: v.error };
  if (v.fragment.entityId !== entityId) {
    return { ok: false, error: `set 不得更改 entityId（片段键）` };
  }
  // 另外执行 add 使用的跨片段 handle 唯一性写前检查。
  const conflict = handleConflict(v.fragment, home);
  if (conflict) return { ok: false, error: conflict };

  const w = atomicWrite(f.path, stringifyYaml(raw));
  if (!w.ok) return { ok: false, error: w.error };
  const proj = writeProjection(home);
  if (!proj.ok) return { ok: false, error: `片段已写入，但重新投影失败：${proj.error}` };
  return { ok: true, path: f.path, fragment: v.fragment };
}

export function removeHumanFragment(
  entityId: string,
  opts: { force?: boolean; inflight: InflightItem[] },
  home: string = getOpenRigHome(),
): RemoveHumanResult {
  const path = fragmentPathFor(entityId, home);
  if (!existsSync(path)) return { ok: false, error: unknownHumanError(entityId, home) };

  if (!opts.force && opts.inflight.length > 0) {
    const lines = opts.inflight.map((i) => `  - ${i.kind} ${i.id} — ${i.detail}`).join("\n");
    return {
      ok: false,
      inflight: opts.inflight,
      error:
        `拒绝移除 "${entityId}"——这会使 ${opts.inflight.length} 个进行中条目失去归属：\n${lines}\n` +
        `请先处理这些条目，或传入 --force 强制归档（上方每个进行中条目都会记录为孤立项，绝不静默丢弃）。`,
    };
  }

  // 归档而不删除字节。名称避免冲突：毫秒时间戳 + 计数器回退。
  const archiveDir = join(humansDir(home), ".archive");
  try {
    mkdirSync(archiveDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: `创建归档目录 ${archiveDir} 失败：${(err as Error).message}` };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let archivedPath = join(archiveDir, `${entityId}.${stamp}.yaml`);
  for (let n = 1; existsSync(archivedPath); n++) archivedPath = join(archiveDir, `${entityId}.${stamp}-${n}.yaml`);
  try {
    renameSync(path, archivedPath);
  } catch (err) {
    return { ok: false, error: `归档 ${path} 失败：${(err as Error).message}` };
  }

  let orphanRecordPath: string | undefined;
  if (opts.inflight.length > 0) {
    orphanRecordPath = archivedPath.replace(/\.yaml$/, ".orphans.json");
    const record = { entityId, archivedFragment: archivedPath, orphaned: opts.inflight };
    const w = atomicWrite(orphanRecordPath, JSON.stringify(record, null, 2));
    if (!w.ok) return { ok: false, error: `片段已归档到 ${archivedPath}，但孤立项记录失败：${w.error}` };
  }

  const proj = writeProjection(home);
  if (!proj.ok) return { ok: false, error: `片段已归档到 ${archivedPath}，但重新投影失败：${proj.error}` };
  const base = { ok: true as const, removed: entityId, archivedPath };
  return orphanRecordPath !== undefined ? { ...base, orphanRecordPath } : base;
}

/** 移除门禁中 dispatch-buffer 的一半：绑定到此实体且未确认的出站决策属于开放会话。匹配
 * 规则来自文档而非猜测：entityBindingRef 等于 entityId、等于其注册地址，或以
 * "<entityId>:" 为前缀。 */
export function pendingConversationsFor(entityId: string, home: string = getOpenRigHome()): InflightItem[] {
  const address = `${entityId}@${ADDRESS_DOMAIN}`;
  return new DispatchBuffer(home)
    .pending()
    .filter((d) => d.entityBindingRef === entityId || d.entityBindingRef === address || d.entityBindingRef.startsWith(`${entityId}:`))
    .map((d) => ({
      kind: "open-conversation" as const,
      id: d.decisionId,
      detail: `未交付的出站决策 ${d.decisionId}（操作 ${d.op}，binding ${d.entityBindingRef}）`,
    }));
}

export type LoadResult =
  | { ok: true; entities: HumanFragment[] }
  | { ok: false; error: string };

/** 只识别已采用生成器可能产出的投影字节。解析后的快照仅是校验证据，绝不是身份输入；
 * 当前片段始终是注册表事实源，兼容旧格式加载后会重新投影。 */
function canonicalProjectionSnapshot(body: string, expectedEntityBody: string): { ok: true; format: "v2" | "legacy" } | { ok: false; error: string } {
  let entityBody: string;
  let expectedDigest: string | undefined;
  let format: "v2" | "legacy";
  if (body.startsWith(PROJECTION_V2_HEADER)) {
    format = "v2";
    const remainder = body.slice(PROJECTION_V2_HEADER.length);
    const digestLineEnd = remainder.indexOf("\n");
    if (digestLineEnd < 0 || !remainder.startsWith(PROJECTION_DIGEST_PREFIX)) {
      return { ok: false, error: "v2 投影摘要行缺失或已更改" };
    }
    expectedDigest = remainder.slice(PROJECTION_DIGEST_PREFIX.length, digestLineEnd);
    if (!/^[a-f0-9]{64}$/.test(expectedDigest)) {
      return { ok: false, error: "v2 投影摘要格式错误" };
    }
    entityBody = remainder.slice(digestLineEnd + 1);
  } else if (body.startsWith(PROJECTION_HEADER)) {
    format = "legacy";
    entityBody = body.slice(PROJECTION_HEADER.length);
  } else {
    return { ok: false, error: "生成文件头缺失或已更改" };
  }

  let raw: unknown;
  try {
    raw = parseYaml(entityBody);
  } catch (err) {
    return { ok: false, error: `生成的 YAML 无法解析：${(err as Error).message}` };
  }
  if (!isObj(raw) || Object.keys(raw).length !== 1 || !Array.isArray(raw.entities)) {
    return { ok: false, error: "生成正文必须恰好包含一个 entities 列表" };
  }

  const entities: HumanFragment[] = [];
  for (let i = 0; i < raw.entities.length; i++) {
    const validated = validateHumanFragment(raw.entities[i]);
    if (!validated.ok) {
      return { ok: false, error: `生成的 entities[${i}] 无效：${validated.error}` };
    }
    entities.push(validated.fragment);
  }
  entities.sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
  const collectionError = validateEntityCollection(entities);
  if (collectionError) return { ok: false, error: collectionError };

  const canonicalEntityBody = stringifyYaml({ entities });
  if (entityBody !== canonicalEntityBody) {
    return { ok: false, error: "生成字节不是规范形式（存在手工编辑或额外内容）" };
  }
  if (expectedDigest !== undefined) {
    const actualDigest = createHash("sha256").update(canonicalEntityBody).digest("hex");
    if (actualDigest !== expectedDigest) {
      return { ok: false, error: "v2 投影摘要与生成正文不匹配（检测到手工编辑）" };
    }
  }
  if (canonicalEntityBody !== expectedEntityBody) {
    return { ok: false, error: "生成正文与当前片段事实不匹配（检测到手工编辑）" };
  }
  return { ok: true, format };
}

/** 通过投影加载注册表，但拒绝手工编辑或发生漂移的投影。片段是事实源，因此身份始终来自
 * 新生成的片段投影。已采用投影格式中的规范快照兼容，并会原子重写；格式错误或不规范字节
 * 仍会明确报错。 */
export function loadHumanRegistry(home: string = getOpenRigHome(), opts: { readOnly?: boolean } = {}): LoadResult {
  const proj = projectHumans(home);
  if (!proj.ok) return { ok: false, error: proj.error };
  const path = projectionPath(home);
  if (!existsSync(path)) {
    return { ok: false, error: `${path} 缺少注册表投影——请从片段重新投影` };
  }
  const stored = readFileSync(path, "utf8");
  if (stored !== proj.body) {
    const snapshot = canonicalProjectionSnapshot(stored, stringifyYaml({ entities: proj.entities }));
    if (!snapshot.ok) {
      return {
        ok: false,
        error: `${path} 的注册表投影被手工编辑或已漂移：${snapshot.error}。片段文件仍是身份事实源；请重新投影片段来修复，绝不要重新添加现有人类或编辑生成文件`,
      };
    }
    if (opts.readOnly) return { ok: true, entities: proj.entities };
    const repaired = atomicWrite(path, proj.body);
    if (!repaired.ok) {
      return { ok: false, error: `${path} 的注册表投影发生漂移：片段事实有效，但原子重新投影失败：${repaired.error}` };
    }
  }
  return { ok: true, entities: proj.entities };
}

/** 将人类的每种已注册写法解析为规范外部地址。身份来自注册表实体，绝不来自域名/后缀白名单。 */
export function resolveRegisteredHumanAddress(
  sessionRef: string | null | undefined,
  entities: readonly HumanFragment[],
): string | null {
  if (!sessionRef) return null;
  const parsed = parseSessionName(sessionRef);
  const identity = parsed.kind === "external"
    ? parsed.local
    : parsed.kind === "canonical"
      ? parsed.member
      : null;
  if (!identity) return null;
  return entities.find((entity) => entity.entityId === identity)?.address ?? null;
}
