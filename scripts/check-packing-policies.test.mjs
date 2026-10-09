// OPR.0.4.8.3——内置策略的打包约束（guard 封印的 plan v2 eea3c778，D4 T6/T7）。
// 这是在既有 check-packing 底线旁新增的文件（底线是旁挂新增，绝不编辑）。
//
// 本文件钉的链路（与 check-packing.test.mjs 记录的 sdlc-conventions daemon-package
// 先例同构）：
//   仓库源码        packages/daemon/policies/builtin/<name>.policy.md
//   打包后          daemon/policies/builtin/<name>.policy.md   （build-package.sh 暂存）
//   安装后稳定版    $OPENRIG_HOME/reference/policies/builtin/<name>.policy.md
//                   （daemon 启动 materializer，mode 0444 检查副本）
// 运行时边缘由 scripts/verify-packaged-builtins.mjs 在编译后组装边界处证明（计划 D5b）；
// 这些测试钉住源码与暂存这两条腿，使一个被漏掉的暂存块或被编辑的源码响亮失败。
import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

const AUTHORITY_SHA256 = {
  "locked.policy.md": "dcb38c372def7fe58ddfc9f1f3e97b9ba391ae79a99ef486e44f017cb39e57fe",
  "standard.policy.md": "737d3f56e6d8275fe548a3a06e9b02ede8f328207ec2e6223cea6a83f40f5148",
  "open.policy.md": "bb5fbb18e1f3706bd0676a9e709e29b5754bb6b41b6f304453dd6d73e7a4d62b",
  "yolo.policy.md": "1c34fff0b385426689fd26e20b8b431de6b688028d584924e7d5384fe5ff6d42",
};

test("T6: build-package.sh stages daemon policies into the assembled package", () => {
  const sh = readFileSync("scripts/build-package.sh", "utf-8");
  assert.ok(
    /if \[ -d "\$DAEMON_DIR\/policies" \]/.test(sh),
    "build-package.sh no longer stages $DAEMON_DIR/policies — the assembled daemon would ship no built-in policies and the startup materializer would find nothing to copy to $OPENRIG_HOME/reference/policies/builtin/."
  );
  assert.ok(
    sh.includes('cp -r "$DAEMON_DIR/policies" "$CLI_DIR/daemon/policies"'),
    "the policies staging copy line is missing/changed — packed daemon/policies would not match the repo source."
  );
});

test("T7: the canonical repo-source built-ins are exactly the known four, byte-equal to authority", () => {
  const dir = "packages/daemon/policies/builtin";
  const files = readdirSync(dir).filter((file) => file.endsWith(".policy.md")).sort();
  assert.deepEqual(files, ["locked.policy.md", "open.policy.md", "standard.policy.md", "yolo.policy.md"],
    "the built-in policy inventory must be EXACTLY locked|standard|open|yolo");
  for (const [file, expected] of Object.entries(AUTHORITY_SHA256)) {
    const actual = createHash("sha256").update(readFileSync(`${dir}/${file}`)).digest("hex");
    assert.equal(actual, expected, `${file} diverged from the authoritative verbatim content`);
  }
});
