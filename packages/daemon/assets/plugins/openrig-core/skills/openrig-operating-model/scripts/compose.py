#!/usr/bin/env python3
"""compose.py——从叶到根组合链并渲染子树。

SUPERSEDED FOR REFOCUS（重新聚焦场景已由其他实现取代）：公共核心重定向追踪位于
../../refocusing/scripts/trace-to-root.py。此通用组合器继续作为 down/progress 与历史 up
调用的兼容表面。

  up   <start-dir> --name FILE [--name FILE ...] [--root DIR]
       从 start-dir 向上遍历到根目录（默认在含 .compose-root 的目录或 --root 处停止）。
       按根优先顺序输出链（先默认值，后覆盖值）及来源页头；层级缺少文件时输出
       MISSING-LINK 报告——告警属于输出，不是错误。

  down <root-dir> --name FILE [--name FILE ...] [--exclude GLOB ...]
       收集 root-dir 下具名文件的每个实例。

  progress <root-dir> --name FILE [--name FILE ...] [--exclude GLOB ...]
       派生进度视图（正确实现的 PROGRESS.md 原型）：统计具名文件中的 Markdown 复选框
       （标记层），沿树向上汇总计数，并打印遍历图形态的树，显示各层 done/total。
       绝不存入任何文件，渲染结果是唯一载体。收集 root-dir 下具名文件的每个实例
       （子树渲染；在拓扑根运行即主干渲染），按路径排序。

组合输出由程序生成，绝不编辑；片段才是事实源。seal/lock 绑定渲染结果的字节，而不是片段。
只使用标准库。
"""
import argparse, os, sys, fnmatch, datetime, re, shutil, subprocess

# SHELF 容纳某层级的实例；它本身不是位置，也不携带链文件。两棵树都有 shelf：工作树中的
# missions/、slices/，拓扑树中的 rigs/、pods/、seats/。若没有此列表，追踪会把每个 shelf
# 都报告为缺口，审计还会要求为其搭脚手架；这只会制造垃圾，把地图虚增成貌似干净的 5/5，
# 却不增加信息。树使用不同名称时，可通过 --shelf 扩展。
SHELF_NAMES = {"missions", "slices", "seats", "pods", "rigs"}

_TPL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "templates")
def _template_bytes(name):
    try:
        return open(os.path.join(_TPL_DIR, name), "rb").read()
    except OSError:
        return None

def read_state(path):
    """检测以确定性为先、声明为后，绝不依赖记忆：
    1. 与随附模板逐字节相同 -> 'unseeded'（无需任何人记住状态）
    2. 内容与模板不同但带 `status: UNSEEDED` 标记 -> 'conflicted'：渲染内容并明确告警；
       真实工作绝不隐藏在过期字段后，分歧本身就是需要报告的状态（第三状态定律）。
    3. 其他情况 -> 'seeded'。所有残余失败模式都宁可显示过多内容并告警，绝不隐藏工作，
       也绝不静默信任字段。"""
    raw = open(path, "rb").read()
    tpl = _template_bytes(os.path.basename(path))
    body = raw.decode("utf-8", errors="replace")
    head = "\n".join(body.splitlines()[:15])
    marked = re.search(r"^status:\s*UNSEEDED", head, re.M)
    if tpl is not None and raw == tpl:
        m = re.search(r"^owners?:\s*(.+)$", head, re.M)
        return "unseeded", (m.group(1).strip() if m else "负责人未知——未改动的脚手架")
    if marked:
        return "conflicted", body
    return "seeded", body

def hdr(title):
    return f"\n\n<!-- ═══ {title} ═══ -->\n\n## ⟦{title}⟧\n"

def frontmatter(payload):
    """只解析一次 frontmatter 块。返回 (dict, note)；没有可读内容时设置 note，使调用方
    能报告缺口，而非静默跳过。"""
    if not payload:
        return None, "无内容"
    m = re.match(r"^---\n(.*?)\n---\n", payload, re.S)
    if not m:
        return None, "无 frontmatter"
    try:
        import yaml
        return (yaml.safe_load(m.group(1)) or {}), None
    except Exception as e:
        return None, f"frontmatter 解析失败（{e.__class__.__name__}）"

