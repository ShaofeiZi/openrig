// 工作组上下文 / 可组合上下文注入 v0（PL-014）——manifest 解析器。
//
// 将 <context.root>/<ref>/manifest.yaml 解析为类型化形状，对畸形输入返回
// 结构化错误。此解析器为纯逻辑，不接触文件系统；调用方传入原始 YAML。

import { parse as parseYaml } from "yaml";
import {
  ATOM_PRIORITIES,
  ATOM_PURPOSES,
  ATOM_REGIONS,
  ATOM_RUNTIMES,
  ATOM_SITUATIONS,
  ATOM_TAXONOMIES,
  CONTEXT_PROFILE_RUNTIMES,
  CONTEXT_PROFILE_SOURCES,
  TAXONOMY_TEACHING,
  ContextPackError,
  type ContextPackAtom,
  type ContextPackManifest,
  type ContextPackManifestFile,
  type ContextPackProfile,
} from "./context-pack-types.js";
import { isSafePackVersion } from "./ref-safety.js";
import { AddressResolutionError, parseAddress } from "../markdown-address.js";
import { parseSourceRef, SourceResolutionError } from "./profile-source-resolver.js";

// 以 UTF-8 bundle 文本提供。脚本后缀承载正文引用的 skill 辅助资产——它们只是惰性文本，
// 绝不执行。未列出的后缀仍会响亮拒绝，使真正的新 pack 文件类型在摄取时失败，
// 而不是提供静默缺项的 bundle。
const ALLOWED_FILE_SUFFIXES = [".md", ".markdown", ".yaml", ".yml", ".txt", ".sh", ".ts", ".mjs", ".py"];

