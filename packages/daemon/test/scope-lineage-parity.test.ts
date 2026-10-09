// OPR.0.5.0.18——跨 surface parity 锁定（guard 携带的 requirement；提取已落地）。
//
// amendment-lineage 派生现在只有一个 canonical source：
//   packages/cli/src/lib/scope/attestation-lineage.ts        （canonical，手工编辑）
//   packages/daemon/src/domain/scope/attestation-lineage.generated.ts
//     （GENERATED 原样 body mirror——由 scripts/sync-scope-lineage.mjs 生成；cli→daemon import
//      方向被禁止，因此 repo 的 mirror/codegen convention 跨 package 边界携带 body）
//
// 此锁定覆盖整条链：canonical == generated（function body 字节级一致），且两个 consumer surface
// 都导入自身 package-local module，而非携带私有 copy——因此 canonical function 的变化会一起改变
// 两个 surface（运行 `node scripts/sync-scope-lineage.mjs`），旧 silent-drift 类从结构上消失。若
// generated 发生 drift（未 sync 就手工编辑），此测试失败。
import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** 通过 brace matching 提取 `attestationLineage(...)` function source（从 signature 到匹配的
 *  closing brace）——可稳健处理其中嵌套的 for/if block。 */
function extractAttestationLineage(src: string): string {
  const start = src.indexOf("function attestationLineage(");
  if (start < 0) return "";
  const open = src.indexOf("{", start);
  if (open < 0) return "";
  let depth = 0;
  let i = open;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return src.slice(start, i).replace(/\r\n/g, "\n").trim();
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", ".."); // packages/daemon/test -> repo root。

it("canonical 与 generated attestationLineage body 字节级一致（sync 已传递）", () => {
  const canonical = readFileSync(join(root, "packages/cli/src/lib/scope/attestation-lineage.ts"), "utf8");
  const generated = readFileSync(join(root, "packages/daemon/src/domain/scope/attestation-lineage.generated.ts"), "utf8");

  const canonicalFn = extractAttestationLineage(canonical);
  const generatedFn = extractAttestationLineage(generated);
  expect(canonicalFn.length, "未找到 canonical attestationLineage").toBeGreaterThan(0);
  expect(generatedFn.length, "未找到 generated attestationLineage").toBeGreaterThan(0);
  expect(generatedFn).toBe(canonicalFn);

  // generated 文件必须显著声明 provenance（repo 的 generated-file 规则）。
  expect(generated).toMatch(/生成文件[\s\S]*请勿手改/);
  expect(generated).toContain("scripts/sync-scope-lineage.mjs");
});

it("两个 surface 都消费共享 derivation——不残留私有 builder copy", () => {
  const cliSurface = readFileSync(join(root, "packages/cli/src/commands/scope.ts"), "utf8");
  const daemonSurface = readFileSync(join(root, "packages/daemon/src/routes/scope-audit.ts"), "utf8");

  // 两个 surface 都不再定义自己的 copy……
  expect(cliSurface).not.toContain("function attestationLineage(");
  expect(daemonSurface).not.toContain("function attestationLineage(");
  // ……二者都 import 各自 package-local module。
  expect(cliSurface).toMatch(/from "\.\.\/lib\/scope\/attestation-lineage\.js"/);
  expect(daemonSurface).toMatch(/from "\.\.\/domain\/scope\/attestation-lineage\.generated\.js"/);
});

it("共享 derivation 通过两个 package-local module 表现一致（behavioral belt）", async () => {
  const cli = await import(join(root, "packages/cli/src/lib/scope/attestation-lineage.ts"));
  const daemon = await import(join(root, "packages/daemon/src/domain/scope/attestation-lineage.generated.ts"));
  const fixtures = [
    null,
    "id: X",
    "approved-spec-by: a@r\napproved-spec-at: t1\napproved-spec-priors: 2",
    "approved-by: b@r\napproved-at: t2\napproved-priors: 1\napproved-spec-by: a@r\napproved-spec-at: t1\napproved-spec-priors: 3",
    "approved-spec-by: a@r\napproved-spec-at: t1\napproved-spec-priors: 0",
    'approved-spec-by: "q@r"\napproved-spec-at: t\napproved-spec-priors: not-a-number',
  ];
  for (const fm of fixtures) {
    expect(daemon.attestationLineage(fm)).toEqual(cli.attestationLineage(fm));
  }
});
