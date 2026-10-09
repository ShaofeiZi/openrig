#!/usr/bin/env python3
# Extract candidate visible strings from packages/ui/src/**/*.tsx for auditable review.
# Captures: (1) JSX text nodes between > and <, (2) string literals assigned to known
# visible props. Flags entries containing ASCII letters but NOT in a known allowlist
# of machine/protocol tokens. Prints a per-file, line-numbered auditable list.
import re, sys, glob, os

ROOT = "packages/ui/src"
VISIBLE_PROPS = ("aria-label","placeholder","title","label","description","heading","alt","tooltip","tooltipLabel","message","emptyText","emptyStateText","emptyMessage","actionLabel","cancelLabel","confirmLabel","okText","placeholderText")

# tokens that are machine/protocol/URL/path/format and may legitimately stay ASCII
ALLOW = re.compile(r'^(HTTP|GET|POST|PUT|DELETE|PATCH|/|http|\\$|v\d|%|\\{|\\})|\\.(ts|tsx|js|json|yaml|md|rigbundle|exe)$', re.I)

def prose_english(s):
    # flag only: has ASCII letters, NO CJK, reads like multi-word prose English
    t = s.strip()
    if not re.search(r'[A-Za-z]', t): return False
    if re.search(r'[一-鿿]', t): return False
    if re.search(r'[{}$%]', t): return False
    # strip code symbols
    words = re.findall(r'[A-Za-z][A-Za-z]+', t)
    # need >=2 lowercase words to be prose; single CamelWords are likely idents/buttons-ish
    if len(words) >= 2: return True
    return False

def scan(path):
    out=[]
    with open(path, encoding="utf-8") as fh:
        lines = fh.readlines()
    src = "".join(lines)
    # 1) visible props with string literal value "..." or '...' or `...`
    for m in re.finditer(r'(' + "|".join(VISIBLE_PROPS) + r')\s*=\s*(["\'\`])(.*?)\2', src, re.S):
        line = src[:m.start()].count("\n")+1
        val = m.group(3)
        if prose_english(val):
            out.append((line, m.group(1), val[:80]))
    # 2) JSX text nodes: >...<  (skip pure whitespace, expressions)
    for m in re.finditer(r'>\s*([^<>{}\n]{2,}?)\s*<', src):
        line = src[:m.start()].count("\n")+1
        val = m.group(1).strip()
        if val and prose_english(val):
            out.append((line, "jsx-text", val[:80]))
    return out

files = sorted(glob.glob(os.path.join(ROOT,"**/*.tsx"), recursive=True))
total_flag=0
for f in files:
    res = scan(f)
    # only print files with a flag (prose English visible string)
    if res:
        print(f"\n=== {f} ===")
        for ln,kind,val in res:
            print(f"  :{ln} [{kind}] {val}")
            total_flag+=1
print(f"\n# FILES={len(files)} FLAGGED_ENTRIES={total_flag}")
