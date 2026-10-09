import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, isAbsolute } from "node:path";
import { getOpenRigHome } from "../../openrig-compat.js";
import { SETTINGS_VALID_KEYS, type SettingsStore, type ResolvedSetting } from "./settings-store.js";
import { connectionsProjection, readConnectionConfiguration } from "../gateway/connections-projection.js";
import { DEFAULT_CONFIG } from "../gateway/slack/config.js";
import { projectionPath } from "../gateway/human-registry.js";
import { loadHostRegistry } from "../hosts/hosts-registry-reader.js";
import { DEFAULT_HEALTH_POLICY, validateHealthPolicy } from "../health-policy.js";

type Value = string | number | boolean | null;
type State = "available" | "missing" | "malformed" | "unavailable";
type Kind = "scalar" | "text" | "path" | "identity" | "url" | "names" | "paths" | "withheld";
export interface BrowserEntry {
  key: string;
  group: "general" | "slack" | "people" | "hosts" | "health";
  value: Value;
  defaultValue: Value;
  defaultKnown: boolean;
  subject?: string;
  source: "env" | "file" | "default" | "unreported" | "unavailable";
  visibility: "shown" | "withheld" | "unavailable";
  reason: string | null;
  scope: string;
  application: string;
}
interface BrowserSource { id: string; state: State; path: string | null; detail: string; }

/** 名称属于展示策略，绝不是第二套设置 registry 或 resolver。 */
const PATHS = new Set(["db.path", "transcripts.path", "workspace.root", "workspace.slices_root",
  "workspace.steering_path", "workspace.specs_root", "workspace.projects_root", "workspace.catalog_path",
  "topology.root", "context.root", "skills.root", "policies.claude_compaction.message_file_path"]);
const IDENTITIES = new Set(["daemon.host", "host.name", "host.selected", "context.system_world",
  "ui.timezone", "agents.advisor_session", "agents.operator_session", "workspace.operator_seat_name",
  "workflow.exception_routing", "policies.idle_gate_qitem.auto_register"]);
const INSTRUCTIONS = new Set(["policies.claude_compaction.pre_compact_instruction",
  "policies.claude_compaction.compact_instruction", "policies.claude_compaction.message_inline",
  "policies.claude_compaction.post_restore_audit_instruction"]);
function kindFor(key: string): Kind {
  if (PATHS.has(key)) return "path";
  if (IDENTITIES.has(key)) return "identity";
  if (INSTRUCTIONS.has(key)) return "withheld";
  if (key === "files.allowlist" || key === "progress.scan_roots") return "paths";
  if (key === "recovery.provider_auth_env_allowlist" || key === "policies.idle_gate_qitem.opt_in_sessions") return "names";
  return "scalar";
}

/** 先应用值/类型策略；凭据和终端控制检查属于纵深防御。即使 key 看似无害，也绝不序列化未知对象
 * 或未经审查的字符串。 */
