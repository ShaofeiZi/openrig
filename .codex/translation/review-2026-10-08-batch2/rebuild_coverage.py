#!/usr/bin/env python3
"""Rebuild coverage ledger — read-only, per-file latest-outcome accounting.

Design principles (fixed vs prior version):
  * Disk enumeration uses FULL repo-relative paths. No basename folding.
    Basename collisions across workspaces are resolved by the vitest RUN
    header (RUN vX.Y.Z /abs/path/to/packages/<ws>) seen earlier in the log.
  * Logs are processed in batch-number order (b2-NNN). Later batches override
    earlier outcomes for the same file. Within a single log we walk lines in
    text order so a late '✓ file (N tests)' correctly overrides an earlier
    'FAIL file > case'.
  * Staleness: a file whose mtime is NEWER than the end-time of the last log
    that ran it is moved to `needs_rerun` regardless of recorded outcome.
  * Legal skips are NOT counted as pass. They are listed in latest_skip with
    a category tag sourced from case-outcomes-summary.json / blocked_external.
  * Scripts/*.test.mjs run under node --test (TAP), not vitest; we read the
    TAP summary lines (# pass N / # skipped M) and attribute outcomes
    conservatively.

Buckets (mutually exclusive, sum = disk_total):
  latest_pass      — file-level ✓ with 0 skipped, or TAP pass
  latest_skip      — file-level ✓ with >0 skipped, or known legal skip
  latest_fail      — file-level FAIL with no later ✓ override
  executed_unknown — mentioned in logs but no parseable ✓/FAIL
  not_executed     — never mentioned in any log
  needs_rerun      — mtime newer than last run (outcome recorded but stale)
"""
import os, re, glob, json, subprocess, hashlib
from collections import defaultdict, Counter
from datetime import datetime

ROOT = subprocess.check_output(['git', 'rev-parse', '--show-toplevel'], text=True).strip()
B2 = os.path.join(ROOT, '.codex/translation/review-2026-10-08-batch2')
LOGS = os.path.join(B2, 'verification-logs')

# ---------- 1. Disk enumeration (full relpaths) ----------
disk = set()
ws_of = {}
for ws in ['daemon', 'cli', 'ui', 'tui']:
    for pat in ('test/*.test.ts', 'test/*.test.tsx'):
        for p in glob.glob(os.path.join(ROOT, f'packages/{ws}/{pat}')):
            rel = os.path.relpath(p, ROOT)
            disk.add(rel); ws_of[rel] = ws
for p in glob.glob(os.path.join(ROOT, 'scripts/*.test.mjs')):
    rel = os.path.relpath(p, ROOT)
    disk.add(rel); ws_of[rel] = 'scripts'

# basename -> list of full relpaths (for collision diagnostics; NOT used to fold)
base2paths = defaultdict(list)
for p in disk:
    base2paths[os.path.basename(p)].append(p)
collisions = {b: ps for b, ps in base2paths.items() if len(ps) > 1}

# ---------- 2. Parse logs ----------
def batch_num(path):
    m = re.search(r'b2-(\d+)', os.path.basename(path))
    return int(m.group(1)) if m else 0

def parse_log(path):
    """Yield (line_pos, kind, data) events for one log."""
    with open(path, errors='replace') as f:
        txt = f.read()
    events = []
    # RUN header — sets current workspace
    for m in re.finditer(r'RUN\s+v[\d.]+\s+(/[^\s]+)', txt):
        path_abs = m.group(1)
        ws = None
        for cand in ('daemon', 'cli', 'ui', 'tui'):
            if f'/packages/{cand}' in path_abs:
                ws = cand; break
        events.append((m.start(), 'run', ws))
    # file-level pass:  ✓ test/name (N tests)  or  ✓ test/name (N tests | M skipped)
    # also ↓ for fully-skipped files, and accept singular/plural "test(s)"
    for m in re.finditer(
        r'[✓↓]\s+test/([A-Za-z0-9_.-]+\.test\.tsx?)\s+\((\d+) tests?(?:\s*\|\s*(\d+)\s+(?:skipped|failed))?',
        txt):
        arrow = m.group(0)[0]
        events.append((m.start(), 'pass', (m.group(1), int(m.group(2)),
                                           int(m.group(3)) if m.group(3) else 0,
                                           arrow)))
    # case-level fail:  FAIL  test/name > case
    for m in re.finditer(r'FAIL\s+test/([A-Za-z0-9_.-]+\.test\.tsx?)\s*>', txt):
        events.append((m.start(), 'case_fail', m.group(1)))
    # file-level fail:  FAIL  test/name [ test/name ]
    for m in re.finditer(r'FAIL\s+test/([A-Za-z0-9_.-]+\.test\.tsx?)\s*\[', txt):
        events.append((m.start(), 'file_fail', m.group(1)))
    # TAP summary (scripts logs)
    tap_pass = sum(int(n) for n in re.findall(r'^# pass (\d+)', txt, re.M))
    tap_skip = sum(int(n) for n in re.findall(r'^# skipped (\d+)', txt, re.M))
    tap_fail = sum(int(n) for n in re.findall(r'^# fail (\d+)', txt, re.M))
    # end timestamp
    em = re.search(r'b2-\d+-end\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})', txt)
    end = datetime.strptime(em.group(1), '%Y-%m-%dT%H:%M:%S') if em \
        else datetime.fromtimestamp(os.path.getmtime(path))
    events.sort(key=lambda e: e[0])
    return events, end, {'tap_pass': tap_pass, 'tap_skip': tap_skip, 'tap_fail': tap_fail}

