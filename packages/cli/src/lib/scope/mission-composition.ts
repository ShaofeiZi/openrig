import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseDocument } from "yaml";
import { ScopeCliError } from "./types.js";
import {
  LifecycleManifestValidationError,
  validateMissionComposition,
} from "@openrig/daemon/project-lifecycle";

export interface MissionSliceMembership {
  ref: string;
  order: number;
  active: boolean;
}

export interface MissionCompositionEdit {
  manifestPath: string;
  original: string;
  updated: string;
}

interface LoadedComposition {
  manifestPath: string;
  original: string;
  document: ReturnType<typeof parseDocument>;
  members: MissionSliceMembership[];
}

export function planMissionMembershipAdd(
  missionPath: string,
  ref: string,
  order: number,
): MissionCompositionEdit | null {
  const loaded = loadMissionComposition(missionPath);
  if (!loaded) return null;
  assertSafeRelative(ref);
  if (!Number.isInteger(order)) fail(`为 ${ref} 指定的成员顺序必须是整数。`);
  if (loaded.members.some((member) => path.normalize(member.ref) === path.normalize(ref))) {
    fail(`任务组合已包含 ${ref}。`);
  }
  if (loaded.members.some((member) => member.order === order)) {
    fail(`任务组合已包含顺序号 ${order}。`);
  }
  const members = [...loaded.members, { ref, order, active: true }]
    .sort((a, b) => a.order - b.order);
  return renderEdit(loaded, members);
}

export function planMissionMembershipRemove(
  missionPath: string,
  ref: string,
): MissionCompositionEdit | null {
  const loaded = loadMissionComposition(missionPath);
  if (!loaded) return null;
  const normalized = path.normalize(ref);
  const members = loaded.members.filter((member) => path.normalize(member.ref) !== normalized);
  if (members.length === loaded.members.length) {
    fail(`任务组合不包含 ${ref}。`);
  }
  return renderEdit(loaded, members);
}

export function nextMissionMembershipOrder(missionPath: string): number {
  const members = loadMissionComposition(missionPath)?.members ?? [];
  return (members.at(-1)?.order ?? 0) + 10;
}

/** 用回滚机制替换一份或多份已校验的 manifest：写入出错时回滚。 */
export function applyMissionCompositionEdits(edits: MissionCompositionEdit[]): void {
  const unique = Array.from(new Map(edits.map((edit) => [edit.manifestPath, edit])).values());
  const staged: Array<{ edit: MissionCompositionEdit; temporary: string }> = [];
  const applied: MissionCompositionEdit[] = [];
  try {
    for (const edit of unique) {
      const temporary = `${edit.manifestPath}.openrig-${process.pid}-${randomUUID()}.tmp`;
      fs.writeFileSync(temporary, edit.updated, { encoding: "utf8", mode: fs.statSync(edit.manifestPath).mode });
      staged.push({ edit, temporary });
    }
    for (const item of staged) {
      fs.renameSync(item.temporary, item.edit.manifestPath);
      applied.push(item.edit);
    }
  } catch (error) {
    for (const edit of applied.reverse()) fs.writeFileSync(edit.manifestPath, edit.original, "utf8");
    for (const item of staged) {
      if (fs.existsSync(item.temporary)) fs.rmSync(item.temporary, { force: true });
    }
    throw error;
  }
}

function loadMissionComposition(missionPath: string): LoadedComposition | null {
  const manifestPath = path.join(missionPath, "mission.yaml");
  // 遗留的工作节点长期有效。缺失表示该任务尚未选用“manifest 驱动的组合”；
  // 但显式提供的输入若格式错误仍要大声拒绝。
  if (!fs.existsSync(manifestPath)) return null;
  if (fs.lstatSync(manifestPath).isSymbolicLink()) fail(`任务 manifest 不得是符号链接：${manifestPath}。`);
  const original = fs.readFileSync(manifestPath, "utf8");
  const document = parseDocument(original);
  if (document.errors.length > 0) fail(`任务 manifest 不是合法 YAML：${document.errors[0]!.message}`);
  const root = document.toJS() as unknown;
  let members: MissionSliceMembership[];
  try {
    members = validateMissionComposition(root, manifestPath).map((member) => ({
      ref: member.ref,
      order: member.order,
      active: member.active,
    }));
  } catch (error) {
    if (error instanceof LifecycleManifestValidationError) fail(error.message);
    throw error;
  }
  return { manifestPath, original, document, members };
}

function renderEdit(loaded: LoadedComposition, members: MissionSliceMembership[]): MissionCompositionEdit {
  loaded.document.setIn(["composition", "slices"], members);
  return { manifestPath: loaded.manifestPath, original: loaded.original, updated: String(loaded.document) };
}

function assertSafeRelative(ref: string): void {
  if (path.isAbsolute(ref) || path.normalize(ref).split(path.sep).includes("..")) {
    fail(`任务成员关系必须是不含 '..' 的安全相对路径：${ref}。`);
  }
}

function fail(fact: string): never {
  throw new ScopeCliError({
    fact,
    consequence: "范围组合未被改动。",
    action: "请修复 mission.yaml 或被引用的 slice，然后重试。",
  });
}