export function parseManifest(rawYaml: string, sourcePath: string): ContextPackManifest {
  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml);
  } catch (err) {
    throw new ContextPackError(
      "manifest_parse_error",
      `${sourcePath} 处的 manifest 不是合法 YAML：${(err as Error).message}`,
      { sourcePath },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ContextPackError(
      "manifest_invalid",
      `${sourcePath} 处的 manifest 根节点必须是 YAML 对象`,
      { sourcePath },
    );
  }
  const obj = parsed as Record<string, unknown>;

  const name = obj["name"];
  if (typeof name !== "string" || name.length === 0) {
    throw new ContextPackError(
      "manifest_invalid",
      `${sourcePath} 处的 manifest 缺少必填字段 'name'（字符串）`,
      { sourcePath },
    );
  }

  // YAML 中 version 可以是数字或字符串；归一化为字符串，以便与库 id 和
  // `<name>:<version>` 格式无损往返。
  const versionRaw = obj["version"];
  if (versionRaw === undefined || versionRaw === null) {
    throw new ContextPackError(
      "manifest_invalid",
      `${sourcePath} 处的 manifest 缺少必填字段 'version'`,
      { sourcePath },
    );
  }
  const version = String(versionRaw);
  // Slice-03 谱系修复（R2 HIGH-2）：在摄取窄口强制有界、无分隔符的 version 谓词。
  // 带冒号的 version 可伪造 `<name>:<version>` 存储 id，过长值会突破 OS 文件名限制。
  // 在此拒绝可覆盖所有流经解析器的扫描/安装路径。
  if (!isSafePackVersion(version)) {
    throw new ContextPackError(
      "manifest_invalid",
      `${sourcePath} 处的 manifest 含非法 version '${version}'——version 必须是单个有界 token ` +
        `[A-Za-z0-9][A-Za-z0-9._+-]{0,31}（不含 ':' 或其他分隔符、不含空白、最多 32 字符），` +
        `从而不能伪造 '<name>:<version>' 存储 id 或突破 OS 文件名限制。`,
      { sourcePath },
    );
  }

  const purpose = typeof obj["purpose"] === "string" ? (obj["purpose"] as string) : undefined;

  // OPR.0.5.6.10 mini-req 2——pack 级分类为必填，失败时错误中响亮给出迁移说明。
  // 不设祖父条款：未盖戳 pack 不得交付，拒绝信息会说明修复方法。
  const taxonomyRaw = obj["taxonomy"];
  if (taxonomyRaw === undefined || taxonomyRaw === null) {
    throw new ContextPackError(
      "manifest_invalid",
      `${sourcePath} 处的 manifest 缺少必填字段 'taxonomy'——每个 context pack 都必须声明其上下文种类。${TAXONOMY_TEACHING}`,
      { sourcePath },
    );
  }
  if (typeof taxonomyRaw !== "string" || !(ATOM_TAXONOMIES as readonly string[]).includes(taxonomyRaw)) {
    throw new ContextPackError(
      "manifest_invalid",
      `${sourcePath} 处的 manifest 含非法 taxonomy ${JSON.stringify(taxonomyRaw)}。${TAXONOMY_TEACHING}`,
      { sourcePath },
    );
  }
  const taxonomy = taxonomyRaw as (typeof ATOM_TAXONOMIES)[number];

  const filesRaw = obj["files"];
  if (!Array.isArray(filesRaw)) {
    throw new ContextPackError(
      "manifest_invalid",
      `${sourcePath} 处的 manifest 必须声明 'files: [...]'（实际为 ${typeof filesRaw}）`,
      { sourcePath },
    );
  }
  const files: ContextPackManifestFile[] = [];
  for (let i = 0; i < filesRaw.length; i++) {
    const f = filesRaw[i];
    if (!f || typeof f !== "object" || Array.isArray(f)) {
      throw new ContextPackError(
        "manifest_invalid",
        `${sourcePath} 处的 manifest 在 files[${i}] 有畸形条目（必须是含 'path' + 'role' 的对象）`,
        { sourcePath, index: i },
      );
    }
    const fr = f as Record<string, unknown>;
    const path = fr["path"];
    if (typeof path !== "string" || path.length === 0) {
      throw new ContextPackError(
        "manifest_invalid",
        `${sourcePath} 处的 manifest files[${i}] 缺少 'path'（字符串）`,
        { sourcePath, index: i },
      );
    }
    if (path.includes("..") || path.startsWith("/")) {
      throw new ContextPackError(
        "manifest_invalid",
        `${sourcePath} 处的 manifest files[${i}].path '${path}' 必须是 pack 内的相对路径（不得含 '..' 段，不得以 '/' 开头）`,
        { sourcePath, index: i, path },
      );
    }
    const role = fr["role"];
    if (typeof role !== "string" || role.length === 0) {
      throw new ContextPackError(
        "manifest_invalid",
        `${sourcePath} 处的 manifest files[${i}] 缺少 'role'（字符串）`,
        { sourcePath, index: i, path },
      );
    }
    if (!ALLOWED_FILE_SUFFIXES.some((s) => path.endsWith(s))) {
      throw new ContextPackError(
        "manifest_invalid",
        `${sourcePath} 处的 manifest files[${i}].path '${path}' 后缀不受支持；允许：${ALLOWED_FILE_SUFFIXES.join(", ")}`,
        { sourcePath, index: i, path },
      );
    }
    const summary = typeof fr["summary"] === "string" ? (fr["summary"] as string) : undefined;
    files.push(summary === undefined ? { path, role } : { path, role, summary });
  }

  const estimatedTokensRaw = obj["estimated_tokens"] ?? obj["estimatedTokens"];
  const estimatedTokens = typeof estimatedTokensRaw === "number" && Number.isFinite(estimatedTokensRaw)
    ? Math.max(0, Math.floor(estimatedTokensRaw))
    : undefined;

  const atoms = obj["atoms"] !== undefined ? parseAtoms(obj["atoms"], files, sourcePath) : undefined;
  const profiles = obj["profiles"] !== undefined ? parseProfiles(obj["profiles"], atoms ?? [], sourcePath) : undefined;

  return {
    name,
    version,
    ...(purpose !== undefined ? { purpose } : {}),
    taxonomy,
    files,
    ...(estimatedTokens !== undefined ? { estimatedTokens } : {}),
    ...(atoms !== undefined ? { atoms } : {}),
    ...(profiles !== undefined ? { profiles } : {}),
  };
}

