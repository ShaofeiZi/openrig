// release-0.3.2 slice 12——`rig scope` CLI 原语。
//
// 命令语法：rig scope <tier> <verb>。v0 交付 `mission` +
// `slice` tier；`project` 和 `sub-slice` 按 substrate 约定
// `conventions/scope-and-versioning/README.md` 保留（stage: provisional）。
// CLI 按该约定 §1 把稳定 dot-ID 铸进创建的
// mission/slice frontmatter。

import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { attestationLineage, type AttestationLineage } from "../lib/scope/attestation-lineage.js";
import { getDaemonStatus, getDaemonUrl , statusGuardMessage} from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";

import {
  CLOSE_REASONS,
  MISSION_TEMPLATE_KINDS,
  SLICE_TEMPLATE_KINDS,
  STAGE_VALUES,
  ScopeCliError,
  type CloseReason,
  type MissionInfo,
  type MissionTemplateKind,
  type SliceInfo,
  type SliceTemplateKind,
  type SliceState,
  type Stage,
} from "../lib/scope/types.js";
import {
  DEFAULT_PROJECT_PREFIX,
  inferMissionDotId,
  isMissionDotId,
  isSliceDotId,
  nextEscapeBandOrdinal,
  sliceIdFromMission,
} from "../lib/scope/dot-id.js";
import {
  buildMissionDependencyGraph,
  ensureMissionId,
  ensureMissionIdPersisted,
  findMission,
  resolveNodeFile,
  findSlice,
  listMissions,
  listSlices,
  moveSlice,
  rollbackMovedSlice,
  nextSliceNN,
  NOTES_FILE_PRECEDENCE,
  pad2,
  readFrontmatter,
  resolveNotesFile,
  resolveMissionsRoot,
  splitFrontmatter,
  todayDateISO,
  updateFrontmatter,
} from "../lib/scope/scope-fs.js";
import {
  renderCapabilityDeltaTemplate,
  renderNotesTemplate,
  renderMissionProgressTemplate,
  renderMissionTemplate,
  renderSliceProofTemplate,
  renderSliceProgressTemplate,
  renderSliceTemplate,
  titleFromSlug,
} from "../lib/scope/templates.js";
import {
  addProgressRow,
  DEFAULT_PROGRESS_SECTION,
  parseStatus,
  PROGRESS_STATUSES,
  setProgressRow,
} from "../lib/scope/progress-edit.js";
import { deriveScopeTrust } from "../lib/scope/trust.js";
import { capabilityDeltaExpiryFindings } from "../lib/scope/capability-delta.js";
import {
  applyMissionCompositionEdits,
  nextMissionMembershipOrder,
  planMissionMembershipAdd,
  planMissionMembershipRemove,
  type MissionCompositionEdit,
} from "../lib/scope/mission-composition.js";

// ---------------------------------------------------------------------
// 共享辅助函数
// ---------------------------------------------------------------------

interface Stdout {
  write: (text: string) => void;
}

function makeStdout(): Stdout {
  return { write: (text: string) => process.stdout.write(text) };
}

const MISSION_MANIFEST = `schema: openrig.mission/v0alpha1
kind: mission
composition:
  mission_markdown:
    spec: SPEC.md
  slices: []
# Optional team and SDLC sections are added here.
`;

const SLICE_MANIFEST = `schema: openrig.slice/v0alpha1
kind: slice
composition:
  mission: ../../mission.yaml
  slice_markdown:
    spec: SPEC.md
    progress: PROGRESS.md
    proof: PROOF.md
# Optional assignment, SDLC, and evidence sections are added here.
`;

function emit(out: Stdout, payload: unknown, json: boolean, lines?: string[]): void {
  if (json) {
    out.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }
  if (lines) {
    for (const line of lines) out.write(line + "\n");
    return;
  }
  out.write(JSON.stringify(payload, null, 2) + "\n");
}

function fail(err: unknown, json: boolean, out: Stdout): never {
  if (err instanceof ScopeCliError) {
    if (json) {
      out.write(JSON.stringify({
        ok: false,
        error: { fact: err.fact, consequence: err.consequence, action: err.action },
      }, null, 2) + "\n");
    } else {
      process.stderr.write(`错误：${err.fact}\n${err.consequence}\n${err.action}\n`);
    }
  } else {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`错误：${message}\n`);
  }
  process.exit(1);
}

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sliceManifestRef(missionPath: string, slicePath: string): string {
  return path.relative(missionPath, path.join(slicePath, "slice.yaml")).split(path.sep).join("/");
}

function rollbackComposition(edits: MissionCompositionEdit[]): void {
  applyMissionCompositionEdits(edits.map((edit) => ({
    manifestPath: edit.manifestPath,
    original: edit.updated,
    updated: edit.original,
  })));
}

interface RootOpts {
  workspace?: string;
}

function getOpts(cmd: Command): RootOpts {
  // commander v13 将 opts 挂在父命令上。
  let walker: Command | null = cmd;
  while (walker) {
    const o = walker.opts() as RootOpts;
    if (o.workspace) return o;
    walker = walker.parent;
  }
  return {};
}

/** FR-5：派生 stage 的一行人类渲染。显示声明的 stage，
 *  （当弱 `verified` 把它降级时）显示生效 stage + 原因。读时派生；不写任何东西。 */
function formatTrustLine(trust: ReturnType<typeof deriveScopeTrust>): string {
  const declared = trust.declaredStage || "—";
  if (trust.downgraded) {
    return `  stage: ${declared}（生效：${trust.effectiveStage} — ${trust.verified.status}）\n`;
  }
  return `  stage: ${declared}\n`;
}

// ---------------------------------------------------------------------
// zrig scope slice ls
// ---------------------------------------------------------------------

function buildSliceLsCommand(): Command {
  const cmd = new Command("ls")
    .description("列出一个 mission 里（或跨所有 mission）的 slices")
    .option("--mission <name>", "限定到单个 mission")
    .option("--state <state>", "过滤：active | closed | shipped | all", "active")
    .option("--json", "机器可读输出")
    .action(async (opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      const state = (opts.state as SliceState) ?? "active";
      if (!["active", "closed", "shipped", "all"].includes(state)) {
        fail(new ScopeCliError({
          fact: `未知 --state 值 "${state}"。`,
          consequence: "命令未运行。",
          action: "选一个：active、closed、shipped、all。",
        }), json, out);
      }
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const missions = opts.mission
          ? [findMission(missionsRoot, opts.mission)]
          : listMissions(missionsRoot);
        const rows: unknown[] = [];
        const lines: string[] = [];
        for (const mission of missions) {
          const slices = listSlices(mission, state);
          for (const slice of slices) {
            rows.push({
              mission: mission.name,
              name: slice.name,
              nn: slice.nn,
              slug: slice.slug,
              id: slice.id,
              status: slice.status,
              path: slice.absPath,
            });
            lines.push(`${mission.name}/${slice.name}    ${slice.id ?? "—"}    ${slice.status ?? "—"}`);
          }
        }
        emit(out, { ok: true, count: rows.length, slices: rows }, json, lines.length === 0 ? ["（无 slices）"] : lines);
      } catch (err) {
        fail(err, json, out);
      }
    });
  return cmd;
}

// ---------------------------------------------------------------------
// zrig scope slice show
// ---------------------------------------------------------------------

function buildSliceShowCommand(): Command {
  return new Command("show")
    .description("检视单个 slice（frontmatter + README + 子项）")
    .argument("<slice-path>", "Slice 路径（绝对、相对 substrate，或 NN-slug）")
    .option("--mission <name>", "路径只是 NN-slug 时提示 mission")
    .option("--json", "机器可读输出")
    .action(async (slicePath: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const slice = findSlice(missionsRoot, slicePath, opts.mission ?? null);
        const readme = slice.readmePath ? fs.readFileSync(slice.readmePath, "utf8") : null;
        const children = fs.readdirSync(slice.absPath, { withFileTypes: true })
          .map((e) => ({ name: e.name, kind: e.isDirectory() ? "dir" : "file" as const }));
        // FR-5：读时从（stage x verified）派生信任——绝不存储。
        const trust = deriveScopeTrust(slice.frontmatter);
        const payload = {
          ok: true,
          slice: {
            mission: slice.missionName,
            name: slice.name,
            id: slice.id,
            status: slice.status,
            path: slice.absPath,
            frontmatter: slice.frontmatter,
            trust,
            readme,
            children,
          },
        };
        if (json) {
          out.write(JSON.stringify(payload, null, 2) + "\n");
        } else {
          out.write(`Slice：${slice.missionName}/${slice.name}\n`);
          out.write(`  id: ${slice.id ?? "—"}\n`);
          out.write(`  status: ${slice.status ?? "—"}\n`);
          out.write(formatTrustLine(trust));
          out.write(`  path: ${slice.absPath}\n`);
          out.write(`  子项：${children.length}\n`);
          if (readme) {
            out.write("\n--- README ---\n");
            out.write(readme);
            if (!readme.endsWith("\n")) out.write("\n");
          }
        }
      } catch (err) {
        fail(err, json, out);
      }
    });
}

// ---------------------------------------------------------------------
// zrig scope slice create
// ---------------------------------------------------------------------

