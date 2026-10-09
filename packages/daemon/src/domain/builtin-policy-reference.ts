// OPR.0.4.8.3 —— 内置策略参考资料实体化器（guard 封存计划 v2 eea3c778）。
// 将随包提供的内置策略投射到稳定的检查路径
// $OPENRIG_HOME/reference/policies/builtin/，使操作员无需深入安装目录树即可
// 阅读（并复制后定制）这些策略。
//
// 契约（guard 裁定）：
//   - 只实体化已知的四个内置策略 locked|standard|open|yolo；绝不复制随包目录中的
//     陌生文件。
//   - 副本逐字节一致，权限为 0444，只用于只读检查。该权限是“复制后定制”的使用
//     提示，不是安全边界；刷新和内容跳过两条路径都要校正权限，并且绝不作用于用户
//     的自定义副本（本模块只写入 targetDir 下四个稳定名称）。
//   - 尽力而为：随包目录或文件缺失时按名称跳过，绝不抛出异常。不提供解析器或写入
//     表面——路径由调用方注入（启动流程负责接入随包目录结构）。
import * as fs from "node:fs";
import * as nodePath from "node:path";

export const BUILTIN_POLICY_NAMES = ["locked", "standard", "open", "yolo"] as const;

export interface MaterializeBuiltinPolicyReferenceDeps {
  /** 随包源目录（后台服务 dist 旁的 …/policies/builtin）。 */
  bundledDir: string;
  /** 稳定目标目录（$OPENRIG_HOME/reference/policies/builtin）。 */
  targetDir: string;
}

export interface MaterializeBuiltinPolicyReferenceResult {
  written: string[];
  skipped: string[];
}

const READ_ONLY_MODE = 0o444;

export function materializeBuiltinPolicyReference(
  deps: MaterializeBuiltinPolicyReferenceDeps,
): MaterializeBuiltinPolicyReferenceResult {
  const written: string[] = [];
  const skipped: string[] = [];
  fs.mkdirSync(deps.targetDir, { recursive: true });
  for (const name of BUILTIN_POLICY_NAMES) {
    const file = `${name}.policy.md`;
    const source = nodePath.join(deps.bundledDir, file);
    const target = nodePath.join(deps.targetDir, file);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(source);
    } catch {
      skipped.push(file); // 源缺失：记录名称但不抛出异常（尽力而为）。
      continue;
    }
    const upToDate = (() => {
      try {
        return fs.readFileSync(target).equals(bytes);
      } catch {
        return false;
      }
    })();
    if (upToDate) {
      // 内容未变而跳过写入时，仍要校正检查副本的权限。
      fs.chmodSync(target, READ_ONLY_MODE);
      continue;
    }
    // 刷新可能只读的副本：先解除链接再写入，避免 chmod 竞态。
    fs.rmSync(target, { force: true });
    fs.writeFileSync(target, bytes, { mode: READ_ONLY_MODE });
    fs.chmodSync(target, READ_ONLY_MODE); // 不受 umask 影响：权限本身就是契约。
    written.push(file);
  }
  return { written, skipped };
}
