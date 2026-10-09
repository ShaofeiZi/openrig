#!/usr/bin/env node
/*
 * slice-07 R6——种子 fixture context-library 生成器。
 *
 * 在评测用例选择的 canonical ref（skills/<ns>/<name>）处写入最小上下文包。
 * 这些是派生产物（应重新生成；绝不要手改 fixtures/ 下的文件）。根据 Repair 2，实时运行
 * 不会让席位指向这些 fixture，而是针对 generate-context-packs.mjs 构建出的准确生产包解析 ref。
 * 这些 fixture 仅支持 canonical-ref 结构检查。
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "fixtures");

// ref = 库路径（ns/name）；包目录位于 fixtures/<ref>/，并通过该 ref 提供。
const ENTRIES = [
  { ref: "skills/core/rig-lifecycle", purpose: "bring rigs and the whole fleet up/down/back", teaches: "For a whole-box bring-back after a reboot, use `rig start` (not per-rig `rig up`)." },
  { ref: "skills/core/topology-mutation-and-seat-management", purpose: "replace a seat's occupant without losing the address", teaches: "Swap an occupant with `rig handover <seat>` — the seat, name, edges and queue stay put." },
  { ref: "skills/core/agent-startup-and-context-ingestion", purpose: "orient a freshly-woken seat", teaches: "Run `rig whoami --json` first; it is ground truth for who and where you are." },
  { ref: "skills/core/watchdog", purpose: "arm a wake you cannot perform yourself", teaches: "You cannot wake yourself; arm `rig watchdog register --spec <yaml>` before you stop." },
  { ref: "skills/core/cross-host-rig-commands", purpose: "reach agents on other machines", teaches: "Address a remote seat bare plus `--host <id>` (see `rig host ls`)." },
  { ref: "skills/core/rig-bundles-and-shareable-artifacts", purpose: "package a rig for a machine that never had the source", teaches: "Build a portable rig with `rig bundle create`; install with `rig bundle install`." },
  { ref: "skills/core/openrig-upgrade", purpose: "upgrade a running daemon without downtime", teaches: "Use the sidecar-operator upgrade path so the rig stays up while the daemon upgrades." },
  { ref: "skills/process/systematic-debugging", purpose: "chase a failure methodically", teaches: "Instrument every boundary once and read where it actually breaks — one run beats five hypotheses." },
  { ref: "skills/openrig-operating-model", purpose: "place durable knowledge at the right context altitude", teaches: "Put context at the narrowest scope that needs it, and trace one filename toward the root." },
  { ref: "skills/queue-handoff", purpose: "pass active work durably before a turn ends", teaches: "Active work ends by handing off a queue baton, not by going idle at the prompt." },
  // 干扰项——使选择成为真正的多项选择，而不是只有一个候选。
  { ref: "skills/core/human-in-the-loop", purpose: "when and how to reach the human", teaches: "Reach the human by exception; orchestrators use discretion, others route through them." },
  { ref: "skills/pm/requirements-writer", purpose: "turn intent into requirements", teaches: "Proportional structured requirements — three capture points, elastic middle." },
  { ref: "skills/process/test-driven-development", purpose: "red-first discipline", teaches: "A failing test per chunk; if you cannot show it red, it is not a check." },
];

rmSync(ROOT, { recursive: true, force: true });
for (const e of ENTRIES) {
  const dir = join(ROOT, e.ref);
  mkdirSync(dir, { recursive: true });
  const name = e.ref.split("/").pop();
  const manifest = `name: ${name}\nversion: "1"\ntaxonomy: skills\npurpose: "(eval fixture) ${e.purpose}"\nfiles:\n  - path: content.md\n    role: source\n`;
  writeFileSync(join(dir, "manifest.yaml"), manifest);
  writeFileSync(join(dir, "content.md"), `# ${e.ref}\n\n${e.purpose}\n\n${e.teaches}\n`);
}
console.log(`wrote ${ENTRIES.length} fixture packs under ${ROOT}`);
