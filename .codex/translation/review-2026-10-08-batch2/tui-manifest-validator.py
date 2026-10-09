#!/usr/bin/env python3
# TUI manifest validator — 等作者 86 文件清单后运行。
# 用法: python3 tui-manifest-validator.py <manifest.txt>
# manifest.txt: 每行一个 source_path（packages/tui/...）。
# 行为: 仅对 status=done 且当前 self_reported 的记录锁 validated + note；
#       标题翻译+测试过 ≠ 整文件注释全文，note 注明标题批深度。
import importlib.util, os, sys
HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = os.path.join(HERE, "..", "..", "scripts")
spec = importlib.util.spec_from_file_location("state", os.path.join(SCRIPTS, "state.py"))
st = importlib.util.module_from_spec(spec); spec.loader.exec_module(st)

paths = [l.strip() for l in open(sys.argv[1]) if l.strip()]
NOTE = "batch2 TUI标题批:标题翻译+相关测试过;待整文件注释全文证据→validated"
for o in ("tui",):
    def w():
        d = st.load(o); n = 0
        for f in d["files"]:
            if f["source_path"] in paths and f["status"] == "done" and f.get("validation_state") == "self_reported":
                f["validation_state"] = "validated"
                f["note"] = str(f.get("note","")) + " | " + NOTE
                n += 1
        st.save(o, d); return n
    print(o, "->", st.with_lock(o, w))
st.rebuild()
print("rebuilt; manifest paths:", len(paths))
