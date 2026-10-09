import * as fs from "node:fs";
import * as path from "node:path";
import { parse, YAMLParseError } from "yaml";
import type { SettingsStore } from "../user-settings/settings-store.js";
import { NODE_FILE_PRECEDENCE } from "../scope/node-file.js";
import { readProjectCatalog, selectCatalogProject, yamlObject, ProjectReadError } from "./project-catalog.js";

export interface ProjectRead { id: string; root: string; name: string; sourcePath: string | null; missionsRoot: string; error?: string }
type ReadContext = { get: (key: never) => unknown; req: { query: (key: string) => string | undefined } };
export function projectCatalogPaths(c: Pick<ReadContext, "get">) {
  const store = c.get("settingsStore" as never) as SettingsStore | undefined;
  const workspace = store?.resolveOne("workspace.root").value;
  if (typeof workspace !== "string" || !workspace) throw new ProjectReadError("workspace_root_missing", "未配置工作区根目录");
  const configured = store?.resolveOne("workspace.catalog_path").value;
  return { workspace, catalog: typeof configured === "string" && configured ? configured : path.join(workspace, "workspace.yaml") };
}
export function insideProject(root: string, target: string): string {
  const actual = fs.realpathSync(target);
  const rel = path.relative(root, actual);
  if (path.isAbsolute(rel) || rel === ".." || rel.startsWith(`..${path.sep}`)) throw new ProjectReadError("project_path_escape", `源文件位于所选项目之外：${target}`);
  return actual;
}
export function workSource(root: string, dir: string, validate = true): string {
  insideProject(root, dir);
  const source = NODE_FILE_PRECEDENCE.map(name => path.join(dir, name)).find(file => fs.existsSync(file));
  if (!source) throw new ProjectReadError("source_unavailable", `${dir} 中没有工作源文件`);
  insideProject(root, source);
  if (!validate) return source;
  const text = fs.readFileSync(source, "utf8");
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end < 0) throw new ProjectReadError("source_invalid", `frontmatter 未结束：${source}`);
    let value: unknown;
    try { value = parse(text.slice(3, end)); }
    catch (err) {
      if (!(err instanceof YAMLParseError)) throw err;
      const at = err.linePos?.[0];
      throw new ProjectReadError("source_invalid", `frontmatter 无效：${source}（${err.code}${at ? `，第 ${at.line} 行，第 ${at.col} 列` : ""}）。请读取并修正源文件。`);
    }
    if (value !== null && (typeof value !== "object" || Array.isArray(value))) throw new ProjectReadError("source_invalid", `frontmatter 无效：${source}`);
  }
  return source;
}
function projectEntry(id: string, root: string): ProjectRead {
  let p: ProjectRead = { id, root, name: id, sourcePath: null, missionsRoot: path.join(root, "missions") };
  try {
    p.root = fs.realpathSync(root);
    const manifest = path.join(p.root, "project.yaml");
    const value = fs.existsSync(manifest) ? yamlObject(insideProject(p.root, manifest)) : {};
    const declared = value.id ?? value.metadata?.id;
    if (declared && declared !== id) throw new ProjectReadError("project_identity_conflict", `目录中的 ${id} 与项目身份 ${declared} 冲突`);
    p.name = typeof value.metadata?.name === "string" ? value.metadata.name : id;
    const missions = value.missions?.root ?? "missions";
    if (typeof missions !== "string" || path.isAbsolute(missions) || missions.split(/[\\/]/).includes("..")) throw new ProjectReadError("missions_root_escape", "项目的 missions.root 无效");
    p.missionsRoot = path.resolve(p.root, missions);
    p.sourcePath = workSource(p.root, p.root);
    if (fs.existsSync(p.missionsRoot)) insideProject(p.root, p.missionsRoot);
  } catch (err) { p.error = (err as Error).message; }
  return p;
}
export function listProjects(c: Pick<ReadContext, "get">): { catalogPath: string; projects: ProjectRead[] } {
  const { workspace, catalog } = projectCatalogPaths(c);
  const entries = readProjectCatalog(catalog);
  if (entries) return { catalogPath: catalog, projects: entries.map(e => projectEntry(e.id, path.resolve(path.dirname(catalog), e.root))) };
  // 未纳入目录的工作区继续保留原有的单项目权威来源。
  const manifest = path.join(workspace, "project.yaml");
  const value = fs.existsSync(manifest) ? yamlObject(manifest) : {};
  return { catalogPath: catalog, projects: [projectEntry(value.id ?? value.metadata?.id ?? "workspace", workspace)] };
}
export function selectedProject(c: ReadContext): ProjectRead | null {
  const id = c.req.query("project");
  if (id === undefined) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) throw new ProjectReadError("invalid_project", "项目 ID 无效");
  const { catalog } = projectCatalogPaths(c);
  const selected = selectCatalogProject(catalog, id);
  const p = selected ? projectEntry(selected.id, selected.root) : listProjects(c).projects.find(p => p.id === id);
  if (!p) throw new ProjectReadError("project_not_found", `项目 ${id} 不可用`);
  if (c.req.query("projectRoot") && c.req.query("projectRoot") !== p.root) throw new ProjectReadError("project_changed", `项目 ${id} 的根目录已变化，请重新选择`);
  if (p.error) throw new ProjectReadError("project_unavailable", `${id}: ${p.error}`);
  if (!fs.existsSync(p.missionsRoot)) throw new ProjectReadError("missions_unavailable", `${id}：任务目标根目录不可用：${p.missionsRoot}`);
  return p;
}
export function projectReadResponse(err: unknown): Response {
  return Response.json({ error: err instanceof ProjectReadError ? err.code : "project_source_unavailable", message: (err as Error).message }, { status: 409 });
}
export function projectMission(p: ProjectRead, mission: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(mission)) throw new ProjectReadError("invalid_mission", "任务目标目录无效");
  const dir = path.join(p.missionsRoot, mission);
  workSource(p.root, dir);
  const slices = path.join(dir, "slices");
  if (fs.existsSync(slices)) {
    insideProject(p.root, slices);
    for (const child of fs.readdirSync(slices, { withFileTypes: true })) {
      // 对任务目标 reader 消费的每个源文件保留 containment 检查。子项的语法错误只属于该
      // 子项的读取，不应影响健康的同级项。
      if (child.isDirectory() || child.isSymbolicLink()) {
        const childDir = insideProject(p.root, path.join(slices, child.name));
        const source = NODE_FILE_PRECEDENCE.map(name => path.join(childDir, name)).find(file => fs.existsSync(file));
        if (source) insideProject(p.root, source);
      }
    }
  }
  return dir;
}
