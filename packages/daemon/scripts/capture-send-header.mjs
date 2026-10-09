// 发送/广播页头捕获工具（裁决 03c35295，锁定项 6 证明）。通过真实 wrapPaneEnvelope 渲染
// 四种信封类型，即接收方窗格所见的准确字节；使用固定时间戳，并输出逐类型 .txt 与
// SHA256SUMS。风暴测试：接收方只看页头（To 行 + 规模）即可区分私信、多目标、工作组广播与
// 拓扑广播；由四条不同 To 行证明。输入固定，重跑时逐字节一致。
//
//   node --import tsx scripts/capture-send-header.mjs <out-dir>
import { writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { wrapPaneEnvelope } from "../src/lib/pane-envelope.js";

const OUT = process.argv[2] ?? "send-header-captures";
mkdirSync(OUT, { recursive: true });
const SENDER = "orch-advisor@v-openrig-build"; // member@rig
// 来源主机 id 按 51-09 已交付渲染解析（主机注册表 self-id），位于三元地址第三槽。
// 这是实际创建者主机 mm2，与工作组不同，因此 From/Reply 会干净渲染为 member@rig@host。
// 旧捕获在此硬编码工作组名，造成重复的 'rig@rig' 教学表面；代码路径本身通过
// getSelfHostId/fetchSelfHostId 解析真实 host_id。
const HOST = "mm2";
const STAMP = "2026-08-07T00:42:00Z"; // fixed → deterministic captures

const captures = {
  // 私信——To：单个接收方。
  dm: wrapPaneEnvelope(SENDER, "dev-driver@v-openrig-build", "one-to-one status.", HOST, { stampISO: STAMP }),
  // 多目标发送——To：完整接收方列表，即哪些人收到了。
  multi: wrapPaneEnvelope(SENDER, "dev-driver@v-openrig-build", "coordinate the three of you.", HOST, {
    stampISO: STAMP,
    scope: { kind: "multi", recipients: ["dev-driver@v-openrig-build", "dev-guard@v-openrig-build", "dev-qa@v-openrig-build"] },
  }),
  // 工作组广播——“广播到 <rig>（N 个席位）”规模行，使接收方知道同伴也已收到。
  "rig-broadcast": wrapPaneEnvelope(SENDER, "openrig-pm", "checkpoint review complete.", HOST, {
    stampISO: STAMP,
    scope: { kind: "rig-broadcast", rig: "openrig-pm", seats: 11 },
  }),
  // 拓扑广播——“广播到拓扑”。
  topology: wrapPaneEnvelope(SENDER, "*", "system maintenance in 5 minutes.", HOST, {
    stampISO: STAMP,
    scope: { kind: "topology" },
  }),
};

const manifest = [];
const toLines = [];
for (const [name, text] of Object.entries(captures)) {
  writeFileSync(join(OUT, `${name}.txt`), text + "\n");
  manifest.push(`${createHash("sha256").update(text + "\n").digest("hex")}  ${name}.txt`);
  toLines.push(text.split("\n").find((l) => l.startsWith("To:")));
}
// 风暴测试：四条 To 行必须彼此不同，证明仅靠页头即可区分。
const distinct = new Set(toLines).size === 4;
writeFileSync(join(OUT, "SHA256SUMS"), manifest.join("\n") + "\n");
writeFileSync(join(OUT, "STORM-TEST.txt"), `风暴测试：${distinct ? "通过" : "失败"}——4 条不同的 To 行（仅凭页头即可区分）\n` + toLines.join("\n") + "\n");
console.log(`已捕获 4 个发送页头信封 → ${OUT}`);
console.log(`风暴测试：${distinct ? "通过" : "失败"}`);
console.log(toLines.join("\n"));
console.log("\n" + captures["rig-broadcast"]);