def field_of(payload, field):
    """提取一个 frontmatter 字段，返回 (value, note)。按 FIELD 遍历的链组合 intent，
    不携带正文：展开的是三句话，而非三篇文档。某层文件存在但缺少字段时属于真实缺口，
    必须如实报告，绝不静默跳过。"""
    fm, note = frontmatter(payload)
    if fm is None:
        return None, note
    if field not in fm:
        return None, f"没有 `{field}:` 字段"
    v = fm[field]
    return (" ".join(str(v).split()) if v is not None else None), None

def _cut_at_boundary(s, n):
    """在不拆分 token 的前提下截断到最多 n 个字符。

    依次优先使用段落、行和词边界。若单个连续 token 超过预算，则整个丢弃；不完整路径或
    标识符看似有效，实际并非如此。"""
    if len(s) <= n:
        return s
    head = s[:n]
    if s[n:n + 1].isspace():                 # n 已位于边界上。
        return head.rstrip()
    for sep, floor in (("\n\n", n // 2), ("\n", n // 2), (" ", 0)):
        i = head.rfind(sep)
        if i > floor:
            return head[:i].rstrip()
    return ""                                # 单个连续 token——整个丢弃，绝不从中截断。


def _short(s, n=52):
    s = " ".join(str(s).split())
    if len(s) <= n:
        return s
    return _cut_at_boundary(s, n - 1).rstrip(" ,;:.-—") + "…"

_ARTIFACT_KEYS = ("outputs", "output", "artifacts", "artifact")


def dep_artifacts(dep_dir, names, dep_fm):
    """返回依赖交付的文件，而非仅返回“依赖已完成”这一事实。

    若节点通过 `outputs:`/`output:`/`artifacts:`/`artifact:` 声明产物，则优先采用
    frontmatter，因为显式声明优于猜测。否则检查目录本身：节点文件旁的所有内容；对已构建的
    slice 来说，这些内容就是它的输出（MAP.md、PROOF.md、脚本）。不要解析正文——`## Output`
    章节面向人类，解析它会让追踪恰好在试图消除误判的地方自信地得出错误结论。"""
    for k in _ARTIFACT_KEYS:
        v = (dep_fm or {}).get(k)
        if v:
            return [" ".join(str(x).split()) for x in (v if isinstance(v, list) else [v])], "已声明"
    try:
        entries = sorted(os.listdir(dep_dir))
    except OSError:
        return [], "不可读"
    out = [e + ("/" if os.path.isdir(os.path.join(dep_dir, e)) else "")
           for e in entries if not e.startswith(".") and e not in set(names)]
    return out, "磁盘现有"


def blocking_state(payload, lvl, names):
    """返回叶节点 intent 旁的状态和依赖事实；没有则返回 None。

    仅靠 intent 无法判断工作能否开始，也无法得知依赖产物的位置。应在磁盘上解析依赖并报告
    状态、绝对路径和产物；目的说明由祖先节点承载。"""
    fm, _ = frontmatter(payload)
    if not fm:
        return None
    parts = []
    if fm.get("status") is not None:
        parts.append(f"status: {_short(fm['status'], 88)}")
    deps = fm.get("depends")
    if deps:
        shelf = os.path.dirname(lvl)
        lines = ["depends:"]
        for dep in (deps if isinstance(deps, list) else [deps]):
            dep = " ".join(str(dep).split())
            dep_dir = os.path.join(shelf, dep)
            if not os.path.isdir(dep_dir):
                lines.append(f"    {dep}——⚠ 未解析：{shelf} 下没有目录 `{dep}`"
                             f"（没有可指向的位置——请检查 id）")
                continue
            state, dfm = None, None
            for n in names:
                cand = os.path.join(dep_dir, n)
                if os.path.isfile(cand):
                    st, body = read_state(cand)
                    dfm = frontmatter(body)[0] if st != "unseeded" else None
                    state = _short((dfm or {}).get("status") or st)
                    break
            lines.append(f"    {dep} ({state})" if state else
                         f"    {dep}（⚠ 没有 {'/'.join(names)}——状态未知）")
            lines.append(f"      path: {os.path.abspath(dep_dir)}")
            arts, how = dep_artifacts(dep_dir, names, dfm)
            if arts:
                shown = arts[:8]
                more = f"（另有 {len(arts) - 8} 项）" if len(arts) > 8 else ""
                lines.append(f"      artifacts ({how}): " + " · ".join(shown) + more)
            else:
                lines.append(f"      artifacts: ⚠ 未找到——依赖尚未生成输出文件")
        parts.append("\n".join(lines))   # 第 2 行起自带缩进；调用方负责缩进第 1 行。
    return "\n  ".join(parts) or None


def operates_on(payload):
    """返回工作节点声明的操作根目录。

    正在遍历的树不一定是工作实际修改的树。此信息无法安全推断，因此按原样渲染
    `operates_on`，未声明时则省略。"""
    fm, _ = frontmatter(payload)
    if not fm:
        return None
    roots = fm.get("operates_on")
    if not roots:
        return None
    return [" ".join(str(r).split()) for r in (roots if isinstance(roots, list) else [roots])]


# 叶节点正文超过上限时，优先保留契约和范围章节，再保留理由与历史。未知标题保持中等优先级，
# 使新结构能够平稳降级，不会被静默优先或丢弃。
_PRI_CONTRACT = re.compile(
    r"(done when|what done looks like|scope fence|outputs?\b|inputs?\b|depends on|"
    r"what must be built|how we will know|acceptance|payload|deliverable)", re.I)
_PRI_DISCUSSION = re.compile(
    r"^(why\b|the problem|the evidence|the finding|result\b|also\b|related\b|triage\b|"
    r"background\b|history\b|what is already done|new evidence|measured\b|answered\b|"
    r"where this spec was wrong|notes for|the counter-argument|the asset|the mechanism|"
    r"this mission is the acceptance criteria)", re.I)


def _priority(heading):
    """0 = 前言（绝不丢弃）· 1 = 契约 · 2 = 未分类 · 3 = 讨论。"""
    if heading is None:
        return 0
    if _PRI_CONTRACT.search(heading):
        return 1
    if _PRI_DISCUSSION.match(heading):
        return 3
    return 2


def _sections(body):
    """按二级标题将节点正文拆成 [(heading|None, chunk), ...]。

    第 0 块是前言，即 `# Title` 及其导语，heading 为 None。`###` 留在父章节中：在这些规范里
    它是上级章节的子步骤；若在此拆分，可能导致半个章节脱离自身标题而残留。"""
    starts = [m.start() for m in re.finditer(r"^## +.*$", body, re.M)]
    if not starts:
        return [(None, body)]
    out = [(None, body[:starts[0]])]
    for i, s in enumerate(starts):
        chunk = body[s:starts[i + 1] if i + 1 < len(starts) else len(body)]
        out.append((chunk.splitlines()[0].lstrip("# ").strip(), chunk))
    return out


def leaf_body(payload, cap):
    """渲染叶节点正文，按语义优先级而非位置截断。

    祖先节点可通过稳定的 intent 字段组合，但叶节点承载具体对象、边界、输出和完成条件。
    超出预算时，优先保留契约与范围章节，再保留解释性历史。"""
    if not payload:
        return None
    m = re.match(r"^---\n.*?\n---\n", payload, re.S)
    body = (payload[m.end():] if m else payload).strip()
    if not body:
        return None
    if len(body) <= cap:
        return body
    secs = _sections(body)
    if len(secs) == 1:                     # 无标题正文——没有可排序的章节。
        kept = _cut_at_boundary(body, cap)
        return (kept + "\n\n[…另有 " + str(len(body) - len(kept)) + " 个字符，后续无标题——"
                "正文尾部]" + "\n（请读取节点文件以查看这些内容）")
    # 优先丢弃低优先级且较大的章节，以保留更多简短而关键的章节。标题与导语前言绝不参与丢弃。
    keep, size = set(range(len(secs))), len(body)
    for i in sorted(range(1, len(secs)), key=lambda i: (-_priority(secs[i][0]), -len(secs[i][1]))):
        if size <= cap:
            break
        keep.discard(i)
        size -= len(secs[i][1])
    kept = "".join(secs[i][1] for i in sorted(keep)).rstrip()
    if len(kept) > cap:                    # 仅前言就超限；安全截断，绝不从 token 中间切开。
        kept = _cut_at_boundary(kept, cap)
    dropped = [secs[i][0] for i in range(1, len(secs)) if i not in keep]
    # 列出省略的标题，让读者明确看到发生了截断。
    tail = ("\n\n本次渲染已省略——" + str(len(body) - len(kept)) + " 个字符，章节："
            + " · ".join(dropped) if dropped else
            "\n\n[…另有 " + str(len(body) - len(kept)) + " 个字符，后续无标题——正文尾部]")
    return kept + tail + "\n（请读取节点文件以查看这些内容）"


def resolve_roots():
    """从配置或显式环境变量解析工作根目录与拓扑根目录。

    库副本可以从自身真实路径推导拓扑；投影的插件副本必须通过配置获取，不能猜测。解析顺序为
    环境变量、配置、推导位置。"""
    out = {}
    out["work_root"] = os.environ.get("OPENRIG_WORKSPACE_ROOT") or rig_config("workspace.root")

    t = os.environ.get("OPENRIG_TOPOLOGY_ROOT") or rig_config("workspace.topology_root")
    if not t:
        # 向上遍历前先解析符号链接；否则投影副本会沿自身目录树上溯，而不是沿 shared-docs 源上溯。
        here = os.path.realpath(__file__)
        for _ in range(6):                       # scripts/ skill/ skills/ skill-canon/ -> shared-docs/
            here = os.path.dirname(here)
            cand = os.path.join(here, "rigs")
            if os.path.isdir(cand):
                t = cand
                break
    out["topology_root"] = t
    return out


def rig_config(key):
    if not shutil.which("rig"):
        return None
    try:
        p = subprocess.run(["rig", "config", "get", key], capture_output=True, text=True, timeout=10)
        v = (p.stdout or "").strip()
        return v if p.returncode == 0 and v else None
    except Exception:
        return None


def compose_up(start, names, root, field=None, prefer=False, shelves=None, leaf_cap=2400):
    shelves = SHELF_NAMES | set(shelves or ())
    start = os.path.abspath(start); root = os.path.abspath(root) if root else None
    levels = []
    d = start
    while True:
        levels.append(d)
        if root and os.path.samefile(d, root): break
        if not root and os.path.exists(os.path.join(d, ".compose-root")): break
        parent = os.path.dirname(d)
        if parent == d: break
        d = parent
    levels.reverse()  # 根目录优先：先默认值，后覆盖值。
    out = [f"<!-- GENERATED by compose.py up · {datetime.datetime.now().isoformat(timespec='minutes')} -->",
           f"<!-- 起点：{start} · 层级：{sum(1 for d in levels if os.path.basename(d) not in shelves)}（{len(levels)} 个路径段）· 链：{', '.join(names)}" + (f" · FIELD: {field}" if field else "") + " -->",
           "<!-- 组合视图——绝不要编辑；请编辑片段。 -->"]
    GLYPH = {"seeded": "✓ seeded（已播种）", "unseeded": "⟂ UNSEEDED（未播种）",
             "conflicted": "⚠ conflicted（标记已过期）", "absent": "✗ absent（缺失）",
             "shelf": "· shelf（容器层）"}
    missing, unseeded = [], []
    # --prefer 将 --name 列表变成一条按优先级逐层解析的链（首个匹配项胜出），而非 N 条独立链。
    # 树处于改名过程中是常态而非例外：SPEC.md 是当前节点文件名，README.md 是旧名称。若追踪
    # 无法跨越二者，就会把只是混用名称的链误报为断裂。
    # 根据已配置的树根验证起始节点。仅位于 workspace.root 下并不充分，因为 fixture 也可能
    # 看起来结构有效。
    _cfg = [c for c in (rig_config("workspace.slices_root"),
                        resolve_roots().get("topology_root")) if c]
    _here = os.path.abspath(start)
    _root_warning = None
    if _cfg and not any(_here == os.path.abspath(c) or _here.startswith(os.path.abspath(c) + os.sep)
                        for c in _cfg):
        _root_warning = ("  ⚠ 这不是已配置的树。当前实例上的树："
                         + " · ".join(_cfg) + "\n    从游离树或 fixture 树遍历也能渲染得同样完整——"
                         "据此行动前请先核实。")
    groups = [list(names)] if prefer else [[n] for n in names]
    for group in groups:
        name = group[0]
        out.append(f"\n\n# 链：{' → '.join(group)}（根 → 叶）"
                   + (" · 优先级：每层首个匹配项胜出" if len(group) > 1 else ""))
        # 第 1 遍——收集每一层的状态（这就是追踪本身；地图由此派生）。
        chain, hits = [], {}
        for lvl in levels:
            p = None
            for n in group:
                cand = os.path.join(lvl, n)
                if os.path.isfile(cand):
                    p, hits[lvl] = cand, n
                    break
            where = os.path.relpath(lvl, levels[0]) or '.'
            # SHELF 是路径段，不是层级。链只有项目、mission、slice 三阶；若把 `missions/` 和
            # `slices/` 也渲染成阶梯，就会误成五阶。shelf 中的任何文件都只是普通目录文档，
            # 不是链路节点，应忽略而非标记。`README.md` 既可能是旧节点名，也可能是普通说明，
            # 只有它所在的层级才能区分二者。
            is_shelf = os.path.basename(lvl) in shelves
            if is_shelf:
                state, payload, p = "shelf", None, None
                hits.pop(lvl, None)
            elif p:
                state, payload = read_state(p)
            else:
                state, payload = "absent", None
            # 在这里解析字段，地图才能反映真实状态。若地图只看文件是否存在，会把未组合任何内容
            # 的层级标成 ✓；这种误读会让追踪反过来证明它本应发现的漂移没有问题。
            fval, fnote = (field_of(payload, field) if (field and state == "seeded") else (None, None))
            chain.append((lvl, where, state, payload, fval, fnote))
        # 追踪——派生的定位树（绝不存入文件，渲染结果是唯一载体）。地图把层级显示为阶梯；
        # shelf 折叠进下一阶路径，使树深度等于实际承载 intent 的层级数。
        rungs, pending = [], []
        for idx, row in enumerate(chain):
            if row[2] == "shelf" and idx != len(chain) - 1:
                pending.append(os.path.basename(row[0]) or row[0])
                continue
            label = "/".join(pending + [os.path.basename(row[0]) or row[0]])
            rungs.append((label, row)); pending = []
        leads = [("" if i == 0 else "   " * (i - 1) + "└─ ") + rungs[i][0] + "/" for i in range(len(rungs))]
        width = max(len(l) for l in leads) + 2
        # 标明遍历的根和链，避免读者把展示中的树与工作实际修改的树混为一谈。
        out.append(f"\n追踪 · 根 {levels[0]} · 链 {' → '.join(group)}")
        # 对未配置的根发出告警：任意外观相似的树也能渲染出完整链。
        if _root_warning:
            out.append(_root_warning)
        for i, (_label, (lvl, where, state, payload, fval, fnote)) in enumerate(rungs):
            note = f"（负责人：{payload}）" if state == "unseeded" and payload else ""
            here = "   ← 你在这里" if i == len(rungs) - 1 else ""
            glyph = f"⟂ 没有 {field}" if (field and state == "seeded" and not fval) else GLYPH[state]
            # 在优先级模式下，标明每层究竟由哪个文件响应。混用名称的树是可读状态而非噪声；
            # 隐藏此信息会让改名过程看起来像数据损坏。
            via = f" [{hits[lvl]}]" if len(group) > 1 and lvl in hits and state != "shelf" else ""
            out.append(f"  {leads[i]:<{width}}{glyph}{via}{note}{here}")
        # 第 2 遍——内容；按三状态规则折叠状态。
        found = 0
        for lvl, where, state, payload, fval, fnote in chain:
            if state == "shelf":
                continue          # 路径段而非位置——不贡献内容，也不产生标记。
            elif state == "unseeded":
                out.append(f"\n⟂ {name} @ {where}——UNSEEDED（仅脚手架，不渲染；请播种：{payload}）")
                unseeded.append(f"{name} @ {where}（负责人：{payload}）")
            elif state == "conflicted":
                found += 1
                out.append(hdr(f"{name} @ {where}——⚠ 标有 status: UNSEEDED，但内容不同于模板"))
                out.append(payload.rstrip())
                unseeded.append(f"{name} @ {where}——标记与内容不一致：仍已渲染；负责人应清除过期的 status 行")
            elif state == "seeded":
                found += 1
                if field:
                    if fval:
                        out.append(f"\n{where}:  {fval}")
                    else:
                        out.append(f"\n{where}:  ⚠ {fnote}")
                        unseeded.append(f"{name} @ {where} — {fnote}")
                    # 只有叶节点的答案代表操作。在这里组合其阻塞状态，否则遍历会认证一个它从未
                    # 读取过的下一步。
                    if lvl == chain[-1][0]:
                        blocked = blocking_state(payload, lvl, group)
                        if blocked:
                            out.append(f"  {blocked}")
                        roots = operates_on(payload)
                        if roots:
                            out.append("  operates_on：" + " · ".join(roots))
                        # ……也是唯一给出具体规范的层级。参见 leaf_body()。
                        lb = leaf_body(payload, leaf_cap) if leaf_cap else None
                        if lb:
                            out.append(f"\n─── {where} · 节点正文 ───")
                            out.append(lb)
                else:
                    out.append(hdr(f"{name} @ {where}"))
                    out.append(payload.rstrip())
            else:
                missing.append(f"{name} @ {where}")
        if not found:
            out.append(f"\n⚠ 本次遍历中没有 {name} 的 seeded 实例。")
    if unseeded or missing:
        out.append("\n\n# ⚠ 链审计（遍历只在这里集中告警；绝不靠中断，也绝不靠模板垃圾）")
        if unseeded:
            out.append("UNSEEDED（文件存在但仅为模板——由负责人写入首个真实版本）：")
            out += [f"- {m}" for m in unseeded]
        if missing:
            out.append("ABSENT（某个位置没有文件——请搭建脚手架；若不应缺失，则报告给该层负责人）：")
            out += [f"- {m}" for m in missing]
    return "\n".join(out)

def compose_down(root, names, excludes):
    root = os.path.abspath(root)
    hits = []
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if not x.startswith(".") and x != "node_modules"
                   and not any(fnmatch.fnmatch(os.path.join(dirpath, x), g) for g in excludes)]
        for name in names:
            if name in files:
                hits.append(os.path.join(dirpath, name))
    hits.sort()
    out = [f"<!-- GENERATED by compose.py down · {datetime.datetime.now().isoformat(timespec='minutes')} -->",
           f"<!-- 根：{root} · 文件：{len(hits)} · 链：{', '.join(names)} -->",
           "<!-- 子树渲染（在树根处即为主干渲染）。绝不要编辑。 -->"]
    unseeded = []
    for p in hits:
        state, payload = read_state(p)
        rel = os.path.relpath(p, root)
        if state == "unseeded":
            unseeded.append(f"{rel}（负责人：{payload}）")
        elif state == "conflicted":
            out.append(hdr(f"{rel}——⚠ 真实内容上存在过期的 UNSEEDED 标记"))
            out.append(payload.rstrip())
            unseeded.append(f"{rel}——标记与内容不一致：仍已渲染；请清除过期的 status 行")
        else:
            out.append(hdr(rel))
            out.append(payload.rstrip())
    if unseeded:
        out.append("\n\n# ⚠ 此根目录下的 UNSEEDED（仅脚手架——已折叠，不渲染）")
        out += [f"- {u}" for u in unseeded]
    if not hits:
        out.append("\n⚠ 此根目录下没有链文件——是否需要先展开？")
    return "\n".join(out)

def compose_progress(root, names, excludes):
    import collections
    root = os.path.abspath(root)
    direct = collections.defaultdict(lambda: [0, 0])   # dir -> 自身文件中的 [done, total]。
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [x for x in dirs if not x.startswith(".") and x != "node_modules"
                   and not any(fnmatch.fnmatch(os.path.join(dirpath, x), g) for g in excludes)]
        for name in names:
            if name in files:
                txt = open(os.path.join(dirpath, name), encoding="utf-8", errors="replace").read()
                done = len(re.findall(r"^\s*[-*] \[[xX]\]", txt, re.M))
                open_ = len(re.findall(r"^\s*[-*] \[ \]", txt, re.M))
                if done + open_:
                    direct[dirpath][0] += done
                    direct[dirpath][1] += done + open_
    agg = collections.defaultdict(lambda: [0, 0])       # dir -> 向上汇总后的 [done, total]。
    for d, (dn, tt) in direct.items():
        cur = d
        while True:
            agg[cur][0] += dn; agg[cur][1] += tt
            if os.path.samefile(cur, root): break
            cur = os.path.dirname(cur)
    out = [f"<!-- GENERATED by compose.py progress · {datetime.datetime.now().isoformat(timespec='minutes')} -->",
           "<!-- 在渲染时从标记层派生。绝不要把此结果存入文件。 -->",
           f"\n进度图（{', '.join(names)}——复选框是唯一标记层；其上各层均由此派生）："]
    if not agg:
        out.append("  （此根目录下的具名文件中未发现复选框——这里没有任何标记）")
        return "\n".join(out)
    keys = sorted(agg, key=lambda d: os.path.relpath(d, root))
    leads = []
    for d in keys:
        rel = os.path.relpath(d, root)
        depth = 0 if rel == "." else rel.count(os.sep) + 1
        label = os.path.basename(root) if rel == "." else os.path.basename(d)
        leads.append(("" if depth == 0 else "   " * (depth - 1) + "└─ ") + label)
    width = max(len(l) for l in leads) + 2
    for i, d in enumerate(keys):
        dn, tt = agg[d]
        pct = 100 * dn // tt if tt else 0
        glyph = "✓" if dn == tt else ("◐" if dn else "○")
        own = " ·" if d in direct else "  "   # · = 自身带标记（区别于纯汇总）。
        out.append(f"  {leads[i]:<{width}}{glyph} {dn}/{tt} ({pct}%){own}")
    return "\n".join(out)

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["up", "down", "progress", "roots"])
    ap.add_argument("path", nargs="?")
    ap.add_argument("--name", action="append")
    ap.add_argument("--root", default=None)
    ap.add_argument("--prefer", action="store_true",
                    help="将 --name 视为优先级列表（每层首个匹配项胜出），而非独立链——适用于"
                         "改名过程中的树：--name SPEC.md --name README.md --prefer")
    ap.add_argument("--exclude", action="append", default=[])
    ap.add_argument("--field", default=None, help="沿链组合一个 frontmatter 字段（如 --field intent），而非完整正文")
    ap.add_argument("--leaf-cap", type=int, default=2400, metavar="N",
                    help="与 --field 搭配时同时渲染叶节点正文，上限为 N 个字符（0 = 关闭）。"
                         "祖先节点会压缩；具体对象位于叶节点。")
    ap.add_argument("--shelf", action="append", default=[],
                    help=f"额外的容器目录名；它容纳实例而非表示位置，因此没有链文件是正确的"
                         f"（默认：{', '.join(sorted(SHELF_NAMES))}）")
    a = ap.parse_args()
    if a.mode == "roots":
        r = resolve_roots()
        for k in ("work_root", "topology_root"):
            v = r.get(k)
            if v:
                print(f"{k}={v}")
            else:
                key = "workspace.root" if k == "work_root" else "workspace.topology_root"
                print(f"# {k} 未解析——请设置：rig config set {key} <path>", file=sys.stderr)
        sys.exit(0 if all(r.values()) else 3)
    if not a.name:
        ap.error("up/down/progress 模式必须提供 --name")
    if a.mode == "up":
        print(compose_up(a.path, a.name, a.root, a.field, prefer=a.prefer, shelves=a.shelf, leaf_cap=a.leaf_cap))
    elif a.mode == "down":
        print(compose_down(a.path, a.name, a.exclude))
    else:
        print(compose_progress(a.path, a.name, a.exclude))
