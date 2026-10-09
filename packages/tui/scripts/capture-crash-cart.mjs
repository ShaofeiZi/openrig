// 故障诊断外观门捕获工具（PM 放置增量比较，裁决 3c6c2be0）。在
// 壳内渲染后台服务降级屏（内容面板在标准资源管理器│内容壳中），通过
// 真实 renderScreen + stylize 管道（TUI 写入的确切字节）在固定视口，
// 并输出每屏 .ans（ANSI——`cat` 查看真实外观）+ .txt（纯文本）+ SHA256SUMS。确定性
// （固定夹具 + truecolor + 固定时钟）→ 重跑字节相同。
//
//   node --import tsx scripts/capture-crash-cart.mjs <输出目录>
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { renderScreen } from "../src/render.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { demoSnapshot } from "../src/demo-data.js";
import { demoCrashCartModel, buildCrashCartModel } from "../src/crash-cart/crash-cart-model.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle, stripAnsi } from "../src/theme.js";

const OUT = process.argv[2] ?? "crash-cart-captures";
mkdirSync(OUT, { recursive: true });
const style = createStyle("truecolor");
const cols = 120, rows = 32, nowMs = 0;
const snap = emptySnapshot();
const view = createViewState({ instanceId: "crash-cart", getSnapshot: () => snap });
const draw = (opts, s = snap) => renderScreen(view.get(), s, { cols, rows, nowMs, ...opts });

const screens = {
  // 壳内座舱——资源管理器（账本喂入，诚实标记）+ 右窗格中批准的内容，
  // 含诚实空头条槽位。与创建者批准内容的放置增量。
  "cockpit-in-shell": draw({ daemonState: "down", crashCart: demoCrashCartModel() }),
  // 壳内未验证——证据 + 重试，无恢复，资源管理器存在。
  "unverified-in-shell": draw({
    daemonState: "unverified",
    daemonEvidence: { pidState: "alive (pid 4242)", probeResult: "timeout", failedSignal: "healthz timed out after 3 probes" },
  }),
  // 壳内首次运行——降级 + 无数据库 → 入门框架，资源管理器即使无工作组也标记账本。
  "first-run-in-shell": draw({
    daemonState: "down",
    crashCart: buildCrashCartModel({ header: { lastActivityAt: null }, foundOnHost: [], whereWorkStopped: [] }),
  }),
  // 恢复后交换——成功恢复后壳将账本→实时交换：相同壳，现在
  // 渲染实时组（无 daemonState）。证明数据源交换诚实渲染，相同壳。
  "post-restore-swap": draw({}, demoSnapshot()),
};

const manifest = [];
for (const [name, screen] of Object.entries(screens)) {
  const ansi = stylizeLines(screen, style).join("\n") + "\n";
  const plain = screen.lines.map((l) => stripAnsi(l)).join("\n") + "\n";
  writeFileSync(join(OUT, `${name}.ans`), ansi);
  writeFileSync(join(OUT, `${name}.txt`), plain);
  manifest.push(`${createHash("sha256").update(ansi).digest("hex")}  ${name}.ans`);
  manifest.push(`${createHash("sha256").update(plain).digest("hex")}  ${name}.txt`);
}
writeFileSync(join(OUT, "SHA256SUMS"), manifest.join("\n") + "\n");
console.log(`已捕获 ${Object.keys(screens).length} 个壳内故障诊断屏 → ${OUT}`);
console.log(manifest.join("\n"));
