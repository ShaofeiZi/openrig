---
kind: as-built
title: 工作区原语 —— RigSpec.workspace、迁移 038/039、Missions/Projects/Slices
status: active
topics: [specification-and-bundles, observability]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  需要了解 rig 如何声明类型化工作区（workspaceRoot / repos / defaultRepo /
  knowledgeRoot）、该块如何持久化并解析进 whoami / node-inventory、逐项
  target_repo 范围如何校验，或文件后端 missions/slices 树如何被索引并投影到
  Project UI。Author-mode 模块——无既有 architecture.md 散文；每条承重论断都在
  HEAD 锚定 file:line。
siblings: [content-surfaces.md, daemon-core.md, ../ui/project-and-for-you.md]
prerequisite-reads: [../README.md, daemon-core.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# 工作区原语 —— RigSpec.workspace、迁移 038/039、Missions/Projects/Slices

**工作区原语（PL-007）**是类型化声明，让 rig 命名*其工作所在处*——一个工作区根、一组带 kind 的命名 repo、一个可选默认 repo、一个可选知识根——并使其经 `whoami` / node-inventory 呈现，门控逐项 repo 范围。与之并行，一棵**文件后端 missions/slices 树**被只读索引并投影到 Project UI 的 mission / slice 表面。

> **AUTHOR-FROM-SOURCE 模块。** 此前无 `architecture.md` 散文。每条承重论断都带 `> Source: <file:line> @HEAD`；歧义声明为 OPEN 项，从不抹平。路径相对 `packages/daemon/src/`，除非前缀为 `packages/` 或 `docs/`。
>
> 已在 HEAD `7eaf524c`（`git describe` → `v0.3.1-6-g7eaf524c`）核验。包版本 **0.3.1**；HEAD 携带 6 个未发布的 release-0.3.2 提交；无 `v0.3.2` 标签（daemon-core.md；slice-00 §1.1）。
>
> **拆分说明（§10.6）。** `workspace-and-content-primitives`（proposed-structure.md §4.9 / D13）诚实的源码锚定范围跨两个不同子系统簇、约 400+ 行，源码根不同。依 §10.6 拆分指令，按子系统簇拆为本模块（工作区原语 + 迁移 038/039 + missions/projects/slices）与兄弟 `content-surfaces.md`（files/markdown/progress/steering）。这是对标已批准 Q7 "18" 的透明标注偏差，忠实应用创始人自己已批准的 Q3 原则（"不同原语 / 不同源码根 → 拆分"）；在 slice-08 评审门呈现，非执行中途打断。

## 0. 版本归属（取证证明——先读）

依 §10.8，在 HEAD 经 `git cat-file -e <tag>:<path>` 重新核验：

| 子系统 | 版本 | HEAD 处取证证明 |
|---|---|---|
| `domain/workspace/{workspace-resolver,frontmatter-validator,default-workspace-scaffold}.ts` | **≤0.3.0** | `v0.3.0:<path>` → 存在 |
| 迁移 `038_workspace_primitive.ts`、`039_queue_target_repo.ts` | **≤0.3.0** | `v0.3.0:<path>` → 存在 |
| `domain/slices/{slice-indexer,slice-detail-projector}.ts` | **≤0.3.0** | `v0.3.0:<path>` → 存在 |
| `routes/{workspace,slices,projects}.ts` | **≤0.3.0** | `v0.3.0:<path>` → 存在 |
| `domain/workspace/getting-started-narrative.ts` | **0.3.1** | `v0.3.0:` → **缺席**；`v0.3.1:` → 存在 |
| `routes/missions.ts` | **0.3.1** | `v0.3.0:` → **缺席**；`v0.3.1:` → 存在 |

> 来源：§10.8 证明在 HEAD `7eaf524c` 重跑——`git cat-file -e v0.3.0:packages/daemon/src/domain/workspace/getting-started-narrative.ts` 与 `...routes/missions.ts` 都失败（"磁盘存在，但不在 'v0.3.0'"）；其他列出路径在 `v0.3.0` 可解析。工作区原语本身是 **0.3.0** 特性（slice-00 0.3.0-GT §1.4，PL-007，迁移 038/039）——不要反向归到 0.3.1。`missions` 路由 + getting-started 叙事脚手架是叠加其上的 **0.3.1** 新增（slice 12 mission 范围；slice 21 onboarding-conveyor）。

slice-00 0.3.0-GT §1.4 独立确认原语随 0.3.0 交付：workspace-primitive 合并 `2ce54abc`（PL-007）带迁移 `038_workspace_primitive` + `039_queue_target_repo`，"新数据库把迁移应用到 `039_queue_target_repo`"。

## 1. 类型化工作区声明（PL-007）—— 0.3.0

`RigSpec.workspace` 是**可选**类型块。无它的 rig 仍有效；`whoami` / node-inventory 在此情况返回 null 工作区块。

> 来源：`domain/types.ts:762-770`（`WorkspaceSpec`）、`:751-758`（`WorkspaceRepoSpec`）、`:780`（`RigSpec.workspace?`）@HEAD。

| 字段 | 形状 | 注 |
|---|---|---|
| `workspaceRoot` | string | 逐字来自 spec |
| `repos[]` | `{ name, path, kind }[]` | `path` 在解析时解析为绝对；作者可在 YAML 中相对 `workspaceRoot` 声明 |
| `defaultRepo?` | string | 无 env 覆盖 / cwd 匹配时的活动 repo |
| `knowledgeRoot?` | string | 呈现时按 `kind=knowledge` 处理 |

`WorkspaceKind` 是封闭 5 成员联合：`user`、`project`、`knowledge`、`lab`、`delivery`。

> 来源：`domain/types.ts:748-749`（`WORKSPACE_KINDS` / `WorkspaceKind`）@HEAD。

### 1.1 持久化 —— 迁移 038 + RigRepository

迁移 **038** 给 `rigs` 表加 `workspace_json TEXT`。rig 声明时以 JSON 保存类型化 `RigSpec.workspace` 块；无工作区块的 rig 为 NULL。

> 来源：`db/migrations/038_workspace_primitive.ts:16-21`（`ALTER TABLE rigs ADD COLUMN workspace_json TEXT`）；doc-comment `:3-14` @HEAD。

`RigRepository.setRigWorkspace(rigId, workspace)` 持久化（UPDATE `workspace_json` + `updated_at`）；`getRigWorkspace(rigId)` 读回，JSON 解析为 `WorkspaceSpec`，解析失败返回 `null`。二者在列缺席时都是**防御性 no-op**（`hasRigColumn` 探测）——绕过规范迁移列表的旧测试 fixture 无该列；setter 契约是"尽力持久化"。

> 来源：`domain/rig-repository.ts:98-105`（setter，列探测 L99）、`:106-117`（getter；解析失败 → null L114-116）@HEAD。

实例器在 rig-create 时**仅当声明**时持久化该块：

> 来源：`domain/rigspec-instantiator.ts:653-655`（`if (rigSpec.workspace) … setRigWorkspace(rigId, rigSpec.workspace)`）@HEAD。

### 1.2 运行时解析 —— workspace-resolver

`resolveWorkspaceContext({ spec, cwd, envOverride })`（由 `whoami-service` 消费）在无 spec 时返回 `WhoamiWorkspaceBlock` 或 `null`。`activeRepo` 解析：`envOverride`（非空、trimmed）**逐字**胜出——即使未知 repo 名也被尊重，因为操作者有意识地设 `OPENRIG_TARGET_REPO`（PL-007 PRD § 第 3 项）；否则 `defaultRepo` **仅当它命名一个已声明 repo 时**使用。`knowledgeKind` 在声明 `knowledgeRoot` 时为 `"knowledge"`，否则 `null`。

> 来源：`domain/workspace/workspace-resolver.ts:26-52`（resolver；env-override-逐字 L34-43，含"honored verbatim"注释 L35-36）@HEAD。

`whoami-service` 读持久化 spec 并用查询的 `targetRepoOverride` 解析，回退 `process.env["OPENRIG_TARGET_REPO"]`：

> 来源：`domain/whoami-service.ts:319-324`（`getRigWorkspace` + `resolveWorkspaceContext`，env 回退 L323）；`whoami` 在负载 `:335` 返回 `workspace` @HEAD。

`resolveNodeWorkspace({ spec, cwd })`（由 `node-inventory` 消费）沿目录树向上走节点 `cwd`，找包含它的**最长前缀 repo 路径**，派生逐节点 `NodeWorkspaceInfo`；cwd 在 `knowledgeRoot` 下时回退 `knowledge`，cwd 解析不出时回退 rig 的 `defaultRepo`。包含用 `path.relative` 边界检查（非字符串 `startsWith`），使 `/foo/bar` 不匹配 `/foo/bar-other`。

> 来源：`domain/workspace/workspace-resolver.ts:57-95`（最长前缀 L67-73；knowledge 回退 L77-79；default-repo 回退 L82-88）、`isInside` `:97-103`；`domain/node-inventory.ts:397`（`workspace: resolveNodeWorkspace(...)`）、`:434-437`（`NodeWorkspaceInfo`）@HEAD。

### 1.3 逐项 repo 范围 —— 迁移 039 + 队列校验

迁移 **039** 给 `queue_items` 加 `target_repo TEXT` 加 `idx_queue_items_target_repo`。操作者传 `--target-repo <name>` 时携带逐项类型化 repo 范围；qitem 对 rig `default_repo` 无歧义或未声明工作区时为 NULL。Mission Control 视图呈现该字段以利跨 rig handoff 清晰。

> 来源：`db/migrations/039_queue_target_repo.ts:16-22`（`ALTER TABLE queue_items ADD COLUMN target_repo TEXT` + `CREATE INDEX … idx_queue_items_target_repo`）；doc-comment `:3-14` @HEAD。

队列路由在路由层对照**源 rig 的** `RigSpec.workspace.repos[]` 校验 `target_repo`：从 `source_session`（`<member>@<rig>`）解析 rig 名，查 rig，读 `getRigWorkspace`，以 `unknown_target_repo` + 已知 repo 列表拒绝未知 repo。无 rigRepo、无可解析 rig、rig 未知或未声明工作区时**fail-open**（`{ ok: true }`）——仅当工作区主动声明 repos 时校验才咬。

> 来源：`routes/queue.ts:49-57`（fail-open 守卫）、`:55`（`getRigWorkspace`）、`:58-66`（`unknown_target_repo` + `knownRepos`）@HEAD。

## 2. 工作区 HTTP 路由 —— frontmatter 校验器（0.3.0）

`workspaceRoutes()`（挂载 `server.ts:491` 为 `/api/workspace`）在 v0 暴露**单个只读端点**：

`POST /api/workspace/validate` —— body `{ root, workspaceKind?, recursive?, requireFrontmatter?, maxFiles? }`；返回 `FrontmatterValidationReport`。`root` 必填（400 `root_required`）；词表外 `workspaceKind` 拒绝 400 `invalid_workspace_kind`；校验器抛错 → 500 `validate_failed`。**无文件系统变更。**

> 来源：`routes/workspace.ts:23-65`（处理器；root 必填 L35-37；kind 枚举 L39-47；500 L59-62）；挂载 `server.ts:491` @HEAD。

`validateWorkspaceFrontmatter()` 遍历根，解析每个 `.md` 文件的 YAML frontmatter（首行 `---` 定界），发出结构化缺口报告——**仅建议，从不改文件**。缺口种类：`missing-required-field`、`unrecognized-status-value`、`parse-error`、`missing-frontmatter`。逐 kind 必填字段：`user`/`project` → `["doc"]`；`knowledge`/`lab`/`delivery` → `["doc","status","created","owner"]`。合法 `status` 枚举：`active|draft|archived|superseded`。默认行为静默跳过无 `---` 文件（非正式笔记），除非 `requireFrontmatter`；默认递归；跳过 `node_modules` / `.git` / `.worktrees` / `dist` / `build`；硬上限 `maxFiles` 默认 10000。

> 来源：`domain/workspace/frontmatter-validator.ts:53`（status 枚举）、`:56-62`（逐 kind 必填）、`:23-27`（缺口种类）、`:90-122`（遍历；跳过目录 L105-111）、`:160-172`（missing-frontmatter 行为）、`:201-226`（必填 + status 检查）@HEAD。

CLI 表面：`rig workspace validate [root]`——v0 刻意窄（仅 `validate`）；未来版本在同一遍历器上加类型 kind 撰写。

> 来源：`docs/as-built/cli-reference.md:931-941` @HEAD。

## 3. 默认项目工作区脚手架

`workspaceScaffoldDirs()` / `workspaceScaffoldFiles()` 产出 repo-ready 默认工作区（`~/.openrig/workspace/` 或 `--root`）。同一脚手架被**后台服务启动幂等使用**。它恰好发出两个目录（`missions/`、`exhaust/`）与四个文件（`SPEC.md`、`project.yaml`、`workspace.yaml`、`.gitignore`）。目录把单一默认项目指向 `.`；`project.yaml` 拥有项目意图与 mission 发现，并暴露空 `install.context` / `install.skills` 选择器。忽略文件排除 `exhaust/` 与本地 `.openrig/` 投影状态，同时保持 authored 项目上下文可版本化。

工作区所有者由 CLI daemon start 与直接 daemon 首次启动所用共享实例初始化器调用。初始化器是加法。它从不删除或覆盖既有文件；保留的 `--force` 拼写是覆盖行为的兼容 no-op。CLI 与 daemon 脚手架字节对等钉住。Mission 与 slice 内容经 `rig scope` 显式创建，不由工作区初始化播种。实例上下文、System World、skill 源、运行时状态，以及已退役 `artifacts/`、`evidence/`、`progress/`、`field-notes/`、`dogfood-evidence/`、`README.md`、`STEERING.md` 条目不发出。

> 来源：`domain/workspace/default-workspace-scaffold.ts`（`workspaceScaffoldDirs`、`workspaceScaffoldFiles`）；CLI `domain/instance-initialization.ts`；daemon `index.ts`；CLI `packages/cli/src/daemon-lifecycle.ts` 与 `packages/cli/src/commands/config-init-workspace.ts`（`runInitWorkspace`）；对等：`packages/daemon/test/getting-started-narrative-parity.test.ts` @HEAD。

## 4. 文件后端 missions / slices 树

### 4.1 SliceIndexer（Slice Story View v0）—— 0.3.0

`SliceIndexer` 从配置的文件系统根读 slice 文件夹。**默认工作区契约**是 `workspace/missions/<mission>/slices/<slice>`；显式配置的扁平根（`workspace/slices/<slice>`）为兼容保留支持。嵌套 `slices/` 子目录使父目录成为 mission（`missionId = <mission-folder>`）；裸文件夹是扁平 slice（`missionId = null`）。**无**新 SQLite 迁移，**无**新事件类型：对既有表（`queue_items`、`queue_transitions`、`mission_control_actions`）+ dogfood-evidence 目录做只读投影。有界时间列表 + 详情缓存（`invalidate()` 二者都丢）。任何配置 slice 根在磁盘存在时 `isReady()` 为真。

> 来源：`domain/slices/slice-indexer.ts:1-14`（契约 + 无新状态）、`:174-176`（`isReady`）、`:179-182`（`invalidate`）、`:212-256`（`readSliceLocations`；嵌套 vs 扁平 L233-253）、`:62-89`（`SliceListEntry` 形状：`missionId` / `slicePath` / `qitemIds` / `proofPacket`）@HEAD。

### 4.2 SliceDetailProjector（Slice Story View v0 + v1）—— 0.3.0

给定 `SliceRecord`，projector 跨六个标签（Story、Acceptance、Decisions、Docs、Tests/Verification、Topology）组装完整逐 slice 负载。只读；组合已交付表 + `workflow_specs`/`workflow_instances`/`workflow_step_trails` + 磁盘 slice 文档 + dogfood-evidence。**v1 移除 v0 硬编码旧版 phase 枚举**（`discovery`/`product-lab`/`delivery`/…）：`StoryEvent.phase` 现为开放 string-or-null——绑到 `workflow_instance` 时是 spec 定义 `step.id`，否则 `null`（UI 在 "Untagged" 下分组）。无 workflow runtime 构造时 projector 静默降级到 v0 行为（`workflowBinding=null`、`specGraph=null`）。

> 来源：`domain/slices/slice-detail-projector.ts:1-21`（六标签契约 + v1 富集）、`:18-21`（v0 phase 枚举在 v1 移除）；启动降级路径 `startup.ts:1063-1076`（projector 用 `workflowRuntime?.specCache` 构造；注释 L1064-1071）@HEAD。

### 4.3 Slices 路由 —— 0.3.0

`slicesRoutes()`（挂载 `server.ts:501` 为 `/api/slices`）：`GET /`（过滤 `all|active|done|blocked`，默认 `all`；`?refresh=1` 失效；可选 `?boundToWorkflow=<name>:<version>` 透镜收窄到绑到 workflow 实例的 slice）、`POST /refresh`（丢两个 indexer 缓存——无后台服务重启）、`GET /:name/proof-asset/*`（路径遍历守卫；不可变 1 天缓存）、`GET /:name/doc/*`（Docs 标签 markdown；遍历守卫）、`GET /:name`（完整逐标签负载）。未接通时 503 `slices_indexer_unavailable`；未就绪时 503 `slices_root_not_configured` + 设置提示。**路由顺序纪律：** 字面 `/` / `/refresh` / `/:name/proof-asset/*` / `/:name/doc/*` 在动态 `/:name` **之前**注册，以免被遮蔽。

> 来源：`routes/slices.ts:31-177`（处理器；路由顺序 L34-35、L101-102、L109-113、L166-167；503 L38-44；`boundToWorkflow` L60-86）；挂载 `server.ts:501` @HEAD。

### 4.4 Missions 路由 —— **0.3.1**（slice 12 + slice 13 + slice 18）

`missionsRoutes()`（挂载 `server.ts:505` 为 `/api/missions`）是 mission 范围数据层。`GET /:missionId` 返回 `{ missionId, missionPath, slices, workflow_spec, topology, status }`——slices 按 `missionId` 从 SliceIndexer 过滤；`missionPath` 从任一 slice 的 `slicePath` 上溯两级派生；`workflow_spec` 从 `<missionPath>/README.md` frontmatter 懒解析（slice-indexer 用同一 `parseWorkflowSpecRef` 辅助）；`topology.specGraph` 在 spec 缓存时经 `projectSpecGraph(spec, null)` 投影，声明但未缓存时 `{ specGraph: null }`，未声明时 `null`；`status` 从 README frontmatter 读。`POST /:missionId/complete` 把 `status: complete` 写入 mission README frontmatter（幂等；保留无关字段）——后台服务是审计轨迹表面，UI 保留乐观 localStorage 镜像。无 slice 匹配时 404 `mission_not_found`。

> 来源：`routes/missions.ts:39-118`（处理器）、`:124-142`（`writeMissionStatusComplete`）、`:148-150`（`computeMissionPath` 上溯两级）、`:171-177`（`readMissionWorkflowSpec`）、`:205-215`（`computeMissionTopology`）；挂载 `server.ts:505`；§0 证明：`routes/missions.ts` 在 v0.3.0 缺席 ⇒ HEAD 处为 **0.3.1**。

### 4.5 Projects 路由 —— 协调 L2 classifier（PL-004 Phase B）—— 0.3.0

`projectsRoutes()`（挂载 `server.ts:492` 为 `/api/projects`）支撑 `rig project` CLI 动词——这是 **PL-004 Phase B 项目 classifier**（租约生命周期 + 幂等 classify + 操作者动词 reclaim + SSE），**不是** Project *工作区 UI*（那是上面的 slices/missions 表面；命名重叠是已记录接缝）。端点：`POST /lease/acquire`（可选 `evaluateDeadnessFirst` 先清 stale/dead 租约）、`POST /lease/heartbeat`、`POST /reclaim-classifier`、`POST /project`（按 `stream_item_id` 幂等）、`GET /lease`、`GET /list`、`GET /sse` + `GET /watch`（SSE）、`GET /:projectId`。**路由顺序纪律：** 字面 `/lease`、`/list`、`/sse`、`/watch` 在裸 `/:projectId` 通配**之前**注册（Phase A R1 SSE 教训）。

> 来源：`routes/projects.ts:18-194`（处理器；路由顺序注 L15-17、L140-141、L158-159、L185）；错误码 → HTTP 映射 `:31-52`；挂载 `server.ts:492` @HEAD。

## 5. UI 路由现实（§10.7——在 routes.tsx@HEAD 源码核验）

`packages/ui/src/routes.tsx` 共 **542 行**，用 TanStack Router（`createRoute({ path, component })` 对象），**不是** JSX `<Route>`。Phase-8.1 调查的 grep 派生 missions/projects 期望在此对照 routes.tsx 现实更正：

| 调查期望 | routes.tsx@HEAD 现实 | routes.tsx:NN |
|---|---|---|
| `/project`（工作区） | **真实路由** —— `WorkspaceScopePage` | `:128-131` |
| `/project/mission/$missionId` | **真实路由** —— `MissionScopePage` | `:134-137` |
| `/project/slice/$sliceId` | **真实路由** —— `SliceScopePage` | `:140-143` |
| `/files` | **真实路由** —— `FilesWorkspace`（见 content-surfaces.md） | `:192-195` |
| `/mission-control` | **`<Navigate to="/for-you" />`** 重定向桩（按 SC-18 删除；Mission Control *系统* 在后台服务/PL-005，非 UI 目的地） | `:440-444` |
| `/slices` | **`<Navigate to="/project" />`** 重定向桩（按 project-tree.md 删除） | `:447-451` |
| `/slices/$name` | **`<Navigate to="/project/slice/$sliceId" />`** 重定向桩 | `:453-460` |
| `/progress` | **`<Navigate to="/project" />`** 重定向桩（并入 Project 标签页，Phase 3） | `:464-468` |
| `/steering` | **`<Navigate to="/project" />`** 重定向桩（并入 Project 工作区概览标签页，Phase 3） | `:470-474` |
| `/missions`（顶层） | **无路由** —— missions 仅经 `/project/mission/$missionId` 到达 | （缺席） |
| `/markdown` | **无路由** —— markdown 是 file/drawer 表面中组件，非目的地（见 content-surfaces.md §4） | （缺席） |

> 来源：`packages/ui/src/routes.tsx:90-195`（真实路由）、`:435-474`（重定向桩块；每个 `<Navigate>` + DELETED/folds 注释）、`:476-490`（路由树）@HEAD。grep 确认缺席：HEAD 处 routes.tsx 中无任何 `path: "/missions"` / `path: "/markdown"` 声明。

§10.7 净裁定：后台服务 `/api/missions` + `/api/slices` + `/api/projects` 路由真实且承重；**操作者面向 UI** 仅经 `/project*` 目的地消费。`/mission-control`、`/slices`、`/progress`、`/steering` 是重定向桩（系统存在于后台服务层，URL 被并入 `/project` / `/for-you`）。

## 6. 横切性质

- **可选 + 无之亦有效：** 无 `workspace` 块的 rig 仍有效；whoami / node-inventory / queue-target-repo 全返回 null / fail-open（`workspace-resolver.ts:32`；`rig-repository.ts:99,107`；`routes/queue.ts:55`）@HEAD。
- **防御性列探测：** 每次 `workspace_json` / `target_repo` 访问都在列存在上门控，使部分测试 fixture 不崩（`rig-repository.ts:99,107`；迁移 038/039 分别交付，使 fixture 可只应用其所需半——`038.ts:11-14`）@HEAD。
- **只读投影，树无新状态：** SliceIndexer / SliceDetailProjector 不加迁移 / 事件类型；仅工作区声明（038）+ 逐项范围（039）碰 SQLite（`slice-indexer.ts:12-14`）@HEAD。
- **建议性，从不变更：** frontmatter 校验器与 init-workspace 脚手架从不删操作者内容（`frontmatter-validator.ts:12-13`；`config-init-workspace.ts:12-16`）@HEAD。

## OPEN 项（保留，不抹平）

- **OPEN-A** —— `resolveWorkspaceContext` **逐字**尊重 `envOverride`，即使它未命名已声明 repo（`workspace-resolver.ts:34-43`，按 PL-007 PRD § 第 3 项显式设计），而队列路由对照同一 `repos[]` **拒绝**未知 `target_repo`（`routes/queue.ts:58-66`）。这两个表面对未知 repo 名施加相反策略（whoami 信任操作者；队列校验）。原样陈述——不对称按所引注释是源码现实且刻意，但分歧未在源码调和。
- **OPEN-B** —— `/api/projects` *classifier*（PL-004 Phase B）与 `/project*` *工作区 UI*（slices/missions）共享 "project" 一词但为无关子系统。记为命名接缝；非源码缺陷。
- 无 slice-00 数字漂移 OPEN（1–5）适用——本模块不携带迁移数 / 路由组 / PL-004 事件数论断（那些落在 daemon-core / coordination-primitive / architecture-rules）。
