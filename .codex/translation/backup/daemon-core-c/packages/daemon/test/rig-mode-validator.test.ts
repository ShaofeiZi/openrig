// 切片 09 — 校验器(运行时防御 + 调用消歧)。

import { describe, it, expect } from "vitest";
import {
  REQUIRED_RECORD_FIELDS,
  disambiguateModeInvocation,
  validateModeName,
  validateRecord,
} from "../src/domain/rig-mode/rig-mode-validator.js";

// 依据守卫 BLOCKING-1:该记录是冻结的组件 3 十字段设置模式(schema)。
// `mode`(组件 2 词表)位于绑定层,而不在此记录内部。
// 因此 validRecord() 恰好有 10 个字段且不含 `mode`。
function validRecord(): Record<string, unknown> {
  return {
    autonomy_scope: "bounded_continuation",
    heartbeat_cadence: "fast",
    inspection_depth: "forensic",
    update_detail: "verbose",
    escalation_threshold: "low",
    concurrency_limit: "serial",
    permission_prompt_posture: "normal",
    scope: "qitem",
    expiry_or_stale_rule: "re_confirm_on_long_gap",
    evidence_citation: "qitem-20260518000000-abc",
  };
}

describe("validateRecord — 切片 09 冻结契约", () => {
  it("HG-2:接收一个由合法枚举值填充全部 10 个字段的记录", () => {
    const result = validateRecord(validRecord());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(REQUIRED_RECORD_FIELDS.every((f) => f in result.record)).toBe(true);
    }
  });

  // 来自守卫裁决 qitem-20260518043346 的 BLOCKING-1 判别条件:
  // 该记录必须是组件 3 的那 10 个设置字段。
  // 向记录中添加 `mode` 会被当作未知的额外字段拒绝
  // (mode 属于绑定边界,不在记录中)。
  it("HG-2:恰好 10 个必填字段,没有名为 `mode` 的字段(组件 3 契约)", () => {
    expect(REQUIRED_RECORD_FIELDS.length).toBe(10);
    expect(REQUIRED_RECORD_FIELDS as readonly string[]).not.toContain("mode");
    const valid = validRecord();
    expect(Object.keys(valid).length).toBe(10);
    expect(Object.keys(valid)).not.toContain("mode");
  });

  it("HG-2:包含 `mode` 的记录会被当作未知字段拒绝(mode 是绑定层字段)", () => {
    const result = validateRecord({ ...validRecord(), mode: "debug" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes(`Unknown field "mode"`))).toBe(true);
    }
  });

  // HG-2 反例:缺失字段会被拒绝,并一次性收集全部错误
  // (依据三段式错误原则 —— 运维人员一轮就能看到完整差异,
  // 而不是每重试一次才报一个错误)。
  it("HG-2 反例:缺少任意单个字段的记录会被拒绝并给出三段式错误", () => {
    for (const field of REQUIRED_RECORD_FIELDS) {
      const record = validRecord();
      delete record[field];
      const result = validateRecord(record);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.some((e) => e.includes(`Missing required field "${field}"`))).toBe(true);
      }
    }
  });

  it("HG-2 反例:未知字段会被拒绝并给出封闭模式(schema)提示(禁止扩展)", () => {
    const record = { ...validRecord(), extra_field: "value" };
    const result = validateRecord(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes(`Unknown field "extra_field"`))).toBe(true);
    }
  });

  // HG-1 反例:同义词 / 数字别名在运行时被拒绝,
  // 尽管类型系统已在编译期拦截它们。
  // 这是针对类型表面之外来源的纵深防御 ——
  // JSON 文件、环境变量、HTTP 请求体。
  it("HG-1 运行时反例:同义词(`dnd`、`ooo`、`bed`)会被 validateModeName 拒绝", () => {
    for (const bad of ["dnd", "ooo", "bed", "office", "commute"]) {
      const result = validateModeName(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.includes(`mode="${bad}"`)).toBe(true);
      }
    }
  });

  it("HG-1 运行时反例:数字 / 带命名空间的数字别名会被 validateModeName 拒绝", () => {
    for (const bad of ["L0", "L1", "L2", "L3", "operator:L0", "operator:L2"]) {
      const result = validateModeName(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.includes(`mode="${bad}"`)).toBe(true);
      }
    }
  });

  it("HG-1 运行时反例:大小写变体会被 validateModeName 拒绝(小写单词词表)", () => {
    for (const bad of ["Sleep", "DEBUG", "Mobile", "FOCUS"]) {
      const result = validateModeName(bad);
      expect(result.ok).toBe(false);
    }
  });

  it("HG-1 正例:validateModeName 接受六个保留模式中的每一个", () => {
    for (const m of ["sleep", "desk", "mobile", "away", "focus", "debug"]) {
      const result = validateModeName(m);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.mode).toBe(m);
    }
  });

  // HG-SAFE(运行时)—— 在类型系统之外,自动接受也在校验器处被拒绝。
  // 这是 JSON / 环境变量 / HTTP 请求体输入所走的路径;
  // 此处的运行时拦截是关键环节。
  it("HG-SAFE 运行时:permission_prompt_posture='auto_accept' 被拒绝", () => {
    const forbidden = ["auto_accept", "auto", "accept_all", "allow_all", "yes_to_all"];
    for (const bad of forbidden) {
      const result = validateRecord({ ...validRecord(), permission_prompt_posture: bad });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.errors.some((e) =>
            e.includes(`permission_prompt_posture="${bad}"`)
            && e.includes("normal, batch_for_human, do_not_prompt_unless_blocked"),
          ),
        ).toBe(true);
      }
    }
  });

  // HG-SAFE 正例:只接受三个已记录的合法值。
  it("HG-SAFE 正例:恰好接受三个合法值", () => {
    for (const safe of ["normal", "batch_for_human", "do_not_prompt_unless_blocked"]) {
      const result = validateRecord({ ...validRecord(), permission_prompt_posture: safe });
      expect(result.ok).toBe(true);
    }
  });

  it("HG-3 反例:未知 scope 被拒绝", () => {
    const result = validateRecord({ ...validRecord(), scope: "all_rigs" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes(`scope="all_rigs"`))).toBe(true);
    }
  });

  it("HG-8 反例:静默切换类过期规则值被拒绝(`auto_switch` 等)", () => {
    for (const bad of ["auto_switch", "switch_on_long_gap", "drift_switch"]) {
      const result = validateRecord({ ...validRecord(), expiry_or_stale_rule: bad });
      expect(result.ok).toBe(false);
    }
  });

  it("evidence_citation 缺失或为空时被拒绝", () => {
    const empty = validateRecord({ ...validRecord(), evidence_citation: "" });
    expect(empty.ok).toBe(false);
    const whitespace = validateRecord({ ...validRecord(), evidence_citation: "   " });
    expect(whitespace.ok).toBe(false);
  });

  it("提前拒绝非对象输入", () => {
    expect(validateRecord(null).ok).toBe(false);
    expect(validateRecord("hello").ok).toBe(false);
    expect(validateRecord([validRecord()]).ok).toBe(false);
    expect(validateRecord(42).ok).toBe(false);
  });

  it("一次遍历报告多个错误(一次性收集)", () => {
    const record = {
      ...validRecord(),
      scope: "BadScope",
      permission_prompt_posture: "auto_accept",
      heartbeat_cadence: "instant",
    };
    const result = validateRecord(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("disambiguateModeInvocation — 切片 09 §组件 4 裸词消歧", () => {
  it("裸保留字 → 调用", () => {
    for (const m of ["sleep", "desk", "mobile", "away", "focus", "debug"]) {
      expect(disambiguateModeInvocation(m)).toBe(m);
    }
  });

  it("`mode:` 前缀 → 调用(大小写不敏感)", () => {
    expect(disambiguateModeInvocation("mode: mobile")).toBe("mobile");
    expect(disambiguateModeInvocation("Mode:debug")).toBe("debug");
    expect(disambiguateModeInvocation("MODE : sleep")).toBe("sleep");
  });

  it("词嵌在句子中 → 不是调用(调用方按话题处理)", () => {
    expect(disambiguateModeInvocation("I want to debug the auth flow")).toBeNull();
    expect(disambiguateModeInvocation("let me grab my mobile")).toBeNull();
  });

  it("不是保留模式的裸词 → null(调用方只询问一次)", () => {
    expect(disambiguateModeInvocation("dnd")).toBeNull();
    expect(disambiguateModeInvocation("commute")).toBeNull();
    expect(disambiguateModeInvocation("L2")).toBeNull();
  });

  it("空 / 仅空白输入 → null", () => {
    expect(disambiguateModeInvocation("")).toBeNull();
    expect(disambiguateModeInvocation("   ")).toBeNull();
  });

  it("裸词保留模式大小写不敏感", () => {
    expect(disambiguateModeInvocation("DEBUG")).toBe("debug");
    expect(disambiguateModeInvocation("Sleep")).toBe("sleep");
  });
});
