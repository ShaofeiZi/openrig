import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { configureShadowCapture, inventoryCaptureOptions, ShadowCapture, type ShadowConfig } from "../src/domain/shadow-capture.js";
import { SessionTransport } from "../src/domain/session-transport.js";
import { attachAgentActivity } from "../src/domain/node-inventory.js";
import type { NodeInventoryEntry } from "../src/domain/types.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { projectsRoutes } from "../src/routes/projects.js";
import { StreamClassificationWorker, type WorkerOptions, type ClassificationDecision } from "../src/domain/stream-classification-worker.js";
import type { Observation } from "../src/domain/capture-observer.js";

const config:ShadowConfig={destination:"/unused/private/shadow.jsonl",maxRecords:10,maxBytes:100_000,capacity:10,maxQueuedBytes:100_000,maxObservationBytes:10_000};
function terminal(capture?:ShadowCapture) {
  let pane="%7", occupant="old", probes=0, captures=0, pastes=0, enters=0, verify=0;
  let hook:()=>void=()=>{};
  const db={prepare:()=>({get:()=>({runtime:"codex",attachment_type:"tmux",node_id:"node",binding_session:"seat@rig",pane,occupant}),all:()=>[{pane,occupant}]})} as unknown as Database.Database;
  const tmux={hasSession:async()=>true,probeSession:async()=>{probes++;return {state:"present"};},
    capturePaneContent:async(_session:string,lines:number)=>{captures++;hook();return lines===20?"idle\n❯ ":++verify%2?"before\n❯ ":"before\nhello world\n❯ ";},
    sendText:async()=>{pastes++;return {ok:true};},sendKeys:async()=>{enters++;return {ok:true};},getPaneCommand:async()=>null} as unknown as TmuxAdapter;
  const transport=new SessionTransport({db,rigRepo:{},sessionRegistry:{},tmuxAdapter:tmux,captureObserver:capture?.observer,sleep:async()=>{}} as unknown as ConstructorParameters<typeof SessionTransport>[0]);
  return {db,tmux,transport,mutate:()=>{pane="%99";occupant="new";},setHook:(fn:()=>void)=>{hook=fn;},counts:()=>({probes,captures,pastes,enters})};
}
describe("默认禁用的生产 observer port",()=>{
  it("stop 立即禁用 capture，一次性 flush 保留的 active/queued row，并保留普通 send",async()=>{
    const rows:Observation[]=[];let release!:()=>void, entered!:()=>void, closes=0;
    const started=new Promise<void>(r=>{entered=r;});
    const shadow=new ShadowCapture(config,async()=>({append:async text=>{if(!rows.length){entered();await new Promise<void>(r=>{release=r;});} rows.push(JSON.parse(text));},close:async()=>{closes++;}}));
    const f=terminal(shadow);await f.transport.send("seat@rig","hello world",{verify:true});
    const draining=shadow.drain();await started;
    await f.transport.send("seat@rig","hello world",{verify:true});
    expect(shadow.status().observer.recorded).toBe(4);
    const stop=shadow.stop();expect(shadow.status().enabled).toBe(false);
    expect((await f.transport.send("seat@rig","hello world",{verify:true})).outcome).toBe("delivered");
    expect(shadow.status().observer.recorded).toBe(4);release();await draining;
    const status=await stop;expect(status.observer.queued).toBe(0);expect(rows).toHaveLength(4);expect(closes).toBe(1);
    expect(status.sink).toMatchObject({completedRecords:4,dropped:0,stopped:true});
    expect(await shadow.stop()).toEqual(status);expect(closes).toBe(1);
  });
  it("公开 stop 要求 actor、drain 已保留 observation，且无法启用不存在的 collector",async()=>{
    const rows:Observation[]=[];const shadow=new ShadowCapture(config,async()=>({append:async text=>{rows.push(JSON.parse(text));},close:async()=>{}}));
    const f=terminal(shadow);await f.transport.send("seat@rig","hello world",{verify:true});
    const app=new Hono();app.use("*",async(c,next)=>{c.set("shadowCapture" as never,shadow);await next();});app.route("/",projectsRoutes());
    expect((await app.request("/shadow/stop",{method:"POST"})).status).toBe(400);expect(shadow.status().enabled).toBe(true);
    const response=await app.request("/shadow/stop",{method:"POST",headers:{"x-openrig-session":"fixture@rig"}});
    expect(await response.json()).toMatchObject({enabled:false,sink:{completedRecords:2,stopped:true}});expect(rows).toHaveLength(2);
    const absent=new Hono().route("/",projectsRoutes());
    expect(await(await absent.request("/shadow/stop",{method:"POST",headers:{"x-openrig-session":"fixture@rig"}})).json()).toEqual({enabled:false,error:null});
  });
  it("缺失/无效 opt-in 不产生 collector 或 sink，且不影响 send",async()=>{
    expect(configureShadowCapture(undefined)).toEqual({});
    expect(configureShadowCapture(JSON.stringify({...config,maxBytes:Infinity})).capture).toBeUndefined();
    expect(configureShadowCapture(JSON.stringify({...config,destination:"relative"})).capture).toBeUndefined();
    const valid=configureShadowCapture(JSON.stringify(config));expect(valid.capture?.status().sink.reservedRecords).toBe(0);
    const f=terminal();expect((await f.transport.send("seat@rig","hello world",{verify:true})).outcome).toBe("delivered");
    expect(f.counts()).toMatchObject({captures:3,pastes:1});
    expect(inventoryCaptureOptions(f.db,undefined)).toEqual({});
  });
  it("transport entry 在 await 前 snapshot node/occupant/pane，且只使用已有 capture",async()=>{
    const rows:Observation[]=[];
    const shadow=new ShadowCapture(config,async()=>({append:async text=>{rows.push(JSON.parse(text));},close:async()=>{}}));
    const f=terminal(shadow);f.setHook(f.mutate);
    expect((await f.transport.send("seat@rig","hello world",{verify:true})).outcome).toBe("delivered");
    expect(rows).toHaveLength(0);await shadow.drain();
    expect(f.counts()).toMatchObject({captures:3,pastes:1});
    expect(rows).toHaveLength(2);
    for(const row of rows)expect(row.binding).toEqual({sessionName:"seat@rig",nodeId:"node",occupant:"old",pane:"%7"});
    expect(rows.find(x=>x.seam==="send_verify")!.regexResult).toMatchObject({outcome:"delivered"});
  });
  it("独立 inventory probe 使用相同 entry snapshot；低成本 inventory 不执行 capture",async()=>{
    const rows:Observation[]=[];const shadow=new ShadowCapture(config,async()=>({append:async text=>{rows.push(JSON.parse(text));},close:async()=>{}}));
    const f=terminal(shadow);let release!:(x:boolean)=>void;
    f.tmux.hasSession=()=>new Promise(resolve=>{release=resolve;});
    const entry={nodeId:"node",canonicalSessionName:"seat@rig",runtime:"codex",attachmentType:"tmux"} as NodeInventoryEntry;
    const options={tmuxAdapter:f.tmux,...inventoryCaptureOptions(f.db,shadow)};
    await attachAgentActivity([entry],options);expect(f.counts().captures).toBe(0);
    const pending=attachAgentActivity([entry],{...options,captureFallback:true});
    entry.canonicalSessionName="successor@rig";entry.nodeId="new-node";f.mutate();release(true);await pending;await shadow.drain();
    expect(f.counts().captures).toBe(1);expect(rows[0]!.binding).toEqual({sessionName:"seat@rig",nodeId:"node",occupant:"old",pane:"%7"});
  });
  it.each(["slow","error","full","bytes"])("%s sink 不能延迟或决定 send；loss 保持计数",async(kind)=>{
    let release!:()=>void, entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    const shadow=new ShadowCapture({...config,capacity:2,maxRecords:kind==="full"?1:10,maxObservationBytes:kind==="bytes"?10:10000},async()=>({
      append:async()=>{entered();if(kind==="error")throw Error("sink failed");if(kind==="slow")await new Promise<void>(resolve=>{release=resolve;});},close:async()=>{}}));
    const f=terminal(shadow);await f.transport.send("seat@rig","hello world",{verify:true});
    const drain=shadow.drain();
    if(kind==="slow")await started;
    const result=await f.transport.send("seat@rig","hello world",{verify:true});
    expect(result.outcome).toBe("delivered");expect(f.counts()).toMatchObject({pastes:2,captures:6});
    if(kind==="slow"){
      expect(shadow.status().observer.drainingBytes).toBeGreaterThan(0);
      // 只允许一个 pending drain；下一次 send 的 overflow 不能产生另一 sink 调用。
      await shadow.drain();await f.transport.send("seat@rig","hello world",{verify:true});
      expect(shadow.status().observer.dropped).toBeGreaterThan(0);
      release();
      // retained batch 有两行。第二次 append 也必须 release。
      await new Promise(resolve=>setTimeout(resolve,0));release();
    }
    await drain;
    if(kind==="error")expect(shadow.status()).toMatchObject({sink:{errors:1,stopped:true},observer:{consumerFailures:1}});
    if(kind==="full")expect(shadow.status().sink).toMatchObject({reservedRecords:1,dropped:1});
    if(kind==="bytes")expect(shadow.status().observer).toMatchObject({recorded:0,dropped:4});
  });
  it("HTTP drain 独立存在，无法启用 capture，要求 actor，并报告 sink error",async()=>{
    const shadow=new ShadowCapture(config,async()=>{throw Error("private destination unavailable");});
    const f=terminal(shadow);await f.transport.send("seat@rig","hello world",{verify:true});
    const app=new Hono();app.use("*",async(c,next)=>{c.set("shadowCapture" as never,shadow);await next();});app.route("/",projectsRoutes());
    expect((await app.request("/shadow/drain",{method:"POST"})).status).toBe(400);
    const r=await app.request("/shadow/drain",{method:"POST",headers:{"x-openrig-session":"fixture@rig"}});
    expect((await r.json()).sink).toMatchObject({errors:1,stopped:true,error:"private destination unavailable"});
    const disabled=new Hono().route("/",projectsRoutes());expect((await disabled.request("/shadow")).status).toBe(200);
    expect(await(await disabled.request("/shadow")).json()).toEqual({enabled:false,error:null});
  });
  it("private sink 只写入合成 observation，并拒绝已有或非私有 destination",async()=>{
    const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"shadow-private-")));
    const destination=path.join(dir,"new.jsonl");
    const capture=new ShadowCapture({...config,destination,maxRecords:1});
    await terminal(capture).transport.send("seat@rig","hello world",{verify:true});await capture.drain();
    expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
    const bytes=fs.readFileSync(destination,"utf8");expect(bytes.trim().split("\n")).toHaveLength(1);
    expect(capture.status().sink).toMatchObject({reservedRecords:1,completedRecords:1,dropped:1,stopped:true});
    const existing=new ShadowCapture({...config,destination});
    await terminal(existing).transport.send("seat@rig","hello world",{verify:true});await existing.drain();
    expect(existing.status().sink.errors).toBe(1);expect(fs.readFileSync(destination,"utf8")).toBe(bytes);
    const shared=path.join(dir,"shared");fs.mkdirSync(shared,{mode:0o755});
    const rejected=new ShadowCapture({...config,destination:path.join(shared,"no.jsonl")});
    await terminal(rejected).transport.send("seat@rig","hello world",{verify:true});await rejected.drain();
    expect(rejected.status().sink.errors).toBe(1);expect(fs.existsSync(path.join(shared,"no.jsonl"))).toBe(false);
  });
});

