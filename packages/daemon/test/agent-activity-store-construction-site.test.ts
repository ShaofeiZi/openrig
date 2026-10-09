import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// W2a-1 结构守卫（A4 第六站点形状）。
//
// generation gate 是可选依赖：构造站点省略 `resolveOccupantGeneration` 或 node 作用域
// membership resolver 时，会静默退到不完整的 generation detector——且什么都不失败。
// "一个生产站点，resolver 已注入"今天成立（startup.ts），明天却无强制。本钉死它：生产
// `src/` 必须 EXACTLY ONE `new AgentActivityStore(`，且该站点必须注入 resolver。第二个站点
// 或裸站点会在此 LOUD 失败，而不是在暗中关掉 detector。
//
//（`test/` 中的直接构造刻意省略 resolver 以走 legacy 路径；它们被排除，因为构造上 prod 不可达
//——这正是本守卫存在的全部理由。）
describe("AgentActivityStore——单一生产构造站点（W2a-1）", () => {
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));

  function walkTs(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walkTs(full);
      return entry.isFile() && full.endsWith(".ts") ? [full] : [];
    });
  }

  it("恰有一个生产构造站点，且同时注入两个 generation resolver", () => {
    const sites: Array<{ file: string; injectsResolver: boolean; injectsMembership: boolean }> = [];
    for (const file of walkTs(srcDir)) {
      const text = fs.readFileSync(file, "utf8");
      const re = /new AgentActivityStore\(/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(text)) !== null) {
        // 在构造参数字面量的有界窗口内检查 resolver key。
        const window = text.slice(match.index, match.index + 400);
        sites.push({
          file: path.relative(srcDir, file),
          injectsResolver: /resolveOccupantGeneration/.test(window),
          injectsMembership: /isRegisteredOccupantGeneration/.test(window),
        });
      }
    }

    expect(
      sites,
      `期望 EXACTLY ONE 个 AgentActivityStore 生产构造站点；实际得到 ${JSON.stringify(sites)}`,
    ).toHaveLength(1);
    expect(
      sites[0]?.injectsResolver,
      `唯一构造站点（${sites[0]?.file}）必须注入 resolveOccupantGeneration——裸站点会静默禁用 generation gate（legacy clock-only 路径）`,
    ).toBe(true);
    expect(
      sites[0]?.injectsMembership,
      `唯一构造站点（${sites[0]?.file}）必须注入 isRegisteredOccupantGeneration——否则未提交的 reservation 会被误报为 dead tenure`,
    ).toBe(true);
  });
});
