// Slice 09——类型级判别项（OPR.0.3.2.9）。
//
// 这些测试锚定 FROZEN 约定的词汇，以及 HG-SAFE 对 auto-accept 的结构性阻断。它们的 runtime
// 覆盖较薄（由于封闭 union，大部分覆盖位于类型层），但会断言常量数组与类型 union 一致，使值列表
// 与类型 alias 的未来漂移在此暴露。

import { describe, it, expect } from "vitest";
import {
  OPERATOR_CONTEXT_MODES,
  OPERATOR_CONTEXT_SCOPES,
  SAFE_PERMISSION_PROMPT_POSTURES,
  SCOPE_SPECIFICITY,
  STALE_RULES,
} from "../src/domain/rig-mode/rig-mode-types.js";

describe("rig-mode 类型——slice 09 冻结契约", () => {
  // HG-1——六种 mode，精确、保留、封闭。
  it("HG-1：公开 legacy 和显式 operating-posture mode 名称", () => {
    expect([...OPERATOR_CONTEXT_MODES]).toEqual([
      "sleep",
      "desk",
      "mobile",
      "away",
      "focus",
      "debug",
      "human-led",
      "delegated",
    ]);
    for (const m of OPERATOR_CONTEXT_MODES) {
      expect(m).toMatch(/^[a-z]+(?:-[a-z]+)?$/);
    }
  });

  // HG-1 负例——同义词和数字 alias 不在列表中。L0–L3 冲突警告是承重行为；带 namespace 的数字
  // 形式（如 `operator:L2`）同样禁止。
  it("HG-1 负例：禁止的同义词与 alias 不存在", () => {
    const forbidden = [
      "dnd",
      "ooo",
      "commute",
      "bed",
      "office",
      "L0",
      "L1",
      "L2",
      "L3",
      "operator:L0",
      "operator:L2",
      "Sleep",
      "DEBUG",
    ];
    for (const f of forbidden) {
      expect(OPERATOR_CONTEXT_MODES as readonly string[]).not.toContain(f);
    }
  });

  // HG-3——四种 scope，精确、保留。
  it("HG-3：公开 legacy 和 project/mission scope 名称", () => {
    expect([...OPERATOR_CONTEXT_SCOPES]).toEqual([
      "global_host",
      "rig",
      "project",
      "mission",
      "workstream",
      "qitem",
    ]);
  });

  // HG-3——scope specificity rank 支持“更具体者胜出”的解析
  //（qitem > workstream > rig > global_host）。
  it("HG-3：scope specificity rank 支持更具体者胜出的解析", () => {
    expect(SCOPE_SPECIFICITY.qitem).toBeGreaterThan(SCOPE_SPECIFICITY.workstream);
    expect(SCOPE_SPECIFICITY.workstream).toBeGreaterThan(SCOPE_SPECIFICITY.rig);
    expect(SCOPE_SPECIFICITY.rig).toBeGreaterThan(SCOPE_SPECIFICITY.global_host);
  });

  // HG-SAFE——permission_prompt_posture 在结构上排除 auto-accept。常量列表镜像 union，而 union 不含
  // auto-accept 字面量，因此调用方无法通过类型系统表达 auto-accept。runtime validator 对绕过类型的
  // 输入（JSON、env 等）执行相同约束，见 rig-mode-validator 测试。
  it("HG-SAFE（类型层）：SAFE_PERMISSION_PROMPT_POSTURES 枚举仅有的三个安全值，不含 auto-accept", () => {
    expect([...SAFE_PERMISSION_PROMPT_POSTURES]).toEqual([
      "normal",
      "batch_for_human",
      "do_not_prompt_unless_blocked",
    ]);
    const forbidden = [
      "auto_accept",
      "autoaccept",
      "auto",
      "accept_all",
      "allow_all",
      "yes_to_all",
    ];
    for (const f of forbidden) {
      expect(SAFE_PERMISSION_PROMPT_POSTURES as readonly string[]).not.toContain(f);
    }
  });

  // HG-8——枚举 drift rule；不存在 silent-switch 值。规则值会触发重新确认（提问），不会自动应用
  // mode 变更。
  it("HG-8：stale 规则枚举重新确认触发器，不含 silent-switch 值", () => {
    expect([...STALE_RULES]).toEqual([
      "none",
      "re_confirm_on_long_gap",
      "re_confirm_on_day_boundary",
      "re_confirm_on_observed_conflict",
    ]);
    const forbidden = [
      "auto_switch",
      "switch_on_long_gap",
      "switch_on_day_boundary",
      "drift_switch",
    ];
    for (const f of forbidden) {
      expect(STALE_RULES as readonly string[]).not.toContain(f);
    }
  });
});
