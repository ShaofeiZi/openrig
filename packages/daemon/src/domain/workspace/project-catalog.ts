import * as fs from "node:fs";
import * as path from "node:path";
import { parse } from "yaml";

export class ProjectReadError extends Error {
  constructor(readonly code: string, message: string, readonly candidates?: string[]) { super(message); }
}
export function yamlObject(file: string): Record<string, any> {
  try {
    const value = parse(fs.readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("应为 YAML 对象");
    return value;
  } catch (err) { throw new ProjectReadError("workspace_catalog_invalid", `${file}: ${(err as Error).message}`); }
}
/** 现有 workspace.yaml 目录，由 work-install 与项目读取共享。 */
export function readProjectCatalog(catalogPath: string): Array<{ id: string; root: string }> | null {
  if (!fs.existsSync(catalogPath)) return null;
  const entries = yamlObject(catalogPath).projects;
  if (!Array.isArray(entries) || entries.some(e => !e || typeof e.id !== "string" || typeof e.root !== "string"))
    throw new ProjectReadError("workspace_catalog_invalid", `${catalogPath} 中每个 project 都必须声明字符串 id 和 root`);
  const ids = entries.map(e => e.id);
  const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
  if (duplicate) throw new ProjectReadError("project_identity_ambiguous", `${catalogPath} 中 project id '${duplicate}' 指向多个根目录`);
  return entries.map(e => ({ id: e.id, root: e.root }));
}
export function selectCatalogProject(catalogPath: string, selectedId?: string): { id: string; root: string } | null {
  const projects = readProjectCatalog(catalogPath);
  if (!projects) return null;
  const candidates = projects.map(p => p.id);
  const id = selectedId ?? (projects.length === 1 ? projects[0]!.id : undefined);
  if (!id) throw new ProjectReadError("project_required", "声明了多个项目；请用 --project 选择一个", candidates);
  const selected = projects.find(p => p.id === id);
  if (!selected) throw new ProjectReadError("project_not_found", `${catalogPath} 中未声明项目 '${id}'`, candidates);
  const nominal = path.resolve(path.dirname(catalogPath), selected.root);
  try { return { id, root: fs.realpathSync(nominal) }; }
  catch { throw new ProjectReadError("project_root_missing", `项目 '${id}' 的根目录不存在：${nominal}`); }
}
/** 精确的项目成员关系；未限定作用域的历史行不会归入所选项目。 */
export function belongsToProject(raw: string | null | undefined, id: string): boolean {
  try {
    const tags: unknown = JSON.parse(raw ?? "null");
    return Array.isArray(tags) && tags.flatMap(t => typeof t === "string" ? t.split(",").map(s => s.trim()) : []).includes(`project:${id}`);
  } catch { return false; }
}
