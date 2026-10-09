// schema-validator.ts — 根据 v0 JSON Schema 验证 restore-summary.json
// （packages/cli/src/schemas/restore-summary.schema.json）。
//
// 根据 M1 契约 § 8 + IMPL § M2 第 167 行：
// - 生成器端：在原子重命名包目录之前，根据 schema 发出时自检。
// - 操作者端：M3 `rig restore-packet validate <packet-dir>` 运行此
//   验证器并暴露逐字段违规。
//
// 验证器返回带 `valid` 和逐字段错误列表的 ValidationResult。
// 每个错误命名：字段路径、值（截断/转义）、规则和严重程度。
// 必需字段违规为 `error` 严重程度；可选字段格式错误为
// `warning` 严重程度（根据 § 8）。
//
// M2a R2 打包修复：schema 直接嵌入本模块作为类型化 TS 常量
// （RESTORE_SUMMARY_SCHEMA），而不是在运行时从同级 .json 文件读取。
// tsc 将常量发射到编译后的验证器 JS 中，因此验证器在 `tsc`
// 发射后即可工作，无需额外的构建脚本复制步骤。规范 JSON Schema 文件
// `packages/cli/src/schemas/restore-summary.schema.json` 仍是下游
// IDE/工具消费的真相来源；`test/restore-packet.test.ts` 中的漂移捕获
// 测试断言两者保持字节一致。

import Ajv from "ajv";
import addFormats from "ajv-formats";

