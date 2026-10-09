// Slice-21 FR-5——`zrig workspace doctor` 的工作区诊断就绪检查。
//
// 7 项检查（此文件提供纯检查辅助函数；守护进程路由与 CLI 子命令接线在后续提交中落地）：
//   1. 工作区根目录可访问（优先级：环境变量 > 文件 > 默认值）
//   2. missions 文件夹存在
//   3. 文件允许列表有效（ConfigStore 中的具名键值对，不是文件）
//   4. 守护进程指向此工作区
//   5. 守护进程是否需要重载
//   6. 可选的 slice 文档（仅警告）
//   7. NOTES.md 是否存在（可回退到可读的旧版 MISSION_NOTES.md）
//
// 按照 FR-5 IMPL-PRD §76-78，每项检查返回 `{check, status:
// "ok"|"warn"|"fail", message, fixHint?, evidence?}`。此结构有意区别于
// 安装健康检查 `zrig doctor` 的 DoctorCheck 结构
//（pass|warn|fail|skipped、reason/fix）——不同关注点应采用不同模式（工作区就绪度
// 与安装健康度）；依据 cont.43-followup，此差异已获 orch-marshal 接受。

import * as fs from "node:fs";
import * as path from "node:path";
import { decodeAllowlist } from "../files/path-safety.js";
import { resolveNodeFile, resolveNotesFile, withSpecFirst } from "../scope/node-file.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  check: string;
  status: CheckStatus;
  message: string;
  fixHint?: string;
  evidence?: Record<string, unknown>;
}

export type WorkspaceRootSource = "env" | "file" | "default";

export interface CheckWorkspaceRootInput {
  workspaceRoot: string;
  source: WorkspaceRootSource;
}

const ENV_FIX_HINT =
  "取消设置 OPENRIG_WORKSPACE_ROOT，或将其设为现有目录；运行 `zrig config init-workspace` 创建新的工作区框架";
const FILE_FIX_HINT =
  "将 config.json 中的 workspace.root 更新为现有目录；运行 `zrig config init-workspace` 创建新的工作区框架";
const DEFAULT_FIX_HINT =
  "运行 `zrig config init-workspace`，在配置的根目录创建默认工作区框架";

function fixHintForSource(source: WorkspaceRootSource): string {
  switch (source) {
    case "env":
      return ENV_FIX_HINT;
    case "file":
      return FILE_FIX_HINT;
    case "default":
      return DEFAULT_FIX_HINT;
  }
}

/**
 * 检查 #1——工作区根目录可访问。
 *
 * 验证解析后的工作区根目录存在且为目录。将 `source`（env / file / default）
 * 传入修复提示，使操作员获得正确的修复途径。
 */
export function checkWorkspaceRootReachable(opts: CheckWorkspaceRootInput): DoctorCheck {
  const { workspaceRoot, source } = opts;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(workspaceRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      check: "workspace_root_reachable",
      status: "fail",
      message: code === "ENOENT"
        ? `工作区根目录 '${workspaceRoot}' 不存在（解析来源：${source}）`
        : `工作区根目录 '${workspaceRoot}' 无法访问：${(err as Error).message}`,
      fixHint: fixHintForSource(source),
      evidence: { workspaceRoot, source, errorCode: code ?? "unknown" },
    };
  }
  if (!stat.isDirectory()) {
    return {
      check: "workspace_root_reachable",
      status: "fail",
      message: `工作区根目录 '${workspaceRoot}' 存在但不是目录（解析来源：${source}）`,
      fixHint: fixHintForSource(source),
      evidence: { workspaceRoot, source, kind: "not_a_directory" },
    };
  }
  return {
    check: "workspace_root_reachable",
    status: "ok",
    message: `工作区根目录 '${workspaceRoot}' 是可访问目录`,
    evidence: { workspaceRoot, source },
  };
}