// ---------------------------------------------------------------------------
// OPR.0.5.3.5 mini-req 1——安装 atom。atom 是地址加组合元数据，绝不是新文件：
// fresh/handover/post-compaction 都把地址组合为相同字节（构造上满足 mini-req 5）。
// 此处每条规则都以 atom 的索引和 id 响亮失败；畸形 atom 必须停止摄取，
// 绝不能让后续 compose 静默变薄。

const MARKDOWN_SUFFIXES = [".md", ".markdown"];
const ATOM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const ALLOWED_ATOM_KEYS = new Set([
  "id", "address", "taxonomy", "regions", "situations", "purpose", "runtime", "order", "requires", "priority", "profile_only", "probe",
]);
// 值得友好提示的拼写错误（r1 F2）：那些静默丢失影响最严重字段的单复数误写。
const ALLOWED_PROBE_KEYS = new Set(["prompt", "expect", "expectedPatterns", "rubric"]);
const NEAR_MISS_ATOM_KEYS: Record<string, string> = {
  require: "requires", region: "regions", situation: "situations", probes: "probe",
};

function atomError(sourcePath: string, index: number, detail: string): ContextPackError {
  return new ContextPackError("manifest_invalid", `${sourcePath} 处的 manifest atoms[${index}]：${detail}`, { sourcePath, index });
}

function enumField<T extends string>(
  value: unknown, allowed: readonly T[], field: string, sourcePath: string, index: number,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw atomError(sourcePath, index, `'${field}' 必须是 ${allowed.join(" | ")} 之一（实际为 ${JSON.stringify(value)}）`);
  }
  return value as T;
}

