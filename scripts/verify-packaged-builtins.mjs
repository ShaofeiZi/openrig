#!/usr/bin/env node
// OPR.0.4.8.3 —— D5b 编译后包边界探针（guard 封存计划 v2 eea3c778）。
// 可由 guard/QA 重复执行。针对一个已组装好的包证明：
//   1. 包身份：组装后的 daemon 与 cli 的 build-info 都点名同一个候选 SHA，
//      且 dirty === false（把 SHA 作为 argv[2] 传入）；
//   2. 组装后的策略字节：daemon/policies/builtin/* 与四个权威哈希逐一相等；
//   3. 编译后的组装启动边界：在全新临时 OPENRIG_HOME + 隔离状态下调用组装后
//      dist 导出的 createDaemon()（不监听端口），会在 reference/policies/builtin/
//      精确物化那四个稳定文件——字节相等、权限 0444。
// 本探针绝不触碰实时 daemon、它的端口或操作者 home。
//
// 用法：node scripts/verify-packaged-builtins.mjs <已组装cli目录> <期望完整sha>
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const AUTHORITY_SHA256 = {
  "locked.policy.md": "dcb38c372def7fe58ddfc9f1f3e97b9ba391ae79a99ef486e44f017cb39e57fe",
  "standard.policy.md": "737d3f56e6d8275fe548a3a06e9b02ede8f328207ec2e6223cea6a83f40f5148",
  "open.policy.md": "bb5fbb18e1f3706bd0676a9e709e29b5754bb6b41b6f304453dd6d73e7a4d62b",
  "yolo.policy.md": "f0277fc5bb7ecbff88861a042eefc3bd79aa829e00dc4ee342bd82276019f601",
};

const [cliDir, expectedSha] = process.argv.slice(2);
if (!cliDir || !expectedSha || !/^[0-9a-f]{40}$/.test(expectedSha)) {
  console.error("用法：verify-packaged-builtins.mjs <已组装cli目录> <期望完整40位hex sha>");
  process.exit(2);
}
const cli = resolve(cliDir);
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const fail = (msg) => { console.error(`失败：${msg}`); process.exit(1); };
const ok = (msg) => console.log(`通过：${msg}`);

// ---- 1. 包身份（guard 发现 2）----
for (const which of ["daemon/dist/build-info.js", "dist/build-info.js"]) {
  const info = await import(pathToFileURL(join(cli, which)).href);
  const record = info.BUILD_INFO ?? info.buildInfo ?? info.default ?? info;
  const commit = record.commit ?? record.sha ?? record.gitCommit;
  const dirty = record.dirty ?? record.isDirty;
  if (commit !== expectedSha) fail(`${which}：commit ${commit} !== 候选 ${expectedSha}`);
  if (dirty !== false) fail(`${which}：dirty === ${JSON.stringify(dirty)}（应为 false——须由干净候选构建）`);
  ok(`${which}：commit ${expectedSha.slice(0, 12)}… dirty=false`);
}

// ---- 2. 组装后的策略字节 ----
const assembledDir = join(cli, "daemon", "policies", "builtin");
const assembledFiles = readdirSync(assembledDir).sort();
const expectedFiles = Object.keys(AUTHORITY_SHA256).sort();
if (JSON.stringify(assembledFiles) !== JSON.stringify(expectedFiles))
  fail(`组装清单 ${assembledFiles.join(",")} !== 已知四个`);
for (const [file, hash] of Object.entries(AUTHORITY_SHA256))
  if (sha256(join(assembledDir, file)) !== hash) fail(`组装产物 ${file} 偏离权威哈希`);
ok("组装后的 daemon/policies/builtin：恰为已知四个，全部权威哈希匹配");

// ---- 3. 编译后的组装启动边界（guard 发现 1）----
const home = mkdtempSync(join(tmpdir(), "builtins-probe-home-"));
const state = mkdtempSync(join(tmpdir(), "builtins-probe-state-"));
process.env.OPENRIG_HOME = home;
// QA 发现（qitem 03a6194b）：createDaemon() 默认会触发后台 kernel 引导，可能在共享
// 服务器上创建/替换 tmux 会话——探针必须在 import 编译后的 startup 之前确定性地退出，
// 并把“跳过”钉死在输出里，让回归能响亮失败。
process.env.OPENRIG_NO_KERNEL = "1";
delete process.env.OPENRIG_URL;
delete process.env.OPENRIG_PORT;
try {
  const startup = await import(pathToFileURL(join(cli, "daemon", "dist", "startup.js")).href);
  if (typeof startup.createDaemon !== "function") fail("组装后的 dist/startup.js 未导出 createDaemon");
  // 构造但不监听——隔离数据库放在临时 state 目录下；构造期间 tee 住
  // stdout/stderr，把 kernel-boot 跳过这一点钉死
  const chunks = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (c, ...rest) => { chunks.push(String(c)); return origOut(c, ...rest); };
  process.stderr.write = (c, ...rest) => { chunks.push(String(c)); return origErr(c, ...rest); };
  let daemon;
  try {
    daemon = await startup.createDaemon({ dbPath: join(state, "probe.db") });
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  const bootLog = chunks.join("");
  if (!bootLog.includes("skipping kernel auto-boot"))
    fail("未观察到 kernel 自动启动跳过——探针绝不能启动后台 kernel 引导");
  if (bootLog.includes("kernel-boot: booting"))
    fail("探针期间 kernel-boot 试图 BOOT——共享 tmux 会话曾处于风险");
  ok("kernel 自动启动被确定性跳过（OPENRIG_NO_KERNEL=1 已钉在探针输出中）");
  const refDir = join(home, "reference", "policies", "builtin");
  const files = readdirSync(refDir).sort();
  if (JSON.stringify(files) !== JSON.stringify(expectedFiles))
    fail(`物化清单 [${files.join(",")}] !== 已知四个`);
  for (const [file, hash] of Object.entries(AUTHORITY_SHA256)) {
    const p = join(refDir, file);
    if (sha256(p) !== hash) fail(`物化的 ${file} 与权威字节不一致`);
    const mode = statSync(p).mode & 0o777;
    if (mode !== 0o444) fail(`物化的 ${file} 权限 ${mode.toString(8)} !== 444`);
  }
  ok("编译后的组装启动边界精确物化了那四个稳定文件——字节一致、权限 0444");
  // 尽力释放已构造 daemon 的资源（从未绑定任何端口）
  try { await daemon?.contextMonitor?.stop?.(); } catch { /* 尽力即可 */ }
  try { daemon?.eventLoopMonitor?.stop?.(); } catch { /* 尽力即可 */ }
  try { daemon?.db?.close?.(); } catch { /* 尽力即可 */ }
} finally {
  rmSync(home, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
}
console.log("PASS：打包内置策略已验证（身份 + 组装字节 + 编译后启动边界）");
process.exit(0);
