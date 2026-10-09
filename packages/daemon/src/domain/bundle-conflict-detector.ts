/**
 * Bundle 冲突检测器（Item 3 / slice-05 Checkpoint 4.1）。
 *
 * 纯函数。比较 bundle 声明的标识符与后台服务当前状态，并返回结构化冲突报告。
 * 调用方（Checkpoint 4.2 的路由 handler）提供后台服务状态（listRigs() 等）；
 * 检测器本身不依赖后台服务，可完整地进行单元测试。
 *
 * 采用失败关闭策略：冲突列表是唯一事实来源。缺失或有歧义的输入被视为无法检测冲突，
 * 而不是绕过；Items 4.2+ 会在适当位置把歧义呈现为冲突。本提交仅交付工作组名称冲突检查；
 * agent / port / managed-app / sibling-primitive 检查在 Checkpoint 4.3 + 4.4 落地。
 *
 * 按 PRD Item 3 的“扩展而非替换”要求，本检测扩展但不替换
 * /api/bundles/install 现有的 409 "install already in progress" 并发锁守卫。
 */

/** 工作组名称冲突：bundle 声明的工作组名称已被运行中的工作组使用。 */
export interface RigNameCollision {
  kind: "rig_name_collision";
  /** bundle 的 rig spec 声明的名称。 */
  bundleRigName: string;
  /** 占用同名名称的运行中工作组身份。 */
  collisionWith: { rigId: string; rigName: string };
  /** 适合作为三段式错误描述行的人类可读摘要。 */
  description: string;
  /** 操作员可执行的解决方案（三段式错误的操作建议行）。 */
  resolutions: string[];
}

/** 所有冲突类型的可辨识联合；在 Checkpoint 4.3+ 扩展。 */
export type BundleConflict = RigNameCollision;

/** 冲突检查结果。 */
export interface ConflictReport {
  conflicts: BundleConflict[];
  hasConflicts: boolean;
}

/** detectBundleConflicts 的输入；仅含数据，不含后台服务句柄。 */
export interface DetectConflictsInput {
  /** bundle 的 rig spec（rig.yaml 的 `name:` 字段）声明的工作组名称。 */
  bundleRigName: string;
  /** rigRepo.listRigs() 返回的当前运行中工作组快照。 */
  runningRigs: Array<{ rigId: string; name: string }>;
}

/**
 * 对安装候选项执行冲突检查并返回完整冲突列表。Checkpoint 4.2 通过
 * /install --plan 返回该列表；除非使用 --force，否则 --apply 会在列表非空时阻止安装。
 */
export function detectBundleConflicts(input: DetectConflictsInput): ConflictReport {
  const conflicts: BundleConflict[] = [];

  // 工作组名称冲突：bundle 声明了一个已被运行中工作组占用的名称。
  // 对 runningRigs 执行 O(n) 扫描；后台服务管理的工作组是席位量级（数十而非数千），可接受。
  if (input.bundleRigName && input.bundleRigName.length > 0) {
    for (const rig of input.runningRigs) {
      if (rig.name === input.bundleRigName) {
        conflicts.push({
          kind: "rig_name_collision",
          bundleRigName: input.bundleRigName,
          collisionWith: { rigId: rig.rigId, rigName: rig.name },
          description: `包声明了工作组名 '${input.bundleRigName}'，但已有同名工作组正在运行（rigId：${rig.rigId}）`,
          resolutions: [
            "安装时使用 --target <newname> 重命名工作组（落在检查点 4.2）",
            `先停止运行中的工作组（例如 zrig down ${rig.name}），再重试安装`,
            "安装时使用 --force 明确覆盖（落在检查点 4.2；不建议日常使用）",
          ],
        });
        break;
      }
    }
  }

  return { conflicts, hasConflicts: conflicts.length > 0 };
}
