---
kind: as-built
title: As-Built Frontmatter —— 指针 + as-built 专属字段
status: active
topics: [knowledge-and-context, frontmatter]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  在 docs/as-built/ 下撰写或更新文档时使用。告诉你这些文档遵循哪条
  frontmatter 约定，以及唯一一个 as-built 文档专属字段。
siblings: [README.md]
prerequisite-reads: [README.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# As-Built Frontmatter —— 指针 + as-built 专属字段

`docs/as-built/` 下每篇文档都带 YAML frontmatter。其形状**不在此定义**。它是 substrate 全局的 context-frontmatter 约定；本文仅指向该约定，并记录唯一一个 as-built 文档专属字段。

## 规范约定（不要重复定义——去读它）

`openrig-work/conventions/frontmatter-for-context/README.md` 是权威 schema：必需底字段（`kind` + `title` + `status` + `applies-when`）、推荐字段（`topics`、`domains`、`siblings`、`prerequisite-reads`），以及 `kind:`、`topics:`、`domains:` 的受控词表。按该约定撰写。本文除下方字段外不新增任何东西。

## `kind: as-built`

这些文档使用 `kind: as-built`。该值在约定的受控 `kind:` 词表中（其"Controlled vocabulary — `kind:`"表的第一行，源 `openrig/docs/as-built/*`）。使用它是合规，不是扩展。

## `last-verified-against-source: <sha>`（as-built 专属）

as-built 文档描述运行中的系统。源码漂移时它就漂移。该 as-built 专属字段记录本文件上次核验所对的精确提交：

```yaml
last-verified-against-source: 7eaf524c
```

- **值：** 本文件上次编辑时核验所对的源码 HEAD 短 SHA。与 `last-updated: <iso-date>` 配对使用。
- **为何在此而不在约定里：** 约定是 substrate 全局的；大多数 context 文档不跟踪源码 SHA。本字段只对镜像代码的文档（即 as-built 文档）有意义。它是 context-architecture-v1 任务在自己生产环境 dogfood 的逐模块漂移检测锚点。
- **纪律：** 当对照更新的 HEAD 重新核验某模块时，bump 本字段（及 `last-updated`），并在每条被重新核对的承重论断上带一条 inline `re-confirmed <file:line> @HEAD` 注记。

## 另见

- `openrig-work/conventions/frontmatter-for-context/README.md` —— 规范 schema
- `README.md` —— as-built 语料的领地地图