export interface CheckMissionsFolderInput {
  workspaceRoot: string;
  /** 通过 ConfigStore 解析的 `workspace.slicesRoot`（默认为
   *  `<workspaceRoot>/missions`）。通过环境变量或配置自定义
   *  `workspace.slices_root` 的操作员可将其指向其他位置；检查会尊重覆盖值，
   *  避免有意采用的自定义布局被误报为失败。 */
  slicesRoot: string;
}

/**
 * 检查 #2——missions 文件夹存在。
 *
 * 验证解析后的 missions 文件夹（依据 ConfigStore 的 `workspace.slicesRoot`，
 * 默认为 `<workspaceRoot>/missions`）存在且为目录。缺失或形态错误均判定失败；
 * 这是 Project UI 投影所依赖的关键文件夹。
 */
export function checkMissionsFolder(opts: CheckMissionsFolderInput): DoctorCheck {
  const { workspaceRoot, slicesRoot } = opts;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(slicesRoot);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      check: "missions_folder_present",
      status: "fail",
      message: code === "ENOENT"
        ? `missions 文件夹 '${slicesRoot}' 不存在`
        : `missions 文件夹 '${slicesRoot}' 无法访问：${(err as Error).message}`,
      fixHint:
        slicesRoot === path.join(workspaceRoot, "missions")
          ? "运行 `zrig config init-workspace` 创建默认 missions/ 文件夹框架"
          : "创建已配置的 missions 文件夹，或取消设置 workspace.slices_root 以使用默认的 `<workspaceRoot>/missions/`",
      evidence: { slicesRoot, workspaceRoot, errorCode: code ?? "unknown" },
    };
  }
  if (!stat.isDirectory()) {
    return {
      check: "missions_folder_present",
      status: "fail",
      message: `missions 文件夹 '${slicesRoot}' 存在但不是目录`,
      fixHint:
        "删除或重命名冲突文件，然后运行 `zrig config init-workspace` 创建 missions 文件夹框架",
      evidence: { slicesRoot, workspaceRoot, kind: "not_a_directory" },
    };
  }
  return {
    check: "missions_folder_present",
    status: "ok",
    message: `missions 文件夹 '${slicesRoot}' 已存在`,
    evidence: { slicesRoot, workspaceRoot },
  };
}

/**
 * 发行版文件 API 所看到的、经标准解码的允许列表项（执行 `decodeAllowlist` 后）：
 * 绝对路径；可访问时经 realpath 标准化。相对路径在形成此结构前就会被标准解码器
 * 静默丢弃——可用项与原始项计数的语义参见检查 #3。
 */
export interface AllowlistEntry {
  name: string;
  /** 标准绝对路径（经过 decodeAllowlist 与 realpathSync 回退）。等同于文件 API 的
   *  `AllowlistRoot.canonicalPath`。 */
  path: string;
}

export interface CheckFileAllowlistInput {
  workspaceRoot: string;
  /** 通过 ConfigStore 解析的原始 `files.allowlist` 值（逗号分隔的
   *  `name:/abs/path` 键值对，或空字符串）。 */
  allowlistValue: string;
  allowlistSource: WorkspaceRootSource;
  /** 预解码的条目；若省略，检查会使用 domain/files/path-safety.ts 中的标准
   *  `decodeAllowlist` 解码 allowlistValue，使诊断结果与发行版 /api/files/* 文件 API
   *  实际接受的内容完全一致。预解码条目必须采用标准形式（绝对路径）；来自
   *  SettingsStore 的原始具名键值对字符串应通过 allowlistValue 和函数内解码处理，
   *  不应传给 parsedEntries。 */
  parsedEntries?: AllowlistEntry[];
}

