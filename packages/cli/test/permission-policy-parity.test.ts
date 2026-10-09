// B7 r2 HIGH-2 修复——CLI 的 permission-policy 语义是 daemon 权威模块的
// 字节等价孪生（与 scaffold-placeholder 相同的孪生+并行安排）：
//   packages/cli/src/lib/permission-policy/policy-ref.ts   ⇔ packages/daemon/src/domain/permission-policy/policy-ref.ts
//   packages/cli/src/lib/permission-policy/policy-spec.ts  ⇔ packages/daemon/src/domain/permission-policy/policy-spec.ts
//   packages/cli/src/lib/path-safety.ts                    ⇔ packages/daemon/src/domain/path-safety.ts
// 一套语法，两个包，无发散：任一侧改变须两侧同改，否则失败。

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const PAIRS: Array<[string, string]> = [
  ["../src/lib/permission-policy/policy-ref.ts", "../../daemon/src/domain/permission-policy/policy-ref.ts"],
  ["../src/lib/permission-policy/policy-spec.ts", "../../daemon/src/domain/permission-policy/policy-spec.ts"],
  ["../src/lib/path-safety.ts", "../../daemon/src/domain/path-safety.ts"],
];

describe("permission-policy CLI/daemon twin parity (byte-equivalent)", () => {
  for (const [cliRel, daemonRel] of PAIRS) {
    it(`${cliRel} is byte-identical to its daemon twin`, () => {
      const cli = fs.readFileSync(fileURLToPath(new URL(cliRel, import.meta.url)), "utf-8");
      const daemon = fs.readFileSync(fileURLToPath(new URL(daemonRel, import.meta.url)), "utf-8");
      expect(cli).toBe(daemon);
    });
  }
});
