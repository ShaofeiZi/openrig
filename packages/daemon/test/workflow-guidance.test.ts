import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { stringify } from "yaml";
import { readWorkflowGuidance } from "../src/domain/workflow-guidance.js";
import { ContextPackLibraryService } from "../src/domain/context-packs/context-pack-library-service.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive:true, force:true}); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workflow-guidance-")); roots.push(root);
  const project = join(root,"project.yaml"), mission = join(root,"missions/trial/mission.yaml"), slice = join(root,"missions/trial/slices/one/slice.yaml");
  const write = (path: string, value: unknown) => {mkdirSync(join(path,".."),{recursive:true});writeFileSync(path,typeof value === "string" ? value : stringify(value));};
  const catalog = join(root,"method.md");
  const prose = "### draft.choose\n\nChoose one reader question. Preserve uncertainty; do not start another guide.\n\n### draft.review\n\nRead the outline and judge accuracy. Stop at the original promise. Return one decision.\n";
  write(catalog,"# Editorial method\n\n## Components\n\n"+prose);
  const selected = {catalog:{address:catalog+"#components"},components:[{id:"draft.choose",owner:"writer@rig"},{id:"draft.review",owner:"reader@rig"}],edges:[{from:"draft.choose",to:"draft.review",when:"outline ready"}]};
  write(project,{sdlc:selected}); write(mission,{metadata:{name:"trial"}});write(slice,{metadata:{id:"one"}});
  for (const p of [project,mission,slice]) write(join(p,"../SPEC.md"),"---\nintent: Write one accurate public guide.\n---\n");
  const input = {instanceId:"WF",contextRefs:[project,mission],ownerSession:"writer@rig",packetId:"qitem-test"};
  return {root,project,mission,slice,catalog,prose,selected,write,input};
}
describe("已选择的 workflow guidance",()=>{
  it("提供灵活 prose、原始 intent 与条件 edge，且不强加固定 contract ontology",()=>{
    const f=fixture(), g=readWorkflowGuidance(f.input);
    expect(g.state).toBe("selected");expect(g.lines.join("\n")).toContain("Preserve uncertainty");
    expect(g.lines.join("\n")).toContain("outline ready");expect(g.lines.join("\n")).toContain("Write one accurate public guide");
    expect(g.position).toContain("UNKNOWN");expect(g.expansionCommand).toContain("--packet 'qitem-test' --full");
  });
  it("更窄的 component 会替换 ancestor 及其 edge，同时继承已寻址 catalog",()=>{
    const f=fixture();f.write(f.mission,{sdlc:{components:[{id:"draft.review",owner:"reader@rig"}]}});
    const g=readWorkflowGuidance({...f.input,full:true});
    expect(g.components?.map(c=>c.id)).toEqual(["draft.review"]);expect(g.edges).toEqual([]);expect(g.selectionSource).toBe(f.mission);
    f.write(f.slice,{sdlc:{components:[{id:"draft.choose"}]}});
    const child=readWorkflowGuidance({...f.input,contextRefs:[...f.input.contextRefs,f.slice],full:true});
    expect(child.components?.map(c=>c.id)).toEqual(["draft.choose"]);expect(child.selectionSource).toBe(f.slice);
  });
  it("只验证 effective selection，允许更窄的显式选择修复未使用 ancestor 字段",()=>{
    const f=fixture();f.write(f.project,{sdlc:{catalog:null,components:"unused",edges:"unused"}});
    f.write(f.mission,{sdlc:{...f.selected,components:[{id:"draft.review"}],edges:[]}});
    const g=readWorkflowGuidance({...f.input,full:true});expect(g.state).toBe("selected");
    expect(g.components?.map(c=>c.id)).toEqual(["draft.review"]);
  });
  it("不将 bound member composition 误认为 active slice context",()=>{
    const f=fixture();f.write(f.slice,{metadata:{id:"one"},sdlc:{components:[{id:"draft.review"}]}});
    const sources=[{kind:"slice",path:f.slice,sha256:"old"}];
    const g=readWorkflowGuidance({...f.input,binding:{sources,graphSource:{mode:"project-profile"}},stepId:"one",full:true});
    expect(g.selectionSource).toBe(f.project);
    expect(readWorkflowGuidance({...f.input,binding:{sources,graphSource:{mode:"legacy-slices"}},stepId:"one",full:true}).selectionSource).toBe(f.slice);
  });
  it.each([{components:"not-a-list"},{catalog:null},{components:[{id:"draft.choose"},{id:"draft.choose"}]},{edges:[{from:"draft.choose",to:"absent"}]}])("点明所用 shape/relationship 的错误且不 fallback：%j",sdlc=>{
    const f=fixture();f.write(f.mission,{sdlc});const g=readWorkflowGuidance({...f.input,full:true});
    expect(g.state).toBe("unknown");expect(g.unknowns.length).toBeGreaterThan(0);expect(g.teaching).toEqual([]);
  });
  it("点明缺失或有歧义的 addressed teaching，但接受任意 prose metadata",()=>{
    const f=fixture();f.write(f.mission,{sdlc:{components:[{id:"absent",schema:"unconsumed-label"}]}});
    expect(readWorkflowGuidance(f.input).unknowns.join()).toContain("absent 缺失或存在歧义");
    f.write(f.catalog,"## Components\n### draft.choose\nA\n### draft.choose\nB\n");
    f.write(f.mission,{});expect(readWorkflowGuidance(f.input).unknowns.join()).toContain("draft.choose 缺失或存在歧义");
  });
  it("独立于 manifest adoption 重新读取 referenced prose",()=>{
    const f=fixture();const sha256=createHash("sha256").update(readFileSync(f.project)).digest("hex");
    const input={...f.input,binding:{sources:[{kind:"project",path:f.project,sha256}]}};
    const before=readWorkflowGuidance(input);f.write(f.catalog,readFileSync(f.catalog,"utf8").replace("Preserve uncertainty","Keep the newly stated caveat"));
    const after=readWorkflowGuidance(input);expect(after.catalogHash).not.toBe(before.catalogHash);expect(after.sources[0]?.binding).toBe("matches-bound");
    expect(after.lines.join()).toContain("newly stated caveat");
    f.write(f.project,{sdlc:{...f.selected,components:[{id:"draft.review"}]}});
    expect(readWorkflowGuidance(input).sources[0]?.binding).toBe("differs-from-bound");
  });
  it("保持 compact output 有界且不截断 caveat，并支持精确完整展开",()=>{
    const f=fixture(), text="A long rationale. ".repeat(900)+"Do not expand the assignment.";
    f.write(f.catalog,"## Components\n### draft.choose\n"+text+"\n### draft.review\nReview only.\n");
    const compact=readWorkflowGuidance(f.input);expect(compact.lines.join("\n").length).toBeLessThan(6500);
    expect(compact.lines.join()).not.toContain("A long rationale");expect(compact.lines.join()).toContain("已省略部分完整 block");
    const full=readWorkflowGuidance({...f.input,full:true,component:"draft.choose"});expect(full.teaching?.[0]?.text).toContain(text);
    expect(full.teaching?.map(c=>c.id)).toEqual(["draft.choose"]);
  });
  it("解析 repository-root 与已安装 context-library catalog 地址",()=>{
    const f=fixture();execFileSync("git",["init",f.root],{stdio:"ignore"});
    f.write(f.mission,{sdlc:{catalog:{root:"repository",address:"method.md#components"}}});
    expect(readWorkflowGuidance(f.input).catalogPath).toBe(realpathSync(f.catalog));
    const pack=join(f.root,"packs/editorial");f.write(join(pack,"manifest.yaml"),{name:"Editorial",version:1,taxonomy:"world",files:[{path:"method.md",role:"teaching"}]});
    f.write(join(pack,"method.md"),readFileSync(f.catalog,"utf8"));
    const library=new ContextPackLibraryService({roots:[{path:join(f.root,"packs"),sourceType:"user_file"}]});expect(library.scan().errors).toEqual([]);
    f.write(f.mission,{sdlc:{catalog:{address:"editorial/method.md#components"}}});
    expect(readWorkflowGuidance({...f.input,library}).catalogPath).toBe(realpathSync(join(pack,"method.md")));
  });
});