it("async classifier deadline 如实反映未取消 work；无第二次调用或迟到写入",async()=>{
  let release!:(d:ClassificationDecision)=>void,calls=0,writes=0;
  const now=new Date(),lease={leaseId:"l",lastHeartbeat:now.toISOString(),expiresAt:new Date(now.getTime()+90000).toISOString()};
  const options={session:"seat@rig",classifierVersion:"v",taxonomyVersion:"t",evidenceEpoch:"owner",requestTimeoutMs:5,
    candidates:{version:"c",values:{classificationType:[],classificationUrgency:[],classificationMaturity:[],classificationConfidence:[],classificationDestination:[],area:[],scopeRef:[]},duplicateCandidates:[],relatedRefs:[]},
    leases:{evaluateDeadness:async()=>null,acquire:async()=>lease,requireActiveHolder:async()=>lease,heartbeat:async()=>lease},
    attempts:{eligible:async()=>({items:[{streamItemId:"one"}],nextAfterSortKey:null}),begin:async()=>({attemptId:"a",executionId:"e",leaseId:"l"}),fail:async()=>({status:"retryable"})},
    stream:{getById:async()=>({streamItemId:"one",body:"text"})},classifier:{classify:async()=>{writes++;}},
    classify:async()=>{calls++;return new Promise<ClassificationDecision>(resolve=>{release=resolve;});}} as unknown as WorkerOptions;
  const worker=new StreamClassificationWorker(options);
  expect((await worker.wake()).outcomes[0]!.status).toBe("retryable");
  expect((await worker.wake()).state).toBe("classifier_pending");expect(calls).toBe(1);
  release({kind:"classify",labels:{}});await new Promise(resolve=>setTimeout(resolve,0));expect(writes).toBe(0);
});