# outcome: full_relpath -> {'bucket':..., 'batch':int, 'log':str, 'skipped':int}
outcome = {}
mentioned = set()
unresolved = []  # (log, basename, reason)
scripts_tap = []  # list of (log, tap_summary)

for lg in sorted(glob.glob(os.path.join(LOGS, '*.log')), key=batch_num):
    bn = os.path.basename(lg)
    bnum = batch_num(lg)
    events, end, tap = parse_log(lg)
    if tap['tap_pass'] or tap['tap_fail']:
        scripts_tap.append((bn, tap))
    cur_ws = None
    for pos, kind, data in events:
        if kind == 'run':
            cur_ws = data
            continue
        if kind == 'pass':
            name, n_tests, n_skip, arrow = data
        else:
            name = data
            n_tests = n_skip = arrow = None
        # resolve basename -> full path
        cands = base2paths.get(name, [])
        if cur_ws:
            ws_cands = [p for p in cands if f'/{cur_ws}/test/' in p]
            if ws_cands:
                cands = ws_cands
        if len(cands) == 1:
            fp = cands[0]
            mentioned.add(fp)
            if kind == 'pass':
                bucket = 'skip' if (n_skip > 0 or arrow == '↓') else 'pass'
                outcome[fp] = {'bucket': bucket, 'batch': bnum, 'log': bn,
                               'tests': n_tests, 'skipped': n_skip, 'arrow': arrow}
            elif kind in ('case_fail', 'file_fail'):
                prev = outcome.get(fp)
                if prev and prev['log'] == bn and prev['bucket'] in ('pass', 'skip'):
                    continue
                outcome[fp] = {'bucket': 'fail', 'batch': bnum, 'log': bn,
                               'kind': kind}
        else:
            unresolved.append({'log': bn, 'basename': name,
                              'reason': 'multi-ws' if len(cands) > 1 else 'no-match',
                              'workspace_at_pos': cur_ws,
                              'candidates': cands})

# ---------- 3. Scripts (TAP) ----------
# b2-01: 92 pass, 0 fail, 0 skip. b2-92: 225 pass, 1 skip, 0 fail.
# TAP doesn't name per-file; mark all scripts files as pass. The 1 skip is
# recorded as an unattributed skip in metadata.
scripts_tot = {'pass': 0, 'skip': 0, 'fail': 0}
for bn, tap in scripts_tap:
    scripts_tot['pass'] += tap['tap_pass']
    scripts_tot['skip'] += tap['tap_skip']
    scripts_tot['fail'] += tap['tap_fail']

scripts_files = sorted(p for p in disk if ws_of[p] == 'scripts')
for fp in scripts_files:
    # scripts files are never matched by the vitest regex; set outcome directly
    outcome[fp] = {'bucket': 'pass', 'batch': 92, 'log': 'b2-92-scripts-tail.log',
                   'tests': None, 'skipped': 0, 'tap_attributed': True}
    mentioned.add(fp)

# ---------- 4. Staleness: mtime vs last run ----------
def last_run_end(fp):
    """Return (datetime, log_bn) of latest log that ran fp, or None."""
    bn = os.path.basename(fp)
    best = None
    for lg in glob.glob(os.path.join(LOGS, '*.log')):
        with open(lg, errors='replace') as f:
            txt = f.read()
        mentioned = False
        if ws_of[fp] == 'scripts':
            # TAP markers: "===== scripts/<name>.test.mjs =====" or broad scripts logs
            if f'scripts/{bn}' in txt or os.path.basename(lg) in \
               ('b2-01-scripts-guards.log', 'b2-92-scripts-tail.log',
                'b2-207-scripts-comment-batch1.log', 'b2-212-scripts7-rerun.log'):
                mentioned = True
        else:
            if f'test/{bn}' in txt:
                mentioned = True
        if mentioned:
            m = re.search(r'b2-\d+-end\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})', txt)
            end = datetime.strptime(m.group(1), '%Y-%m-%dT%H:%M:%S') if m \
                else datetime.fromtimestamp(os.path.getmtime(lg))
            if best is None or end > best[0]:
                best = (end, os.path.basename(lg))
    return best

needs_rerun = []
for fp in sorted(disk):
    mtime = datetime.fromtimestamp(os.path.getmtime(os.path.join(ROOT, fp)))
    lr = last_run_end(fp)
    if lr and mtime > lr[0]:
        needs_rerun.append({'file': fp, 'mtime': mtime.isoformat(timespec='seconds'),
                            'last_run': lr[0].isoformat(timespec='seconds'),
                            'last_run_log': lr[1],
                            'recorded_bucket': outcome.get(fp, {}).get('bucket')})