function buildSliceCreateCommand(): Command {
  return new Command("create")
    .description("创建一个新 slice，带 SPEC.md、slice.yaml、PROGRESS.md、PROOF.md 和 proof/。约定 SSOT：docs/reference/sdlc-conventions.md（已安装：$OPENRIG_HOME/reference/sdlc-conventions.md）。")
    .argument("<mission>", "Mission 名")
    .argument("<slug>", "短 slug（成为文件夹名后缀）")
    .option("--template <kind>", `模板：${SLICE_TEMPLATE_KINDS.join(" | ")}`, "placeholder")
    .option("--title <text>", "显示标题（默认 titlecased slug）")
    .option("--intent <text>", "存进 SPEC.md frontmatter 的编写意图（默认标题）")
    .option("--depends-on <dot-id...>", "对兄弟 slice dot-ID 的建议构建顺序依赖")
    .option("--readme-only", "在 README frontmatter 写 progress_rail: readme-only，而不是搭 PROGRESS.md 骨架")
    .option("--json", "机器可读输出")
    .action(async (missionName: string, rawSlug: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const kind = opts.template as SliceTemplateKind;
        if (!SLICE_TEMPLATE_KINDS.includes(kind)) {
          throw new ScopeCliError({
            fact: `未知 --template 种类 "${kind}"。`,
            consequence: "未创建 slice。",
            action: `选一个：${SLICE_TEMPLATE_KINDS.join(", ")}。`,
          });
        }
        const slug = slugify(rawSlug);
        if (!slug) {
          throw new ScopeCliError({
            fact: `slug "${rawSlug}" slugify 后为空。`,
            consequence: "未创建 slice。",
            action: "选一个含字母或数字的 slug。",
          });
        }
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const mission = findMission(missionsRoot, missionName);
        const nn = nextSliceNN(mission.absPath);
        const sliceFolder = `${pad2(nn)}-${slug}`;
        const sliceAbs = path.join(mission.absPath, "slices", sliceFolder);
        if (fs.existsSync(sliceAbs)) {
          throw new ScopeCliError({
            fact: `slice 文件夹 ${sliceAbs} 已存在。`,
            consequence: "拒绝覆盖。",
            action: "换一个 slug，或先 rm -rf 现有文件夹。",
          });
        }
        const title = opts.title ?? titleFromSlug(slug);
        const intent = opts.intent ?? title;
        const compositionEdit = planMissionMembershipAdd(
          mission.absPath,
          `slices/${sliceFolder}/slice.yaml`,
          nextMissionMembershipOrder(mission.absPath),
        );
        const missionId = ensureMissionId(mission, missionsRoot);
        const id = sliceIdFromMission(missionId, nn);
        const dependsOn = Array.isArray(opts.dependsOn) ? [...new Set(opts.dependsOn as string[])] : [];
        for (const dependency of dependsOn) {
          if (!isSliceDotId(dependency) || !dependency.startsWith(`${missionId}.`)) {
            throw new ScopeCliError({
              fact: `依赖 "${dependency}" 不是 ${missionId} 下的兄弟 slice dot-ID。`,
              consequence: "未创建 slice。",
              action: `用形如 ${missionId}.<n> 的兄弟 ID，或省略 --depends-on。`,
            });
          }
        }
        const createdDate = todayDateISO();
        const body = renderSliceTemplate(kind, {
          id,
          slice_number: pad2(nn),
          slug,
          mission: mission.name,
          title,
          created_date: createdDate,
          intent,
          depends_on: dependsOn,
        });
        const proofBody = renderSliceProofTemplate({ id, title });
        const originalMissionNode = mission.readmePath ? fs.readFileSync(mission.readmePath, "utf8") : null;
        const readmePath = path.join(sliceAbs, "SPEC.md");
        try {
          // 在与子项及组合成员关系相同的回滚边界中持久化父 ID。上方校验不执行写入。
          ensureMissionIdPersisted(mission, missionsRoot);
          fs.mkdirSync(sliceAbs, { recursive: true });
          fs.mkdirSync(path.join(sliceAbs, "proof"), { recursive: true });
          // 新脚手架编写 SPEC.md；由现有 README 支撑的节点绝不重写。
          const readmeOnly = Boolean(opts.readmeOnly);
          if (readmeOnly) {
            const markerBody = body.replace(
              /^(---\n)/,
              `---\nprogress_rail: readme-only\n`,
            );
            fs.writeFileSync(readmePath, markerBody, "utf8");
          } else {
            fs.writeFileSync(readmePath, body, "utf8");
            const progressPath = path.join(sliceAbs, "PROGRESS.md");
            fs.writeFileSync(progressPath, renderSliceProgressTemplate(title), "utf8");
          }
          fs.writeFileSync(path.join(sliceAbs, "slice.yaml"), SLICE_MANIFEST, "utf8");
          fs.writeFileSync(path.join(sliceAbs, "PROOF.md"), proofBody, "utf8");
          applyMissionCompositionEdits(compositionEdit ? [compositionEdit] : []);
        } catch (error) {
          fs.rmSync(sliceAbs, { recursive: true, force: true });
          if (originalMissionNode !== null && mission.readmePath) fs.writeFileSync(mission.readmePath, originalMissionNode, "utf8");
          throw error;
        }
        const payload = {
          ok: true,
          slice: {
            mission: mission.name,
            name: sliceFolder,
            id,
            path: sliceAbs,
            readmePath,
            template: kind,
          },
        };
        emit(out, payload, json, [
          `已创建 ${mission.name}/slices/${sliceFolder}`,
          `  id: ${id}`,
          `  template: ${kind}`,
          `  path: ${sliceAbs}`,
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

// ---------------------------------------------------------------------
// zrig scope slice ship
// ---------------------------------------------------------------------

function buildSliceShipCommand(): Command {
  return new Command("ship")
    .description("把一个 slice 发布到 release mission（保留 git 历史）")
    .argument("<slice-path>", "Slice 路径（绝对、相对，或 NN-slug）")
    .argument("<release-mission>", "目标 release mission 名")
    .option("--mission <name>", "slice-path 只是 NN-slug 时提示 mission")
    .option("--json", "机器可读输出")
    .action(async (slicePath: string, releaseMission: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const slice = findSlice(missionsRoot, slicePath, opts.mission ?? null);
        const target = findMission(missionsRoot, releaseMission);
        if (target.name === slice.missionName) {
          throw new ScopeCliError({ fact: "源 mission 和 release mission 是同一个。", consequence: "未发布 slice。", action: "选一个不同的 release mission。" });
        }
        const targetSlicesDir = path.join(target.absPath, "slices");
        const newNN = nextSliceNN(target.absPath);
        const slug = slice.slug ?? slugify(slice.name);
        const newName = `${pad2(newNN)}-${slug}`;
        const destAbs = path.join(targetSlicesDir, newName);
        const sourceMission = findMission(missionsRoot, slice.missionName);
        const edits = [
          planMissionMembershipRemove(sourceMission.absPath, sliceManifestRef(sourceMission.absPath, slice.absPath)),
          planMissionMembershipAdd(target.absPath, `slices/${newName}/slice.yaml`, nextMissionMembershipOrder(target.absPath)),
        ].filter((edit): edit is MissionCompositionEdit => edit !== null);
        applyMissionCompositionEdits(edits);
        let moveResult: ReturnType<typeof moveSlice> | null = null;
        const originalNode = slice.readmePath ? fs.readFileSync(slice.readmePath, "utf8") : null;
        const originalTargetNode = target.readmePath ? fs.readFileSync(target.readmePath, "utf8") : null;
        try {
          moveResult = moveSlice(slice.absPath, destAbs);
          const targetId = ensureMissionIdPersisted(target, missionsRoot);
          const newSliceId = sliceIdFromMission(targetId, newNN);
          const newReadme = resolveNodeFile(destAbs);
          if (newReadme) {
            updateFrontmatter(newReadme, {
              id: newSliceId,
              mission: target.name,
              status: `shipped-to-${target.name}`,
              "shipped-on": todayDateISO(),
              "shipped-from": slice.missionName,
            });
          }
          const { usedGit, repoRoot } = moveResult;
          emit(out, {
            ok: true,
            shipped: {
              from: { mission: slice.missionName, name: slice.name, id: slice.id },
              to: { mission: target.name, name: newName, id: newSliceId, path: destAbs },
              git: { usedGit, repoRoot },
            },
          }, json, [
            `已发布 ${slice.missionName}/${slice.name} → ${target.name}/slices/${newName}`,
            `  id: ${newSliceId}`,
            `  git: ${usedGit ? "git mv" : "fs.rename（不在 git 仓库里）"}`,
          ]);
        } catch (error) {
          if (moveResult) rollbackMovedSlice(slice.absPath, destAbs, moveResult);
          if (originalNode !== null && slice.readmePath) fs.writeFileSync(slice.readmePath, originalNode, "utf8");
          if (originalTargetNode !== null && target.readmePath) fs.writeFileSync(target.readmePath, originalTargetNode, "utf8");
          rollbackComposition(edits);
          throw error;
        }
      } catch (err) {
        fail(err, json, out);
      }
    });
}

// ---------------------------------------------------------------------
// zrig scope slice close
// ---------------------------------------------------------------------

function buildSliceCloseCommand(): Command {
  return new Command("close")
    .description("关闭一个 slice（移到 <mission>/closed/，更新 status）")
    .argument("<slice-path>", "Slice 路径（绝对、相对，或 NN-slug）")
    .requiredOption("--reason <reason>", `关闭原因：${CLOSE_REASONS.join(" | ")}`)
    .option("--note <text>", "可选关闭备注")
    .option("--mission <name>", "slice-path 只是 NN-slug 时提示 mission")
    .option("--json", "机器可读输出")
    .action(async (slicePath: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const reason = opts.reason as CloseReason;
        if (!CLOSE_REASONS.includes(reason)) {
          throw new ScopeCliError({
            fact: `未知 --reason "${reason}"。`,
            consequence: "未关闭 slice。",
            action: `选一个：${CLOSE_REASONS.join(", ")}。`,
          });
        }
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const slice = findSlice(missionsRoot, slicePath, opts.mission ?? null);
        const mission = findMission(missionsRoot, slice.missionName);
        const closedDir = path.join(mission.absPath, "closed");
        const destName = slice.name;
        const destAbs = path.join(closedDir, destName);
        const compositionEdit = planMissionMembershipRemove(
          mission.absPath,
          sliceManifestRef(mission.absPath, slice.absPath),
        );
        const edits = compositionEdit ? [compositionEdit] : [];
        applyMissionCompositionEdits(edits);
        let moveResult: ReturnType<typeof moveSlice> | null = null;
        const originalNode = slice.readmePath ? fs.readFileSync(slice.readmePath, "utf8") : null;
        try {
          moveResult = moveSlice(slice.absPath, destAbs);
        } catch (error) {
          rollbackComposition(edits);
          throw error;
        }
        const { usedGit, repoRoot } = moveResult;
        const newReadme = resolveNodeFile(destAbs);
        try {
          if (newReadme) {
            const updates: Record<string, unknown> = {
              status: `closed-${reason}`,
              "closed-on": todayDateISO(),
            };
            if (opts.note) updates["closure-note"] = opts.note;
            updateFrontmatter(newReadme, updates);
          }
        } catch (error) {
          rollbackMovedSlice(slice.absPath, destAbs, moveResult);
          if (originalNode !== null && slice.readmePath) fs.writeFileSync(slice.readmePath, originalNode, "utf8");
          rollbackComposition(edits);
          throw error;
        }
        emit(out, {
          ok: true,
          closed: {
            mission: slice.missionName,
            name: destName,
            id: slice.id,
            reason,
            note: opts.note ?? null,
            path: destAbs,
            git: { usedGit, repoRoot },
          },
        }, json, [
          `已关闭 ${slice.missionName}/${slice.name} → ${slice.missionName}/closed/${destName}`,
          `  reason: ${reason}`,
          `  git: ${usedGit ? "git mv" : "fs.rename（不在 git 仓库里）"}`,
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

// ---------------------------------------------------------------------
// zrig scope slice move
// ---------------------------------------------------------------------

function buildSliceMoveCommand(): Command {
  return new Command("move")
    .description("在 mission 之间移动一个 slice（在目的地重新编号）")
    .argument("<slice-path>", "Slice 路径（绝对、相对，或 NN-slug）")
    .argument("<dest-mission>", "目标 mission 名")
    .option("--mission <name>", "slice-path 只是 NN-slug 时提示源 mission")
    .option("--json", "机器可读输出")
    .action(async (slicePath: string, destMission: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const slice = findSlice(missionsRoot, slicePath, opts.mission ?? null);
        const target = findMission(missionsRoot, destMission);
        if (target.name === slice.missionName) {
          throw new ScopeCliError({ fact: "源 mission 和目标 mission 是同一个。", consequence: "未移动 slice。", action: "选一个不同的目标 mission。" });
        }
        const targetSlicesDir = path.join(target.absPath, "slices");
        const newNN = nextSliceNN(target.absPath);
        const slug = slice.slug ?? slugify(slice.name);
        const newName = `${pad2(newNN)}-${slug}`;
        const destAbs = path.join(targetSlicesDir, newName);
        const sourceMission = findMission(missionsRoot, slice.missionName);
        const edits = [
          planMissionMembershipRemove(sourceMission.absPath, sliceManifestRef(sourceMission.absPath, slice.absPath)),
          planMissionMembershipAdd(target.absPath, `slices/${newName}/slice.yaml`, nextMissionMembershipOrder(target.absPath)),
        ].filter((edit): edit is MissionCompositionEdit => edit !== null);
        applyMissionCompositionEdits(edits);
        let moveResult: ReturnType<typeof moveSlice> | null = null;
        const originalNode = slice.readmePath ? fs.readFileSync(slice.readmePath, "utf8") : null;
        const originalTargetNode = target.readmePath ? fs.readFileSync(target.readmePath, "utf8") : null;
        try {
          moveResult = moveSlice(slice.absPath, destAbs);
          const targetId = ensureMissionIdPersisted(target, missionsRoot);
          const newSliceId = sliceIdFromMission(targetId, newNN);
          const newReadme = resolveNodeFile(destAbs);
          if (newReadme) {
            updateFrontmatter(newReadme, {
              id: newSliceId,
              mission: target.name,
              "moved-on": todayDateISO(),
              "moved-from": slice.missionName,
            });
          }
          const { usedGit, repoRoot } = moveResult;
          emit(out, {
            ok: true,
            moved: {
              from: { mission: slice.missionName, name: slice.name, id: slice.id },
              to: { mission: target.name, name: newName, id: newSliceId, path: destAbs },
              git: { usedGit, repoRoot },
            },
          }, json, [
            `已移动 ${slice.missionName}/${slice.name} → ${target.name}/slices/${newName}`,
            `  id: ${newSliceId}`,
            `  git: ${usedGit ? "git mv" : "fs.rename（不在 git 仓库里）"}`,
          ]);
        } catch (error) {
          if (moveResult) rollbackMovedSlice(slice.absPath, destAbs, moveResult);
          if (originalNode !== null && slice.readmePath) fs.writeFileSync(slice.readmePath, originalNode, "utf8");
          if (originalTargetNode !== null && target.readmePath) fs.writeFileSync(target.readmePath, originalTargetNode, "utf8");
          rollbackComposition(edits);
          throw error;
        }
      } catch (err) {
        fail(err, json, out);
      }
    });
}

// ---------------------------------------------------------------------
// zrig scope mission ls / show / create
// ---------------------------------------------------------------------

function buildMissionLsCommand(): Command {
  return new Command("ls")
    .description("列出 missions（带 SPEC.md 或旧 README.md 的顶层文件夹）")
    .option("--json", "机器可读输出")
    .action(async (opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const missions = listMissions(missionsRoot);
        const rows = missions.map((m) => ({
          name: m.name,
          id: m.id,
          path: m.absPath,
          activeSliceCount: m.activeSliceCount,
          closedSliceCount: m.closedSliceCount,
        }));
        emit(out, { ok: true, count: rows.length, missions: rows }, json,
          rows.length === 0
            ? ["（无 missions）"]
            : rows.map((r) => `${r.name}    ${r.id ?? "—"}    active=${r.activeSliceCount}  closed=${r.closedSliceCount}`),
        );
      } catch (err) {
        fail(err, json, out);
      }
    });
}

function buildMissionShowCommand(): Command {
  return new Command("show")
    .description("检视单个 mission")
    .argument("<mission>", "Mission 名")
    .option("--json", "机器可读输出")
    .action(async (missionName: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const mission = findMission(missionsRoot, missionName);
        const readme = mission.readmePath ? fs.readFileSync(mission.readmePath, "utf8") : null;
        const slices = listSlices(mission, "all").map((s) => ({
          name: s.name, id: s.id, status: s.status, nn: s.nn,
        }));
        // FR-5：读时从（stage x verified）派生信任——绝不存储。
        const trust = deriveScopeTrust(mission.frontmatter);
        const payload = {
          ok: true,
          mission: {
            name: mission.name,
            id: mission.id,
            path: mission.absPath,
            activeSliceCount: mission.activeSliceCount,
            closedSliceCount: mission.closedSliceCount,
            frontmatter: mission.frontmatter,
            trust,
            readme,
            slices,
          },
        };
        if (json) {
          out.write(JSON.stringify(payload, null, 2) + "\n");
        } else {
          out.write(`Mission：${mission.name}\n`);
          out.write(`  id: ${mission.id ?? "—"}\n`);
          out.write(formatTrustLine(trust));
          out.write(`  活动 slices：${mission.activeSliceCount}\n`);
          out.write(`  已关闭 slices：${mission.closedSliceCount}\n`);
          out.write(`  path: ${mission.absPath}\n`);
          if (readme) {
            out.write(`\n--- ${path.basename(mission.readmePath!)} ---\n`);
            out.write(readme);
            if (!readme.endsWith("\n")) out.write("\n");
          }
        }
      } catch (err) {
        fail(err, json, out);
      }
    });
}

function buildMissionCreateCommand(): Command {
  return new Command("create")
    .description("创建一个新 mission，带 SPEC.md 和 mission.yaml（在 frontmatter 铸一个稳定 dot-ID）")
    .argument("<name>", "Mission 文件夹名（例如 release-0.4.0、backlog-foo）")
    .option("--template <kind>", `模板：${MISSION_TEMPLATE_KINDS.join(" | ")}（名字匹配 release-X.Y.Z 时自动）`, "")
    .option("--id <dot-id>", "显式 dot-ID。覆盖名字模式推断。")
    .option("--title <text>", "显示标题（默认 titlecased 名）")
    .option("--intent <text>", "存进 SPEC.md frontmatter 的编写意图（默认标题）")
    .option("--depends-on <dot-id...>", "对兄弟 mission dot-ID 的建议构建顺序依赖")
    .option("--no-notes", "跳过 NOTES.md 骨架")
    .option("--no-mission-notes", "--no-notes 的已废弃别名")
    .option("--json", "机器可读输出")
    .action(async (rawName: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const name = rawName.trim();
        if (!name || /[\\/\s]/.test(name)) {
          throw new ScopeCliError({
            fact: `非法 mission 名 "${rawName}"。`,
            consequence: "未创建 mission。",
            action: "选一个不含空白或路径分隔符的名字。",
          });
        }
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const absPath = path.join(missionsRoot, name);
        if (fs.existsSync(absPath)) {
          throw new ScopeCliError({
            fact: `mission 文件夹 ${absPath} 已存在。`,
            consequence: "拒绝覆盖。",
            action: "换一个名字，或用 `zrig scope mission show <name>` 检视已有 mission。",
          });
        }
        // 解析 template kind：显式 > release 模式自动 > placeholder。
        const isReleaseName = /^release-\d+\.\d+(?:\.\d+)?$/.test(name);
        let templateKind: MissionTemplateKind = opts.template as MissionTemplateKind;
        if (!templateKind) templateKind = isReleaseName ? "release" : "placeholder";
        if (!MISSION_TEMPLATE_KINDS.includes(templateKind)) {
          throw new ScopeCliError({
            fact: `未知 --template 种类 "${templateKind}"。`,
            consequence: "未创建 mission。",
            action: `选一个：${MISSION_TEMPLATE_KINDS.join(", ")}。`,
          });
        }
        // 铸造 dot-ID。
        let id: string;
        if (opts.id) {
          // 按 guard BC 裁定（BLOCK 1）的 tier 感知校验。
          // mission ID 在前缀后有 2-3 段数字
          //（release X.Y 或 X.Y.Z；escape band 99.x.y）。拒绝
          // slice 形 ID（4 段），让父身份保持无歧义。
          if (!isMissionDotId(opts.id)) {
            throw new ScopeCliError({
              fact: `提供的 --id "${opts.id}" 不是 mission tier dot-ID。`,
              consequence: "未创建 mission。mission ID 形如 <PFX>.<ver>（2-3 段数字），不是 slice 形 <PFX>.<ver>.<n>。",
              action: `用 mission 形 dot-ID，例如 OPR.0.3.2（release）或 OPR.99.0.1（escape band）。slice ID 在你创建 slice 时由 scope 自动铸造。`,
            });
          }
          id = opts.id;
        } else if (isReleaseName) {
          id = inferMissionDotId(name, null);
        } else {
          const peers = listMissions(missionsRoot);
          const ordinal = nextEscapeBandOrdinal(peers.map((p) => p.id));
          id = inferMissionDotId(name, ordinal);
        }
        // 在任何文件系统副作用前解析标题 + 渲染模板。
        // 陈旧的 current 或旧 notes-template 覆盖必须在 mkdir 前失败，
        // 否则会漏出半个创建的 mission 目录。
        const title = opts.title ?? titleFromSlug(name.replace(/^release-/, ""));
        const intent = opts.intent ?? title;
        const dependsOn = Array.isArray(opts.dependsOn) ? [...new Set(opts.dependsOn as string[])] : [];
        const project = id.split(".")[0];
        for (const dependency of dependsOn) {
          if (!isMissionDotId(dependency) || dependency.split(".")[0] !== project) {
            throw new ScopeCliError({
              fact: `依赖 "${dependency}" 不是 project ${project} 下的兄弟 mission dot-ID。`,
              consequence: "未创建 mission。",
              action: `用形如 ${project}.<version> 的 mission ID，或省略 --depends-on。`,
            });
          }
        }
        const releaseVersion = isReleaseName ? name.replace(/^release-/, "") : "";
        const readmeBody = renderMissionTemplate(templateKind, {
          id,
          slug: name,
          mission: name,
          title,
          created_date: todayDateISO(),
          release_version: releaseVersion,
          intent,
          depends_on: dependsOn,
        });
        let notesRendered: ReturnType<typeof renderNotesTemplate> | null = null;
        if (opts.notes !== false && opts.missionNotes !== false) {
          notesRendered = renderNotesTemplate({
            mission_id: id,
            mission_name: title,
            created_date: todayDateISO(),
          });
        }
        const progressBody = renderMissionProgressTemplate(title);
        const capabilityDeltaBody = isReleaseName
          ? renderCapabilityDeltaTemplate({
              id,
              slug: name,
              mission: name,
              title,
              created_date: todayDateISO(),
              release_version: releaseVersion,
              intent,
              depends_on: dependsOn,
            })
          : null;
        // 全部渲染成功——可以安全动文件系统了。
        fs.mkdirSync(absPath, { recursive: true });
        fs.mkdirSync(path.join(absPath, "slices"), { recursive: true });
        // 新骨架编写 SPEC.md；已有 README 节点绝不被重写。
        const readmePath = path.join(absPath, "SPEC.md");
        fs.writeFileSync(readmePath, readmeBody, "utf8");
        fs.writeFileSync(path.join(absPath, "mission.yaml"), MISSION_MANIFEST, "utf8");
        const progressPath = path.join(absPath, "PROGRESS.md");
        fs.writeFileSync(progressPath, progressBody, "utf8");
        const capabilityDeltaPath = capabilityDeltaBody
          ? path.join(absPath, `CAPABILITY-DELTA-v${releaseVersion}.md`)
          : null;
        if (capabilityDeltaPath && capabilityDeltaBody) {
          fs.writeFileSync(capabilityDeltaPath, capabilityDeltaBody, "utf8");
        }
        let notesPath: string | null = null;
        if (notesRendered) {
          notesPath = path.join(absPath, "NOTES.md");
          fs.writeFileSync(notesPath, notesRendered.rendered, "utf8");
        }
        const humanLines = [
          `已创建 mission ${name}`,
          `  id: ${id}`,
          `  template: ${templateKind}`,
          `  path: ${absPath}`,
        ];
        if (notesPath) {
          humanLines.push(`  notes: ${notesPath}（模板：${notesRendered?.resolvedFrom}）`);
        }
        if (capabilityDeltaPath) humanLines.push(`  capability delta: ${capabilityDeltaPath}`);
        if (notesRendered?.resolvedFrom === "legacy-env") {
          humanLines.push("  提示：OPENRIG_MISSION_NOTES_TEMPLATE_PATH 已废弃；用 OPENRIG_NOTES_TEMPLATE_PATH");
        }
        emit(out, {
          ok: true,
          mission: {
            name,
            id,
            template: templateKind,
            path: absPath,
            readmePath,
            notesPath,
            capabilityDeltaPath,
            notesResolvedFrom: notesRendered?.resolvedFrom ?? null,
            advisories: notesRendered?.resolvedFrom === "legacy-env"
              ? ["OPENRIG_MISSION_NOTES_TEMPLATE_PATH is deprecated; use OPENRIG_NOTES_TEMPLATE_PATH"]
              : [],
          },
        }, json, humanLines);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

function buildMissionGraphCommand(): Command {
  return new Command("graph")
    .description("显示建议的兄弟构建顺序边和当前 ready 集")
    .argument("<mission>", "Mission 名")
    .option("--json", "机器可读输出")
    .action(async (missionName: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const graph = buildMissionDependencyGraph(findMission(missionsRoot, missionName));
        emit(out, { ok: true, graph }, json, [
          `Ready：${graph.ready.join(", ") || "（无）"}`,
          ...graph.waiting.map((row) => `Waiting：${row.id} 等 ${row.on.join(", ")}`),
          ...graph.advisories.map((row) => `Advisory：${row.id}${row.dependency ? ` -> ${row.dependency}` : ""}：${row.message}`),
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

function buildResolveNotesCommand(): Command {
  return new Command("resolve-notes")
    .description("为一个绝对工作节点目录解析可读的 mission notes 文件")
    .argument("<absolute-work-node-dir>", "绝对 mission 或 slice 目录")
    .option("--json", "机器可读 JSON 输出")
    .action((workNodeDir: string, opts) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        if (!path.isAbsolute(workNodeDir)) {
          throw new ScopeCliError({
            fact: `工作节点目录必须是绝对路径：${workNodeDir}`,
            consequence: "mission notes 无法从一个有歧义的位置解析。",
            action: "传绝对 mission 或 slice 目录。",
          });
        }
        const resolution = resolveNotesFile(workNodeDir);
        emit(out, { ok: true, resolution }, json, [
          resolution
            ? `${resolution.name}: ${resolution.path}`
            : `${workNodeDir} 处无可读 mission notes`,
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

// ---------------------------------------------------------------------
// Audit（B2——只读 scope 审计）
// ---------------------------------------------------------------------

function buildAuditCommand(): Command {
  return new Command("audit")
    .description("只读 scope 审计：标记 scope findings 并显示建议依赖图")
    .requiredOption("--mission <name>", "要审计的 mission")
    .option("--json", "机器可读 JSON 输出")
    .action(async (opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const { classifyScopeItem } = await import("../lib/scope/scope-audit.js");
        const missionName = opts.mission as string;

        const missionDir = path.join(missionsRoot, missionName);
        if (!fs.existsSync(missionDir)) {
          throw new ScopeCliError({ fact: `在 ${missionDir} 找不到 mission "${missionName}"。`, consequence: "无法审计。", action: "检查 mission 名。" });
        }

        const missionReadme = resolveNodeFile(missionDir) ?? path.join(missionDir, "SPEC.md");
        const missionProgress = path.join(missionDir, "PROGRESS.md");
        const missionNotesResolution = resolveNotesFile(missionDir);
        const missionNotesPath = missionNotesResolution?.path
          ?? path.join(missionDir, NOTES_FILE_PRECEDENCE[0]);
        const missionReadmeExists = fs.existsSync(missionReadme);
        const missionProgressExists = fs.existsSync(missionProgress);
        const auditMission: MissionInfo = missionReadmeExists
          ? findMission(missionsRoot, missionName)
          : {
              name: missionName,
              absPath: missionDir,
              readmePath: null,
              frontmatter: {},
              id: null,
              activeSliceCount: 0,
              closedSliceCount: 0,
            };
        const graph = buildMissionDependencyGraph(auditMission);

        let missionResult: ReturnType<typeof classifyScopeItem>;
        if (!missionReadmeExists && missionProgressExists) {
          missionResult = {
            railStatus: "malformed",
            findings: [{
              kind: "orphan_progress",
              severity: "high",
              path: missionDir,
              message: `PROGRESS.md 存在但没有 SPEC.md 或旧 README.md（孤立 progress rail，无 backing scope item）`,
              remediation: `加一个带 frontmatter id 的 SPEC.md，或删掉孤立 PROGRESS.md`,
            }],
            frontmatterError: null,
          };
        } else {
          const missionFm = missionReadmeExists
            ? extractFrontmatterRaw(fs.readFileSync(missionReadme, "utf-8"))
            : null;
          missionResult = classifyScopeItem({
            id: null,
            path: missionDir,
            readmeFrontmatterRaw: missionFm,
            progressFileExists: missionProgressExists,
            readmeOnlyMarker: false,
            isActiveRelease: true,
            level: "mission",
            missionNotesResolution,
            missionNotesPath,
          });
        }

        const missionShadow = shadowedNodeFileFinding(missionDir, "mission");
        if (missionShadow) missionResult.findings.push(missionShadow);
        missionResult.findings.push(...capabilityDeltaExpiryFindings(missionDir));

        const slicesDir = path.join(missionDir, "slices");
        const dogfoodEvidenceRoot = defaultDogfoodEvidenceRoot(missionsRoot);
        const sliceResults: Array<{
          name: string;
          result: ReturnType<typeof classifyScopeItem>;
          attestations?: AttestationLineage;
        }> = [];

        if (fs.existsSync(slicesDir)) {
          for (const entry of fs.readdirSync(slicesDir)) {
            const sliceDir = path.join(slicesDir, entry);
            if (!fs.statSync(sliceDir).isDirectory()) continue;
            const sliceReadme = resolveNodeFile(sliceDir) ?? path.join(sliceDir, "SPEC.md");
            const sliceProgress = path.join(sliceDir, "PROGRESS.md");
            const proofFile = path.join(sliceDir, "PROOF.md");
            const proofDir = path.join(sliceDir, "proof");

            if (!fs.existsSync(sliceReadme)) {
              if (fs.existsSync(sliceProgress)) {
                sliceResults.push({
                  name: entry,
                  result: {
                    railStatus: "malformed" as const,
                    findings: [{
                      kind: "orphan_progress" as const,
                      severity: "high" as const,
                      path: sliceDir,
                      message: `PROGRESS.md 存在但没有 SPEC.md 或旧 README.md（孤立 progress rail，无 backing scope item）`,
                      remediation: `加一个带 frontmatter id 的 SPEC.md，或删掉孤立 PROGRESS.md`,
                    }],
                    frontmatterError: null,
                  },
                });
              } else {
                const noReadmeResult = classifyScopeItem({
                  id: null,
                  path: sliceDir,
                  readmeFrontmatterRaw: null,
                  progressFileExists: false,
                  readmeOnlyMarker: false,
                  isActiveRelease: true,
                  level: "slice",
                });
                sliceResults.push({ name: entry, result: noReadmeResult });
              }
              continue;
            }

            const sliceReadmeContent = fs.readFileSync(sliceReadme, "utf-8");
            const sliceFm = extractFrontmatterRaw(sliceReadmeContent);
            const readmeOnlyMarker = sliceFm !== null && /^progress_rail\s*:\s*readme-only/m.test(sliceFm);

            const sliceResult = classifyScopeItem({
              id: null,
              path: sliceDir,
              readmeFrontmatterRaw: sliceFm,
              progressFileExists: fs.existsSync(sliceProgress),
              readmeOnlyMarker,
              isActiveRelease: true,
              level: "slice",
              proofFileExists: fs.existsSync(proofFile),
              proofFilePath: proofFile,
              proofDirExists: fs.existsSync(proofDir),
              proofDirPath: proofDir,
              proofDirHasEntries: directoryHasEntries(proofDir),
              hasProofPacket: hasProofPacketForSlice(dogfoodEvidenceRoot, entry),
              // OPR.0.4.4.19 FR-10 兜底输入。
              proofArtifacts: listProofArtifactsForAudit(proofDir),
              implementationPrdExists: fs.existsSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md")),
              // OPR.0.4.4.23 约定段建议输入。
              nodeFileName: path.basename(sliceReadme) as "SPEC.md" | "README.md",
              readmeContent: sliceReadmeContent,
              implementationPrdContent: fs.existsSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"))
                ? fs.readFileSync(path.join(sliceDir, "IMPLEMENTATION-PRD.md"), "utf-8")
                : null,
            });

            if (!/^\d{2}-/.test(entry)) {
              sliceResult.findings.push({
                kind: "id_convention_violation",
                severity: "high",
                path: sliceDir,
                message: `文件夹 "${entry}" 不匹配 NN-slice 命名约定（例如 01-my-slice）`,
                remediation: `重命名为 NN-slug 格式，或移出 slices/`,
              });
            }

            sliceResults.push({ name: entry, result: sliceResult, attestations: attestationLineage(sliceFm) });
          }
        }

        for (const sr of sliceResults) {
          const shadow = shadowedNodeFileFinding(path.join(slicesDir, sr.name), "slice");
          if (shadow) sr.result.findings.push(shadow);
        }

        const allFindings = [
          ...missionResult.findings.map((f) => ({ ...f, scope: "mission" as const, scopeName: missionName })),
          ...sliceResults.flatMap((s) => s.result.findings.map((f) => ({ ...f, scope: "slice" as const, scopeName: s.name }))),
        ];
        const hardFindings = allFindings.filter((f) => f.severity === "high");

        if (json) {
          out.write(JSON.stringify({
            ok: hardFindings.length === 0,
            mission: { name: missionName, railStatus: missionResult.railStatus, frontmatterError: missionResult.frontmatterError, findings: missionResult.findings },
            slices: sliceResults.map((s) => ({
              name: s.name,
              railStatus: s.result.railStatus,
              frontmatterError: s.result.frontmatterError,
              findings: s.result.findings,
              // OPR.0.5.0.18——amendment lineage（仅 re-stamp 时存在）。
              ...(s.attestations ? { attestations: s.attestations } : {}),
            })),
            graph,
            totalFindings: allFindings.length,
          }, null, 2));
          out.write("\n");
          if (hardFindings.length > 0) process.exitCode = 1;
          return;
        }

        out.write(`Scope 审计：${missionName}\n`);
        out.write(`Mission rail：${missionResult.railStatus}\n`);
        out.write(`Slices：共 ${sliceResults.length}\n`);
        out.write(`Ready：${graph.ready.join(", ") || "（无）"}\n`);
        for (const row of graph.waiting) out.write(`Waiting：${row.id} 等 ${row.on.join(", ")}\n`);
        for (const row of graph.advisories) {
          out.write(`Advisory：${row.id}${row.dependency ? ` -> ${row.dependency}` : ""}：${row.message}\n`);
        }
        out.write("\n");

        // OPR.0.5.0.18——amendment lineage：re-stamp 的 slice 显示
        // 当前 attestation + prior 数（append-only 审计行
        // 重建完整历史；这是一目了然的表面）。
        const amended = sliceResults.filter((s) => s.attestations);
        if (amended.length > 0) {
          out.write("AMENDMENT LINEAGE：\n");
          for (const s of amended) {
            for (const [scope, att] of Object.entries(s.attestations!)) {
              out.write(`  ${s.name} [${scope}]：当前 ${att.by} 于 ${att.at}——审计日志中 ${att.priors} 条 prior attestation\n`);
            }
          }
          out.write("\n");
        }

        if (allFindings.length > 0) {
          out.write("FINDINGS：\n");
          for (const f of allFindings) {
            out.write(`  [${f.severity}] [${f.kind}] ${f.scope}/${f.scopeName}\n`);
            out.write(`    ${f.message}\n`);
            out.write(`    修复：${f.remediation}\n`);
          }
          if (hardFindings.length > 0) {
            out.write(`\nFAIL：${allFindings.length} 个 finding\n`);
            process.exitCode = 1;
          } else {
            out.write(`\nWARN：${allFindings.length} 个建议性 finding\n`);
          }
        } else {
          out.write("PASS：所有 scope item 的 rail 都有效\n");
        }
      } catch (err) {
        if (err instanceof ScopeCliError) { fail(err, json, out); }
        throw err;
      }
    });
}

function extractFrontmatterRaw(content: string): string | null {
  if (!content.startsWith("---")) return null;
  const match = /^---\s*\n([\s\S]*?)\n---/.exec(content);
  return match ? match[1]! : null;
}

function directoryHasEntries(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((entry) => !entry.startsWith("."));
  } catch {
    return false;
  }
}

function defaultDogfoodEvidenceRoot(missionsRoot: string): string {
  return path.join(path.dirname(missionsRoot), "dogfood-evidence");
}

// OPR.0.4.4.19 FR-10（C1 backstop 输入）——列出 slice 的 proof/ markdown
// artifact 及其原始 frontmatter。媒体文件按构造豁免。
// 目录不存在/不可读时为 undefined，让分类器保持惰性。
function listProofArtifactsForAudit(proofDir: string): Array<{ path: string; frontmatterRaw: string | null }> | undefined {
  if (!fs.existsSync(proofDir)) return undefined;
  try {
    return fs.readdirSync(proofDir)
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .map((f) => {
        const artifactPath = path.join(proofDir, f);
        return { path: artifactPath, frontmatterRaw: extractFrontmatterRaw(fs.readFileSync(artifactPath, "utf-8")) };
      });
  } catch {
    return undefined;
  }
}

function hasProofPacketForSlice(dogfoodEvidenceRoot: string, sliceName: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dogfoodEvidenceRoot, { withFileTypes: true });
  } catch {
    return false;
  }

  const sliceTokens = sliceName.split("-").filter((token) => token.length > 0 && !/^v\d+$/.test(token));
  return entries.some((entry) => {
    if (!entry.isDirectory()) return false;
    const dirTokenSet = new Set(entry.name.split(/[-._]/).filter((token) => token.length > 0));
    return sliceTokens.every((token) => dirTokenSet.has(token));
  });
}

// ---------------------------------------------------------------------
// rig scope <tier> progress（OPR.0.4.0.33 FR-3——确定性更新）
// ---------------------------------------------------------------------

/** 解析一个 scope 目录的 progress 更新编辑哪个文件：
 *  有 PROGRESS.md 时用它；否则 readme-only
 *  scope 用 README 的 rail；否则报错指引 create/repair（这个动词更新
 *  已有表面；它不搭骨架）。 */
function resolveProgressTarget(scopeDir: string, level: "mission" | "slice"): {
  targetPath: string;
  kind: "progress" | "readme-only";
} {
  const progressPath = path.join(scopeDir, "PROGRESS.md");
  if (fs.existsSync(progressPath)) return { targetPath: progressPath, kind: "progress" };
  const readmePath = resolveNodeFile(scopeDir);
  if (readmePath) {
    const fm = readFrontmatter(readmePath);
    if (String(fm.progress_rail ?? "") === "readme-only") {
      return { targetPath: readmePath, kind: "readme-only" };
    }
  }
  throw new ScopeCliError({
    fact: `${scopeDir} 的 ${level} 没有 progress 表面（无 PROGRESS.md，也无 readme-only rail）。`,
    consequence: "progress 动词更新已有表面；它不搭骨架。",
    action: `用以下之一回填：zrig scope ${level} repair <target>（创建 PROGRESS.md），或 zrig scope ${level} create。`,
  });
}

/** slice/mission progress 的共享主体：校验互斥的
 *  --add/--set 模式，编辑解析出的表面，仅在变化时写入。 */
function runProgressUpdate(
  scopeDir: string,
  level: "mission" | "slice",
  scopeName: string,
  opts: { add?: string; set?: string; section?: string; status?: string },
  out: Stdout,
  json: boolean,
): void {
  const hasAdd = typeof opts.add === "string";
  const hasSet = typeof opts.set === "string";
  if (hasAdd === hasSet) {
    throw new ScopeCliError({
      fact: hasAdd
        ? "同时给了 --add 和 --set。"
        : "--add 和 --set 都没给。",
      consequence: "未做任何 progress 更新。",
      action: '恰好传一个：--add "<row text>" 或 --set "<row text>"。',
    });
  }
  const status = parseStatus(opts.status ?? "active");
  const { targetPath, kind } = resolveProgressTarget(scopeDir, level);
  const before = fs.readFileSync(targetPath, "utf8");

  let result: { content: string; changed: boolean };
  let operation: "add" | "set";
  if (hasAdd) {
    operation = "add";
    result = addProgressRow(before, {
      section: opts.section ?? DEFAULT_PROGRESS_SECTION,
      text: opts.add!,
      status,
    });
  } else {
    operation = "set";
    result = setProgressRow(before, { text: opts.set!, status });
  }

  if (result.changed) fs.writeFileSync(targetPath, result.content, "utf8");

  emit(out, {
    ok: true,
    progress: {
      scope: level,
      name: scopeName,
      target: targetPath,
      kind,
      operation,
      status,
      changed: result.changed,
    },
  }, json, [
    `${result.changed ? "已更新" : "无变化"} ${level} ${scopeName} progress（${operation}）`,
    `  target: ${targetPath}`,
    `  status: ${status}`,
  ]);
}

function buildSliceProgressCommand(): Command {
  return new Command("progress")
    .description("确定性更新 slice 的 progress rail（追加一行，或设置一行的 status）")
    .argument("<slice-path>", "Slice 路径（绝对、相对，或 NN-slug）")
    .option("--mission <name>", "slice-path 只是 NN-slug 时提示 mission")
    .option("--add <text>", "追加一行带此文本的 checkbox 行")
    .option("--set <text>", "设置 trimmed 文本精确匹配的行的 status")
    .option("--section <heading>", `--add 的段标题（默认：${DEFAULT_PROGRESS_SECTION}）`)
    .option("--status <status>", `行 status：${PROGRESS_STATUSES.join(" | ")}`, "active")
    .option("--json", "机器可读输出")
    .action(async (slicePath: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const slice = findSlice(missionsRoot, slicePath, opts.mission ?? null);
        runProgressUpdate(slice.absPath, "slice", slice.name, opts, out, json);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

function buildMissionProgressCommand(): Command {
  return new Command("progress")
    .description("确定性更新 mission 的 progress rail（追加一行，或设置一行的 status）")
    .argument("<mission>", "Mission 名")
    .option("--add <text>", "追加一行带此文本的 checkbox 行")
    .option("--set <text>", "设置 trimmed 文本精确匹配的行的 status")
    .option("--section <heading>", `--add 的段标题（默认：${DEFAULT_PROGRESS_SECTION}）`)
    .option("--status <status>", `行 status：${PROGRESS_STATUSES.join(" | ")}`, "active")
    .option("--json", "机器可读输出")
    .action(async (missionName: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const mission = findMission(missionsRoot, missionName);
        runProgressUpdate(mission.absPath, "mission", mission.name, opts, out, json);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

// ---------------------------------------------------------------------
// rig scope <tier> repair（OPR.0.4.0.33 FR-6——幂等回填）
// ---------------------------------------------------------------------

interface BackfillResult {
  scope: "mission" | "slice";
  name: string;
  created: boolean;
  reason: string;
  path: string | null;
}

/** 镜像 create 时的标题派生，让回填的 PROGRESS.md
 *  与 create 当时会写的字节一致。 */
function backfillTitle(level: "mission" | "slice", scopeDir: string): string {
  const base = path.basename(scopeDir);
  return level === "mission"
    ? titleFromSlug(base.replace(/^release-/, ""))
    : titleFromSlug(base.replace(/^\d+-/, ""));
}

/** 为单个 scope 目录创建缺失的 PROGRESS.md。幂等
 * （已存在则跳过）且不覆盖（跳过有意
 *  readme-only 的 scope，也跳过未声明为
 *  scope 的无 README 目录）。 */
function backfillScopeProgress(scopeDir: string, level: "mission" | "slice"): BackfillResult {
  const name = path.basename(scopeDir);
  const readmePath = resolveNodeFile(scopeDir);
  if (!readmePath) {
    return { scope: level, name, created: false, reason: "no-readme（非已声明 scope）", path: null };
  }
  const progressPath = path.join(scopeDir, "PROGRESS.md");
  if (fs.existsSync(progressPath)) {
    return { scope: level, name, created: false, reason: "already-present", path: progressPath };
  }
  const fm = readFrontmatter(readmePath);
  if (String(fm.progress_rail ?? "") === "readme-only") {
    return { scope: level, name, created: false, reason: "readme-only（有意 opt-out）", path: null };
  }
  const title = backfillTitle(level, scopeDir);
  const body = level === "mission"
    ? renderMissionProgressTemplate(title)
    : renderSliceProgressTemplate(title);
  fs.writeFileSync(progressPath, body, "utf8");
  return { scope: level, name, created: true, reason: "backfilled", path: progressPath };
}

// ---------------------------------------------------------------------
// OPR.0.4.1.6——stage + verified 动作（确定性的 §2 成熟度编辑）
// ---------------------------------------------------------------------

/** 按 §2 枚举校验一个 stage，拒绝凭空造的值。 */
function validateStage(raw: string): Stage {
  if (!STAGE_VALUES.includes(raw as Stage)) {
    throw new ScopeCliError({
      fact: `非法 stage "${raw}"。`,
      consequence: "stage 未改变。",
      action: `用其中之一：${STAGE_VALUES.join(" | ")}。`,
    });
  }
  return raw as Stage;
}

/** 在 scope README 上外科手术式地设置 `stage`（superseded 时加 `superseded-by`），
 *  强制 §2 superseded-needs-successor 规则。 */
function applyStage(readmePath: string, stage: Stage, successor: unknown): void {
  const updates: Record<string, unknown> = { stage };
  if (stage === "superseded") {
    const id = typeof successor === "string" ? successor.trim() : "";
    if (!id) {
      throw new ScopeCliError({
        fact: "stage 'superseded' 需要一个 successor。",
        consequence: "stage 未改变（superseded scope 必须按 scope-and-versioning §2 命名它的替代者）。",
        action: "带 --successor <id> 重跑，例如 --successor OPR.0.4.1.7。",
      });
    }
    updates["superseded-by"] = id;
  }
  updateFrontmatter(readmePath, updates);
}

/** `retired` 是出口，不是 rung——警告（不阻塞）。 */
function warnRetired(stage: Stage): void {
  if (stage === "retired") {
    process.stderr.write("警告：stage 'retired' 意为 do-not-use（一个出口，不是成熟度 rung）。\n");
  }
}

/** 校验 --against 出处：必填、非空、非纯空白
 * （§2 "no bare timestamp" 规则）。返回 trimmed 后的 source。 */
function validateAgainst(raw: unknown): string {
  const source = typeof raw === "string" ? raw.trim() : "";
  if (!source) {
    throw new ScopeCliError({
      fact: "--against 出处为空或缺失。",
      consequence: "未盖 verified——scope-and-versioning §2 禁止没有命名 source 的裸时间戳。",
      action: '提供它被 against 的对象，例如 --against "runtime (npm+tag+origin)"。',
    });
  }
  return source;
}

function buildSliceStageCommand(): Command {
  return new Command("stage")
    .description(`设置 slice 的认知 stage（${STAGE_VALUES.join(" | ")}）；superseded 需要 --successor`)
    .argument("<slice-path>", "Slice 路径（绝对、相对，或 NN-slug）")
    .argument("<new-stage>", `新 stage：${STAGE_VALUES.join(" | ")}`)
    .option("--successor <id>", "Successor scope id——new-stage 为 superseded 时必填")
    .option("--mission <name>", "slice-path 只是 NN-slug 时提示 mission")
    .option("--json", "机器可读输出")
    .action(async (slicePath: string, newStage: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const stage = validateStage(newStage);
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const slice = findSlice(missionsRoot, slicePath, opts.mission ?? null);
        if (!slice.readmePath) {
          throw new ScopeCliError({
            fact: `slice ${slice.name} 没有 SPEC.md 或旧 README.md。`,
            consequence: "stage 是 work-node frontmatter 字段；没东西可写。",
            action: "先用 `zrig scope slice create` 创建 slice，再设置它的 stage。",
          });
        }
        applyStage(slice.readmePath, stage, opts.successor);
        warnRetired(stage);
        const supersededBy = stage === "superseded" ? String(opts.successor).trim() : undefined;
        emit(out, { ok: true, scope: { tier: "slice", mission: slice.missionName, name: slice.name, id: slice.id, stage, ...(supersededBy ? { supersededBy } : {}) } }, json, [
          `已设置 ${slice.missionName}/${slice.name} stage：${stage}`,
          ...(supersededBy ? [`  superseded-by: ${supersededBy}`] : []),
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

function buildMissionStageCommand(): Command {
  return new Command("stage")
    .description(`设置 mission 的认知 stage（${STAGE_VALUES.join(" | ")}）；superseded 需要 --successor`)
    .argument("<mission>", "Mission 名")
    .argument("<new-stage>", `新 stage：${STAGE_VALUES.join(" | ")}`)
    .option("--successor <id>", "Successor scope id——new-stage 为 superseded 时必填")
    .option("--json", "机器可读输出")
    .action(async (missionName: string, newStage: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const stage = validateStage(newStage);
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const mission = findMission(missionsRoot, missionName);
        if (!mission.readmePath) {
          throw new ScopeCliError({
            fact: `mission ${mission.name} 没有 SPEC.md 或旧 README.md。`,
            consequence: "stage 是 work-node frontmatter 字段；没东西可写。",
            action: "先用 `zrig scope mission create` 创建 mission，再设置它的 stage。",
          });
        }
        applyStage(mission.readmePath, stage, opts.successor);
        warnRetired(stage);
        const supersededBy = stage === "superseded" ? String(opts.successor).trim() : undefined;
        emit(out, { ok: true, scope: { tier: "mission", name: mission.name, id: mission.id, stage, ...(supersededBy ? { supersededBy } : {}) } }, json, [
          `已设置 ${mission.name} stage：${stage}`,
          ...(supersededBy ? [`  superseded-by: ${supersededBy}`] : []),
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

function buildSliceVerifiedCommand(): Command {
  return new Command("verified")
    .description("盖 slice 的 verified 行：<today> against <source>（出处必填；覆盖前一行）")
    .argument("<slice-path>", "Slice 路径（绝对、相对，或 NN-slug）")
    .option("--against <source>", "它被 against 的对象——必填（不要裸时间戳）")
    .option("--mission <name>", "slice-path 只是 NN-slug 时提示 mission")
    .option("--json", "机器可读输出")
    .action(async (slicePath: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const source = validateAgainst(opts.against);
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const slice = findSlice(missionsRoot, slicePath, opts.mission ?? null);
        if (!slice.readmePath) {
          throw new ScopeCliError({
            fact: `slice ${slice.name} 没有 SPEC.md 或旧 README.md。`,
            consequence: "verified 是 work-node frontmatter 字段；没东西可写。",
            action: "先用 `zrig scope slice create` 创建 slice，再盖 verified。",
          });
        }
        const verified = `${todayDateISO()} against ${source}`;
        updateFrontmatter(slice.readmePath, { verified });
        emit(out, { ok: true, scope: { tier: "slice", mission: slice.missionName, name: slice.name, id: slice.id, verified } }, json, [
          `已盖 ${slice.missionName}/${slice.name} verified：${verified}`,
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

function buildMissionVerifiedCommand(): Command {
  return new Command("verified")
    .description("盖 mission 的 verified 行：<today> against <source>（出处必填；覆盖前一行）")
    .argument("<mission>", "Mission 名")
    .option("--against <source>", "它被 against 的对象——必填（不要裸时间戳）")
    .option("--json", "机器可读输出")
    .action(async (missionName: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const source = validateAgainst(opts.against);
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const mission = findMission(missionsRoot, missionName);
        if (!mission.readmePath) {
          throw new ScopeCliError({
            fact: `mission ${mission.name} 没有 SPEC.md 或旧 README.md。`,
            consequence: "verified 是 work-node frontmatter 字段；没东西可写。",
            action: "先用 `zrig scope mission create` 创建 mission，再盖 verified。",
          });
        }
        const verified = `${todayDateISO()} against ${source}`;
        updateFrontmatter(mission.readmePath, { verified });
        emit(out, { ok: true, scope: { tier: "mission", name: mission.name, id: mission.id, verified } }, json, [
          `已盖 ${mission.name} verified：${verified}`,
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

// OPR.0.4.1.6 FR-4——frontmatter 一致性回填（扩展 `repair`）。
// `repair` 历史上只回填缺失的 PROGRESS.md；按
// 约定的"consolidate, do not invent"，它现在在同一个
// 幂等动词里也对齐必填的
// scope-and-versioning §1/§2 frontmatter（id / stage / verified），
// 而不是加一个平行的 `reconcile`。

interface FrontmatterConformResult {
  /** 铸造+写入的 id，或 null（已存在/无法铸造）。 */
  idAdded: string | null;
  /** 加的 stage，或 null（已存在）。 */
  stageAdded: string | null;
  /** 加的 verified 占位符，或 null（已存在）。 */
  verifiedAdded: string | null;
  changed: boolean;
}

/** 把旧 `status:` 映射到 §4 迁移 stage。缺省或未映射时默认
 *  `wip`（安全地板）。 */
function mapLegacyStatusToStage(status: unknown): string {
  const s = typeof status === "string" ? status.toLowerCase().trim() : "";
  if (s === "placeholder") return "wip";
  if (s === "draft" || s === "draft-for-comms") return "wip";
  if (s === "active" || s === "in-flight") return "established";
  if (s.startsWith("shipped") || s.startsWith("closed")) return "established";
  if (s === "ready-for-mission" || s === "ready-for-orch-dispatch") return "provisional";
  return "wip";
}

/** 在 repair 用一致表示替换畸形值之前先保留它。已有保留 key 意味着
 *  之前的 repair 已经记过另一个 original；拒绝是唯一无损动作。 */
function preserveMalformedFrontmatterValue(
  frontmatter: Record<string, unknown>,
  updates: Record<string, unknown>,
  key: string,
): void {
  if (!Object.prototype.hasOwnProperty.call(frontmatter, key)) return;
  const preservedKey = `repair-original-${key.replaceAll("_", "-")}`;
  if (Object.prototype.hasOwnProperty.call(frontmatter, preservedKey)) {
    throw new ScopeCliError({
      fact: `${key} 是畸形的，且 ${preservedKey} 已存在。`,
      consequence: "拒绝 repair，而不是覆盖任一 authored 值。",
      action: `手动解决 ${key}，把 ${preservedKey} 留作 prior-value 记录，然后重跑 repair。`,
    });
  }
  updates[preservedKey] = frontmatter[key];
}

/** 幂等地对齐一个 scope README 的必填 frontmatter。加缺失
 *  字段，仅在把畸形值保留到
 *  repair-original-* key 下后才替换。合法 id/stage/verified 绝不碰。
 *  `mintId` 只在 `id` 缺失或畸形时调用（它可能按 §1 lazy adoption 持久化一个
 *  parent id）。 */
function conformReadmeFrontmatter(readmePath: string, mintId: () => string | null): FrontmatterConformResult {
  const fm = readFrontmatter(readmePath);
  const updates: Record<string, unknown> = {};

  let idAdded: string | null = null;
  const hasId = typeof fm.id === "string" && fm.id.trim().length > 0;
  if (!hasId) {
    preserveMalformedFrontmatterValue(fm, updates, "id");
    const minted = mintId();
    if (minted) { idAdded = minted; updates.id = minted; }
  }

  let stageAdded: string | null = null;
  const hasStage = typeof fm.stage === "string" && STAGE_VALUES.includes(fm.stage as Stage);
  if (!hasStage) {
    preserveMalformedFrontmatterValue(fm, updates, "stage");
    stageAdded = mapLegacyStatusToStage(fm.status);
    updates.stage = stageAdded;
  }

  let verifiedAdded: string | null = null;
  const hasVerified = typeof fm.verified === "string" && fm.verified.trim().length > 0;
  if (!hasVerified) {
    preserveMalformedFrontmatterValue(fm, updates, "verified");
    // `against backfill (rig scope repair)` 是由 trust.ts 识别的稳定 provenance 标记。
    verifiedAdded = `${todayDateISO()} against backfill (rig scope repair)`;
    updates.verified = verifiedAdded;
  }

  const changed = Object.keys(updates).length > 0;
  if (changed) updateFrontmatter(readmePath, updates);
  return { idAdded, stageAdded, verifiedAdded, changed };
}

/** 从 slice 的（已持久化的）parent mission id + NN 铸造 id——§1
 *  lazy parent-ID adoption 点。文件夹没有 NN 时为 null。 */
function mintSliceIdClosure(slice: SliceInfo, missionsRoot: string): () => string | null {
  return () => {
    if (slice.nn == null) return null;
    const mission = findMission(missionsRoot, slice.missionName);
    const missionId = ensureMissionIdPersisted(mission, missionsRoot);
    return sliceIdFromMission(missionId, slice.nn);
  };
}

function conformLines(scope: string, r: FrontmatterConformResult): string[] {
  if (!r.changed) return [`  frontmatter：一致（无变化）`];
  const parts: string[] = [];
  if (r.idAdded) parts.push(`id=${r.idAdded}`);
  if (r.stageAdded) parts.push(`stage=${r.stageAdded}`);
  if (r.verifiedAdded) parts.push(`verified=${r.verifiedAdded}`);
  return [`  frontmatter 已对齐：${parts.join(", ")}`];
}

function buildSliceRepairCommand(): Command {
  return new Command("repair")
    .description("回填 slice 缺失的 PROGRESS.md + 对齐必填 frontmatter（id/stage/verified）；幂等")
    .argument("<slice-path>", "Slice 路径（绝对、相对，或 NN-slug）")
    .option("--mission <name>", "slice-path 只是 NN-slug 时提示 mission")
    .option("--json", "机器可读输出")
    .action(async (slicePath: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const legacySlice = findSlice(missionsRoot, slicePath, opts.mission ?? null);
        const specPath = ensureCurrentSpec(legacySlice.absPath, legacySlice.readmePath, legacySlice.name);
        const slice = findSlice(missionsRoot, legacySlice.absPath, opts.mission ?? null);
        const result = backfillScopeProgress(slice.absPath, "slice");
        const frontmatter = specPath
          ? conformReadmeFrontmatter(specPath, mintSliceIdClosure(slice, missionsRoot))
          : { idAdded: null, stageAdded: null, verifiedAdded: null, changed: false };
        if (specPath) ensureConventionFrontmatter(specPath, slice.name);
        ensureSliceProofSurface(slice.absPath, readFrontmatter(specPath ?? "").id, slice.name);
        emit(out, { ok: true, result, frontmatter }, json, [
          `${result.created ? "已回填" : "跳过"} ${slice.name}：${result.reason}`,
          ...(result.path ? [`  path: ${result.path}`] : []),
          ...conformLines("slice", frontmatter),
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

function buildMissionRepairCommand(): Command {
  return new Command("repair")
    .description("为一个 mission 及其 slices 回填缺失的 PROGRESS.md + 对齐必填 frontmatter（id/stage/verified）；幂等")
    .argument("<mission>", "Mission 名")
    .option("--json", "机器可读输出")
    .action(async (missionName: string, opts, command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        const legacyMission = findMission(missionsRoot, missionName);
        const missionSpec = ensureCurrentSpec(legacyMission.absPath, legacyMission.readmePath, legacyMission.name);
        const mission = findMission(missionsRoot, missionName);
        const results: BackfillResult[] = [];
        results.push(backfillScopeProgress(mission.absPath, "mission"));
        const slicesDir = path.join(mission.absPath, "slices");
        if (fs.existsSync(slicesDir)) {
          for (const entry of fs.readdirSync(slicesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (!entry.isDirectory() || !/^\d+-/.test(entry.name)) continue;
            results.push(backfillScopeProgress(path.join(slicesDir, entry.name), "slice"));
          }
        }

        // FR-4：对齐必填 frontmatter——先 mission（铸造+持久化
        // mission id），再每个 slice（child id 从现在已持久化的
        // parent id 派生）。
        const conformed: Array<{ scope: "mission" | "slice"; name: string; frontmatter: FrontmatterConformResult }> = [];
        if (missionSpec) {
          const fm = conformReadmeFrontmatter(missionSpec, () => ensureMissionId(mission, missionsRoot));
          ensureConventionFrontmatter(missionSpec, mission.name);
          conformed.push({ scope: "mission", name: mission.name, frontmatter: fm });
        }
        const freshMission = findMission(missionsRoot, mission.name);
        ensureMissionNotesSurface(freshMission.absPath, freshMission);
        for (const slice of listSlices(freshMission, "all")) {
          const specPath = ensureCurrentSpec(slice.absPath, slice.readmePath, slice.name);
          if (!specPath) continue;
          const fm = conformReadmeFrontmatter(specPath, mintSliceIdClosure(slice, missionsRoot));
          ensureConventionFrontmatter(specPath, slice.name);
          backfillScopeProgress(slice.absPath, "slice");
          ensureSliceProofSurface(slice.absPath, readFrontmatter(specPath).id, slice.name);
          conformed.push({ scope: "slice", name: slice.name, frontmatter: fm });
        }

        const created = results.filter((r) => r.created);
        const fmChanged = conformed.filter((c) => c.frontmatter.changed);
        emit(out, { ok: true, mission: mission.name, created, results, conformed }, json, [
          `已修复 ${mission.name}：回填 ${created.length} 个 PROGRESS.md，对齐 ${fmChanged.length} 个 frontmatter`,
          ...created.map((r) => `  + PROGRESS ${r.scope}/${r.name}`),
          ...fmChanged.map((c) => `  ~ frontmatter ${c.scope}/${c.name}`),
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

/** 在不动旧文件的前提下，把当前 authored node 加到旧 README 旁边。
 *  已有 SPEC 字节保持原位。 */
function ensureCurrentSpec(dir: string, nodePath: string | null, fallbackName: string): string | null {
  const specPath = path.join(dir, "SPEC.md");
  if (fs.existsSync(specPath)) return specPath;
  if (!nodePath || !fs.existsSync(nodePath)) return null;
  fs.copyFileSync(nodePath, specPath);
  ensureConventionFrontmatter(specPath, fallbackName);
  return specPath;
}

function ensureConventionFrontmatter(specPath: string, fallbackName: string): void {
  const content = fs.readFileSync(specPath, "utf8");
  const { frontmatter, body } = splitFrontmatter(content);
  const h2Intent = /^##\s+(?:Intent|意图)\s*\n+([\s\S]*?)(?=\n##\s+|$)/mi.exec(body)?.[1]?.trim();
  const h1 = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  const updates: Record<string, unknown> = {};
  if (!(typeof frontmatter.intent === "string" && frontmatter.intent.trim().length > 0)) {
    preserveMalformedFrontmatterValue(frontmatter, updates, "intent");
    updates.intent = h2Intent && !/^\[.*\]$/.test(h2Intent)
      ? h2Intent
      : h1 ?? titleFromSlug(fallbackName.replace(/^\d+-/, ""));
  }
  if (!Array.isArray(frontmatter.depends_on)) {
    preserveMalformedFrontmatterValue(frontmatter, updates, "depends_on");
    updates.depends_on = [];
  }
  if (Object.keys(updates).length > 0) updateFrontmatter(specPath, updates);
}

function ensureMissionNotesSurface(dir: string, mission: ReturnType<typeof findMission>): void {
  const notesPath = path.join(dir, NOTES_FILE_PRECEDENCE[0]);
  const resolved = resolveNotesFile(dir);
  if (resolved?.name === NOTES_FILE_PRECEDENCE[0]) return;
  if (resolved) {
    fs.copyFileSync(resolved.path, notesPath);
    return;
  }
  const rendered = renderNotesTemplate({
    mission_id: mission.id ?? mission.name,
    mission_name: typeof mission.frontmatter.intent === "string" ? mission.frontmatter.intent : mission.name,
    created_date: todayDateISO(),
  });
  fs.writeFileSync(notesPath, rendered.rendered, "utf8");
}

function ensureSliceProofSurface(dir: string, rawId: unknown, fallbackName: string): void {
  fs.mkdirSync(path.join(dir, "proof"), { recursive: true });
  const proofPath = path.join(dir, "PROOF.md");
  if (fs.existsSync(proofPath)) return;
  fs.writeFileSync(proofPath, renderSliceProofTemplate({
    id: typeof rawId === "string" ? rawId : fallbackName,
    title: titleFromSlug(fallbackName.replace(/^\d+-/, "")),
  }), "utf8");
}

// ---------------------------------------------------------------------
// Approve（OPR.0.4.4.19 FR-9）
// ---------------------------------------------------------------------

// `rig scope slice|mission approve`——后台服务唯一
// 写路径（POST /api/scope/approve）的薄客户端：frontmatter 盖章 + append-only
// 审计行在后台服务侧一起落地（构造上不允许半盖章）。
// STAGED：--scope spec（"PRD 匹配我的意图"）| delivery（
// 终局签字 + 未来 freeze 触发器）；省略 = delivery。
// DELEGATED：--on-behalf-of 在审计
// notes 里记录这是谁的决定；actor 仍是真实调用会话（诚实出处）。
// 双 regime 规则（BR-6）：approval 是 freeze/sign-off——绝不 proven-green。
function buildApproveCommand(tier: "slice" | "mission"): Command {
  return new Command("approve")
    .description(
      tier === "slice"
        ? "批准一个 slice：写 frontmatter 盖章 + 一行 append-only 审计（后台服务侧，一个操作）。--scope spec = PLAN-LOCK（PRD 匹配意图；这组 artifact 将被构建）；delivery（默认）= PROOF-LOCK（终局签字）。approval 是 freeze/sign-off，绝不是 proven-green。约定 SSOT：docs/reference/sdlc-conventions.md（已安装：$OPENRIG_HOME/reference/sdlc-conventions.md）。"
        : "批准一个 mission：与 slice approve 相同的 staged/delegated 语义，在 mission tier。"
    )
    .argument(tier === "slice" ? "<slice-path>" : "<mission>", tier === "slice" ? "Slice 路径（绝对、相对，或 NN-slug）" : "Mission 名")
    .option("--mission <name>", tier === "slice" ? "slice-path 只是 NN-slug 时提示 mission" : "（mission tier 不用）")
    .option("--scope <scope>", "批准范围：spec | delivery（默认 delivery）")
    .option("--actor <session>", "（已废弃，忽略）approver 从 seat 环境（X-OpenRig-Session）派生")
    .option("--on-behalf-of <human>", "记录委托：这枚盖章记的是谁的决定（actor 仍是真实调用会话）")
    .option("--re-approve", "OPR.0.5.0.18 amend/re-stamp：用一个新的有理 attestation 取代已有盖章（prior 保留在 append-only 审计日志）。需要 --reason。")
    .option("--reason <why>", "为什么要 amend 这枚盖章（与 --re-approve 一起必填；记在审计行上）")
    .option("--locked-artifacts <paths>", "仅 PLAN-LOCK（--scope spec）：逗号分隔的 slice 相对路径，命名这把锁冻结的 artifact 集——完全替换派生默认。每个文件必须存在。没有它，只会冻结缺失/骨架 PRD 的派生会拒绝。")
    .option("--json", "机器可读输出")
    .action(async (target: string, opts: {
      mission?: string;
      scope?: string;
      actor?: string;
      onBehalfOf?: string;
      reApprove?: boolean;
      reason?: string;
      lockedArtifacts?: string;
      json?: boolean;
    }, command: Command) => {
      const out = makeStdout();
      const json = Boolean(opts.json);
      try {
        if (opts.scope !== undefined && opts.scope !== "spec" && opts.scope !== "delivery") {
          throw new ScopeCliError({
            fact: `未知 --scope 值 "${opts.scope}"。`,
            consequence: "命令未运行。",
            action: "选一个：spec、delivery（省略即 delivery）。",
          });
        }
        // OPR.0.5.0.18——在本地快速失败 flag 误用（后台服务
        // 强制同一契约；这只是省一趟往返）。
        if (opts.reApprove && (!opts.reason || opts.reason.trim().length === 0)) {
          throw new ScopeCliError({
            fact: "--re-approve 没带 --reason。",
            consequence: "re-stamp 是一个有理的 deliberate 动作；什么都没写。",
            action: '带 --reason "<why>" 重跑，描述自上次 attestation 以来变了什么。',
          });
        }
        if (opts.reason && !opts.reApprove) {
          throw new ScopeCliError({
            fact: "--reason 没有 --re-approve。",
            consequence: "首次批准不带 amend 原因；什么都没写。",
            action: "首次批准去掉 --reason，或加 --re-approve 来 amend 已有盖章。",
          });
        }
        // B14——显式集是 PLAN-LOCK 概念；在 delivery 批准上
        // 它会静默什么都不做，而锁内容周围的静默就是缺陷。
        const lockedArtifactsList = typeof opts.lockedArtifacts === "string"
          ? opts.lockedArtifacts.split(",").map((p) => p.trim()).filter((p) => p.length > 0)
          : null;
        if (lockedArtifactsList && (tier !== "slice" || opts.scope !== "spec")) {
          throw new ScopeCliError({
            fact: "--locked-artifacts 只适用于 slice plan-lock（--scope spec）。",
            consequence: "什么都没写。",
            action: "带 --scope spec 重跑，或为 delivery/mission 批准去掉这个 flag。",
          });
        }
        // P21：approver 从 seat 环境派生（X-OpenRig-Session，由 DaemonClient
        // 从 OPENRIG_SESSION_NAME 盖章）——绝不是 flag/body 声明。--actor 已废弃 + 忽略。
        // 如果环境未设置，提前用友好消息失败（否则后台服务返回 400 actor_required——
        // 没有 seat 身份可归因这次写；P18 已退役 401 拒绝）。
        if (!process.env.OPENRIG_SESSION_NAME) {
          throw new ScopeCliError({
            fact: "没有 seat 身份：OPENRIG_SESSION_NAME 未设置（approver 从 seat 环境派生，不是 flag）。",
            consequence: "后台服务没有 seat 身份可归因这次批准写（400 actor_required——缺参数，不是不信任拒绝）。",
            action: "从一个受管 seat（OPENRIG_SESSION_NAME 已设置）运行。",
          });
        }
        // 在本地解析 scope target（富 NN-slug 解析），然后
        // 把 canonical missions-root 相对路径发给后台服务。
        const missionsRoot = resolveMissionsRoot({ override: getOpts(command).workspace });
        let scopeAbsPath: string;
        if (tier === "slice") {
          const slice = findSlice(missionsRoot, target, opts.mission ?? null);
          scopeAbsPath = slice.absPath;
        } else {
          const mission = findMission(missionsRoot, target);
          scopeAbsPath = mission.absPath;
        }
        const scopePath = path.relative(missionsRoot, scopeAbsPath).split(path.sep).join("/");

        const lifecycleDeps = realDeps();
        const status = await getDaemonStatus(lifecycleDeps);
        if (status.state !== "running" || status.healthy === false) {
          throw new ScopeCliError({
            fact: statusGuardMessage(status).fact, // B8-1b：down ≠ busy
            consequence: "scope approve 通过后台服务写盖章 + 审计行（一个操作）。",
            action: "用以下命令启动：zrig daemon start",
          });
        }
        const client = new DaemonClient(getDaemonUrl(status));
        const res = await client.post<Record<string, unknown>>("/api/scope/approve", {
          scopeTier: tier,
          scopePath,
          approvalScope: opts.scope,
          // P21：body 不带 actorSession——后台服务从传输头派生 approver。
          onBehalfOf: opts.onBehalfOf ?? null,
          reApprove: opts.reApprove === true,
          reason: opts.reason ?? null,
          lockedArtifacts: lockedArtifactsList,
        });
        if (res.status >= 400) {
          const err = res.data as { error?: string; message?: string; action?: string };
          throw new ScopeCliError({
            fact: `批准失败（${err.error ?? res.status}）：${err.message ?? "未知错误"}。`,
            consequence: "没留下盖章，也没留下审计行（无半盖章）。",
            action: err.error === "already_approved"
              ? '该 scope 已带这枚盖章；用 --re-approve --reason "<why>" amend 它（新 attestation；prior 保留在审计日志）。'
              : err.action ?? "修掉命名的问题并重跑。",
          });
        }
        const data = res.data;
        emit(out, { ok: true, ...data }, json, [
          `${data.reApproved ? "已重新批准" : "已批准"}（${String(data.approvalScope)}）${tier} ${String(data.scopeId)}——${String(data.approvedBy)} 于 ${String(data.approvedAt)}${data.onBehalfOf ? ` 代表 ${String(data.onBehalfOf)}` : ""}`,
          ...(data.reApproved
            ? [`已取代 prior attestation：${String(data.priorApprovedBy)} 于 ${String(data.priorApprovedAt ?? "?")}（保留在审计日志）`]
            : []),
          `审计动作：${String(data.actionId)}（scope_path=${String(data.scopePath)}）`,
        ]);
      } catch (err) {
        fail(err, json, out);
      }
    });
}

// ---------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------

/**
 * 仅建议性：一个同时带两份 authored 文件的工作节点。
 *
 * SPEC.md 胜出，这里不阻塞任何东西——但被 shadow 的 README.md 是一个值得命名的真实隐患，
 * 因为每个仍读旧名的表面都在悄悄读另一个文件。故意低
 * severity：一个值得注意的状态，不是一个要 gate 的失败。
 */
function shadowedNodeFileFinding(dir: string, level: "mission" | "slice"): {
  kind: "shadowed_node_file"; severity: "low"; path: string; message: string; remediation: string;
} | null {
  if (!fs.existsSync(path.join(dir, "SPEC.md")) || !fs.existsSync(path.join(dir, "README.md"))) return null;
  return {
    kind: "shadowed_node_file",
    severity: "low",
    path: dir,
    message: `${level} 同时有 SPEC.md 和 README.md；SPEC.md 是 authored node 文件并胜出，所以 README.md 被 shadow，任何仍读旧名的表面看到的是不同内容。`,
    remediation: "把 README.md 里仍需要的东西折进 SPEC.md，然后删掉被 shadow 的文件。仅建议性——不阻塞任何东西。",
  };
}

export function scopeCommand(): Command {
  const cmd = new Command("scope")
    .description("scope 树原语：missions、slices、sub-slices（按 conventions/scope-and-versioning）")
    .option("--workspace <path>", "覆盖 workspace 根（否则从 cwd 或 $OPENRIG_WORK_ROOT 推断）");

  const slice = new Command("slice").description("Slice tier 命令");
  slice.addCommand(buildSliceLsCommand());
  slice.addCommand(buildSliceShowCommand());
  slice.addCommand(buildSliceCreateCommand());
  slice.addCommand(buildSliceShipCommand());
  slice.addCommand(buildSliceCloseCommand());
  slice.addCommand(buildSliceMoveCommand());
  slice.addCommand(buildSliceProgressCommand());
  slice.addCommand(buildSliceRepairCommand());
  slice.addCommand(buildSliceStageCommand());
  slice.addCommand(buildSliceVerifiedCommand());
  slice.addCommand(buildApproveCommand("slice"));
  cmd.addCommand(slice);

  const mission = new Command("mission").description("Mission tier 命令");
  mission.addCommand(buildMissionLsCommand());
  mission.addCommand(buildMissionShowCommand());
  mission.addCommand(buildMissionCreateCommand());
  mission.addCommand(buildMissionGraphCommand());
  mission.addCommand(buildMissionProgressCommand());
  mission.addCommand(buildMissionRepairCommand());
  mission.addCommand(buildMissionStageCommand());
  mission.addCommand(buildMissionVerifiedCommand());
  mission.addCommand(buildApproveCommand("mission"));
  cmd.addCommand(mission);
  cmd.addCommand(buildResolveNotesCommand());
  cmd.addCommand(buildAuditCommand());

  return cmd;
}

// 给测试用的再导出。
export { DEFAULT_PROJECT_PREFIX, splitFrontmatter };
