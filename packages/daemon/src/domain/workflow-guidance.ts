import { shellQuote as quote } from "../adapters/shell-quote.js";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse } from "yaml";
import { parseAddress, parseMarkdownSections, resolveAddress, slugifyHeader } from "./markdown-address.js";
import type { ContextPackLibraryService } from "./context-packs/context-pack-library-service.js";

type Mapping = Record<string, any>;
type Source = { kind: string; path: string; sha256: string; binding: "matches-bound" | "differs-from-bound" | "not-bound" };
type Component = { id: string; owner?: string; admission?: string };
export interface GuidanceInput {
  instanceId: string;
  contextRefs?: string[];
  binding?: Record<string, unknown> | null;
  stepId?: string;
  ownerSession?: string;
  packetId?: string;
  component?: string;
  full?: boolean;
  library?: ContextPackLibraryService;
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const mapping = (value: unknown, at: string): Mapping => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error(at + "：应为 mapping");
  return value as Mapping;
};
const string = (value: unknown, at: string): string => {
  if (typeof value !== "string" || !value.trim()) throw Error(at + "：应为非空文本");
  return value;
};

/** 当前 authored advice。无 component cursor、scheduler、cache 或 adoption write。 */
export function readWorkflowGuidance(input: GuidanceInput) {
  const unknowns: string[] = [], sources: Source[] = [], stories: Array<{ address: string; text: string }> = [];
  const bound = Array.isArray(input.binding?.sources) ? input.binding.sources as Array<{kind: string; path: string; sha256: string}> : [];
  const refs = [...new Set([...(input.contextRefs ?? []), ...bound.filter(s => s.kind !== "slice").map(s => s.path)])];
  const manifests: Array<{kind: string; path: string; document: Mapping}> = [];
  let components: Component[] = [], edges: Array<{from: string; to: string; when?: string}> = [];
  let selectionSource: string | null = null, catalogSource: string | null = null, catalog: Mapping | null = null;
  let catalogPath: string | null = null, catalogHash: string | null = null;
  let selected = false, selectionInvalid = false;
  let rawComponents: unknown, rawEdges: unknown = [];
  const command = "zrig workflow guidance " + quote(input.instanceId) + (input.packetId ? " --packet " + quote(input.packetId) : "");
  const readManifest = (kind: string, path: string) => {
    const text = readFileSync(path, "utf8"), sha256 = hash(text), prior = bound.find(s => resolve(s.path) === resolve(path));
    sources.push({kind, path, sha256, binding: !prior ? "not-bound" : prior.sha256 === sha256 ? "matches-bound" : "differs-from-bound"});
    const document = mapping(parse(text), path);
    manifests.push({kind, path, document});
    return document;
  };
  try {
    for (const kind of ["project", "mission"]) {
      const paths = refs.filter(ref => ref.endsWith("/" + kind + ".yaml"));
      if (paths.length > 1) throw Error("存在多个 " + kind + " source；请选择无歧义的 authored context：" + paths.join(", "));
      if (paths[0]) readManifest(kind, paths[0]);
    }
    // bound member 表示 membership，而非 active slice。只有显式 context 或 legacy slice 的精确
    // executable identity 才能确立 active slice。
    const slicePaths = refs.filter(ref => ref.endsWith("/slice.yaml"));
    if ((input.binding?.graphSource as Mapping | undefined)?.mode === "legacy-slices" && input.stepId) {
      for (const source of bound.filter(s => s.kind === "slice")) {
        const doc = mapping(parse(readFileSync(source.path, "utf8")), source.path);
        if ((doc.metadata?.id ?? dirname(source.path).split("/").at(-1)) === input.stepId) slicePaths.push(source.path);
      }
    }
    const slices = [...new Set(slicePaths)];
    if (slices.length > 1) throw Error("无法确定 active slice：存在多个显式 slice context：" + slices.join(", "));
    if (slices[0]) readManifest("slice", slices[0]);
    for (const source of manifests) {
      if (!("sdlc" in source.document)) continue;
      selected = true;
      const at = source.path + "#sdlc", sdlc = mapping(source.document.sdlc, at);
      if ("catalog" in sdlc) { catalog = sdlc.catalog; catalogSource = source.path; }
      if ("components" in sdlc) {
        rawComponents = sdlc.components; selectionSource = source.path;
        rawEdges = []; // replacement 绝不追加 ancestor gate 或 edge。
      }
      if ("edges" in sdlc) rawEdges = sdlc.edges;
    }
    if (selected && !selectionSource) throw Error("显式 SDLC selection 没有 components list；未选择默认 gate。");
    if (selected) {
      // 只验证下方实际使用的 effective field，不验证被 override 的 advice。
      if (!Array.isArray(rawComponents)) throw Error(selectionSource + "#sdlc.components：应为 list");
      components = rawComponents.map(raw => {
        const c = mapping(raw, selectionSource + "#sdlc.components");
        return {id: string(c.id, selectionSource + "#sdlc.components.id"),
          ...(c.owner === undefined ? {} : {owner: string(c.owner, selectionSource + "#sdlc.components.owner")}),
          ...(c.admission === undefined ? {} : {admission: string(c.admission, selectionSource + "#sdlc.components.admission")})};
      });
      if (new Set(components.map(c => c.id)).size !== components.length) throw Error(selectionSource + "#sdlc.components：ID 重复");
      if (!Array.isArray(rawEdges)) throw Error("Effective sdlc.edges：应为 list");
      edges = rawEdges.map(raw => {
        const e = mapping(raw, "sdlc.edges");
        return {from: string(e.from, "sdlc.edges.from"), to: string(e.to, "sdlc.edges.to"),
          ...(e.when === undefined ? {} : {when: string(e.when, "sdlc.edges.when")})};
      });
    }
    for (const edge of edges) if (![edge.from, edge.to].every(id => components.some(c => c.id === id))) throw Error("SDLC edge 指向未选择的 component：" + edge.from + " -> " + edge.to);
  } catch (error) { selectionInvalid = true; unknowns.push(String(error)); }

  if (selected) for (const source of manifests) {
    try {
      const ref = source.document.composition?.[source.kind + "_markdown"]?.spec ?? "SPEC.md";
      const address = resolve(dirname(source.path), string(ref, source.path + ": spec"));
      const text = readFileSync(address, "utf8");
      const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      const intent = frontmatter ? parse(frontmatter[1]!)?.intent : undefined;
      stories.push({address: address + (typeof intent === "string" ? " (frontmatter intent)" : "#intent"),
        text: typeof intent === "string" ? intent : resolveAddress(text, ["intent"]).text});
    } catch (error) { unknowns.push(source.path + "：无法读取原始 intent：" + String(error)); }
  }
  const teaching: Array<Component & { address: string; text: string }> = [];
  if (selected && !selectionInvalid) {
    try {
      if (!catalog || !catalogSource) throw Error("缺少已选择的 SDLC catalog；未选择 fallback catalog。");
      catalog = mapping(catalog, catalogSource + "#sdlc.catalog");
      const {ref, headerPath} = parseAddress(string(catalog.address, catalogSource + "#sdlc.catalog.address"));
      if (catalog.root !== undefined && catalog.root !== "repository") throw Error("未知 SDLC catalog root：" + String(catalog.root));
      if (catalog.root === "repository") {
        const repository = execFileSync("git", ["-C", dirname(catalogSource), "rev-parse", "--show-toplevel"], {encoding:"utf8", stdio:["ignore","pipe","pipe"], timeout:2000}).trim();
        catalogPath = resolve(repository, ref);
      } else if (ref.startsWith("$OPENRIG_HOME/")) {
        if (!process.env.OPENRIG_HOME) throw Error("OPENRIG_HOME 不可用于 " + ref);
        catalogPath = join(process.env.OPENRIG_HOME, ref.slice("$OPENRIG_HOME/".length));
      } else if (isAbsolute(ref) || ref.startsWith("./") || ref.startsWith("../")) {
        catalogPath = resolve(dirname(catalogSource), ref);
      } else {
        // 现有 library 负责 pack ref。未匹配 ref 是相对于声明 manifest 的 path，绝不相对于 daemon cwd。
        const entry = input.library?.list().filter(e => ref.startsWith(e.relativePath + "/")).sort((a,b) => b.relativePath.length - a.relativePath.length)[0];
        if (entry) {
          const file = ref.slice(entry.relativePath.length + 1);
          if (!entry.files.some(f => f.path === file)) throw Error(ref + "：context pack 未声明该文件");
          catalogPath = input.library!.resolveFileWithinPack(entry, file);
        } else catalogPath = resolve(dirname(catalogSource), ref);
      }
      catalogPath = realpathSync(catalogPath);
      const text = readFileSync(catalogPath, "utf8"); catalogHash = hash(text);
      // 原样保留自然语言；此读取器只关心地址唯一性。
      resolveAddress(text, headerPath);
      const sections = parseMarkdownSections(text).filter(s => headerPath.every((p,i) => s.headerPath[i] === p));
      for (const c of components) {
        const candidates = sections.filter(s => slugifyHeader(s.title) === slugifyHeader(c.id));
        if (candidates.length !== 1) { unknowns.push(catalog.address + "：component " + c.id + " 缺失或存在歧义"); continue; }
        const section = candidates[0]!;
        teaching.push({...c, address: catalogPath + "#" + section.headerPath.join("/"), text: section.text});
      }
    } catch (error) { unknowns.push("SDLC catalog 不可用：" + String(error)); }
  }
  const owned = teaching.filter(c => c.owner === input.ownerSession);
  const relevant = input.component ? teaching.filter(c => c.id === input.component) : owned;
  if (input.component && !relevant.length) unknowns.push("请求的 component 不在 effective selection 中：" + input.component);
  const expanded = input.full ? (input.component ? relevant : (owned.length ? owned : teaching)) : (input.component ? relevant : owned.length ? owned : teaching).slice(0,1);
  const position = "UNKNOWN：component position 未 authored。精确 owner 匹配只确立相关性，而非 stage；请依据当前 evidence 从已选择 component 与显式 edge 中选择。array 顺序仅用于展示。";
  const blocks = [
    ...unknowns.map(u => "UNKNOWN：" + u),
    selected ? "已从 " + selectionSource + " 选择 SDLC advice；catalog 来自 " + catalogSource + "：" + catalog?.address : "可用 authored context 中未选择 SDLC composition。",
    ...(selected ? ["当前 authored advice；component prose 不是已采纳的 executable snapshot。Binding status：" + sources.map(s => s.kind + "=" + s.binding).join(", ") + "。使用 zrig workflow revise " + quote(input.instanceId) + " 检查/采纳 YAML 变更。", "原始 story：", ...stories.map(s => s.address + "\n" + s.text),
      position,
      "已选择 component" + (components.length > 20 && !input.full ? "（共 " + components.length + " 个，显示前 20 个）" : "") + "：" + (input.full ? components : components.slice(0,20)).map(c => c.id + (c.owner ? " owner=" + c.owner : " owner=unknown") + (c.admission ? " admission=" + c.admission : "")).join("; "),
      ...(expanded.length ? expanded.map(c => "已选择 teaching 预览 " + c.id + (input.component ? "（显式选择 component），" : owned.length ? "（owner 匹配；不是 process position），" : "（menu 预览；owner 相关性未知），") + c.address + "\n" + c.text) : ["未精确匹配 owner " + (input.ownerSession ?? "未知 owner") + "；请显式选择已选 component 以展开。"]),
      "Authored edge：" + (edges.length ? (input.full ? edges : edges.slice(0,20)).map(e => e.from + " -> " + e.to + (e.when ? " when " + e.when : "")).join("; ") : "无；不要推断 dependency"),
      "Selection source：" + sources.map(s => s.path + " sha256=" + s.sha256 + " " + s.binding).join("; "),
      "引用的 teaching：" + catalogPath + " sha256=" + catalogHash + "。这是当前 authored advice，而非 bound executable snapshot。YAML 编辑需使用 zrig workflow revise " + quote(input.instanceId) + " 检查/采纳；catalog prose 会在读取时 refresh，但不 revise graph。"] : []),
  ];
  // 只省略完整 block，绝不将 Stop/Skip caveat 截成误导性片段。
  const lines: string[] = []; let omitted = false, size = 0;
  for (const block of blocks) {
    const rendered = block.split("\n").map(line => "工作流方法：" + line);
    if (!input.full && size + rendered.join("\n").length > 5600) { omitted = true; continue; }
    lines.push(...rendered); size += rendered.join("\n").length;
  }
  const expansionCommand = command + " --full" + (input.component ? " --component " + quote(input.component) : "");
  lines.push("工作流方法：" + (omitted ? "受 compact budget 限制，已省略部分完整 block。" : "") + "展开相关 teaching：" + expansionCommand + "；使用 --component <id> 选择其他项。适配前请阅读 authored caveat 与 edge；advice 不授予额外 assignment。");
  return {state: unknowns.length ? "unknown" : selected ? "selected" : "unselected", selectionSource, catalogSource, catalogPath, catalogHash,
    sources, position, ownerSession: input.ownerSession ?? null, unknowns, expansionCommand, lines,
    ...(input.full ? {stories, components, edges, teaching: expanded} : {})};
}