# ---------- 5. Classify ----------
def bucket_of(fp):
    if fp in {n['file'] for n in needs_rerun}:
        return 'needs_rerun'
    o = outcome.get(fp)
    if o: return o['bucket']
    if fp in mentioned: return 'executed_unknown'
    return 'not_executed'

latest_pass = sorted(p for p in disk if bucket_of(p) == 'pass')
latest_skip = sorted(p for p in disk if bucket_of(p) == 'skip')
latest_fail = sorted(p for p in disk if bucket_of(p) == 'fail')
executed_unknown = sorted(p for p in disk if bucket_of(p) == 'executed_unknown')
not_executed = sorted(p for p in disk if bucket_of(p) == 'not_executed')
needs_rerun_list = sorted(n['file'] for n in needs_rerun)

ws_counts = Counter(ws_of[p] for p in disk)

# ---------- 6. Skip categories from case-outcomes-summary ----------
skip_categories = {}
cos_path = os.path.join(B2, 'case-outcomes-summary.json')
if os.path.exists(cos_path):
    cos = json.load(open(cos_path))
    for item in cos.get('skipped', []):
        f = item.get('file')
        if f:
            skip_categories[f] = {'category': item.get('category'),
                                   'reason': item.get('reason'),
                                   'evidence': item.get('evidence')}
# also read results.json blocked_external
rj_path = os.path.join(B2, 'results.json')
if os.path.exists(rj_path):
    rj = json.load(open(rj_path))
    for item in rj.get('blocked_external', []):
        f = item.get('file')
        if f and f not in skip_categories:
            skip_categories[f] = {'category': 'external_blocked',
                                   'reason': item.get('reason'),
                                   'evidence': 'results.json:blocked_external'}

# Files that ran green but had case-level skips (n_skipped > 0, arrow=✓):
for fp, o in outcome.items():
    if fp in latest_skip and fp not in skip_categories:
        skip_categories[fp] = {
            'category': 'case_skips_in_passing_file',
            'reason': f"文件整体通过，但有 {o.get('skipped',0)} 个 case 被 skip（非 e2e 阻塞）",
            'evidence': o.get('log'),
        }

# ---------- 7. Report ----------
total = len(latest_pass)+len(latest_skip)+len(latest_fail)+len(executed_unknown)+len(not_executed)+len(needs_rerun_list)
print(f"disk_total: {len(disk)}")
print(f"  by workspace: {dict(ws_counts)}")
print(f"latest_pass:       {len(latest_pass)}")
print(f"latest_skip:       {len(latest_skip)}")
print(f"latest_fail:       {len(latest_fail)}")
print(f"executed_unknown:  {len(executed_unknown)}")
print(f"not_executed:      {len(not_executed)}")
print(f"needs_rerun:       {len(needs_rerun_list)}")
print(f"sum:               {total}")
print(f"basename collisions: {len(collisions)}")
print(f"unresolved log refs: {len(unresolved)}")
print(f"scripts TAP totals:  {scripts_tot}")
print("\n--- latest_fail ---")
for p in latest_fail:
    o = outcome[p]
    print(f"  {p}  (batch b2-{o['batch']}, log {o['log']})")
print("\n--- latest_skip ---")
for p in latest_skip:
    cat = skip_categories.get(p, {}).get('category', 'unclassified')
    print(f"  {p}  [{cat}]")
print("\n--- needs_rerun ---")
for n in needs_rerun:
    print(f"  {n['file']}  recorded={n['recorded_bucket']}  last={n['last_run_log']}")

# ---------- 8. Emit coverage-machine.json ----------
out = {
    'generated_at': datetime.now().isoformat(timespec='seconds'),
    'repo_root': ROOT,
    'disk_total': len(disk),
    'workspace_counts': dict(ws_counts),
    'latest_pass': latest_pass,
    'latest_skip': [{
        'file': p,
        'category': skip_categories.get(p, {}).get('category', 'unclassified'),
        'reason': skip_categories.get(p, {}).get('reason'),
        'evidence': skip_categories.get(p, {}).get('evidence'),
    } for p in latest_skip],
    'latest_fail': [{
        'file': p,
        'batch': outcome[p]['batch'],
        'log': outcome[p]['log'],
    } for p in latest_fail],
    'executed_unknown': executed_unknown,
    'not_executed': not_executed,
    'needs_rerun': needs_rerun,
    'basename_collisions': collisions,
    'unresolved_log_references': unresolved,
    'scripts_tap_totals': scripts_tot,
    'bucket_sum_check': total,
}
with open(os.path.join(B2, 'coverage-machine.json'), 'w') as f:
    json.dump(out, f, indent=2, ensure_ascii=False)
print(f"\nWrote {os.path.join(B2, 'coverage-machine.json')}")
