---
kind: as-built
title: 内容表面 —— 文件浏览器、原子写入、Progress 树、Steering 编辑器
status: active
topics: [observability, specification-and-bundles]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  需要了解操作者白名单文件浏览器如何强制路径安全、带冲突检查的原子写入 +
  JSONL 编辑审计如何工作、工作区 PROGRESS.md 树如何被索引，或单屏 Steering 表面
  （优先级栈 + roadmap rail + 泳道 rail + 健康门）如何组合。Author-mode 模块——
  无既有 architecture.md 散文；每条承重论断都在 HEAD 处锚定到 file:line。
siblings: [workspace-primitive.md, daemon-core.md, ../ui/project-and-for-you.md]
prerequisite-reads: [../README.md, workspace-primitive.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# 内容表面 —— 文件浏览器、原子写入、Progress 树、Steering 编辑器

> **另见（v0.4.4）：** Living Notes 评审表面——在同一白名单内容层之上组合出的
> intent→plan→delivered 投影——见 [`living-notes-review.md`](living-notes-review.md)。


**内容表面**是 Project / Steering UI 所依托的、操作者白名单、文件系统规范的读写层：一个 fail-closed 文件浏览器、一个带 JSONL 编辑审计的带冲突检查原子写入服务、递归的 PROGRESS.md 树索引器，以及单屏 Steering 编辑器（+ 其紧凑的健康摘要门）。四者都不新增 SQLite 状态。

> **AUTHOR-FROM-SOURCE 模块。** 此前无 `architecture.md` 散文。每条承重论断都带 `> Source: <file:line> @HEAD`；歧义声明为 OPEN 项，从不抹平。路径相对 `packages/daemon/src/`，除非前缀为 `packages/` 或 `docs/`。
>
> 已在 HEAD `7eaf524c`（`git describe` → `v0.3.1-6-g7eaf524c`）核验。包版本 **0.3.1**；HEAD 携带 6 个未发布的 release-0.3.2 提交；无 `v0.3.2` 标签（daemon-core.md；slice-00 §1.1）。
>
> **拆分说明（§10.6）。** 这是 `workspace-and-content-primitives` 拆分的内容表面半壁（兄弟 `workspace-primitive.md` 承载工作区原语 + 迁移 038/039 + missions/projects/slices）。§10.6 理由与透明标注偏差披露见 `workspace-primitive.md` 头部 SPLIT NOTE。

## 0. 版本归属（取证证明——先读）

依 §10.8，在 HEAD 经 `git cat-file -e <tag>:<path>` 重新核验：

| 子系统 | 版本 | HEAD 处取证证明 |
|---|---|---|
| `domain/files/{path-safety,file-write-service}.ts` | **≤0.3.0** | `v0.3.0:<path>` → 存在 |
| `domain/progress/progress-indexer.ts` | **≤0.3.0** | `v0.3.0:<path>` → 存在 |
| `domain/steering/{steering-composer,health-summary}.ts` | **≤0.3.0** | `v0.3.0:<path>` → 存在 |
| `routes/{files,progress,steering,health-summary}.ts` | **≤0.3.0** | `v0.3.0:<path>` → 存在 |

> 来源：§10.8 证明在 HEAD `7eaf524c` 重跑——每个列出路径在 `v0.3.0` 均可解析（无失败）。所有内容表面都是 **≤0.3.0** 特性（UI Enhancement Pack v0 + Operator Surface Reconciliation v0；slice-00 0.3.0-GT §1.7“Files / Markdown / Progress / Proofs”确认该簇随 0.3.0 交付）。**不要**把其中任何一项反向归到 0.3.1——缺口是缺失的 architecture.md 散文，不是新特性。

## 1. 路径安全——fail-closed 白名单（UI Enhancement Pack v0）

文件浏览器由后台服务强制的 **fail-closed** 白名单门控。根从 `OPENRIG_FILES_ALLOWLIST`（环境变量）解码，逗号分隔的 `<name>:<absolute-path>` 对（经 `||` 回退到旧版 `RIGGED_FILES_ALLOWLIST`，使空串穿透）。无效对（无冒号、空名、非绝对路径）**被静默跳过**；重名 → 后者胜出。空/未设置 → 无根 → 路由返回空列表并带结构化的“配置 OPENRIG_FILES_ALLOWLIST”提示。全新安装后的安全默认是**白名单为空**。

> 来源：`domain/files/path-safety.ts:50-51`（环境变量）、`:60-93`（`decodeAllowlist` / `readAllowlistFromEnv`；静默跳过 L67-71、后者胜出 L78、`||` 回退注释 L89-91）@HEAD。

`resolveAllowedPath(allowlist, rootName, relativePath)` 是承重守卫。算法：(1) 拒绝未知根（`root_unknown`）；(2) 在文件系统解析**之前**拒绝表达意图的 `..` 段（`path_escape`）——按段切分，使 `foo..bar` 不被误报；(3) 拒绝绝对 `relativePath`（`path_invalid`）；(4) 经 `fs.realpathSync` 解析符号链接，当 realpath 不以 `<canonicalRoot><sep>` 开头时拒绝（`path_escape`）——以 `path.sep` 为边界，使 `/foo/bar` 不匹配 `/foo/bar-other`；(5) `path === ""` 解析为根本身（使调用方可列出根）。树**内**符号链接正常解析；指向**树外**的符号链接是逃逸尝试。不存在的候选回退到未解析路径，使后续 stat 以特定代码暴露缺失。`resolveAllowedFile` / `resolveAllowedDirectory` 追加 stat 断言（`not_a_file` / `not_a_directory`）。

> 来源：`domain/files/path-safety.ts:95-171`（`resolveAllowedPath`；fs 前 `..` L124-140、绝对拒绝 L141-147、sep 边界 L158-169、doc-comment 中空路径基例 L108-110）、`:173-225`（文件/目录便捷断言）@HEAD。

## 2. 原子写入 + JSONL 审计（UI Enhancement Pack v0 第 4 项）

`FileWriteService.writeAtomic(req)` 是面向操作者的 `STEERING.md` / `PROGRESS.md` / spec YAML / 任意白名单文件的写入表面。序列：(1) 在白名单下解析目标（复用 §1 路径安全）；(2) 重新 stat + 重新哈希目标——若 `mtime !== expectedMtime` 或 `contentHash !== expectedContentHash`，抛出携带**当前** mtime + 哈希的 `WriteConflictError` 供 UI 呈现（乐观并发，不是锁）；(3) 写入**同目录**下的临时文件（PID + 随机后缀，使并发写入不碰撞）；(4) rename 前对临时 fd 做 `fsync` 以持久化；(5) 原子 `renameSync` 覆盖目标（POSIX 上单 inode 交换——读者只见旧或新，从不见部分）；(6) 重算 mtime + 哈希 + 字节差异；(7) 追加一行 JSONL 审计。

> 来源：`domain/files/file-write-service.ts:9-25`（文档化的原子写语义）、`:111-212`（`writeAtomic`；冲突检测 L129-135、同目录临时 L137-141、fsync L146、原子 rename L161）@HEAD。

审计文件默认在 `~/.openrig/file-edit-audit.jsonl`（`HOME`/`USERPROFILE` → `/tmp` 回退）。**Append-only；v0 从不轮转。** 审计追加失败抛 `FileWriteError("audit_write_failed")`，但**不**撤销已落地的写入——用户的编辑已成功；审计系统抖动绝不能静默回滚规范。（路由仍以 500 呈现，使失败诚实、不被吞掉。）

> 来源：`domain/files/file-write-service.ts:87-91`（默认路径 + 回退）、`:24-25`（v0 不轮转）、`:182-204`（审计追加；“不撤销写入”注释 L183-184）@HEAD。

## 3. Files 路由——浏览 + 读 + 资源 + 写

`filesRoutes()`（挂载于 `server.ts:507` 为 `/api/files`）。所有路由都是**字面量**（无 `/:param` 通配），故顺序不影响遮蔽（Phase A R1 SSE 教训）：

- `GET /roots` —— 白名单根列表（无则 `{roots:[], hint}`）。
- `GET /list?root&path` —— 目录条目（目录在前，再文件，按名排序；始终含 dotfile——把根加入白名单即表达检视意图）。
- `GET /read?root&path` —— 文件内容 + `mtime` + `contentHash`（SHA-256）+ `size`。**内容截断到 `FILE_READ_TRUNCATION_BYTES`（1 MB）**，但哈希按**完整**文件计算，使即使截断读取时原子写冲突检测仍诚实；响应携带 `truncated` / `truncatedAtBytes` / `totalBytes`。
- `GET /asset?root&path` —— 内嵌图片/视频/pdf 的原始字节（推断 `Content-Type`，5 分钟缓存）。**v0.4.4（OPR.0.4.4.20 FR-5）：** 服务 HTTP **字节区间**——单区间形式，`206` + `Content-Range` + `Accept-Ranges: bytes`（畸形/不可满足 → `416`）——iOS-Safari 级媒体播放要求；且 `.html` 仅在显式 `?render=1` 选择下渲染为 `text/html`（默认仍 `text/plain`）。slice 证明资产路由（`/api/slices/:name/proof-asset/*`）带相同区间语义（living-notes 修正）。见 [`living-notes-review.md`](living-notes-review.md) §5。
- `POST /write` —— 原子写（§2）；无写服务时 503（`OPENRIG_FILES_ALLOWLIST` 为空）；stale mtime/哈希时 409 `write_conflict`，带当前值供 UI 刷新提示。

白名单依赖未接通时 503 `files_routes_unavailable`。路径安全错误按代码映射 HTTP（`root_unknown`/`path_*` → 400，`stat_failed` → 404）。

> 来源：`routes/files.ts:51-242`（处理器；路由顺序注释 L17-19、截断 L139-154、写 503/409 L187-191/L225-231、路径安全→HTTP `:61-69`）；`FILE_READ_TRUNCATION_BYTES = 1_048_576` `:49`；挂载 `server.ts:507`；CLI：无 `rig files` 动词——files 在 HEAD 仅为 UI 表面。

> **§10.7 路由现实（在 `packages/ui/src/routes.tsx` 源码核验）：** `/files` 是 Phase-8.1 调查**漏掉**的**真实路由**（`FilesWorkspace`）。**不存在 `/markdown` 路由**——markdown 渲染是 file / 抽屉表面内的一个*组件*，不是可导航目标。
>
> 来源：`packages/ui/src/routes.tsx:192-195`（`path: "/files"` + `FilesWorkspace`）；@HEAD grep 确认 routes.tsx 中无任何 `path: "/markdown"` 声明。

## 4. Progress 树索引器（UI Enhancement Pack v0 第 1B 项）

`ProgressIndexer` 遍历操作者白名单扫描根（`OPENRIG_PROGRESS_SCAN_ROOTS`，与文件白名单同形 `<name>:<abs-path>`；旧版 `RIGGED_PROGRESS_SCAN_ROOTS`），查找 **`PROGRESS.md` 与 `STEERING.md`** 文件（依 OSR v0 第 2 项，STEERING.md 锚定为约束框架节点；行机制与文件名无关），并把每个解析为 checkbox 层级树。递归深度有界（默认 6——足够 mission/lane/slice 嵌套，而不深入 `node_modules`/`.git`/`.worktrees`/`dist`/`build`/`.turbo`/`.next` 或 dotfile）。checkbox 状态：`[x]` → `done`，`[~]` → `blocked`，`[ ]` → `active`；标题（`##`–`####`）成为层级行；深度来自 2 空格缩进或标题层级。每文件 `counts` + 扫描级 `aggregate`。**每请求内存遍历；v0 无缓存**（受操作者白名单范围约束）。

> 来源：`domain/progress/progress-indexer.ts:79-84`（STEERING 锚 + 环境变量）、`:81`（SKIP_DIRS）、`:71`（`DEFAULT_MAX_DEPTH = 6`）、`:218-235`（checkbox 状态映射）、`:204-215`（标题行）、`:21-23`（v0 无缓存）@HEAD。

`progressRoutes()`（挂载 `server.ts:508` 为 `/api/progress`）：`GET /tree` —— 索引层级；未接通时 503 `progress_indexer_unavailable`；无根时 503 `progress_scan_roots_not_configured` + 设置提示。

> 来源：`routes/progress.ts:18-40`（处理器；503 L29-35）；挂载 `server.ts:508` @HEAD。

> **§10.7 路由现实：** `/progress` 是 **`<Navigate to="/project" />` 重定向桩**——progress 系统在后台服务 `/api/progress` 路由，但 UI URL 并入 Project 标签页（Phase 3）。
>
> 来源：`packages/ui/src/routes.tsx:464-468`（“并入 Project 标签页（Phase 3）——重定向到 /project”）@HEAD。

## 5. Steering 编辑器（Operator Surface Reconciliation v0 第 1 项）

`SteeringComposer.compose()` 是**单屏组合的 steering 表面**。它刻意收窄：只组合**文件系统派生**的部分；UI 经各自既有端点取 PL-005 队列视图（进行中 / 循环态）与健康门，使编辑器保持可测。三个来源都从单一工作区根解析（`OPENRIG_STEERING_WORKSPACE`；逐项覆盖 `OPENRIG_STEERING_PATH` / `OPENRIG_ROADMAP_PATH` / `OPENRIG_DELIVERY_READY_DIR` 优先于根派生默认；旧版 `RIGGED_STEERING_WORKSPACE`）：

- **priorityStack** —— 逐字 `STEERING.md` 内容 + mtime + 字节数。
- **roadmapRail** —— `roadmap/PROGRESS.md` checkbox 行；检测 `PL-XXX` rail-item 码；把**第一个未勾选**项标为 `isNextUnchecked`。
- **laneRails** —— 每条泳道 `delivery-ready/mode-{N}/PROGRESS.md`：复用 `ProgressIndexer`（maxDepth 3），checkbox 语义与 Progress 视图一致；“next pull” = 第一个非 done、非 blocked 行（Priority Rail Rule——shelf/队列新近度不覆盖）；top-N（默认 3）优先 active+blocked，仅在填满 N 时回退到 done。

缺失来源记入 `unavailableSources`（每条指明能解析它的环境变量），而非使整个负载失败。`isReady()` 在**至少一个**来源可解析时为真。

> 来源：`domain/steering/steering-composer.ts:1-25`（刻意收窄理由 + 三源清单）、`:103-119`（环境变量 + `steeringOptsFromEnv`）、`:155-169`（`isReady` / `compose`）、`:198-250`（roadmap rail；next-unchecked L231-235）、`:282-316`（lane next-pull L288-289、top-N L293-296）、`RAIL_CODE_REGEX` `:346` @HEAD。

`steeringRoutes()`（挂载 `server.ts:510` 为 `/api/steering`）：`GET /` —— 组合负载；未接通时 503 `steering_composer_unavailable`；无来源可解析时 503 `steering_workspace_not_configured` + 指向 `rig config init-workspace` / `workspace.steering_path` / `OPENRIG_STEERING_PATH` 的提示。

> 来源：`routes/steering.ts:18-34`（处理器；503 L23-29）；挂载 `server.ts:510` @HEAD。

> **§10.7 路由现实：** `/steering` 是 **`<Navigate to="/project" />` 重定向桩**——编辑器在后台服务 `/api/steering`；UI URL 并入 Project 工作区概览标签页（Phase 3）。
>
> 来源：`packages/ui/src/routes.tsx:470-474`（“并入 Project 工作区概览标签页（Phase 3）——重定向到 /project”）@HEAD。

## 6. 健康摘要聚合器（OSR v0 第 1F 项）

`computeNodeHealthSummary` / `computeContextHealthSummary` 是 steering 表面上的紧凑健康门——**后台服务侧聚合，不是 CLI shell-out**（无每请求子进程）。节点摘要：经 `getNodeInventory` 逐 rig 跨 rig 汇总 `sessionStatus` + `lifecycleState`，带 `attentionRequired` 计数。上下文摘要：直接读 `context_usage`（ContextUsageStore 仅暴露按节点访问器；列全部行是 steering 表面职责），按紧迫度分桶（`usedPercentage` ≥80 critical / ≥60 warning / 否则 low / null unknown）+ 新鲜度（`sampledAt` 年龄对 300 s → fresh/stale/none）。缺失 `context_usage` 表（无该迁移的测试架）得到空摘要，而非错误。

> 来源：`domain/steering/health-summary.ts:44-46`（阈值：`FRESHNESS_THRESHOLD_S=300`、`URGENCY_CRITICAL_PCT=80`、`URGENCY_WARNING_PCT=60`）、`:48-66`（节点汇总）、`:75-117`（上下文汇总；表缺失 → 空 L81-84）@HEAD。

`healthSummaryRoutes()`（挂载 `server.ts:511` 为 `/api/health-summary`）：`GET /nodes`、`GET /context`；rigRepo 依赖未接通时 503 `health_summary_unavailable`。

> 来源：`routes/health-summary.ts:23-44`（处理器；503 L33,L40）；挂载 `server.ts:511` @HEAD。

## 7. 横切性质

- **文件系统规范、无新 SQLite：** 四个表面都读写文件系统 + JSONL 审计；health-summary 只读既有 `context_usage`。无内容表面迁移（`progress-indexer.ts:21-23`；`health-summary.ts:81-84`）@HEAD。
- **Fail-closed、诚实错误：** 路径安全在 fs 解析前拒绝每次逃逸；写冲突呈现当前 mtime/哈希供显式刷新；缺配置返回 503 + 指明确切环境变量的设置提示——从不是静默空成功（`path-safety.ts:124-169`；`file-write-service.ts:129-135`；`routes/steering.ts:25-29`）@HEAD。
- **原子或无写入：** 同目录临时 + fsync + 原子 rename；rename 失败时目标不动（从无部分写）（`file-write-service.ts:160-172`）@HEAD。
- **编辑器收窄是刻意的：** steering 编辑器只拥有文件系统派生部分；队列/健康来自各自端点——保持可测（`steering-composer.ts:6-16`）@HEAD。

## OPEN 项（保留，不抹平）

- **OPEN-A** —— `~/.openrig/file-edit-audit.jsonl` 的 JSONL 编辑审计按显式设计 **v0 从不轮转**（`file-write-service.ts:24-25`）；无界增长是已知接受的 v0 状态（PRD 第 4 项推迟轮转），在此如实陈述而非抹平。
- **OPEN-B** —— `OPENRIG_FILES_ALLOWLIST` 与 `OPENRIG_PROGRESS_SCAN_ROOTS` 与 `OPENRIG_STEERING_WORKSPACE` 是三个独立操作者配置表面，编码相同但解析独立；v0 没有统一三者的单一“工作区白名单”。源码现实；已记录，未调和。
- 无 slice-00 数字漂移 OPEN（1–5）适用——本模块不携带迁移数/路由组/PL-004 事件数论断。
