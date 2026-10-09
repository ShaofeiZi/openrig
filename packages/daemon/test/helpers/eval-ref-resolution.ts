/**
 * slice-07 修复 1+2 复审（HIGH-1）——单一共享的案例到引用校验器，同时供评估运行的
 * 预检与护栏测试使用。生产包目录由外部传入（调用方在临时目录中隔离构建），因此解析
 * 永不依赖被 git 忽略的工作树残留。
 *
 * 粒度为逐案例：每个案例恰好产生一个 CaseRefResolution，因此未产生标准引用，或引用
 * 不存在于已构建生产包中的案例，会按名称失败（绝不会消失）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalCase, EvalCategory } from "./eval-grader.js";

export interface CaseRefResolution {
  caseId: string;
  category: EvalCategory;
  /** 只有选择/加载案例具备上下文拉取契约；行为案例没有。 */
  requiresRef: boolean;
  /** 从案例中提取的标准引用；未找到时为 null。 */
  ref: string | null;
  /** ref 是标准完整路径（skills/<ns>/<name>）。 */
  canonical: boolean;
  /** 该 ref 的清单存在于已构建的生产包中。 */
  resolved: boolean;
}

/** 提取 `zrig context get <ref>` 模式所拉取的 ref。兼容正则仍识别旧命令入口。 */
export function extractRef(pattern: string): string | null {
  const m = /rig context get\\s\+(\S+)/.exec(pattern);
  return m ? m[1]! : null;
}

/** 针对已构建生产包目录逐案例生成一个解析结果（绝不减少）。 */
export function resolveCaseRefs(cases: EvalCase[], productionPackageDir: string): CaseRefResolution[] {
  return cases.map((c) => {
    // 只有选择/加载案例约定拉取上下文；行为案例（slice-05 Q3）断言可观察行为且不携带
    // 上下文引用，因此绝不进行引用解析。
    const requiresRef = c.category === "selection" || c.category === "loading";
    const patterns = [...(c.expectedPatterns ?? [])];
    if (c.order?.getPattern) patterns.push(c.order.getPattern);
    const ref = patterns.map(extractRef).find((r) => r !== null) ?? null;
    const canonical = ref !== null && ref.startsWith("skills/");
    const resolved = canonical && existsSync(join(productionPackageDir, ref, "manifest.yaml"));
    return { caseId: c.id, category: c.category, requiresRef, ref, canonical, resolved };
  });
}

/**
 * 必须解析到标准生产引用但未成功的案例——即引用缺失、非标准或不存在于生产包中的
 * 选择/加载案例。行为案例不携带上下文拉取契约，永不包含在内，因此有效行为案例不会
 * 导致运行被拒绝。
 */
export function unresolvedCases(resolutions: CaseRefResolution[]): CaseRefResolution[] {
  return resolutions.filter((r) => r.requiresRef && !r.resolved);
}

export interface BuiltProductionPackage {
  /** 已构建包目录；引用解析到 `<dir>/skills/<ns>/<name>/manifest.yaml`。 */
  dir: string;
  /** 删除临时包。幂等，并注册为进程退出时的故障安全操作。 */
  cleanup: () => void;
}

/**
 * 将受测的精确生产包构建到全新临时目录中（隔离——绝不读取被 git 忽略的
 * `packages/daemon/context-packs` 残留）。进程退出时会以故障安全方式删除临时目录
 *（成功或错误路径都执行），返回的 `cleanup` 也允许调用方立即回收，因此重复运行的
 * 门禁绝不会泄漏临时包。
 */
export function buildProductionPackage(repoRoot: string): BuiltProductionPackage {
  const out = mkdtempSync(join(tmpdir(), "eval-prod-pkg-"));
  const cleanup = () => {
    try {
      rmSync(out, { recursive: true, force: true });
    } catch {
      // 尽力而为——目录可能已经不存在
    }
  };
  process.once("exit", cleanup);
  execFileSync("node", [join(repoRoot, "scripts/generate-context-packs.mjs")], {
    env: { ...process.env, OPENRIG_PACKS_OUT: out },
    stdio: "pipe",
  });
  return { dir: out, cleanup };
}