/**
 * 检查 #3——文件允许列表有效。
 *
 * IMPL-PRD §43 将 `<workspace-root>/.openrig/file-allowlist` 描述为文件——但发行表层
 *（ConfigStore 的 `files.allowlist` 键、环境变量 OPENRIG_FILES_ALLOWLIST，默认值
 * `workspace:${workspaceRoot}`）实际是 CONFIGSTORE 字符串键，其中保存逗号分隔的
 * `name:/abs/path` 键值对；并不存在逐工作区文件。检查 #3 验证解析后的值至少能解码为
 * 一个覆盖 workspaceRoot 的可用条目（标准、绝对路径）——这与发行版 /api/files/*
 * 文件 API 通过 domain/files/path-safety.ts:60-80 中 `decodeAllowlist` 强制执行的
 * 可用根目录语义相同（第 71 行静默丢弃非绝对路径）。
 *
 * 使用标准解码器而非本地重复实现，可保证诊断结论与文件 API 的实际行为一致——
 * `workspace:.` 或 `workspace:relative-root` 在此会得到零个可用条目，与文件 API
 * 的静默跳过行为相符。
 */
export function checkFileAllowlist(opts: CheckFileAllowlistInput): DoctorCheck {
  const { workspaceRoot, allowlistValue, allowlistSource } = opts;
  const entries: AllowlistEntry[] = opts.parsedEntries
    ?? decodeAllowlist(allowlistValue).map((r) => ({ name: r.name, path: r.canonicalPath }));
  if (entries.length === 0) {
    return {
      check: "file_allowlist_sane",
      status: "fail",
      message: `files.allowlist 未解析出可用条目（原始值='${allowlistValue}'，来源=${allowlistSource}）；为匹配发行版文件 API，非绝对路径或格式错误的键值对会被静默丢弃`,
      fixHint:
        "设置 OPENRIG_FILES_ALLOWLIST，或运行 `zrig config set files.allowlist workspace:<absoluteWorkspaceRoot>`，为文件表层提供可读根目录（仅限绝对路径）",
      evidence: { allowlistValue, allowlistSource, entryCount: 0 },
    };
  }
  const covers = entries.some((e) => allowlistPathCoversRoot(e.path, workspaceRoot));
  if (!covers) {
    return {
      check: "file_allowlist_sane",
      status: "warn",
      message: `files.allowlist 有 ${entries.length} 个可用条目，但没有任何条目覆盖工作区根目录 '${workspaceRoot}'`,
      fixHint:
        "向 files.allowlist 添加 `workspace:<absoluteWorkspaceRoot>` 条目（或设置 OPENRIG_FILES_ALLOWLIST），以允许读取工作区文件",
      evidence: {
        allowlistValue,
        allowlistSource,
        entryCount: entries.length,
        workspaceRoot,
        entries,
      },
    };
  }
  return {
    check: "file_allowlist_sane",
    status: "ok",
    message: `files.allowlist 有 ${entries.length} 个可用条目覆盖工作区根目录`,
    evidence: { allowlistValue, allowlistSource, entryCount: entries.length, entries },
  };
}

