import { selectCatalogProject, ProjectReadError } from "@openrig/daemon/project-catalog";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { readFrontmatter, resolveNodeFile } from "./scope/scope-fs.js";
import { readProjectSkillSelection } from "@openrig/daemon/skill-loadout";
import {
  resolveSystemWorld,
  type SystemWorldContextSelection,
  type SystemWorldSource,
} from "@openrig/daemon/system-world";
import {
  LifecycleManifestValidationError,
  validateMissionComposition,
} from "@openrig/daemon/project-lifecycle";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type WorkInstallSource = "explicit" | "manifest" | "default";
export type WorkInstallAltitude = "project" | "mission" | "slice";

export interface WorkInstallPiece {
  altitude: WorkInstallAltitude;
  address: string;
  path: string;
  exists: boolean;
  source: WorkInstallSource;
}

export interface WorkInstallPlan {
  position: {
    workspaceRoot: string;
    projectId: string | null;
    projectRoot: string;
    missionRoot: string | null;
    sliceRoot: string | null;
    mission: string | null;
    slice: string | null;
    frontier: WorkInstallAltitude;
  };
  pieces: WorkInstallPiece[];
  systemWorld: {
    state: "default" | "replacement" | "disabled";
    source: SystemWorldSource;
    selection: string;
    manifestPath: string | null;
    id: string | null;
    version: string | null;
    context: SystemWorldContextSelection[];
    skills: string[];
  };
  /** 来自 project.yaml install.skills 的项目世界技能身份。 */
  skills: string[];
  derive: [];
  warnings: string[];
}

export interface WorkInstallFailure {
  error: {
    code: string;
    message: string;
    candidates?: string[];
  };
}

export type WorkInstallResult = WorkInstallPlan | WorkInstallFailure;

