// F1 gate-lane runner 逻辑（arch d6a6c1db，机制 (B)，5 条约束）。纯函数/依赖可注入，
// 以便说明文案、诚实间隙腿集合与 C2 裁决都可单测；CLI 入口（gate-lane.mjs）在这些外面接上
// 真实互斥锁 + 子进程执行 + 产物写入。

import { rmSync } from "node:fs";
import { join } from "node:path";
import { resolveGateWithLedger, renderLedgerState } from "./gate-lane-ledger.mjs";

/**
 * 源码真实性清理：在各腿运行前删掉 packages/cli/daemon 下的 vendored daemon 包。
 * 该路径是 `npm run build:package` 组装出的、被 gitignore 的构建产物；桌面残留会污染
 * test:repo 的新鲜度守卫（守卫正确地标出任何“已组装但已过期”的包，但闸门不是打包语境——
 * 它测的是源码真实性）。在闸门启动时删掉它，意味着残留永远不可能污染一次运行；
 * 真实打包时的组装仍受守护，没有包的全新 clone 是 `force:true` 的 no-op。`rm` 被注入以便测试。
 * 返回被删除的路径。
 */
export function cleanStaleVendoredBundle(repoRoot, rm = rmSync) {
  const vendored = join(repoRoot, "packages", "cli", "daemon");
  rm(vendored, { recursive: true, force: true });
  return vendored;
}

/**
 * P5——拒绝时的说明文案。始终硬拒绝；始终告知端口常量。持锁者是另一个闸门时会被点名
 * （pid/started-at）；外来占用者则诚实标注未知（绝不编造一个持锁者）。
 */
export function renderRefusal(result, port) {
  const head = `⛔ 闸门通道忙——锁 = localhost 端口 ${port}（OPENRIG_GATE_LANE_PORT）。拒绝执行（非阻塞，退出码非 0）。`;
  if (result.reason === "gate-holder" && result.holder) {
    return (
      `${head}\n` +
      `   由另一个闸门持有：pid ${result.holder.pid}，开始于 ${result.holder.startedAt}。\n` +
      `   本机上另有一条完整闸门通道在运行——等待它结束，或检查该 pid。`
    );
  }
  return (
    `${head}\n` +
    `   由外来进程持有——持有者未知（无闸门持有者信息文件）。\n` +
    `   失败即关闭（load-115）：闸门通道不得与未知负载并行运行。释放端口 ${port}，或查清占用者。`
  );
}

/**
 * 闸门跑两条腿——typecheck（lint）与 vitest（test:repo 脚本 + 受支持的工作区：daemon、cli、tui）。
 * 两条腿都跑（不 fail-fast），使裁决记录每个结果；绿 = 每条腿都 ok。`exec(cmd)` 被注入 → `{ok, code}`。
 *
 * web UI（packages/ui）刻意不作为闸门腿。创始人裁决 2026-08-21：web UI 在 0.5.0 转向 TUI 后
 * 已转为尽力而为的实验性产物，发行不应在它上面花闸门时间或被它阻塞。`npm run test:ui` 仍可手动跑；
 * 它不闸门任何东西。
 */
export async function runLegs(exec) {
  const specs = [
    { name: "typecheck", cmd: "npm run lint" },      // tsc ×4（含 P9 typecheck:prep）
    { name: "vitest", cmd: "npm run test" },          // test:repo + 受支持工作区（不含 packages/ui）
  ];
  const legs = [];
  for (const s of specs) {
    // 每条腿的墙上时钟（ms）——整轮总时长会掩盖的判别信号：混合模式运行（有的腿真跑、有的冒烟/跳过）
    // 总时长仍落在合理区间，但被跳过的腿在这里会显示 ~0ms。
    const t0 = Date.now();
    const r = await exec(s.cmd);
    const durationMs = Date.now() - t0;
    legs.push({ name: s.name, cmd: s.cmd, ok: !!r.ok, code: r.code ?? null, durationMs });
  }
  return legs;
}