function parseAtoms(raw: unknown, files: ContextPackManifestFile[], sourcePath: string): ContextPackAtom[] {
  if (!Array.isArray(raw)) {
    throw new ContextPackError("manifest_invalid", `${sourcePath} 处的 manifest 'atoms' 必须是数组`, { sourcePath });
  }
  const declaredFiles = new Set(files.map((f) => f.path));
  const atoms: ContextPackAtom[] = [];
  const seenIds = new Set<string>();
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw atomError(sourcePath, i, "必须是对象");
    }
    const a = entry as Record<string, unknown>;

    // r1 F2：摄取层知道完整合法键集合——未知键会响亮拒绝。`require:` 拼写错误会
    // 静默丢掉依赖边，正是此字段要防止的错误；若每个必填字段都响亮失败，
    // 而拼错的可选字段静默失败，就会破坏模块契约。
    for (const key of Object.keys(a)) {
      if (!ALLOWED_ATOM_KEYS.has(key)) {
        const hint = NEAR_MISS_ATOM_KEYS[key];
        throw atomError(sourcePath, i, `未知字段 '${key}'${hint ? `——是否想写 '${hint}'？` : ""}（允许：${[...ALLOWED_ATOM_KEYS].join(", ")}）`);
      }
    }

    const id = a["id"];
    if (typeof id !== "string" || !ATOM_ID.test(id)) {
      throw atomError(sourcePath, i, `'id' 必须是匹配 [a-z0-9][a-z0-9-]{0,63} 的稳定 slug（实际为 ${JSON.stringify(id)}）`);
    }
    if (seenIds.has(id)) throw atomError(sourcePath, i, `atom id '${id}' 重复——id 是 order/requires/probes 的连接键`);
    seenIds.add(id);

    const addressRaw = a["address"];
    if (typeof addressRaw !== "string" || addressRaw.length === 0) {
      throw atomError(sourcePath, i, "'address' 为必填项：file 或 file#H2-slug/H3-slug");
    }
    let parsedAddr;
    try {
      parsedAddr = parseAddress(addressRaw);
    } catch (err) {
      if (err instanceof AddressResolutionError) throw atomError(sourcePath, i, `'address' 畸形——${err.message}`);
      throw err;
    }
    // Atom 4a——`#` 前 ref 携带解析器 kind（Q2 修订 1 的单语法双解析器裁决）：
    // 裸 LIBRARY ref 必须是已声明 pack 文件；project:/seat:/mission: TREE ref 按设计
    // 位于 pack 外（可组合内容无需归巢于库），因此这里只做结构校验（未知前缀/遍历会响亮拒绝），
    // compose 时再从已配置根解析。
    let sourceRef;
    try {
      sourceRef = parseSourceRef(parsedAddr.ref);
    } catch (err) {
      if (err instanceof SourceResolutionError) throw atomError(sourcePath, i, `'address'——${err.message}`);
      throw err;
    }
    if (sourceRef.kind === "library" && !declaredFiles.has(parsedAddr.ref)) {
      throw atomError(sourcePath, i, `'address' 引用的 '${parsedAddr.ref}' 不是已声明 pack 文件——library atom 应寻址到 pack 自身文件内（tree 来源使用 project:/seat:/mission: 前缀）`);
    }
    if (parsedAddr.headerPath.length > 0 && !MARKDOWN_SUFFIXES.some((s) => sourceRef.rel.endsWith(s))) {
      throw atomError(sourcePath, i, `'address' 在 '${parsedAddr.ref}' 上使用标题路径——标题寻址仅适用于 Markdown 文件（${MARKDOWN_SUFFIXES.join(", ")}）`);
    }

    const taxonomy = enumField(a["taxonomy"], ATOM_TAXONOMIES, "taxonomy", sourcePath, i);
    const purpose = enumField(a["purpose"], ATOM_PURPOSES, "purpose", sourcePath, i);
    const priority = enumField(a["priority"], ATOM_PRIORITIES, "priority", sourcePath, i);
    const runtime = a["runtime"] === undefined ? "any" : enumField(a["runtime"], ATOM_RUNTIMES, "runtime", sourcePath, i);
    if (a["profile_only"] !== undefined && typeof a["profile_only"] !== "boolean") {
      throw atomError(sourcePath, i, `'profile_only' 存在时必须是布尔值（实际为 ${JSON.stringify(a["profile_only"])}）`);
    }
    const profileOnly = a["profile_only"] === true;

    const situationsRaw = a["situations"];
    if (!Array.isArray(situationsRaw) || situationsRaw.length === 0) {
      throw atomError(sourcePath, i, `'situations' 必须是 ${ATOM_SITUATIONS.join(" | ")} 的非空数组——它是组合代数的选择器`);
    }
    const situations = situationsRaw.map((s) => enumField(s, ATOM_SITUATIONS, "situations", sourcePath, i));

    let regions: ContextPackAtom["regions"];
    if (a["regions"] !== undefined) {
      const regionsRaw = a["regions"];
      if (!Array.isArray(regionsRaw)) throw atomError(sourcePath, i, "'regions' 存在时必须是数组");
      regions = regionsRaw.map((r) => enumField(r, ATOM_REGIONS, "regions", sourcePath, i));
    }

    const order = a["order"];
    if (typeof order !== "number" || !Number.isInteger(order)) {
      throw atomError(sourcePath, i, `'order' 必须是整数——walk 有顺序，吸收依赖序列（实际为 ${JSON.stringify(order)}）`);
    }

    let requires: string[] | undefined;
    if (a["requires"] !== undefined) {
      const requiresRaw = a["requires"];
      if (!Array.isArray(requiresRaw) || requiresRaw.some((r) => typeof r !== "string")) {
        throw atomError(sourcePath, i, "'requires' 存在时必须是 atom id 数组");
      }
      requires = requiresRaw as string[];
      if (requires.includes(id)) throw atomError(sourcePath, i, `atom '${id}' 依赖自身`);
    }

    let probe: ContextPackAtom["probe"];
    if (a["probe"] !== undefined) {
      const p = a["probe"];
      if (!p || typeof p !== "object" || Array.isArray(p)) throw atomError(sourcePath, i, "'probe' 必须是对象 { prompt, expect, expectedPatterns?, rubric? }");
      const pr = p as Record<string, unknown>;
      // Q3 桥接：键门延伸到 probe 内部（已处置的 Atom-2 注释落在记录位置），
      // 且形状与 harness 的 EvalCase 对齐——expectedPatterns/rubric 在此合法，
      // 因而 r1 预测的自然失误进入 schema，而不是静默丢失。
      for (const key of Object.keys(pr)) {
        if (!ALLOWED_PROBE_KEYS.has(key)) {
          throw atomError(sourcePath, i, `'probe' 含未知字段 '${key}'${key === "rubrics" ? "——是否想写 'rubric'？" : ""}（允许：${[...ALLOWED_PROBE_KEYS].join(", ")}）`);
        }
      }
      if (typeof pr["prompt"] !== "string" || pr["prompt"].length === 0 || typeof pr["expect"] !== "string" || pr["expect"].length === 0) {
        throw atomError(sourcePath, i, "'probe' 同时需要自然语言 'prompt' 与 'expect' 所描述的可观察行为——验收看行为变化，而不是文件交付");
      }
      let expectedPatterns: string[] | undefined;
      if (pr["expectedPatterns"] !== undefined) {
        const eps = pr["expectedPatterns"];
        if (!Array.isArray(eps) || eps.some((e) => typeof e !== "string")) {
          throw atomError(sourcePath, i, "'probe.expectedPatterns' 存在时必须是正则表达式源码字符串数组");
        }
        for (const src of eps as string[]) {
          try {
            new RegExp(src);
          } catch {
            throw atomError(sourcePath, i, `'probe.expectedPatterns' 条目 '${src}' 不是可编译的正则表达式源码`);
          }
        }
        expectedPatterns = eps as string[];
      }
      if (pr["rubric"] !== undefined && typeof pr["rubric"] !== "string") {
        throw atomError(sourcePath, i, "'probe.rubric' 存在时必须是字符串");
      }
      probe = {
        prompt: pr["prompt"],
        expect: pr["expect"],
        ...(expectedPatterns !== undefined ? { expectedPatterns } : {}),
        ...(pr["rubric"] !== undefined ? { rubric: pr["rubric"] as string } : {}),
      };
    }

    atoms.push({
      id,
      address: addressRaw,
      taxonomy,
      ...(regions !== undefined ? { regions } : {}),
      situations,
      purpose,
      runtime,
      order,
      ...(requires !== undefined ? { requires } : {}),
      priority,
      ...(profileOnly ? { profileOnly: true } : {}),
      ...(probe !== undefined ? { probe } : {}),
    });
  }

  // 所有 id 已知后再处理跨 atom 边。
  for (let i = 0; i < atoms.length; i++) {
    for (const req of atoms[i]!.requires ?? []) {
      if (!seenIds.has(req)) {
        throw atomError(sourcePath, i, `atom '${atoms[i]!.id}' 依赖 '${req}'，但没有 atom 声明它`);
      }
    }
  }
  // requires 环永远无法由任何子集 profile 闭合，因此在摄取时拒绝并明确列出环。
  // 遍历使用显式栈迭代实现（r1 F1）：递归形式在约 5000 个 atom 后会抛裸 RangeError，
  // 脱离本模块承诺的 ContextPackError 通道；而深度可由攻击者选择（pack 可从 URL 安装，
  // slice-07 R4），没有跨 Node 版本/平台都安全的递归阈值，所以这里不设阈值。
  const state = new Map<string, "visiting" | "done">();
  const byId = new Map(atoms.map((atom) => [atom.id, atom]));
  for (const root of atoms) {
    if (state.get(root.id) === "done") continue;
    // 每个栈帧记录其 requires 列表已遍历到的位置。
    const stack: Array<{ id: string; next: number }> = [{ id: root.id, next: 0 }];
    state.set(root.id, "visiting");
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const reqs = byId.get(frame.id)!.requires ?? [];
      if (frame.next >= reqs.length) {
        state.set(frame.id, "done");
        stack.pop();
        continue;
      }
      const req = reqs[frame.next++]!;
      const s = state.get(req);
      if (s === "done") continue;
      if (s === "visiting") {
        const trail = stack.map((f) => f.id);
        const cycle = [...trail.slice(trail.indexOf(req)), req].join(" -> ");
        throw new ContextPackError("manifest_invalid", `${sourcePath} 处的 manifest atoms 存在 requires 环 ${cycle}——任何子集 profile 都无法闭合它`, { sourcePath });
      }
      state.set(req, "visiting");
      stack.push({ id: req, next: 0 });
    }
  }

  return atoms;
}

