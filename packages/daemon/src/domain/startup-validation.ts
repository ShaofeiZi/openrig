import { validateSafePath } from "./path-safety.js";
import type { StartupBlock, StartupFile, StartupAction } from "./types.js";

// -- 常量 --

const VALID_DELIVERY_HINTS = new Set(["auto", "guidance_merge", "skill_install", "send_text"]);
const VALID_ACTION_TYPES = new Set(["slash_command", "send_text", "startup_proof"]);
const VALID_PHASES = new Set(["after_files", "after_ready"]);
const VALID_APPLIES_ON = new Set(["fresh_start", "restore"]);

// -- 校验 --

/**
 * 校验一个启动文件条目。
 * @param raw 已解析的文件对象
 * @param index 在 files 数组中的位置
 * @param prefix 错误消息前缀
 * @returns 错误字符串数组
 */
export function validateStartupFile(raw: Record<string, unknown>, index: number, prefix: string): string[] {
  const errors: string[] = [];
  // Slice-03 V3：启动产物只能是文件。上下文包由 `zrig context` 组合，
  // 且只能通过专用投递动词发送。
  const kind = (raw["kind"] as string | undefined) ?? "file";
  if (kind === "context_pack") {
    errors.push(`${prefix}files[${index}]：请使用 'zrig context compose' 组合上下文包并使用专用投递动词；不支持启动 context-pack 条目`);
    return errors;
  }
  if (kind !== "file") errors.push(`${prefix}files[${index}].kind：必须为 file（收到 "${kind}"）`);
  const pathErr = validateSafePath(raw["path"] as string, `${prefix}files[${index}].path`);
  if (pathErr) errors.push(pathErr);
  if (raw["delivery_hint"] !== undefined && !VALID_DELIVERY_HINTS.has(raw["delivery_hint"] as string)) {
    errors.push(`${prefix}files[${index}].delivery_hint：必须是 ${[...VALID_DELIVERY_HINTS].join(", ")} 之一（收到 "${raw["delivery_hint"]}"）`);
  }
  if (raw["applies_on"] !== undefined) {
    if (!Array.isArray(raw["applies_on"])) {
      errors.push(`${prefix}files[${index}].applies_on：必须是数组`);
    } else {
      for (const v of raw["applies_on"]) {
        if (!VALID_APPLIES_ON.has(v as string)) {
          errors.push(`${prefix}files[${index}].applies_on：值 "${v}" 无效；必须是 ${[...VALID_APPLIES_ON].join(", ")} 之一`);
        }
      }
    }
  }
  return errors;
}

/**
 * 校验一个启动动作条目。
 * @param raw 已解析的动作对象
 * @param index 在 actions 数组中的位置
 * @param prefix 错误消息前缀
 * @returns 错误字符串数组
 */