/**
 * 建议性外来负载上下文（arch：外来的非闸门负载无法被加锁，只能被观测 → 建议性告警，
 * 退出码不变，记录在裁决中）。统计外来工具链进程（node/vitest/tsc）——绝不算闸门自己的 pid——
 * 外加 loadavg。注入读取器（loadavg、processes）以便测试。
 */
export function observeForeignLoad({ loadavg, processes }) {
  const foreign = processes.filter((p) => p.pid !== process.pid && /\b(node|vitest|tsc)\b/.test(p.command));
  const advisory = [];
  if (foreign.length > 0) advisory.push(`闸门运行期间有 ${foreign.length} 个外来 node/vitest/tsc 进程`);
  advisory.push(`loadavg ${loadavg.map((n) => n.toFixed(2)).join(" ")}`);
  return { advisory, foreignProcessCount: foreign.length, loadavg };
}

/**
 * C2 风格裁决：绿要承担它所跑时的负载上下文（记录在案，而不只是打印）——一次绿的质量，
 * 取决于它本可能触红的条件。闸门对照排除台账（F1 四条轨道）裁决：当且仅当每条失败的腿都被一个
 * 生效、合法、未过期的常驻者覆盖、且没有常驻者过期/非法时才 pass。随发货的空台账里没有常驻者，
 * 于是退化为严格的“每条腿都 ok 才 pass”——台账状态（0 排除）仍会在带内响亮记录。
 */
export function buildVerdict({ legs, foreignLoad, startedAt, endedAt, ledger = [], now, cutCeiling, smoke = false }) {
  const failures = legs.filter((l) => !l.ok).map((l) => l.name);
  const ledgerResult = resolveGateWithLedger({
    failures,
    ledger,
    now: now ?? endedAt,
    ...(cutCeiling ? { cutCeiling } : {}),
  });
  return {
    gate: ledgerResult.gate,
    // 自描述：本裁决所运行的模式，取自唯一点——调用方（gate-lane.mjs）只算一次 SMOKE 来挑执行器
    // （:56），并把同一个值传进来。刻意不再独立读一次 process.env：buildVerdict 看不到被注入的执行器，
    // 若在这里读环境变量，记录下的“意图”就可能与实际跑的不一致（环境变量未设却跑了冒烟执行器 →
    // 一条从未真正执行的腿上记成 smoke:false）。同一个标志读两次可能分叉，读一次不会。
    // 下面每条腿的 durationMs 是独立的观测交叉校验：声明的模式 vs 观测到的效果——若两者不一致，
    // 这个不一致本身可被发现。没有这一点，一次冒烟运行会封出一个与真跑无法区分的普通 PASS；
    // 对 JSON 做哈希校验只能证明文件真实，证明不了闸门真的跑过。
    smoke: smoke === true,
    legs,
    foreignLoad,
    ledger: ledgerResult,
    ledgerState: renderLedgerState(ledgerResult),
    startedAt,
    endedAt,
  };
}

/**
 * 闸门接线，抽出来让生产代码与它的测试调用同一个来源——而不是一个镜像。唯一的 `smoke` 值
 * 既挑执行器（跳过分支 vs 注入的真执行器）又流进裁决，因此不可能在一处设了冒烟、在另一处忘记
 * （双来源失败）。真执行器是注入的——单测无法 spawn 真 npm，这与 runLegs 已有的 exec 注入一致——
 * 但 smoke→executor→verdict 的接线只在这里出现一次。gate-lane.mjs 调用它产出封存的裁决；
 * 测试调用同一个函数，于是阴性对照守护的是发货路径，而不是仿冒品。
 */
export async function runGate({ smoke, realExec, foreignLoad, startedAt, ledger = [], cutCeiling }) {
  const exec = smoke
    ? async (cmd) => { console.log(`[smoke] 跳过：${cmd}`); return { ok: true, code: 0 }; }
    : realExec;
  const legs = await runLegs(exec);
  const endedAt = new Date().toISOString();
  return buildVerdict({ legs, foreignLoad, startedAt, endedAt, ledger, now: endedAt, cutCeiling, smoke });
}
