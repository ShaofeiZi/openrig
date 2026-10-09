// OPR.0.5.3.5 Q3 harness 桥接（mini-req 8，按桌面裁决 9103302d 修订）：
// slice-05 的行为探针与 slice-07 的选择/加载用例在同一个实时模型评估 harness 中执行，
// 并归入 "behavior" 用例类别——一套 harness、一个 runner、一道评分门；
// 两个 runner 会让评估约定本身分叉，正是本版本持续消除的漂移类别。
//
// 此桥接刻意采用数据形态：把 atom 探针（mini-req 1 元数据）编译为普通评估用例对象，
// 由 harness 在加载时通过自己的 schema 校验——与人工编写 YAML 用例的传递方式完全相同。
// 不从 harness 模块导入，因此产品侧与测试系统侧通过数据解耦（schema 自身声明的设计是
// “不跨 package 导入 TS”），单 harness 属性由构造保证，而不是依赖纪律。

import type { ContextPackManifest } from "./context-pack-types.js";

/** harness 声明式格式中的普通评估用例对象。该形状以 harness 的 validateEvalCase
 *  为权威；桥接只负责发出数据。 */
export type CompiledEvalCaseData = Record<string, unknown>;

/**
 * 把 manifest 中每个带探针的 atom 编译为 behavior 类评估用例数据。
 * 没有探针的 atom 会被跳过（探针是验收证据，不是义务）。用 pack ref
 * 给用例 id 加命名空间，避免多个 pack 的用例在同一次 harness 运行中冲突。
 *
 * 逐字段映射如下：
 *   id               <- <packRef>/<atomId>
 *   name             <- probe.expect（可观察行为契约本身就是用例的人类名称，评分者首先读取它）
 *   category         <- "behavior"
 *   prompt           <- probe.prompt（自然语言提示，mini-req 2）
 *   expectedPatterns <- probe.expectedPatterns（确定性门禁腿；manifest 摄取时校验可编译）
 *   rubric           <- probe.rubric，否则使用 expect 文案（判分腿至少有行为契约可据）
 */
export interface CompiledProbeCases {
  cases: CompiledEvalCaseData[];
  /** 无法变成 harness 用例的探针及其原因——调用方必须暴露这一边界，不得静默截断。
   *  缺少 expectedPatterns 的探针没有确定性门禁腿；桥接既不从文案臆造 pattern，
   *  也不会静默丢掉 atom。 */
  skipped: Array<{ atomId: string; reason: string }>;
}

export function compileAtomProbesToEvalCases(manifest: ContextPackManifest, packRef: string): CompiledProbeCases {
  const cases: CompiledEvalCaseData[] = [];
  const skipped: CompiledProbeCases["skipped"] = [];
  for (const atom of manifest.atoms ?? []) {
    if (!atom.probe) continue;
    if (!atom.probe.expectedPatterns || atom.probe.expectedPatterns.length === 0) {
      skipped.push({
        atomId: atom.id,
        reason: "探针没有 expectedPatterns——harness 的确定性门禁至少需要一个可编译 pattern；请在 atom 的 probe 中编写",
      });
      continue;
    }
    cases.push({
      id: `${packRef}/${atom.id}`,
      name: atom.probe.expect,
      category: "behavior",
      prompt: atom.probe.prompt,
      expectedPatterns: atom.probe.expectedPatterns,
      rubric: atom.probe.rubric ?? atom.probe.expect,
    });
  }
  return { cases, skipped };
}