function safeValue(value: unknown, kind: Kind, redact: (v: unknown) => string | null): { value: Value; reason: string | null } {
  const hidden = (reason: string) => ({ value: null, reason });
  if (value === null || value === undefined) return { value: null, reason: null };
  if (kind === "withheld") return hidden("已隐藏编写的指令内容；请在所属 source 中检查。");
  if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    return kind === "scalar" ? { value, reason: null } : hidden("已隐藏非预期的值类型。");
  }
  if (typeof value !== "string") return hidden("已隐藏非预期的值类型。");
  if (!value) return { value: "", reason: null };
  if (kind === "scalar") return hidden("已隐藏未经审查的字符串值。");
  if (/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value) || redact(value) !== value || value.includes("[redacted]")
    || /(?:xox[baprs]-|xapp-|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16}|-----BEGIN [^-]*PRIVATE KEY|(?:bearer|password|secret|token)\s*[:=])/i.test(value)) {
    return hidden("已隐藏含凭据或不安全的文本。");
  }
  if (kind === "url") {
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) return hidden("已隐藏不支持的 target URL。");
      // Path 也可能包含不透明凭据：只显示地址，绝不显示任意 URL 组件。
      return { value: url.origin, reason: url.username || url.password || url.search || url.hash || url.pathname !== "/"
        ? "已隐藏 URL 凭据、path、query 和 fragment。" : null };
    } catch { return hidden("已隐藏无效的 target URL。"); }
  }
  if (value.includes("://")) return hidden("已隐藏 target-address view 之外的 URI 内容。");
  if (kind === "path" && (!isAbsolute(value) && !value.startsWith("~/") && !/^[A-Za-z0-9_. /-]+$/.test(value))) {
    return hidden("已隐藏无法识别的路径形式。");
  }
  if (kind === "path" && /[?#=]/.test(value)) return hidden("已隐藏可能敏感的路径组件。");
  if (kind === "identity" && !/^[A-Za-z0-9_.:@/+ -]*$/.test(value)) return hidden("已隐藏非预期的 identity 文本。");
  if (kind === "names" && !/^[A-Za-z0-9_.:@/, -]*$/.test(value)) return hidden("已隐藏非预期的名称列表内容。");
  if (kind === "paths" && !value.split(",").every((p) => /^[A-Za-z0-9_.-]+:(?:\/|~\/|\.\/)[^?=#]*$/.test(p.trim()))) {
    return hidden("已隐藏非预期的具名路径内容。");
  }
  return { value, reason: null };
}

/** 只读取文件状态。解析/default 继续由各现有 domain owner 负责。 */
function sourceFile(file: string): { state: State; bytes: string | null } {
  try { return { state: "available", bytes: readFileSync(file, "utf8") }; }
  catch (error) { return { state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable", bytes: null }; }
}
function application(key: string): string {
  if (key === "ui.terminal.max_live_terminals") return "旧版 Web 客户端；resolver 值未设置，consumer fallback 为 2。不表示 TUI 有此限制。";
  if (key === "workflow.exception_routing") return "未设置时按 workflow/class/host 优先级路由；运行中路由未经验证。";
  if (key === "ui.timezone") return "后台服务 instance 值；TUI 显示时区取客户端本地值，并在启动时选择。";
  if (key.startsWith("snapshots.periodic.")) return "snapshot scheduler 启动时选择；运行中的 scheduler 未经验证。";
  if (key === "retention.enabled") return "后台服务启动时选择；运行中的 sweeper 未经验证。";
  if (key.startsWith("retention.")) return "retention sweep 时读取；上次应用的值未经验证。";
  if (key.startsWith("policies.claude_compaction.")) return "由 compaction policy consumer 读取；运行中的 action 未经验证。";
  if (key === "terminal.status_bar" || key.startsWith("runtime.")) return "影响未来启动行为；现有 session 未经验证。";
  return "已解析配置；运行中的应用情况未经验证。";
}

/** 现有 owner 的增量安全 view。不修改、不探测 host、不调用 provider，也不修复。 */
export function settingsBrowser(store: SettingsStore, gateway: Record<string, unknown> | null = null, home = getOpenRigHome()) {
  const read = readConnectionConfiguration(home);
  const redact = read.text;
  const entries: BrowserEntry[] = [];
  const sources: BrowserSource[] = [];
  const safePath = (path: string) => safeValue(path, "path", redact).value as string | null;
  function add(key: string, group: BrowserEntry["group"], value: unknown, defaultValue: unknown,
    source: BrowserEntry["source"], kind: Kind = "scalar", scope = "显示的后台服务 instance",
    applied = "仅配置；运行中的应用情况未经验证。") {
    const v = safeValue(value, kind, redact);
    const d = safeValue(defaultValue, kind, redact);
    entries.push({ key, group, value: v.value, defaultValue: d.value, defaultKnown: defaultValue !== undefined && !["people", "hosts"].includes(group), source,
      visibility: source === "unavailable" ? "unavailable" : v.value === null && v.reason ? "withheld" : "shown",
      reason: v.reason ?? d.reason, scope, application: applied });
  }
  const file = sourceFile(store.configPath);
  let generalState = file.state;
  let resolved: Record<string, ResolvedSetting> | null = null;
  try {
    if (file.bytes !== null) {
      const raw: unknown = JSON.parse(file.bytes);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("对象无效");
    }
  } catch { generalState = "malformed"; }
  if (generalState !== "malformed" && generalState !== "unavailable") {
    try { resolved = store.resolveAllWithSource(); }
    catch { generalState = "unavailable"; }
  }
  sources.push({ id: "general", state: generalState, path: safePath(store.configPath),
    detail: "环境变量 > 文件 > 派生默认值。resolver 不报告具体生效变量和被拒绝的覆盖警告。" });
  for (const key of SETTINGS_VALID_KEYS) {
    const r = resolved?.[key];
    add(key, "general", r?.value, r?.defaultValue, r?.source ?? "unavailable", kindFor(key),
      key === "ui.terminal.max_live_terminals" ? "旧版 Web 客户端" : "显示的后台服务 instance", application(key));
  }
  if (resolved) {
    for (const host of store.listFeedHostSubscriptions()) {
      const key = "feed.subscriptions." + host.hostId + ".enabled";
      const r = store.resolveFeedHostSubscription(key)!;
      add(key, "general", r.value, r.defaultValue, r.source);
    }
  }

  const c = connectionsProjection(home, gateway, store, read);
  sources.push({ id: "slack", state: read.sourceState, path: safePath(read.configPath),
    detail: c.configuration ? (c.configuration.enabled ? "已启用" : "已禁用") + "；已应用 " + c.running.applied + "；外部连通性未经验证。"
      : "配置不可用；不推断禁用或默认状态为成功。" });
  const slackKinds: Record<string, Kind> = { enabled: "scalar", inboundDestination: "identity",
    outboundDestinations: "names", sourceLabel: "text", channel: "identity", requiredScopes: "names",
    minimumLevelThatPosts: "identity", minimumLevelThatInterrupts: "identity" };
  for (const [key, kind] of Object.entries(slackKinds)) {
    const cfg = read.cfg as unknown as Record<string, unknown> | null;
    const defs = DEFAULT_CONFIG as unknown as Record<string, unknown>;
    const flatten = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string") ? v.join(", ") : v;
    add("slack." + key, "slack", cfg ? flatten(cfg[key]) : null, flatten(defs[key]),
      cfg ? read.fields.includes(key) ? "file" : "default" : "unavailable", kind);
  }
  add("slack.credentialFile", "slack", read.cfg ? Boolean(read.cfg.secretsEnvFile) : null, false,
    read.cfg ? read.fields.includes("secretsEnvFile") ? "file" : "default" : "unavailable");
  entries.at(-1)!.reason = "仅显示凭据文件引用是否存在；引用及其内容已隐藏。";
  for (const name of ["botToken", "appToken"] as const) {
    add("slack." + name, "slack", c.configuration?.[name], null, c.configuration ? "unreported" : "unavailable", "identity");
    entries.at(-1)!.defaultKnown = false;
    entries.at(-1)!.reason = "仅显示凭据解析结果是否存在；值和 provenance 已隐藏。";
  }

  const humanPath = projectionPath(home);
  const humanFile = sourceFile(humanPath);
  sources.push({ id: "people", state: c.registry.state === "available" ? "available"
    : humanFile.state === "available" ? "malformed" : humanFile.state, path: safePath(humanPath),
    detail: "只读 registry；canonical fragment 拥有 identity。不报告逐字段默认值。已注册不代表可投递。" });
  const subjectKey = (id: string) => createHash("sha256").update(id).digest("hex").slice(0, 16);
  for (const h of c.humans) {
    // 稳定的不透明 key 保留刷新选择，同时不反射编写的 identity 内容。
    const prefix = "people." + h.browserKey + ".";
    const subject = safeValue(h.displayName, "text", redact).value as string | null;
    for (const [key, value] of Object.entries({ entityId: h.entityId, address: h.address, displayName: h.displayName,
      class: h.class, deliveryClass: h.deliveryClass, availability: h.availability, away: h.away, excluded: h.excluded })) {
      add(prefix + key, "people", value, null, "file", key === "away" || key === "excluded" ? "scalar" : key === "displayName" ? "text" : "identity");
      entries.at(-1)!.subject = subject ?? "人员";
    }
    h.bindings.forEach((b) => {
      for (const [key, value] of Object.entries(b)) {
        if (key === "browserKey") continue;
        add(prefix + "bindings." + b.browserKey + "." + key, "people", value, null, "file", key === "credentialReference" ? "scalar" : "identity");
        entries.at(-1)!.subject = subject ?? "人员";
        if (key === "credentialReference") entries.at(-1)!.reason = "仅显示凭据引用是否存在；引用及其内容已隐藏。";
      }
    });
  }

  const hostPath = join(home, "hosts.yaml");
  const hostFile = sourceFile(hostPath);
  const hosts = loadHostRegistry(hostPath);
  sources.push({ id: "hosts", state: hosts.ok ? "available" : hostFile.state === "available" ? "malformed" : hostFile.state,
    path: safePath(hostPath), detail: "仅显示编写并注册的 target；不执行连接或 readiness 探测。" });
  if (hosts.ok) hosts.registry.hosts.forEach((host) => {
    const prefix = "hosts." + subjectKey(host.id) + ".";
    const optional = host.transport === "http" ? { bearer_env: null, bearer_file: null } : { user: null };
    for (const [key, value] of Object.entries({ hostId: null, notes: null, ...optional, ...host })) {
      const credential = key === "bearer_env" || key === "bearer_file";
      add(prefix + key, "hosts", credential ? Boolean(value) : value, null, "file",
        credential ? "scalar" : key === "notes" ? "withheld" : key === "url" ? "url" : "identity",
        "已注册 target metadata；显示的 instance 拥有此声明");
      entries.at(-1)!.subject = safeValue(host.id, "identity", redact).value as string | null ?? "目标";
      if (credential) entries.at(-1)!.reason = "仅显示认证引用是否存在；引用及其内容已隐藏。";
      if (key === "notes") entries.at(-1)!.reason = "已隐藏自由格式备注。";
    }
  });

  const healthPath = join(home, "health", "policy.json");
  const healthFile = sourceFile(healthPath);
  let healthState = healthFile.state;
  let health: typeof DEFAULT_HEALTH_POLICY | null = null;
  try {
    if (healthFile.state === "missing") health = DEFAULT_HEALTH_POLICY;
    else if (healthFile.bytes !== null) health = validateHealthPolicy(JSON.parse(healthFile.bytes));
  } catch { healthState = "malformed"; }
  sources.push({ id: "health", state: healthState, path: safePath(healthPath),
    detail: "已校验 health policy。Context-pressure 设置单独解析；不执行 evaluation 或 notification。" });
  function policyLeaves(value: unknown, defaults: unknown, prefix = "health.policy") {
    if (defaults && typeof defaults === "object" && !Array.isArray(defaults)) {
      for (const [key, d] of Object.entries(defaults)) policyLeaves((value as Record<string, unknown> | null)?.[key], d, prefix + "." + key);
    } else {
      const flatten = (v: unknown) => Array.isArray(v) ? v.join(", ") : v;
      add(prefix, "health", flatten(value), flatten(defaults), health ? healthFile.state === "missing" ? "default" : "file" : "unavailable",
        typeof defaults === "string" || defaults === null || Array.isArray(defaults) ? "names" : "scalar");
    }
  }
  policyLeaves(health, DEFAULT_HEALTH_POLICY);
  return { observedAt: new Date().toISOString(), home: safePath(home), sources, entries,
    exclusions: [
      "Rig/project/workflow/seat 声明仍保留在所属 Spec 和 rig view 中。",
      "Provider 凭据和私有 runtime 文件不属于 CONFIG。",
      "不支持任意未注册的 JSON key。",
      "Slack queueUrl 未使用；已退役的 alertTag 不是受支持的控制项。",
      "已隐藏指令 body、自由格式备注、凭据内容和敏感 URL 组件。",
    ],
    readOnly: true };
}