function allowlistPathCoversRoot(allowlistPath: string, workspaceRoot: string): boolean {
  // decodeAllowlist 产生的标准条目路径已经是绝对路径并经过 realpath 解析。这里对
  // workspaceRoot 进行 resolve 并尝试 realpath，使调用方即便传入非标准工作区路径，
  // 当条目通过符号链接解析了 realpath 时仍能正确匹配覆盖关系（例如 macOS 的
  // `/var/folders/...` → `/private/var/...`）。
  const normEntry = allowlistPath;
  let normRoot: string;
  try {
    normRoot = fs.realpathSync(workspaceRoot);
  } catch {
    normRoot = path.resolve(workspaceRoot);
  }
  if (normEntry === normRoot) return true;
  const rel = path.relative(normEntry, normRoot);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export interface CheckDaemonWorkspaceInput {
  /** 守护进程解析的 workspace.root（服务端）。 */
  daemonResolvedRoot: string;
  /** 诊断调用方预期的 workspace.root（在 CLI 侧解析，通过请求体传入，或与
   *  --workspace 标志匹配）。 */
  expectedRoot: string;
}

/**
 * 检查 #4——守护进程指向此工作区。
 *
 * 报告守护进程启动时解析的 workspace.root 与诊断调用方预期值之间的差异。
 * 常见原因是启动守护进程的 shell 使用了与操作员当前 shell 不同的
 * OPENRIG_WORKSPACE_ROOT。
 */
export function checkDaemonWorkspace(opts: CheckDaemonWorkspaceInput): DoctorCheck {
  const { daemonResolvedRoot, expectedRoot } = opts;
  const normDaemon = path.resolve(daemonResolvedRoot);
  const normExpected = path.resolve(expectedRoot);
  if (normDaemon === normExpected) {
    return {
      check: "daemon_points_at_this_workspace",
      status: "ok",
      message: `守护进程与调用方对工作区根目录 '${normDaemon}' 的认定一致`,
      evidence: { daemonResolvedRoot: normDaemon, expectedRoot: normExpected },
    };
  }
  return {
    check: "daemon_points_at_this_workspace",
    status: "fail",
    message: `守护进程解析的工作区根目录为 '${normDaemon}'，但调用方预期 '${normExpected}'`,
    fixHint:
      "在 OPENRIG_WORKSPACE_ROOT 与预期工作区一致的 shell 中重启守护进程（`zrig daemon restart`），或取消设置 OPENRIG_WORKSPACE_ROOT，以回退到配置值和默认值",
    evidence: { daemonResolvedRoot: normDaemon, expectedRoot: normExpected },
  };
}

export interface CheckDaemonReloadInput {
  /** 磁盘上 ConfigStore 配置文件的路径。 */
  configFilePath: string;
  /** 以 Date 表示的守护进程启动时间。调用方通常在守护进程启动时捕获一次
   *  （例如在诊断路由处理器中使用
   *  `new Date(Date.now() - process.uptime() * 1000)`），随后透传。将其与配置文件
   *  mtime 比较；mtime > startTime 表示守护进程配置已过期。 */
  daemonStartTime: Date;
}

/**
 * 检查 #5——守护进程是否需要重载。
 *
 * 比较配置文件 mtime 与守护进程启动时间。mtime 更新表示操作员在守护进程启动后
 * 通过 CLI/UI 编辑了配置，而守护进程尚未加载更改。缺少配置文件不算失败——没有
 * 操作员配置的新安装完全使用默认值，无需重载。
 */
export function checkDaemonReload(opts: CheckDaemonReloadInput): DoctorCheck {
  const { configFilePath, daemonStartTime } = opts;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(configFilePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return {
        check: "daemon_reload_needed",
        status: "ok",
        message: `'${configFilePath}' 处没有配置文件；守护进程仅使用默认值运行`,
        evidence: { configFilePath, configFileExists: false },
      };
    }
    return {
      check: "daemon_reload_needed",
      status: "warn",
      message: `无法读取配置文件 '${configFilePath}' 的状态：${(err as Error).message}`,
      fixHint: "检查配置文件路径的文件权限，以便守护进程检测其更新时间",
      evidence: { configFilePath, errorCode: code ?? "unknown" },
    };
  }
  const mtimeMs = stat.mtime.getTime();
  const startMs = daemonStartTime.getTime();
  if (mtimeMs > startMs) {
    return {
      check: "daemon_reload_needed",
      status: "warn",
      message: `配置文件修改时间 ${stat.mtime.toISOString()} 晚于守护进程启动时间 ${daemonStartTime.toISOString()}`,
      fixHint: "运行 `zrig daemon restart` 以加载最新配置",
      evidence: {
        configFilePath,
        configMtime: stat.mtime.toISOString(),
        daemonStartTime: daemonStartTime.toISOString(),
        staleMs: mtimeMs - startMs,
      },
    };
  }
  return {
    check: "daemon_reload_needed",
    status: "ok",
    message: `配置文件修改时间 ${stat.mtime.toISOString()} 早于守护进程启动时间 ${daemonStartTime.toISOString()}`,
    evidence: {
      configFilePath,
      configMtime: stat.mtime.toISOString(),
      daemonStartTime: daemonStartTime.toISOString(),
    },
  };
}