const PROFILE_ID = ATOM_ID;
const ALLOWED_PROFILE_KEYS = new Set(["id", "situations", "runtimes", "phases"]);
const ALLOWED_PROFILE_PHASE_KEYS = new Set(["id", "atoms", "context"]);

function profileError(sourcePath: string, index: number, detail: string): ContextPackError {
  return new ContextPackError("manifest_invalid", `${sourcePath} 处的 manifest profiles[${index}]：${detail}`, { sourcePath, index });
}

function profileEnumField<T extends string>(
  value: unknown, allowed: readonly T[], field: string, sourcePath: string, index: number,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw profileError(sourcePath, index, `'${field}' 必须是 ${allowed.join(" | ")} 之一（实际为 ${JSON.stringify(value)}）`);
  }
  return value as T;
}

function parseProfiles(raw: unknown, atoms: ContextPackAtom[], sourcePath: string): ContextPackProfile[] {
  if (!Array.isArray(raw)) {
    throw new ContextPackError("manifest_invalid", `${sourcePath} 处的 manifest 'profiles' 必须是数组`, { sourcePath });
  }
  if (atoms.length === 0 && raw.length > 0) {
    throw new ContextPackError("manifest_invalid", `${sourcePath} 处的 manifest 声明了 profiles 却没有 atoms——atom phase 需要一个权威来源图`, { sourcePath });
  }

  const atomsById = new Map(atoms.map((atom) => [atom.id, atom]));
  const seenProfileIds = new Set<string>();
  const profiles: ContextPackProfile[] = [];

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw profileError(sourcePath, i, "必须是对象");
    }
    const profile = entry as Record<string, unknown>;
    for (const key of Object.keys(profile)) {
      if (!ALLOWED_PROFILE_KEYS.has(key)) {
        throw profileError(sourcePath, i, `未知字段 '${key}'（允许：${[...ALLOWED_PROFILE_KEYS].join(", ")}）`);
      }
    }
    const id = profile["id"];
    if (typeof id !== "string" || !PROFILE_ID.test(id)) {
      throw profileError(sourcePath, i, `'id' 必须是匹配 [a-z0-9][a-z0-9-]{0,63} 的稳定 slug（实际为 ${JSON.stringify(id)}）`);
    }
    if (seenProfileIds.has(id)) throw profileError(sourcePath, i, `profile id '${id}' 重复`);
    seenProfileIds.add(id);

    const situationsRaw = profile["situations"];
    if (!Array.isArray(situationsRaw) || situationsRaw.length === 0) {
      throw profileError(sourcePath, i, `'situations' 必须是 ${ATOM_SITUATIONS.join(" | ")} 的非空数组`);
    }
    const situations = situationsRaw.map((value) => profileEnumField(value, ATOM_SITUATIONS, "situations", sourcePath, i));
    if (new Set(situations).size !== situations.length) throw profileError(sourcePath, i, "'situations' 不得包含重复值");

    const runtimesRaw = profile["runtimes"];
    if (!Array.isArray(runtimesRaw) || runtimesRaw.length === 0) {
      throw profileError(sourcePath, i, `'runtimes' 必须是 ${CONTEXT_PROFILE_RUNTIMES.join(" | ")} 的非空数组`);
    }
    const runtimes = runtimesRaw.map((value) => profileEnumField(value, CONTEXT_PROFILE_RUNTIMES, "runtimes", sourcePath, i));
    if (new Set(runtimes).size !== runtimes.length) throw profileError(sourcePath, i, "'runtimes' 不得包含重复值");

    const phasesRaw = profile["phases"];
    if (!Array.isArray(phasesRaw) || phasesRaw.length === 0) {
      throw profileError(sourcePath, i, "'phases' 必须是非空数组");
    }
    const phases: ContextPackProfile["phases"] = [];
    const seenPhaseIds = new Set<string>();
    const selectedAtoms = new Set<string>();
    const selectedContext = new Set<string>();

    for (let j = 0; j < phasesRaw.length; j++) {
      const phaseRaw = phasesRaw[j];
      if (!phaseRaw || typeof phaseRaw !== "object" || Array.isArray(phaseRaw)) {
        throw profileError(sourcePath, i, `phases[${j}] 必须是对象`);
      }
      const phase = phaseRaw as Record<string, unknown>;
      for (const key of Object.keys(phase)) {
        if (!ALLOWED_PROFILE_PHASE_KEYS.has(key)) {
          throw profileError(sourcePath, i, `phases[${j}] 含未知字段 '${key}'（允许：${[...ALLOWED_PROFILE_PHASE_KEYS].join(", ")}）`);
        }
      }
      const phaseId = phase["id"];
      if (typeof phaseId !== "string" || !PROFILE_ID.test(phaseId)) {
        throw profileError(sourcePath, i, `phases[${j}].id 必须是稳定 slug（实际为 ${JSON.stringify(phaseId)}）`);
      }
      if (seenPhaseIds.has(phaseId)) throw profileError(sourcePath, i, `phase id '${phaseId}' 重复`);
      seenPhaseIds.add(phaseId);

      const hasAtoms = phase["atoms"] !== undefined;
      const hasContext = phase["context"] !== undefined;
      if (hasAtoms === hasContext) {
        throw profileError(sourcePath, i, `phases[${j}] '${phaseId}' 必须且只能声明 atoms 或 context 之一`);
      }
      if (hasAtoms) {
        const atomIds = phase["atoms"];
        if (!Array.isArray(atomIds) || atomIds.length === 0 || atomIds.some((value) => typeof value !== "string")) {
          throw profileError(sourcePath, i, `phases[${j}].atoms 必须是 atom id 的非空数组`);
        }
        for (const atomId of atomIds as string[]) {
          const atom = atomsById.get(atomId);
          if (!atom) throw profileError(sourcePath, i, `phase '${phaseId}' 引用了缺失的 atom '${atomId}'`);
          if (selectedAtoms.has(atomId)) throw profileError(sourcePath, i, `atom '${atomId}' 在 profile '${id}' 中出现多次`);
          for (const situation of situations) {
            if (!atom.situations.includes(situation)) {
              throw profileError(sourcePath, i, `atom '${atomId}' 不适用于 profile situation '${situation}'`);
            }
          }
          for (const runtime of runtimes) {
            if (atom.runtime !== "any" && atom.runtime !== runtime) {
              throw profileError(sourcePath, i, `atom '${atomId}' 的 runtime=${atom.runtime}，与 profile runtime '${runtime}' 不兼容`);
            }
          }
          for (const required of atom.requires ?? []) {
            if (!selectedAtoms.has(required) && !(atomIds as string[]).includes(required)) {
              throw profileError(sourcePath, i, `atom '${atomId}' 依赖 '${required}'，后者必须出现在同一或更早 phase 中`);
            }
          }
          selectedAtoms.add(atomId);
        }
        phases.push({ id: phaseId, atoms: [...(atomIds as string[])] });
      } else {
        const contextRaw = phase["context"];
        if (!Array.isArray(contextRaw) || contextRaw.length === 0) {
          throw profileError(sourcePath, i, `phases[${j}].context 必须是 ${CONTEXT_PROFILE_SOURCES.join(" | ")} 的非空数组`);
        }
        const context = contextRaw.map((value) => profileEnumField(value, CONTEXT_PROFILE_SOURCES, "context", sourcePath, i));
        for (const source of context) {
          if (selectedContext.has(source)) throw profileError(sourcePath, i, `context 来源 '${source}' 在 profile '${id}' 中出现多次`);
          selectedContext.add(source);
        }
        phases.push({ id: phaseId, context });
      }
    }
    profiles.push({ id, situations, runtimes, phases });
  }
  return profiles;
}
