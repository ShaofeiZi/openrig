import fs from "node:fs";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 调用时读取 daemon 自身 package.json 中的版本。这里有意在函数级读取：按照
 * audit-every-layer 规范，模块级常量会掩盖测试隔离问题，而本次读取成本很低。任何失败
 *（package.json 缺失或损坏、没有 version 字段）均返回 "unknown"，让调用方可以如实呈现
 * 回退值，而不是崩溃。
 *
 * 此逻辑最初在切片 05 的 routes/bundles.ts 中用于 bundle provenance，现为
 * OPR.0.4.1.14 提升为共用 helper，使 dashboard 的 Field Environment VERSION 行可以通过
 * health-summary 路由读取真实运行中的 daemon 版本。路径相对于本模块自身位置
 *（import.meta.url）解析，因此不受调用方位置影响。
 */
export function getDaemonVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    const pkgPath = nodePath.join(nodePath.dirname(here), "..", "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}
