// Slice 09——推荐默认值（组件 3 的 6×7 矩阵及组件 4 的范围）。

import { describe, it, expect } from "vitest";
import {
  DEFAULT_STALE_RULE,
  RECOMMENDED_DEFAULT_SCOPE,
  RECOMMENDED_MODE_DEFAULTS,
} from "../src/domain/rig-mode/rig-mode-defaults.js";
import {
  OPERATOR_CONTEXT_MODES,
  SAFE_PERMISSION_PROMPT_POSTURES,
} from "../src/domain/rig-mode/rig-mode-types.js";
import { validateRecord } from "../src/domain/rig-mode/rig-mode-validator.js";

describe("rig-mode 默认值——slice 09 的组件 3 与组件 4", () => {
  // HG-6——每种模式在 6×7 矩阵中都有默认行。
  it("HG-6：每种模式都有推荐默认值行", () => {
    for (const mode of OPERATOR_CONTEXT_MODES) {
      expect(RECOMMENDED_MODE_DEFAULTS[mode]).toBeDefined();
    }
    expect(Object.keys(RECOMMENDED_MODE_DEFAULTS).sort()).toEqual([...OPERATOR_CONTEXT_MODES].sort());
  });

  // HG-6——每种模式都有默认范围。
  it("HG-6：每种模式都有推荐默认范围", () => {
    for (const mode of OPERATOR_CONTEXT_MODES) {
      expect(RECOMMENDED_DEFAULT_SCOPE[mode]).toBeDefined();
    }
    expect(Object.keys(RECOMMENDED_DEFAULT_SCOPE).sort()).toEqual([...OPERATOR_CONTEXT_MODES].sort());
  });

  // HG-SAFE——每个默认 permission_prompt_posture 都必须属于三个 SAFE 值之一。
  // 即使在默认值层也要防御：不允许发布违反“不得自动接受”规则的默认值。
  it("HG-SAFE：每种模式的默认 permission_prompt_posture 都属于 SAFE_PERMISSION_PROMPT_POSTURES", () => {
    for (const mode of OPERATOR_CONTEXT_MODES) {
      const def = RECOMMENDED_MODE_DEFAULTS[mode];
      expect(SAFE_PERMISSION_PROMPT_POSTURES).toContain(def.permission_prompt_posture);
    }
  });

  // 抽查约定表中的具体值，捕获事实源文档与发布默认值之间的静默漂移。
  it("与约定中组件 3 的 sleep/debug/mobile 表格一致（承重行）", () => {
    expect(RECOMMENDED_MODE_DEFAULTS.sleep).toMatchObject({
      autonomy_scope: "pre_approved_only",
      heartbeat_cadence: "sparse",
      escalation_threshold: "blocker_only",
      concurrency_limit: "serial",
      permission_prompt_posture: "batch_for_human",
    });
    expect(RECOMMENDED_MODE_DEFAULTS.debug).toMatchObject({
      autonomy_scope: "bounded_continuation",
      heartbeat_cadence: "fast",
      inspection_depth: "forensic",
      update_detail: "verbose",
      concurrency_limit: "serial",
      // 根据约定组件 6 及应用证明：debug 不扩大默认权限，姿态保持 `normal`。
      permission_prompt_posture: "normal",
    });
    expect(RECOMMENDED_MODE_DEFAULTS.mobile).toMatchObject({
      autonomy_scope: "bounded_continuation",
      inspection_depth: "surface",
      escalation_threshold: "low",
      permission_prompt_posture: "batch_for_human",
    });
  });

  it("与约定中组件 4 的默认范围表一致", () => {
    expect(RECOMMENDED_DEFAULT_SCOPE).toEqual({
      sleep: "global_host",
      away: "global_host",
      desk: "global_host",
      mobile: "global_host",
      focus: "workstream",
      debug: "qitem",
      "human-led": "rig",
      delegated: "rig",
    });
  });

  // 按约定 Q3，数值阈值暂缓；v0 选择规则种类 `re_confirm_on_long_gap` 作为保守默认值。
  it("DEFAULT_STALE_RULE 是约定中的保守重新确认规则种类", () => {
    expect(DEFAULT_STALE_RULE).toBe("re_confirm_on_long_gap");
  });

  // 端到端：由默认值、默认范围和默认过期规则组装的完整记录必须通过校验。
  // 这是默认值能组成有效 v0 记录的可执行证明，不允许静默丢字段或增加字段。
  it("HG-6 可执行证明：每种模式的默认值、默认范围和 DEFAULT_STALE_RULE 均组成可通过校验的记录（记录 10 个字段；mode 位于绑定而非记录内）", () => {
    for (const mode of OPERATOR_CONTEXT_MODES) {
      const defaults = RECOMMENDED_MODE_DEFAULTS[mode];
      const scope = RECOMMENDED_DEFAULT_SCOPE[mode];
      const record = {
        ...defaults,
        scope,
        expiry_or_stale_rule: DEFAULT_STALE_RULE,
        evidence_citation: `operator confirmed ${mode}`,
      };
      // 记录本身必须恰好有 10 个字段（组件 3 的冻结契约），同时固定字段集合完整性。
      expect(Object.keys(record).length).toBe(10);
      const result = validateRecord(record);
      expect(result.ok).toBe(true);
    }
  });
});