export interface CheckSliceDocsInput {
  /** 解析后的 missions 文件夹根目录。检查会遍历每个
   *  `<missionsRoot>/<mission>/slices/<slice>/`，验证其中包含 SPEC.md 或可读的
   *  旧版节点文件。 */
  missionsRoot: string;
}

const SLICE_DOC_FILES = withSpecFirst(["README.md", "IMPLEMENTATION-PRD.md", "IMPL-PRD.md"]);

interface BareSlice {
  mission: string;
  slice: string;
  path: string;
}

/**
 * 检查 #6——可选的 slice 文档。
 *
 * 遍历每个任务的 slices 子目录，报告既没有 SPEC.md、也没有可读旧版节点文件的
 * slice。仅警告（依据 IMPL-PRD §57-59，空 slice 有时是有意的暂存）。遍历范围
 * 仅限一层任务加一层 slice，不递归进入 slice 子目录。
 */
export function checkOptionalSliceDocs(opts: CheckSliceDocsInput): DoctorCheck {
  const { missionsRoot } = opts;
  let missions: string[];
  try {
    missions = fs.readdirSync(missionsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      check: "optional_slice_docs",
      status: "warn",
      message: code === "ENOENT"
        ? `missions 根目录 '${missionsRoot}' 不存在；没有可检查的 slice 文档`
        : `无法读取 missions 根目录 '${missionsRoot}'：${(err as Error).message}`,
      evidence: { missionsRoot, errorCode: code ?? "unknown" },
    };
  }

  const bareSlices: BareSlice[] = [];
  for (const mission of missions) {
    const slicesDir = path.join(missionsRoot, mission, "slices");
    let slices: string[];
    try {
      slices = fs.readdirSync(slicesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue; // 没有 slices 子目录也没关系——任务可能并非按 slice 组织
    }
    for (const slice of slices) {
      const slicePath = path.join(slicesDir, slice);
      const hasDoc = SLICE_DOC_FILES.some((f) => fs.existsSync(path.join(slicePath, f)));
      if (!hasDoc) {
        bareSlices.push({ mission, slice, path: slicePath });
      }
    }
  }

  if (bareSlices.length === 0) {
    return {
      check: "optional_slice_docs",
      status: "ok",
      message: `'${missionsRoot}' 下的每个 slice 都有 SPEC.md 或可读的旧版节点文件`,
      evidence: { missionsRoot, bareSlices: [] },
    };
  }
  return {
    check: "optional_slice_docs",
    status: "warn",
    message: `有 ${bareSlices.length} 个 slice 没有 SPEC.md 或可读的旧版节点文件`,
    fixHint:
      "在每个空白 slice 目录中编写 SPEC.md；旧版 README.md、IMPLEMENTATION-PRD.md 和 IMPL-PRD.md 仍可读取；由于空 slice 有时是有意的暂存，此项仅警告",
    evidence: { missionsRoot, bareSlices },
  };
}

// slice SPEC（或旧版节点文件）必须包含的 SDLC 约定章节。
// 唯一真相来源：docs/reference/sdlc-conventions.md。
const SDLC_CONVENTION_SECTIONS = [
  { canonical: "## Intent", aliases: ["Intent", "意图"] },
  { canonical: "## Mini-requirements", aliases: ["Mini-requirements", "最小需求", "小型需求"] },
  { canonical: "## Proof contract", aliases: ["Proof contract", "证明契约", "证据约定"] },
] as const;

interface SliceMissingSections {
  mission: string;
  slice: string;
  path: string;
  missing: string[];
}

/**
 * 检查 #8——SDLC 约定章节（OPR.0.4.4.23）。
 *
 * 遍历每个任务的 slice，报告缺少任一约定章节（`## Intent` /
 * `## Mini-requirements` / `## Proof contract`）的工作节点文件。仅警告
 *（建议性、失败开放——逐 slice 深度审计使用 `zrig scope audit`；此行只是工作区级
 * 指引）。没有工作节点文件的 slice 属于检查 #6 的范围，此处不重复报告。
 */
export function checkSdlcConventionSections(opts: CheckSliceDocsInput): DoctorCheck {
  const { missionsRoot } = opts;
  let missions: string[];
  try {
    missions = fs.readdirSync(missionsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      check: "sdlc_convention_sections",
      status: "warn",
      message: code === "ENOENT"
        ? `missions 根目录 '${missionsRoot}' 不存在；没有可检查的 slice 章节`
        : `无法读取 missions 根目录 '${missionsRoot}'：${(err as Error).message}`,
      evidence: { missionsRoot, errorCode: code ?? "unknown" },
    };
  }

  const offenders: SliceMissingSections[] = [];
  let slicesChecked = 0;
  for (const mission of missions) {
    const slicesDir = path.join(missionsRoot, mission, "slices");
    let slices: string[];
    try {
      slices = fs.readdirSync(slicesDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue; // 没有 slices 子目录也没关系——任务可能并非按 slice 组织
    }
    for (const slice of slices) {
      const slicePath = path.join(slicesDir, slice);
      const readmePath = resolveNodeFile(slicePath);
      let readme: string;
      try {
        readme = fs.readFileSync(readmePath ?? path.join(slicePath, "SPEC.md"), "utf-8");
      } catch {
        continue; // 没有工作节点文件属于检查 #6 的发现，不属于章节缺失
      }
      slicesChecked++;
      const missing = SDLC_CONVENTION_SECTIONS.filter(
        (section) => !new RegExp(`^##\\s+(?:${section.aliases.join("|")})\\s*$`, "mi").test(readme),
      ).map((section) => section.canonical);
      if (missing.length > 0) {
        offenders.push({ mission, slice, path: slicePath, missing: [...missing] });
      }
    }
  }

  if (offenders.length === 0) {
    return {
      check: "sdlc_convention_sections",
      status: "ok",
      message: `'${missionsRoot}' 下的每个 slice 工作节点文件都包含 SDLC 约定章节（已检查 ${slicesChecked} 个）`,
      evidence: { missionsRoot, slicesChecked, offenders: [] },
    };
  }
  return {
    check: "sdlc_convention_sections",
    status: "warn",
    message: `有 ${offenders.length} 个 slice 工作节点文件缺少 SDLC 约定章节（Intent / Mini-requirements / Proof contract）`,
    fixHint:
      "按照 docs/reference/sdlc-conventions.md（安装位置：$OPENRIG_HOME/reference/sdlc-conventions.md）补充缺失章节（`zrig scope slice create` 会生成其框架）；运行 `zrig scope audit <mission>` 查看逐 slice 发现——此项仅供参考，不会阻塞任何操作",
    evidence: { missionsRoot, slicesChecked, offenders },
  };
}

export interface CheckMissionNotesInput {
  missionsRoot: string;
}

interface MissionWithoutNotes {
  mission: string;
  path: string;
}

/**
 * 检查 #7——任务 NOTES 是否存在。
 *
 * 验证每个任务目录都有当前的 `NOTES.md` 或可读的旧版 `MISSION_NOTES.md`。
 * 由于旧任务可能早于两者，此项仅警告。
 */
export function checkMissionNotesPresence(opts: CheckMissionNotesInput): DoctorCheck {
  const { missionsRoot } = opts;
  let missions: string[];
  try {
    missions = fs.readdirSync(missionsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      check: "mission_notes_presence",
      status: "warn",
      message: code === "ENOENT"
        ? `missions 根目录 '${missionsRoot}' 不存在；没有可检查的任务备注`
        : `无法读取 missions 根目录 '${missionsRoot}'：${(err as Error).message}`,
      evidence: { missionsRoot, errorCode: code ?? "unknown" },
    };
  }

  const missing: MissionWithoutNotes[] = [];
  for (const mission of missions) {
    const missionDir = path.join(missionsRoot, mission);
    if (resolveNotesFile(missionDir) === null) {
      missing.push({ mission, path: missionDir });
    }
  }

  if (missing.length === 0) {
    return {
      check: "mission_notes_presence",
      status: "ok",
      message: `'${missionsRoot}' 下的每个任务都有 NOTES.md 或可读的旧版 MISSION_NOTES.md`,
      evidence: { missionsRoot, missing: [] },
    };
  }
  return {
    check: "mission_notes_presence",
    status: "warn",
    message: `有 ${missing.length} 个任务没有 NOTES.md 或可读的旧版 MISSION_NOTES.md`,
    fixHint:
      "对现有任务运行 `zrig scope mission repair <id>`，或对新任务运行 `zrig scope mission create <id>`",
    evidence: { missionsRoot, missing },
  };
}

export interface RunDoctorInput {
  /** 待检查的工作区根目录（调用方的 --workspace 覆盖值或守护进程解析的默认值）。 */
  workspaceRoot: string;
  workspaceRootSource: WorkspaceRootSource;
  /** 按 ConfigStore workspace.slices_root 解析的 missions 文件夹；调用方覆盖
   *  --workspace 时则为 `<workspaceRoot>/missions`。 */
  slicesRoot: string;
  /** 来自 SettingsStore 的原始 files.allowlist 值（将通过标准 decodeAllowlist 解码）。 */
  allowlistValue: string;
  allowlistSource: WorkspaceRootSource;
  /** 守护进程解析的 workspace.root（供检查 #4 与待检查工作区比较）。 */
  daemonResolvedWorkspaceRoot: string;
  /** 磁盘上守护进程的 ConfigStore configPath（用于检查 #5 的过期比较）。 */
  configFilePath: string;
  /** 守护进程启动时间（用于检查 #5）。 */
  daemonStartTime: Date;
}

export interface DoctorReport {
  /** 待检查的工作区（回显 input.workspaceRoot 以便识别）。 */
  workspaceRoot: string;
  checks: DoctorCheck[];
  summary: { ok: number; warn: number; fail: number };
  /** 守护进程运行报告时的 ISO 时间戳。 */
  daemonResolvedAt: string;
}

/**
 * 编排器——按固定顺序运行全部 7 项检查，并返回带汇总计数的结构化 DoctorReport。
 * 这是纯函数；文件系统影响仅限各检查辅助函数（statSync / readdirSync / existsSync）。
 * 由守护进程路由 POST /api/workspace/doctor（FR-5c）和 CLI 的 --json 格式化器
 *（FR-5d）使用。
 */
export function runWorkspaceDoctor(input: RunDoctorInput): DoctorReport {
  const checks: DoctorCheck[] = [
    checkWorkspaceRootReachable({
      workspaceRoot: input.workspaceRoot,
      source: input.workspaceRootSource,
    }),
    checkMissionsFolder({
      workspaceRoot: input.workspaceRoot,
      slicesRoot: input.slicesRoot,
    }),
    checkFileAllowlist({
      workspaceRoot: input.workspaceRoot,
      allowlistValue: input.allowlistValue,
      allowlistSource: input.allowlistSource,
    }),
    checkDaemonWorkspace({
      daemonResolvedRoot: input.daemonResolvedWorkspaceRoot,
      expectedRoot: input.workspaceRoot,
    }),
    checkDaemonReload({
      configFilePath: input.configFilePath,
      daemonStartTime: input.daemonStartTime,
    }),
    checkOptionalSliceDocs({
      missionsRoot: input.slicesRoot,
    }),
    checkMissionNotesPresence({
      missionsRoot: input.slicesRoot,
    }),
    // OPR.0.4.4.23——检查 #8：SDLC 约定章节（建议性警告）。
    checkSdlcConventionSections({
      missionsRoot: input.slicesRoot,
    }),
  ];
  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) summary[c.status]++;
  return {
    workspaceRoot: input.workspaceRoot,
    checks,
    summary,
    daemonResolvedAt: new Date().toISOString(),
  };
}
