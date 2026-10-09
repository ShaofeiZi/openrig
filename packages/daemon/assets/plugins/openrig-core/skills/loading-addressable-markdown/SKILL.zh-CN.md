---
name: loading-addressable-markdown
description: 当任务目标、切片、仪表盘或任务通过 path#h2-slug 或 path#h2-slug/h3-slug 引用 zrig context-pack 库之外的 Markdown 时使用。
---

# 加载可寻址 Markdown

## 概述

从任意文件系统目录树中，精确加载一个带地址的 Markdown 章节。解析器复用了 zrig 随附的 H2/H3 语法，但不要求文件位于上下文库中。

## 使用方法

运行随附脚本。相对文件引用会从 `--root` 解析；未传入该参数时，则从当前目录解析。

```bash
node ~/.agents/skills/loading-addressable-markdown/scripts/resolve-markdown.mjs \
  --root /path/to/mission \
  'slices/09-source-cleanup/SPEC.md#proposal'
```

支持以下形式：

- `file.md` — 整个文件
- `file.md#h2-slug` — 完整的 H2 范围，包括其子章节
- `file.md#h2-slug/h3-slug` — 完整的 H3 范围

slug 使用小写；Markdown 强调和代码标记会被移除；其他每一段连续的非字母数字字符都会转换为 `-`。路径重复或不存在时会明确失败。围栏代码块内的标题会被忽略。

## 常见错误

- 不要对任意文件系统路径使用 `zrig context get`；该命令解析的是上下文库引用。
- 不要使用 `sed` 或行号手工截取标题范围；范围和代码围栏行为应由随附解析器统一处理。
- 在 shell 命令中为地址加引号。