export interface ValidationError {
  field: string;
  value: string;
  rule: string;
  severity: "error" | "warning";
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// RESTORE_SUMMARY_SCHEMA — `packages/cli/src/schemas/restore-summary.schema.json`
// 的逐字镜像。保持同步；漂移捕获测试强制等价。
export const RESTORE_SUMMARY_SCHEMA: Record<string, unknown> = {
  $schema: "http://json-schema.org/draft-07/schema#",
  $id: "https://openrig.dev/schemas/restore-summary.schema.json",
  title: "Restore Packet Summary",
  description:
    "Machine-readable metadata for a cross-runtime restore packet per the v0 paper standard.",
  type: "object",
  required: [
    "source_session_id",
    "source_rig",
    "source_runtime",
    "source_cwd",
    "target_rig",
    "target_runtime",
    "target_workspace_root",
    "default_target_repo",
    "role_pointer",
    "bounded_latest_transcript",
    "touched_files",
    "durable_pointers",
    "current_work_summary",
    "next_owner",
    "caveats",
    "authority_boundaries",
    "omitted_classes",
    "redaction_policy_id",
    "source_trust_ranking",
    "generator_version",
    "generated_at",
  ],
  properties: {
    source_session_id: { type: "string", minLength: 1 },
    source_rig: { type: "string", minLength: 1 },
    source_runtime: {
      type: "string",
      enum: ["claude-code", "codex", "terminal", "external"],
    },
    source_cwd: { type: "string", pattern: "^/" },
    target_rig: { type: "string", minLength: 1 },
    target_runtime: {
      type: "string",
      enum: ["claude-code", "codex", "terminal", "external"],
    },
    target_workspace_root: { type: "string", pattern: "^/" },
    default_target_repo: { type: ["string", "null"] },
    role_pointer: {
      type: "string",
      minLength: 1,
      description:
        "Path or URI pointing to the role guidance file the restored seat should consume. REQUIRED per v0 standard field #9; resolves at restore time.",
    },
    bounded_latest_transcript: {
      type: "object",
      required: ["path", "message_count", "bound"],
      properties: {
        path: { type: "string" },
        message_count: {
          type: "integer",
          minimum: 0,
          description: "Actual count of extracted messages in transcript-latest.md.",
        },
        bound: {
          type: "integer",
          const: 120,
          description:
            "v0 bound is fixed at 120 messages to match Velocity prior art (per contract § 7). v1+ may make configurable; v0 schema requires const 120 so packets with the wrong bound cannot pass.",
        },
      },
    },
    full_transcript: {
      type: "object",
      properties: {
        path: { type: "string" },
        line_count: { type: "integer", minimum: 0 },
      },
      description:
        "Optional per v0 standard field #11. Generator emits when full transcript material is available (e.g., from --source-jsonl or full-read --source-session); omitted otherwise.",
    },
    touched_files: {
      type: "object",
      required: ["path", "top_paths"],
      properties: {
        path: { type: "string" },
        top_paths: {
          type: "array",
          items: {
            type: "object",
            required: ["path", "count"],
            properties: {
              path: { type: "string" },
              count: { type: "integer", minimum: 0 },
            },
          },
        },
      },
    },
    durable_pointers: {
      type: "object",
      required: [
        "queue_pointers",
        "progress_pointers",
        "field_note_pointers",
        "artifact_pointers",
      ],
      properties: {
        queue_pointers: {
          type: "array",
          items: { type: "string" },
          description: "References to durable queue items (qitem ids or queue-file paths).",
        },
        progress_pointers: {
          type: "array",
          items: { type: "string" },
          description: "References to PROGRESS.md cursors the source seat was operating against.",
        },
        field_note_pointers: {
          type: "array",
          items: { type: "string" },
          description: "References to field-notes folders or files.",
        },
        artifact_pointers: {
          type: "array",
          items: { type: "string" },
          description: "Other durable artifacts (proof packets, slice packets, candidate dossiers).",
        },
      },
      description:
        "REQUIRED per v0 standard field #13. Pointers to durable work the source seat was operating against; restored seat reads to recover work-context.",
    },
    current_work_summary: { type: "string", minLength: 1 },
    next_owner: { type: "string", minLength: 1 },
    caveats: { type: "array", items: { type: "string" } },
    authority_boundaries: { type: "string", minLength: 1 },
    omitted_classes: {
      type: "array",
      items: {
        type: "string",
        enum: ["reasoning_records", "raw_tool_outputs", "function_call_output", "redacted_secrets"],
      },
    },
    redaction_policy_id: { type: "string", enum: ["velocity-v1", "openrig-v0"] },
    source_trust_ranking: {
      type: "array",
      items: {
        type: "string",
        enum: [
          "rig_whoami",
          "target_rigspec",
          "bounded_latest_transcript",
          "full_transcript",
          "touched_files",
          "restore_summary",
        ],
      },
      minItems: 1,
    },
    generator_version: { type: "string", minLength: 1 },
    generated_at: { type: "string", format: "date-time" },
  },
  additionalProperties: false,
};

let cachedValidator: ReturnType<Ajv["compile"]> | null = null;

function getValidator(): ReturnType<Ajv["compile"]> {
  if (cachedValidator) return cachedValidator;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  cachedValidator = ajv.compile(RESTORE_SUMMARY_SCHEMA);
  return cachedValidator;
}

function truncateValue(value: unknown): string {
  if (value === undefined) return "<undefined>";
  if (value === null) return "null";
  let s: string;
  try {
    s = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s.length > 80) return s.slice(0, 77) + "...";
  return s;
}

export function validateRestoreSummary(summary: unknown): ValidationResult {
  const validator = getValidator();
  const ok = validator(summary);
  if (ok) {
    return { valid: true, errors: [] };
  }
  const errors: ValidationError[] = (validator.errors ?? []).map((err) => {
    const instancePath = err.instancePath || "";
    const missing = err.params && (err.params as { missingProperty?: string }).missingProperty;
    const additional = err.params && (err.params as { additionalProperty?: string }).additionalProperty;
    let field = instancePath.replace(/^\//, "").replace(/\//g, ".");
    if (missing) field = field ? `${field}.${missing}` : missing;
    if (additional) field = additional;
    // 根据 M1 契约 § 8 + IMPL § M3：可选字段格式错误为
    // "warning" 严重程度；必需字段违规为 "error" 严重程度。
    // v0 中唯一的顶层可选字段是 `full_transcript`。
    // 路径以 `/full_transcript` 开头的错误来自验证
    // 可选对象的内容，而不是必需字段上的缺失检查。
    const isOptionalFieldError = instancePath.startsWith("/full_transcript");
    return {
      field: field || "<root>",
      value: truncateValue(err.data),
      rule: `${err.keyword}: ${err.message ?? ""}`.trim(),
      severity: isOptionalFieldError ? "warning" : "error",
    };
  });
  // 任何 ajv 违规时 `valid` 为 false（保留 M2c 写入器
  // 语义：任何格式错误都应阻塞原子重命名）。M3
  // validate 命令根据 `errors[].severity` 决定退出码
  // （根据 M1 契约 § 8：必需字段类错误 → 非零退出；
  // 可选字段警告 → 退出 0 并输出警告文本）。
  return { valid: false, errors };
}
