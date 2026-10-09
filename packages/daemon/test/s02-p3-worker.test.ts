import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { world, V, C } from "./helpers/s02-worker-world.js";
import { periodicReminderPolicy } from "../src/domain/policies/periodic-reminder.js";
import type { ClassificationDecision, ClassificationRequest } from "../src/domain/stream-classification-worker.js";

describe("S02 P3 有界 offline worker",()=>{
  let w: ReturnType<typeof world>;
  beforeEach(()=>{w=world();});
  afterEach(()=>{w.db.close();vi.useRealTimers();});
  it("合并 notification overflow、处理有界 page，并在无 cursor 时恢复延迟/乱序 insert",async()=>{
    for(let i=0;i<11;i++)w.seed(`item-${i}`);
    w.stream.archive("item-3");
    const classify=vi.fn(async()=>({kind:"classify" as const,labels:{needsHuman:null}}));
    const worker=w.worker({classify});
    for(let i=0;i<10000;i++)worker.notify();
    const first=await worker.wake();expect(first.outcomes).toHaveLength(3);expect(first.moreEligible).toBe(true);
    w.seed("late");w.db.prepare("UPDATE stream_items SET ts_emitted='2000-01-01T00:00:00Z' WHERE stream_item_id='late'").run();
    for(let i=0;i<4;i++)expect((await worker.wake()).outcomes.length).toBeLessThanOrEqual(3);
    expect(classify).toHaveBeenCalledTimes(11);
    expect(w.classifier.getByStreamItemId("late")).not.toBeNull();
    expect(w.classifier.getByStreamItemId("item-3")).toBeNull();
    expect((await worker.wake()).outcomes).toEqual([]);
  });
  it("live subscription 只提供提示；classification 期间的 insert 会被后续 durable wake 捕获",async()=>{
    w.seed("first");let release!:(d:ClassificationDecision)=>void;let ready!:()=>void;
    const started=new Promise<void>(r=>ready=r);
    const worker=w.worker({classify:()=>{ready();return new Promise(r=>release=r);}});
    const unsubscribe=worker.subscribe(w.bus);
    const run=worker.wake();await started;w.seed("during");release({kind:"classify",labels:{}});
    expect((await run).moreEligible).toBe(true);unsubscribe();
    expect((await w.worker().wake()).outcomes.map(x=>x.streamItemId)).toEqual(["during"]);
  });
  it("并发的首个 writer 获胜，不 replay 或覆盖其结果",async()=>{
    w.seed("a");
    const worker=w.worker({classify:async r=>{
      w.classifier.classify({streamItemId:"a",leaseId:r.attempt.leaseId,classifierSession:"worker@rig",classificationType:"lesson"});
      return {kind:"classify",labels:{classificationType:"question"}};
    }});
    expect((await worker.wake()).outcomes[0]?.status).toBe("idempotency_violation");
    expect(w.classifier.getByStreamItemId("a")?.classificationType).toBe("lesson");
    expect((await worker.wake()).outcomes).toEqual([]);
  });
  it("评估 dead lease，但遇到 live holder 时退避，不进行 hot reacquisition",async()=>{
    w.seed("a");w.leases.acquire("other@rig");
    const evaluate=vi.spyOn(w.leases,"evaluateDeadness");
    const worker=w.worker();
    expect((await worker.wake()).state).toBe("lease_lost");
    for(let i=0;i<5;i++)expect((await worker.wake()).state).toBe("lease_backoff");
    expect(evaluate).toHaveBeenCalledTimes(1);
    w.clock.ms+=90_001;
    expect((await worker.wake()).outcomes[0]?.status).toBe("written");
    expect(w.leases.getActiveLease()?.classifierSession).toBe("worker@rig");
  });
  it("使用既有 periodic-reminder shape，并在 wake 时按 TTL/3 heartbeat，不执行注册",async()=>{
    const heartbeat=vi.spyOn(w.leases,"heartbeat");const worker=w.worker();
    await worker.wake();
    const job=worker.wakeRegistration("owner@rig","generation");
    expect(job.policy).toBe("periodic-reminder");expect(job.intervalSeconds).toBe(30);
    expect(job.targetGenerationUuid).toBe("generation");
    const result=await periodicReminderPolicy.evaluate(JSON.parse(job.specYaml));
    expect(result).toMatchObject({action:"send",target:{session:"worker@rig"}});
    w.clock.ms+=30_000;await worker.wake();expect(heartbeat).toHaveBeenCalledTimes(1);
    w.clock.ms+=90_001;expect((await worker.wake()).state).toBe("lease_lost");
    expect(heartbeat).toHaveBeenCalledTimes(1); // 不复活已过期项
  });
  it.each(["expiry","replacement"])("classification 期间发生 %s 会停止写入并保留未完成 attempt",async mode=>{
    w.seed("a");let release!: (d:ClassificationDecision)=>void;let ready!:()=>void;
    const started=new Promise<void>(r=>ready=r);
    const worker=w.worker({classify:()=>{ready();return new Promise(r=>release=r);}});
    const run=worker.wake();await started;
    if(mode==="expiry")w.clock.ms+=90_001;else {w.leases.reclaim("owner@rig");w.leases.acquire("worker@rig");}
    release({kind:"classify",labels:{needsHuman:false}});
    expect((await run).state).toBe("lease_lost");
    expect(w.classifier.getByStreamItemId("a")).toBeNull();
    expect(w.db.prepare("SELECT status FROM classification_attempts").get()).toEqual({status:"in_flight"});
  });
  it.each(["classify","abstain","error"])("隔离延迟的 %s result，防止覆盖同一 lease 下更新的 execution",async kind=>{
    w.seed("a");let resolve!: (d:ClassificationDecision)=>void;let reject!: (e:Error)=>void;let request!:ClassificationRequest;let ready!:()=>void;
    const started=new Promise<void>(r=>ready=r);
    const worker=w.worker({classify:r=>{request=r;ready();return new Promise((a,b)=>{resolve=a;reject=b;});}});
    const run=worker.wake();await started;w.clock.ms+=4_001;
    const next=w.attempts.begin({...V,streamItemId:"a",leaseId:request.attempt.leaseId,classifierSession:"worker@rig"});
    if(kind==="error")reject(Error("late failure"));else resolve(kind==="abstain"?{kind,reason:"unclear"}:{kind:"classify",labels:{}});
    expect((await run).outcomes[0]?.status).toBe("attempt_superseded");
    expect(w.attempts.getById(next.attemptId)).toMatchObject({executionId:next.executionId,status:"in_flight"});
    expect(w.classifier.getByStreamItemId("a")).toBeNull();
  });
  it("error 与 abandoned inflight run 在重启后按有限 retry budget 恢复",async()=>{
    w.seed("error");let calls=0;
    const factory=()=>w.worker({classify:async()=>{calls++;throw Error("offline classifier unavailable");}});
    expect((await factory().wake()).outcomes[0]?.status).toBe("error");
    expect((await factory().wake()).outcomes).toHaveLength(0);
    w.clock.ms+=1_000;expect((await factory().wake()).outcomes[0]?.status).toBe("error");
    w.clock.ms+=2_000;expect((await factory().wake()).outcomes[0]?.status).toBe("exhausted");
    w.clock.ms+=9_000;expect((await factory().wake()).outcomes).toHaveLength(0);expect(calls).toBe(3);
    w.seed("crash");const lease=w.leases.getActiveLease()!;
    w.attempts.begin({...V,streamItemId:"crash",leaseId:lease.leaseId,classifierSession:"worker@rig"});
    expect((await w.worker().wake()).outcomes).toHaveLength(0);
    w.clock.ms+=4_001;expect((await w.worker().wake()).outcomes[0]?.status).toBe("written");
    expect(w.db.prepare("SELECT attempt_count FROM classification_attempts WHERE stream_item_id='crash'").get()).toEqual({attempt_count:2});
  });
  it("再次调用 classifier 前耗尽重复 abandoned execution",async()=>{
    w.seed("abandoned");const lease=w.leases.acquire("worker@rig");
    for(let i=0;i<3;i++) {
      w.attempts.begin({...V,streamItemId:"abandoned",leaseId:lease.leaseId,classifierSession:"worker@rig"});
      w.clock.ms+=4_001;
    }
    const classify=vi.fn();
    expect((await w.worker({classify}).wake()).outcomes[0]?.status).toBe("attempt_exhausted");
    expect(classify).not.toHaveBeenCalled();
    expect(w.db.prepare("SELECT status,attempt_count FROM classification_attempts").get()).toEqual({status:"exhausted",attempt_count:3});
    expect((await w.worker({classify}).wake()).outcomes).toEqual([]);
  });
  it("terminal abstention 精确绑定 version 与 epoch，而非不可变 classification",async()=>{
    w.seed("a");const classify=vi.fn(async()=>({kind:"abstain" as const,reason:"indeterminate"}));
    const worker=w.worker({classify});await worker.wake();await worker.wake();expect(classify).toHaveBeenCalledTimes(1);
    await w.worker({classify,evidenceEpoch:"changed-evidence:sha256:new"}).wake();
    await w.worker({classify,classifierVersion:"new"}).wake();
    await w.worker({classify,taxonomyVersion:"new"}).wake();expect(classify).toHaveBeenCalledTimes(4);
    expect(w.classifier.getByStreamItemId("a")).toBeNull();
  });
  it("deadline 会返回，不堆积被忽略的 cancellation，也绝不写入迟到 result",async()=>{
    vi.useFakeTimers();w.seed("a");let release!:(d:ClassificationDecision)=>void;
    const classify=vi.fn((_r,signal:AbortSignal)=>new Promise<ClassificationDecision>(r=>{release=r;}));
    const worker=w.worker({classify,requestTimeoutMs:10});const run=worker.wake();
    await vi.advanceTimersByTimeAsync(10);expect((await run).outcomes[0]?.status).toBe("error");
    expect(classify.mock.calls[0]![1].aborted).toBe(true);
    for(let i=0;i<5;i++)expect((await worker.wake()).state).toBe("classifier_pending");
    expect(classify).toHaveBeenCalledTimes(1);release({kind:"classify",labels:{}});await Promise.resolve();await Promise.resolve();
    expect(w.classifier.getByStreamItemId("a")).toBeNull();
  });
  it("重叠 wake 不做重复工作，classifier 无法修改 request identity/candidate",async()=>{
    w.seed("a");let release!:(d:ClassificationDecision)=>void;let ready!:()=>void;
    const started=new Promise<void>(r=>ready=r);
    const candidates=structuredClone(C);
    const worker=w.worker({candidates,classify:r=>{
      expect(()=>{(r.attempt as {executionId:string}).executionId="wrong";}).toThrow();
      expect(()=>{(r.candidates.values.scopeRef as string[]).push("qitem-wrong");}).toThrow();
      expect(r.candidates.values.scopeRef).toEqual(["OPR.0.6.0.2"]);ready();return new Promise(a=>release=a);
    }});
    candidates.values.scopeRef=[];const run=worker.wake();await started;
    expect((await worker.wake()).state).toBe("busy");release({kind:"classify",labels:{scopeRef:"OPR.0.6.0.2"}});await run;
    expect(w.classifier.getByStreamItemId("a")).toMatchObject({scopeRef:"OPR.0.6.0.2",candidateSetVersion:C.version,identityProvenance:"claimed:v1"});
  });
  it("null 保持 unknown，ref 不能变成 scope，duplicate 需要正向 evidence",async()=>{
    w.seed("original");w.seed("a");w.seed("b");
    const candidates=structuredClone(C);candidates.duplicateCandidates=[{streamItemId:"original",evidenceRef:"comparison:1"}];
    await w.worker({candidates,classify:async r=>({kind:"classify",labels:r.item.streamItemId==="a"?{scopeRef:"qitem-related"}:r.item.streamItemId==="b"?{duplicateOfStreamItemId:"original"}:{needsHuman:null}})}).wake();
    expect(w.classifier.getByStreamItemId("original")?.needsHuman).toBeNull();
    expect(w.classifier.getByStreamItemId("a")).toBeNull();expect(w.classifier.getByStreamItemId("b")).toBeNull();
    w.clock.ms+=1_000;
    await w.worker({candidates,classify:async()=>({kind:"classify",labels:{duplicateOfStreamItemId:"original",duplicateEvidenceRef:"comparison:1",needsHuman:false}})}).wake();
    expect(w.classifier.getByStreamItemId("b")).toMatchObject({duplicateOfStreamItemId:"original",needsHuman:false});
  });
  it.each([NaN,Infinity,0,-1,1.2,101])("开始工作前拒绝无界 page size %s",pageSize=>{
    expect(()=>w.worker({pageSize})).toThrow();expect(w.leases.getActiveLease()).toBeNull();
  });
});