function failure(code: string, message: string, candidates?: string[]): WorkInstallFailure {
  return { error: { code, message, ...(candidates ? { candidates } : {}) } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readYaml(path: string): { value: Record<string, unknown> | null; error?: string } {
  try {
    const value = parseYaml(readFileSync(path, "utf-8")) as unknown;
    return isRecord(value) ? { value } : { value: null, error: `${path} 必须包含一个 YAML 对象` };
  } catch (err) {
    return { value: null, error: `${path} 不是有效的 YAML：${(err as Error).message}` };
  }
}

function canonicalExisting(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function markdownPath(address: string): string | null {
  const path = address.split("#", 1)[0]!;
  if (
    path.length === 0 ||
    isAbsolute(path) ||
    path.split(/[\\/]/).some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    ![".md", ".markdown"].includes(extname(path).toLowerCase())
  ) {
    return null;
  }
  return path;
}

function piece(
  altitude: WorkInstallAltitude,
  address: string,
  root: string,
  source: WorkInstallSource,
): WorkInstallPiece | WorkInstallFailure {
  const rel = markdownPath(address.slice(address.indexOf(":") + 1));
  if (!rel) return failure("invalid_markdown_address", `${address} 必须是其所选根目录内的相对 Markdown 地址`);
  const nominalPath = resolve(root, rel);
  if (!inside(root, nominalPath)) {
    return failure("address_escape", `${address} 解析到其所选 ${altitude} 根目录之外`);
  }
  if (existsSync(nominalPath)) {
    const canonicalPath = canonicalExisting(nominalPath);
    if (canonicalPath && !inside(root, canonicalPath)) {
      return failure("address_escape", `${address} 通过符号链接解析到其所选 ${altitude} 根目录之外`);
    }
  }
  return { altitude, address, path: nominalPath, exists: existsSync(nominalPath), source };
}

function manifestProjectId(manifest: Record<string, unknown> | null): string | null {
  if (!manifest) return null;
  if (typeof manifest["id"] === "string") return manifest["id"];
  const metadata = manifest["metadata"];
  return isRecord(metadata) && typeof metadata["id"] === "string" ? metadata["id"] : null;
}

function resolveExplicitSlice(
  missionRoot: string,
  selection: string,
  declaredSliceRoots?: Set<string>,
): { root: string; name: string } | WorkInstallFailure {
  const slicesRoot = join(missionRoot, "slices");
  const available: string[] = [];
  const matches: Array<{ root: string; name: string }> = [];
  if (existsSync(slicesRoot)) {
    for (const entry of readdirSync(slicesRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const nominalRoot = join(slicesRoot, entry.name);
      const root = canonicalExisting(nominalRoot);
      if (!root || !inside(missionRoot, root)) {
        if (entry.name === selection) {
          return failure("slice_root_escape", `slice '${selection}' 解析到所选任务目标根目录之外`);
        }
        continue;
      }
      if (declaredSliceRoots && !declaredSliceRoots.has(root)) continue;
      available.push(entry.name);
      const nodeFile = resolveNodeFile(root);
      const frontmatter = nodeFile ? readFrontmatter(nodeFile) : {};
      const declaredId = frontmatter["id"] ?? frontmatter["dotId"];
      if (entry.name === selection || declaredId === selection) {
        matches.push({ root, name: entry.name });
      }
    }
  }
  available.sort();
  matches.sort((a, b) => a.name.localeCompare(b.name));
  if (matches.length === 0) {
    return failure("slice_not_found", `slice '${selection}' 不是所选任务目标的子项`, available);
  }
  if (matches.length > 1) {
    return failure(
      "slice_identity_ambiguous",
      `slice '${selection}' 命名了所选任务目标的多个子项`,
      matches.map((match) => match.name),
    );
  }
  return matches[0]!;
}

export function resolveWorkPosition(opts: {
  workspaceRoot: string;
  catalogPath?: string;
  contextRoot: string;
  systemWorldSelection: string;
  systemWorldSource: SystemWorldSource;
  project?: string;
  mission?: string;
  slice?: string;
}): WorkInstallResult {
  if (opts.project !== undefined && !SEGMENT.test(opts.project)) {
    return failure("invalid_project", "project 必须是单个有界段");
  }
  if (opts.mission !== undefined && !SEGMENT.test(opts.mission)) {
    return failure("invalid_mission", "mission 必须是单个有界段");
  }
  if (opts.slice !== undefined && !SEGMENT.test(opts.slice)) {
    return failure("invalid_slice", "slice 必须是单个有界段");
  }
  if (opts.slice !== undefined && opts.mission === undefined) {
    return failure("mission_required", "slice 需要精确的 mission 选择");
  }

  const workspaceRoot = canonicalExisting(opts.workspaceRoot);
  if (!workspaceRoot) {
    return failure("workspace_root_missing", `工作区根目录不存在：${resolve(opts.workspaceRoot)}`);
  }

  const warnings: string[] = [];
  const systemWorld = resolveSystemWorld({
    contextRoot: opts.contextRoot,
    selection: opts.systemWorldSelection,
    source: opts.systemWorldSource,
  });
  if (!systemWorld.ok) return failure(systemWorld.error.code, systemWorld.error.message);
  const catalogPath = resolve(opts.catalogPath ?? join(workspaceRoot, "workspace.yaml"));
  let projectId: string | null = null;
  let projectRoot = workspaceRoot;
  try {
    const selected = selectCatalogProject(catalogPath, opts.project);
    if (selected) { projectId = selected.id; projectRoot = selected.root; }
  } catch (err) {
    if (err instanceof ProjectReadError) return failure(err.code, err.message, err.candidates);
    throw err;
  }

  const projectManifestPath = join(projectRoot, "project.yaml");
  let projectManifest: Record<string, unknown> | null = null;
  if (existsSync(projectManifestPath)) {
    const parsed = readYaml(projectManifestPath);
    if (parsed.value) projectManifest = parsed.value;
    else warnings.push(`${parsed.error}；已忽略可选增强并保持常规地址`);
  }
  const declaredProjectId = manifestProjectId(projectManifest);
  if (projectId && declaredProjectId && projectId !== declaredProjectId) {
    return failure(
      "project_identity_conflict",
      `所选 project '${projectId}' 与 ${projectRoot} 的 project.yaml 身份 '${declaredProjectId}' 冲突`,
    );
  }
  if (!projectId) {
    if (opts.project && declaredProjectId !== opts.project) {
      return failure("project_not_found", `无法从无目录工作区解析 project '${opts.project}'`);
    }
    projectId = opts.project ?? declaredProjectId;
  }

  let missionsRel = "missions";
  const missions = projectManifest?.["missions"];
  if (isRecord(missions) && missions["root"] !== undefined) {
    if (typeof missions["root"] === "string" && !isAbsolute(missions["root"]) && !missions["root"].split(/[\\/]/).includes("..")) {
      missionsRel = missions["root"];
    } else {
      warnings.push("project.yaml：可选的 missions.root 必须是项目内的相对路径；保持常规 missions 根目录");
    }
  }
  const missionsRoot = resolve(projectRoot, missionsRel);
  if (!inside(projectRoot, missionsRoot)) {
    return failure("missions_root_escape", "project.yaml missions.root 解析到所选项目根目录之外");
  }

  let projectIntent = "SPEC.md";
  let projectIntentSource: WorkInstallSource = "default";
  let projectContext: string[] = [];
  const install = projectManifest?.["install"];
  let projectSkills: string[] = [];
  if (isRecord(install)) {
    if (install["intent"] !== undefined) {
      if (typeof install["intent"] === "string" && markdownPath(install["intent"])) {
        projectIntent = install["intent"];
        projectIntentSource = "manifest";
      } else {
        warnings.push("project.yaml：可选的 install.intent 必须是相对 Markdown 地址；保持常规项目 SPEC");
      }
    }
    if (install["context"] !== undefined) {
      if (Array.isArray(install["context"]) && install["context"].every((value) => typeof value === "string" && markdownPath(value))) {
        projectContext = install["context"] as string[];
      } else {
        warnings.push("project.yaml：可选的 install.context 必须是相对 Markdown 地址列表；已忽略");
      }
    }
  }
  try {
    projectSkills = readProjectSkillSelection(projectRoot);
  } catch (err) {
    return failure("project_skills_invalid", (err as Error).message);
  }

  const pieces: WorkInstallPiece[] = [];
  for (const [address, source] of [
    [projectIntent, projectIntentSource],
    ...projectContext.map((address): [string, WorkInstallSource] => [address, "manifest"]),
  ] as Array<[string, WorkInstallSource]>) {
    const planned = piece("project", `project:${address}`, projectRoot, source);
    if ("error" in planned) return planned;
    pieces.push(planned);
  }

  let missionRoot: string | null = null;
  let sliceRoot: string | null = null;
  let sliceName: string | null = null;
  let frontier: WorkInstallAltitude = "project";
  if (opts.mission !== undefined) {
    missionRoot = join(missionsRoot, opts.mission);
    if (existsSync(missionRoot)) {
      const canonicalMissionRoot = canonicalExisting(missionRoot);
      if (!canonicalMissionRoot || !inside(projectRoot, canonicalMissionRoot)) {
        return failure("mission_root_escape", `mission '${opts.mission}' 解析到所选项目根目录之外`);
      }
      missionRoot = canonicalMissionRoot;
      frontier = "mission";
      let missionSpec = "SPEC.md";
      let missionSource: WorkInstallSource = "default";
      let declaredSliceRoots: Set<string> | undefined;
      const missionManifestPath = join(missionRoot, "mission.yaml");
      if (existsSync(missionManifestPath)) {
        const parsed = readYaml(missionManifestPath);
        const composition = parsed.value?.["composition"];
        if (parsed.value && isRecord(composition) && "slices" in composition) {
          try {
            declaredSliceRoots = new Set(
              validateMissionComposition(parsed.value, missionManifestPath)
                .map((member) => dirname(member.path)),
            );
          } catch (error) {
            const message = error instanceof LifecycleManifestValidationError
              ? error.message
              : `任务目标组合验证失败：${(error as Error).message}`;
            return failure("mission_composition_invalid", message);
          }
        }
        const markdown = isRecord(composition) ? composition["mission_markdown"] : null;
        if (isRecord(markdown) && typeof markdown["spec"] === "string" && markdownPath(markdown["spec"])) {
          missionSpec = markdown["spec"];
          missionSource = "manifest";
        } else if (!parsed.value) {
          warnings.push(`${parsed.error}；保持常规任务目标 SPEC`);
        }
      }
      const plannedMission = piece("mission", `mission:${missionSpec}`, missionRoot, missionSource);
      if ("error" in plannedMission) return plannedMission;
      pieces.push(plannedMission);
      const plannedMissionProgress = piece("mission", "mission:PROGRESS.md", missionRoot, "default");
      if ("error" in plannedMissionProgress) return plannedMissionProgress;
      pieces.push(plannedMissionProgress);

      if (opts.slice !== undefined) {
        const selectedSlice = resolveExplicitSlice(missionRoot, opts.slice, declaredSliceRoots);
        if ("error" in selectedSlice) return selectedSlice;
        sliceRoot = selectedSlice.root;
        sliceName = selectedSlice.name;
        frontier = "slice";
        let sliceSpec = "SPEC.md";
        let sliceSource: WorkInstallSource = "explicit";
        const sliceManifestPath = join(sliceRoot, "slice.yaml");
        if (existsSync(sliceManifestPath)) {
          const parsed = readYaml(sliceManifestPath);
          const composition = parsed.value?.["composition"];
          const markdown = isRecord(composition) ? composition["slice_markdown"] : null;
          if (isRecord(markdown) && typeof markdown["spec"] === "string" && markdownPath(markdown["spec"])) {
            sliceSpec = markdown["spec"];
            sliceSource = "manifest";
          } else if (!parsed.value) {
            warnings.push(`${parsed.error}；保持常规 slice SPEC`);
          }
        }
        const plannedSlice = piece(
          "slice",
          `mission:slices/${sliceName}/${sliceSpec}`,
          missionRoot,
          sliceSource,
        );
        if ("error" in plannedSlice) return plannedSlice;
        pieces.push(plannedSlice);
        const plannedSliceProgress = piece("slice", `mission:slices/${sliceName}/PROGRESS.md`, missionRoot, "default");
        if ("error" in plannedSliceProgress) return plannedSliceProgress;
        pieces.push(plannedSliceProgress);
      }
    }
  }

  return {
    position: {
      workspaceRoot,
      projectId,
      projectRoot,
      missionRoot,
      sliceRoot,
      mission: opts.mission ?? null,
      slice: sliceName ?? opts.slice ?? null,
      frontier,
    },
    pieces,
    systemWorld: {
      state: systemWorld.state,
      source: systemWorld.source,
      selection: systemWorld.selection,
      manifestPath: systemWorld.manifestPath,
      id: systemWorld.manifest?.id ?? null,
      version: systemWorld.manifest?.version ?? null,
      context: systemWorld.manifest?.context ?? [],
      skills: systemWorld.manifest?.skills ?? [],
    },
    skills: projectSkills,
    derive: [],
    warnings,
  };
}
