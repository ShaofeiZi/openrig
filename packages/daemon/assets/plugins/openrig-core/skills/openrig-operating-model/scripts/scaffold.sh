#!/usr/bin/env bash
# scaffold.sh topology <root> --node <relpath> [--node <relpath> ...]
# scaffold.sh work     <root> --node <relpath> [--node <relpath> ...]
# 根据模板在根目录及每个具名节点目录中创建缺失的链文件。绝不覆盖现有文件（按构造可安全用于
# 棕地项目；绿地与棕地使用同一命令，只是初始状态不同）。绝不删除任何内容，并报告新建/已存在项。
set -euo pipefail
MODE="${1:?usage: scaffold.sh <topology|work> <root> --node <relpath> ...}"
ROOT="${2:?root dir required}"; shift 2
HERE="$(cd "$(dirname "$0")" && pwd)"; TPL="$HERE/../templates"
case "$MODE" in
  # 链承载某个位置的知识。SOP.md 承载某个类别的知识，现随工作组模式插件
  #（openrig-lab | openrig-factory | openrig-hq）交付；它不是链，不得脚手架到树中。
  # CULTURE.md 随 OpenRig 提供。
  topology) FILES=(LEARNED.md) ; ROOT_FILES=(LEARNED.md) ;;
  # SPEC.md 是人工编写的节点（intent 位于 frontmatter）。NOTES.md 是实际经历文件；脚手架只创建
  # 其表面，经历条目绝不自动生成或投影。PROGRESS 是派生内容；有内容需要证明时由证明者编写 PROOF.md。
  work)     FILES=(SPEC.md NOTES.md) ; ROOT_FILES=(SPEC.md NOTES.md) ;;
  *) echo "mode 必须为 topology 或 work" >&2; exit 2 ;;
esac
NODES=()
while [[ $# -gt 0 ]]; do case "$1" in --node) NODES+=("$2"); shift 2;; *) echo "未知参数 $1" >&2; exit 2;; esac; done
place(){ # $1=dir $2=file
  mkdir -p "$1"
  if [[ -e "$1/$2" ]]; then echo "  已存在：$1/$2"
  else cp "$TPL/$2" "$1/$2"; echo "  已创建：$1/$2（模板——尚未填充；由实际负责人填充）"; fi
}
echo "脚手架 $MODE @ $ROOT"
touch "$ROOT/.compose-root" 2>/dev/null || true
for f in "${ROOT_FILES[@]}"; do place "$ROOT" "$f"; done
for n in ${NODES[@]+"${NODES[@]}"}; do for f in "${FILES[@]}"; do place "$ROOT/$n" "$f"; done; done
echo "完成。规则：现有文件保持不变；未填充模板等待负责人处理；席位 LEARNED.md 由自身填充（审计），绝不批量写入。"
