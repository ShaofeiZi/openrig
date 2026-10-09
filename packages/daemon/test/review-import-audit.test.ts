// OPR.0.4.6.MH5 C5——arch-P1 IMPORT-AUDIT 静态测试（FAC-1 commit-4 模式）：
// 把 C1 模块边界变成机械约束，使其经得住后续每位编辑者。
//
// Q2 纯度纪律：本地 review composer 是本地状态上的纯函数，网络 I/O 绝不进入 review domain。
// MH-5 的 fleet composer 是唯一获准例外（兄弟 aggregate 的 fan-out shell），因此
// domain/review/ 下除 fleet 模块外，任何模块都不得导入 hosts TRANSPORT/REGISTRY 模块或
// node 网络原语。
//
// 所有模块均可使用 domain/hosts/fanout-contract.js：这是零 I/O 的共享契约模块，其 header 固定
//“只定义一次、到处导入、绝不重复声明”。types.ts 从中导入 PerHostStatus；本审计保护的边界是
// 网络 I/O 与 registry 读取，而非仅类型契约。

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, it, expect } from "vitest";

const REVIEW_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/domain/review");
const FLEET_MODULE = "fleet-compose.ts";

/** 纯 review domain 中禁止的 transport/registry/I-O import specifier。
 * fanout-contract 刻意不在此列，原因见文件头。 */
const FORBIDDEN_SPECIFIERS = [
  "hosts/remote-daemon-http",
  "hosts/hosts-registry-reader",
  "hosts/read-through",
  "node:http",
  "node:https",
  "node:net",
  "undici",
];

function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (spec) specs.push(spec);
  }
  return specs;
}

describe("MH-5 P1——review domain import 边界（静态审计）", () => {
  const files = readdirSync(REVIEW_DIR).filter((f) => f.endsWith(".ts"));

  it("review 目录非空且包含 fleet 模块（审计不是空跑）", () => {
    expect(files.length).toBeGreaterThan(1);
    expect(files).toContain(FLEET_MODULE);
  });

  it("除 fleet 外每个 review-domain 模块都不导入 hosts transport/registry 或网络原语", () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file === FLEET_MODULE) continue;
      const specs = importSpecifiers(readFileSync(path.join(REVIEW_DIR, file), "utf-8"));
      for (const spec of specs) {
        if (FORBIDDEN_SPECIFIERS.some((f) => spec.includes(f))) {
          offenders.push(`${file} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("fleet 模块确实导入 transport（边界真实存在，不是死规则）", () => {
    const specs = importSpecifiers(readFileSync(path.join(REVIEW_DIR, FLEET_MODULE), "utf-8"));
    expect(specs.some((s) => s.includes("hosts/remote-daemon-http"))).toBe(true);
    expect(specs.some((s) => s.includes("hosts/hosts-registry-reader"))).toBe(true);
  });

  it("fleet 模块外的 hosts/ import 最多只能是零 I/O fanout 契约", () => {
    for (const file of files) {
      if (file === FLEET_MODULE) continue;
      const specs = importSpecifiers(readFileSync(path.join(REVIEW_DIR, file), "utf-8"));
      const hostsImports = specs.filter((s) => s.includes("/hosts/") || s.startsWith("hosts/"));
      for (const spec of hostsImports) {
        expect(spec).toContain("hosts/fanout-contract");
      }
    }
  });
});
