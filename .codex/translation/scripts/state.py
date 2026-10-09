#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Thread-safe per-file status updater for the openrig translation ledger.

Design:
- Canonical ledger = .codex/translation/plan.md (rollup, rebuilt from shards).
- Per-owner shards = .codex/translation/manifests/<owner>.json. Each owner owns a
  DISJOINT file set, so cross-owner writes never conflict.
- A per-shard file lock (fcntl.flock on manifests/<owner>.json.lock) serializes
  read-modify-write for any concurrent command touching the same owner.
- After mutating a shard, rebuild plan.md (cheap) so the rollup stays authoritative.

Usage:
  state.py claim    <owner> <source_path>            # pending -> in_progress (fails if already taken)
  state.py done     <owner> <source_path> [note]     # -> done
  state.py fail     <owner> <source_path> [note]     # -> failed with reason
  state.py skip     <owner> <source_path> [note]     # -> skipped with reason
  state.py show     [owner]                           # print progress summary
  state.py rebuild                                    # regenerate plan.md rollup from shards
"""
import sys, os, json, fcntl, subprocess

ROOT="/Users/bytedance/openrig"
MAN=os.path.join(ROOT,".codex/translation/manifests")
PLAN=os.path.join(ROOT,".codex/translation/plan.md")
PLAN_LOCK=os.path.join(ROOT,".codex/translation/.plan.lock")
RECORDS=os.path.join(ROOT,".codex/translation/_records.json")

def shard_path(owner): return os.path.join(MAN, f"{owner}.json")
def lock_path(owner):  return os.path.join(MAN, f"{owner}.json.lock")

def load(owner):
    with open(shard_path(owner)) as f:
        return json.load(f)
def save(owner, data):
    tmp=shard_path(owner)+".tmp"
    with open(tmp,"w") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, shard_path(owner))

def find(data, src):
    for f in data["files"]:
        if f["source_path"]==src: return f
    return None

def rebuild():
    rows=[]
    for fn in sorted(os.listdir(MAN)):
        if not fn.endswith(".json"): continue
        d=json.load(open(os.path.join(MAN,fn)))
        owner=fn[:-5]
        for f in d["files"]:
            rows.append((owner,f))
    def rank(o):
        order=["entry","cli-a","cli-b","cli-core-a","cli-core-b","tui","ui-a","ui-b","ui-c",
               "daemon-api","daemon-runtime","daemon-content"]
        if o in order: return (0,order.index(o))
        if o.startswith("daemon-core-"): return (1,o)
        if o.startswith("docs-"): return (2,o)
        if o=="extras": return (3,o)
        return (4,o)
    rows.sort(key=lambda t:(rank(t[0]), t[1]["source_path"]))
    L=["# openrig 全量中文化权威台账 (plan.md)","",
       "- 基线: git HEAD `57380a25` (git clean)；规范: `.codex/translation/style-spec.md`",
       "- 状态机: pending -> in_progress -> done | failed | skipped。用 scripts/state.py 更新。",
       "- 真源: 本文件由 manifests/<owner>.json 分片重建；owner 互斥独占。","",
       "## 进度总览","","| owner | total | pending | in_progress | done | failed | skipped |",
       "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
    from collections import Counter
    owners=sorted(set(o for o,_ in rows), key=rank)
    for o in owners:
        c=Counter(f["status"] for oo,f in rows if oo==o)
        L.append(f"| {o} | {sum(c.values())} | {c.get('pending',0)} | {c.get('in_progress',0)} | {c.get('done',0)} | {c.get('failed',0)} | {c.get('skipped',0)} |")
    L+=["","## 逐文件台账","","| owner | source_path | target_path | category | status | notes |",
        "| --- | --- | --- | --- | --- | --- |"]
    for o,f in rows:
        note=str(f.get("notes","")).replace("|","\\|")
        tgt=f.get("target_path") or "—"
        L.append(f"| {o} | {f['source_path']} | {tgt} | {f['category']} | {f['status']} | {note} |")
    # `_records.json` 是初始化扫描器产出的扁平状态视图。manifests 才是状态真源，
    # 因此每次重建时按 source_path 回填状态、归属和说明；若两边文件集合漂移，
    # 直接失败，避免静默丢行或把过期 pending 重新冒充当前状态。
    records=json.load(open(RECORDS))
    by_source={f["source_path"]:(owner,f) for owner,f in rows}
    record_sources={r["source"] for r in records}
    manifest_sources=set(by_source)
    if record_sources != manifest_sources:
        missing=sorted(manifest_sources-record_sources)
        extra=sorted(record_sources-manifest_sources)
        raise RuntimeError(f"_records/manifests source drift: missing={missing[:5]} extra={extra[:5]}")
    for record in records:
        owner,item=by_source[record["source"]]
        record["status"]=item["status"]
        record["target"]=item.get("target_path") or ""
        record["category"]=item["category"]
        record["owner"]=owner
        record["note"]=item.get("notes","")
        for key in ("validation_state","reason_class"):
            if key in item: record[key]=item[key]
            else: record.pop(key,None)

    # 全局锁 + 唯一临时文件 + 原子替换：plan.md 与 _records.json 不会并发写坏。
    lp=open(PLAN_LOCK,"w"); fcntl.flock(lp, fcntl.LOCK_EX)
    try:
        tmp=f"{PLAN}.{os.getpid()}.{id(L)}.tmp"
        with open(tmp,"w") as f: f.write("\n".join(L)+"\n")
        records_tmp=f"{RECORDS}.{os.getpid()}.{id(records)}.tmp"
        with open(records_tmp,"w") as f: json.dump(records,f,ensure_ascii=False,indent=2)
        os.replace(tmp, PLAN)
        os.replace(records_tmp, RECORDS)
    finally:
        fcntl.flock(lp, fcntl.LOCK_UN); lp.close()

def with_lock(owner, fn):
    fp=open(lock_path(owner),"w")
    fcntl.flock(fp, fcntl.LOCK_EX)
    try:
        return fn()
    finally:
        fcntl.flock(fp, fcntl.LOCK_UN); fp.close()

REASON_CLASSES={"uncovered","translation_error","baseline_test_failure","new_regression","needs_review"}

def cmd_claim(owner, src, reopen=False):
    def w():
        d=load(owner); f=find(d,src)
        if not f: return f"ERROR: {src} not owned by {owner}"
        if f["status"]=="done": return f"ERROR: {src} already done (self-reported; use set-validation to mark validated)"
        if f["status"]=="skipped": return f"ERROR: {src} already skipped"
        if f["status"]=="in_progress": return f"ERROR: {src} already in_progress"
        if f["status"]=="failed" and not reopen:
            return f"ERROR: {src} failed; use reopen <owner> <src> <reason_class> first, or claim --reopen"
        f["status"]="in_progress"; save(owner,d); rebuild()
        return f"claimed{'(reopened)' if reopen else ''} {owner} {src}"
    return with_lock(owner,w)

TERMINAL={"done":"done","fail":"failed","skip":"skipped"}

def cmd_set(owner, src, cmd, note, reason_class=None):
    status=TERMINAL[cmd]   # map fail->failed, skip->skipped
    def w():
        d=load(owner); f=find(d,src)
        if not f: return f"ERROR: {src} not owned by {owner}"
        f["status"]=status
        if reason_class:
            if reason_class not in REASON_CLASSES: return f"ERROR: bad reason_class {reason_class}; allowed {sorted(REASON_CLASSES)}"
            f["reason_class"]=reason_class
        if status=="done" and "validation_state" not in f:
            f["validation_state"]="self_reported"
        if note: f["notes"]=(f.get("notes","")+" | "+note)
        save(owner,d); rebuild()
        return f"{status} {owner} {src}"
    return with_lock(owner,w)

def cmd_reopen(owner, src, reason_class):
    if reason_class not in REASON_CLASSES:
        return f"ERROR: bad reason_class {reason_class}; allowed {sorted(REASON_CLASSES)}"
    def w():
        d=load(owner); f=find(d,src)
        if not f: return f"ERROR: {src} not owned by {owner}"
        if f["status"]!="failed": return f"ERROR: {src} is {f['status']}; reopen only from failed"
        f["status"]="pending"; f["reason_class"]=reason_class; save(owner,d); rebuild()
        return f"reopened(failed->pending,{reason_class}) {owner} {src}"
    return with_lock(owner,w)

def cmd_validation(owner, src, state):
    def w():
        d=load(owner); f=find(d,src)
        if not f: return f"ERROR: {src} not owned by {owner}"
        f["validation_state"]=state; save(owner,d); rebuild()
        return f"validation_state={state} {owner} {src}"
    return with_lock(owner,w)

def cmd_show(owner=None):
    from collections import Counter
    for fn in sorted(os.listdir(MAN)):
        if not fn.endswith(".json"): continue
        o=fn[:-5]
        if owner and o!=owner: continue
        d=json.load(open(os.path.join(MAN,fn)))
        c=Counter(f["status"] for f in d["files"])
        print(f"{o:22} total={len(d['files']):4} pending={c.get('pending',0):4} in_progress={c.get('in_progress',0):3} done={c.get('done',0):4} failed={c.get('failed',0):3} skipped={c.get('skipped',0):3}")

if __name__=="__main__":
    a=sys.argv
    if len(a)<2: print(__doc__); sys.exit(1)
    c=a[1]
    msg=""
    try:
        if c=="claim":
            reopen = "--reopen" in a
            src = a[3]; msg=cmd_claim(a[2], src, reopen=reopen)
        elif c=="done":
            msg=cmd_set(a[2],a[3],"done"," ".join(a[4:]))
        elif c=="fail":
            rc=a[4] if len(a)>4 and a[4] in REASON_CLASSES else None
            note=" ".join(a[5:] if rc else a[4:])
            msg=cmd_set(a[2],a[3],"fail",note,reason_class=rc)
        elif c=="skip":
            msg=cmd_set(a[2],a[3],"skip"," ".join(a[4:]))
        elif c=="reopen":
            msg=cmd_reopen(a[2],a[3],a[4] if len(a)>4 else "needs_review")
        elif c=="set-validation":
            msg=cmd_validation(a[2],a[3],a[4] if len(a)>4 else "self_reported")
        elif c=="show":
            cmd_show(a[2] if len(a)>2 else None); sys.exit(0)
        elif c=="rebuild":
            rebuild(); msg="rebuilt plan.md"
        else: print(__doc__); sys.exit(1)
    except Exception as e:
        print(f"ERROR: {e}"); sys.exit(2)
    print(msg)
    sys.exit(1 if str(msg).startswith("ERROR") else 0)