export function validateStartupAction(raw: Record<string, unknown>, index: number, prefix: string): string[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [`${prefix}actions[${index}]：必须是对象`];
  }
  const errors: string[] = [];
  const type = raw["type"] as string;
  if (type === "shell") {
    errors.push(`${prefix}actions[${index}].type：v1 不支持 "shell" 启动动作；请使用 "slash_command" 或 "send_text"`);
  } else if (!VALID_ACTION_TYPES.has(type)) {
    errors.push(`${prefix}actions[${index}].type：必须是 ${[...VALID_ACTION_TYPES].join(", ")} 之一（收到 "${type}"）`);
  }
  if (!raw["value"] || typeof raw["value"] !== "string") {
    errors.push(`${prefix}actions[${index}].value：必须是非空字符串`);
  }
  if (type === "startup_proof") {
    if (raw["value"] !== "authenticated" && raw["value"] !== "none") {
      errors.push(`${prefix}actions[${index}].value：startup_proof 必须选择 authenticated 或 none`);
    }
    if (raw["idempotent"] !== true) {
      errors.push(`${prefix}actions[${index}].idempotent：startup_proof 选择必须为 true`);
    }
  }
  if (raw["phase"] !== undefined && !VALID_PHASES.has(raw["phase"] as string)) {
    errors.push(`${prefix}actions[${index}].phase：必须是 ${[...VALID_PHASES].join(", ")} 之一（收到 "${raw["phase"]}"）`);
  }
  if (raw["idempotent"] === undefined || raw["idempotent"] === null) {
    errors.push(`${prefix}actions[${index}].idempotent：必填字段`);
  } else if (typeof raw["idempotent"] !== "boolean") {
    errors.push(`${prefix}actions[${index}].idempotent：必须是布尔值`);
  }
  if (raw["applies_on"] !== undefined) {
    if (!Array.isArray(raw["applies_on"])) {
      errors.push(`${prefix}actions[${index}].applies_on：必须是数组`);
    } else {
      for (const v of raw["applies_on"]) {
        if (!VALID_APPLIES_ON.has(v as string)) {
          errors.push(`${prefix}actions[${index}].applies_on：值 "${v}" 无效；必须是 ${[...VALID_APPLIES_ON].join(", ")} 之一`);
        }
      }
    }
  }
  // 恢复安全：非幂等动作不得应用于 restore。这里同时覆盖显式 idempotent=false，
  // 以及缺失 idempotent 且使用默认 applies_on 的情况。
  if (raw["idempotent"] === false || raw["idempotent"] === undefined) {
    const appliesOn = Array.isArray(raw["applies_on"]) ? raw["applies_on"] as string[] : ["fresh_start", "restore"];
    if (appliesOn.includes("restore")) {
      errors.push(`${prefix}actions[${index}]：非幂等动作不得应用于 restore`);
    }
  }
  return errors;
}

/**
 * 校验启动块（files + actions）。
 * @param raw 已解析的 startup 对象
 * @param prefix 错误消息前缀
 * @returns 错误字符串数组
 */
export function validateStartupBlock(raw: unknown, prefix: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (typeof raw !== "object") return [`${prefix}：必须是对象`];
  const obj = raw as Record<string, unknown>;
  const errors: string[] = [];
  if (obj["files"] !== undefined) {
    if (!Array.isArray(obj["files"])) {
      errors.push(`${prefix}.files：必须是数组`);
    } else {
      for (let i = 0; i < (obj["files"] as unknown[]).length; i++) {
        errors.push(...validateStartupFile((obj["files"] as Record<string, unknown>[])[i]!, i, `${prefix}.`));
      }
    }
  }
  if (obj["actions"] !== undefined) {
    if (!Array.isArray(obj["actions"])) {
      errors.push(`${prefix}.actions：必须是数组`);
    } else {
      for (let i = 0; i < (obj["actions"] as unknown[]).length; i++) {
        errors.push(...validateStartupAction((obj["actions"] as Record<string, unknown>[])[i]!, i, `${prefix}.`));
      }
    }
  }
  return errors;
}

// -- 规范化 --

/**
 * 使用默认值把启动块规范化为标准类型形状。
 * @param raw 已解析的 startup 对象
 * @returns 规范化后的 StartupBlock
 */
export function normalizeStartupBlock(raw: unknown): StartupBlock {
  if (!raw || typeof raw !== "object") return { files: [], actions: [] };
  const obj = raw as Record<string, unknown>;

  const files: StartupFile[] = Array.isArray(obj["files"])
    ? (obj["files"] as Record<string, unknown>[]).map((f) => ({
          kind: "file" as const,
          path: f["path"] as string,
          deliveryHint: (f["delivery_hint"] as StartupFile["deliveryHint"]) ?? "auto",
          required: f["required"] !== false,
          appliesOn: Array.isArray(f["applies_on"])
            ? (f["applies_on"] as StartupFile["appliesOn"])
            : ["fresh_start", "restore"],
        }))
    : [];

  const actions: StartupAction[] = Array.isArray(obj["actions"])
    ? (obj["actions"] as Record<string, unknown>[]).map((a) => ({
        type: a["type"] as StartupAction["type"],
        value: a["value"] as string,
        phase: (a["phase"] as StartupAction["phase"]) ?? "after_files",
        appliesOn: Array.isArray(a["applies_on"])
          ? (a["applies_on"] as StartupAction["appliesOn"])
          : ["fresh_start", "restore"],
        idempotent: a["idempotent"] as boolean,
      }))
    : [];

  return { files, actions };
}
