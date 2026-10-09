// Slice-03（OPR.0.4.8.3）接缝 A——permission-policy SPEC 原语：解析并按约定校验。
// policy spec 是包含前置 YAML FRONTMATTER 契约和说明正文的 Markdown 文件。
// 本模块从 frontmatter 解析整个契约（逐字保留正文），并按约定校验；它只提供建议且失败开放
//（对应 `zrig scope audit`），绝不执行策略。它绝不校验 semantic-action 词汇表
//（由 taxonomy 668bb0d2 管理），也绝不把意图解析为 harness 格式
//（flag 表面由其他位置的确定性代码处理，config 表面由 skill 处理）。
// Schema 权威：ARCH-POLICY-SPEC-SCHEMA sha256-8 92409094。

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type PolicySurface = "flag" | "config";
export type PolicySource = "builtin" | "custom";
export type LaunchPosture = "floor" | "full_bypass";
export type DefaultPosture = "allow" | "ask" | "deny";

/** 已解析的 policy spec：原始 frontmatter 对象与保留的 Markdown 正文。 */
export interface ParsedPolicySpec {
  frontmatter: Record<string, unknown>;
  /** frontmatter 块后的 Markdown 正文；逐字保留（人类说明，不属于契约）。 */
  body: string;
}

export interface ParseError {
  error: string;
}

// 前置 `---\n<yaml>\n---\n<body>` frontmatter 块。非贪婪捕获 YAML，使第一个闭合
// `---` 结束 frontmatter；之后的全部内容都是正文并精确保留。
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

/** 把 policy spec 解析为 frontmatter 契约与保留正文；绝不抛错。 */
export function parsePolicySpec(raw: string): ParsedPolicySpec | ParseError {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { error: "策略规格必须以 '---' YAML frontmatter 块开头" };
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(m[1]!);
  } catch (e) {
    return { error: `frontmatter 不是合法 YAML：${(e as Error).message}` };
  }
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    return { error: "frontmatter 根节点必须是 YAML 对象" };
  }
  return { frontmatter: frontmatter as Record<string, unknown>, body: m[2] ?? "" };
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const SOURCES = new Set(["builtin", "custom"]);
const SURFACES = new Set(["flag", "config"]);
const LAUNCH_POSTURES = new Set(["floor", "full_bypass"]);
const DEFAULT_POSTURES = new Set(["allow", "ask", "deny"]);
const ACTION_LIST_FIELDS = ["allow", "ask", "deny", "destructive_class"] as const;

function isStringList(v: unknown): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * 按约定校验：必需标量、枚举成员、符合 surface 的互斥关系，以及标量/列表结构。
 * 仅提供建议且失败开放：返回 {ok, errors[]}，绝不抛错或执行策略。
 * 不校验 semantic-action 词汇表（由 taxonomy 668bb0d2 管理），也不解析为任何 harness 格式。
 */
export function validatePolicySpec(fm: Record<string, unknown>): ValidationResult {
  const errors: string[] = [];

  if (fm["policy_schema_version"] !== 1) errors.push("policy_schema_version 必须是数字 1");
  if (typeof fm["name"] !== "string" || (fm["name"] as string).length === 0) errors.push("name 必须是非空字符串");
  if (typeof fm["source"] !== "string" || !SOURCES.has(fm["source"] as string)) errors.push("source 必须是 'builtin' 或 'custom'");
  if (typeof fm["description"] !== "string" || (fm["description"] as string).length === 0) errors.push("description 必须是非空字符串");

  const surface = fm["surface"];
  if (typeof surface !== "string" || !SURFACES.has(surface)) {
    errors.push("surface 必须是 'flag' 或 'config'");
    return { ok: errors.length === 0, errors }; // surface 无效时无法检查该界面适用的字段。
  }

  if (surface === "flag") {
    if (!LAUNCH_POSTURES.has(fm["launch_posture"] as string)) errors.push("flag 界面策略需要 launch_posture（'floor' 或 'full_bypass'）");
    if (fm["default_posture"] !== undefined) errors.push("flag 界面策略不得携带 default_posture（config 界面字段）");
    for (const f of ACTION_LIST_FIELDS) if (fm[f] !== undefined) errors.push(`flag 界面策略不得携带 '${f}'（config 界面字段）`);
  } else {
    // config 表面
    if (fm["launch_posture"] !== undefined) errors.push("config 界面策略不得携带 launch_posture（flag 界面字段）");
    if (!DEFAULT_POSTURES.has(fm["default_posture"] as string)) errors.push("config 界面策略需要 default_posture（'allow'、'ask' 或 'deny'）");
    // Schema 要求四个 action-list 字段全部存在（无值时使用 []），不能省略。
    for (const f of ACTION_LIST_FIELDS) {
      if (fm[f] === undefined) errors.push(`config 界面策略需要 '${f}'（字符串列表；没有内容时使用 []）`);
      else if (!isStringList(fm[f])) errors.push(`${f} 必须是字符串列表`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// 确定性序列化使用的规范字段顺序；未知 key 稳定地追加在后。
const CANONICAL_ORDER = [
  "source", "name", "surface", "launch_posture", "policy_schema_version", "description",
  "default_posture", "allow", "ask", "deny", "destructive_class",
];

/**
 * 确定性的规范序列化：按规范字段顺序重新发出 frontmatter（保留未知 key，并稳定追加），
 * 再逐字附上正文。往返契约要求序列化稳定（serialize∘parse 幂等）、语义相等
 *（frontmatter 深度相等）且正文保留，而不要求与原始输入逐字节相同。
 */
export function serializePolicySpec(parsed: ParsedPolicySpec): string {
  const fm = parsed.frontmatter;
  const ordered: Record<string, unknown> = {};
  for (const k of CANONICAL_ORDER) if (fm[k] !== undefined) ordered[k] = fm[k];
  for (const k of Object.keys(fm)) if (!(k in ordered)) ordered[k] = fm[k];
  const yamlBlock = stringifyYaml(ordered).replace(/\n+$/, "");
  return `---\n${yamlBlock}\n---\n${parsed.body}`;
}
