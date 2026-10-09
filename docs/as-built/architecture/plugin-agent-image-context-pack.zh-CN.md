---
kind: as-built
title: 内容层 —— 插件、智能体镜像、上下文包、压缩策略
status: active
topics: [extension-and-user-workspace, continuity, skill-management]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  需要了解 OpenRig 如何发现插件、捕获/fork 智能体镜像、组装/发送上下文包，
  或 Claude auto-compaction 强制器如何决定发送 /compact。Author-mode 模块——
  无既有 architecture.md 散文；每条论断都在 HEAD 锚定 file:line。
siblings: [packaging-bootstrap-bundles.md, agent-spec-and-startup.md]
prerequisite-reads: [../README.md, agent-spec-and-startup.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# 内容层 —— 插件、智能体镜像、上下文包、压缩策略

后台服务发现并服务的四个文件系统规范内容原语：**插件**、**智能体镜像**、**上下文包**，以及 **Claude auto-compaction 策略强制器**。四者都不新增 SQLite 状态——全部文件系统规范，带后台服务内存缓存。

> **AUTHOR-FROM-SOURCE 模块。** 此前无 `architecture.md` 散文。每条承重论断都带 `> Source: <file:line> @HEAD`；歧义声明为 OPEN 项，从不抹平。路径相对 `packages/daemon/src/`，除非前缀为 `docs/`。
>
> 已在 HEAD `7eaf524c`（`git describe` → `v0.3.1-6-g7eaf524c`）核验。包版本 **0.3.1**；HEAD 携带 6 个未发布的 release-0.3.2 提交；无 `v0.3.2` 标签（daemon-core.md；slice-00 §1.1）。

## 0. 版本归属（取证接缝——先读）

经 `git cat-file -e <tag>:<path>` 在 HEAD 重新核验：

| 子系统 | 版本 | HEAD 处取证证明 |
|---|---|---|
| 上下文包 | **0.3.0** | `v0.3.0:domain/context-packs/context-pack-library-service.ts` → 存在（slice-00 0.3.0-GT §1.9） |
| 智能体镜像 | **0.3.0** | `v0.3.0:domain/agent-images/agent-image-library-service.ts` → 存在（slice-00 0.3.0-GT §1.9） |
| 插件 | **0.3.1，不是 0.3.0** | `v0.3.0:domain/plugin-discovery-service.ts` → **缺席**；`v0.3.1:` → 存在（slice-00 0.3.0-GT seam (a)；map 行 5） |
| Claude auto-compaction | **0.3.1 头条，无 0.3.0 前身** | `v0.3.0:domain/claude-compaction-enforcer.ts` → **缺席**；`v0.3.1:` → 存在（slice-00 0.3.0-GT map 行 7） |

> 来源：在 HEAD `7eaf524c` 重跑——`git cat-file -e v0.3.0:packages/daemon/src/domain/plugin-discovery-service.ts` 与 `...claude-compaction-enforcer.ts` 都失败（“磁盘存在，但不在 'v0.3.0'”）；两个 0.3.0 库服务在 `v0.3.0` 可解析。磁盘 HEAD 处存在的代码**不**使插件/压缩成为 0.3.0 特性——祖先关系才是真相；同一日历日提交日期正是 slice-00 0.3.0-GT seam (a) 警告的取证陷阱。

**不要把插件或压缩反向归到 0.3.0。** CLI 参考已编码此点（“## Plugin Inspection (v0.3.1)”）。

> 来源：`docs/as-built/cli-reference.md:943` @HEAD。

## 1. 上下文包（PL-014）—— 0.3.0

**上下文包**是一个含 `manifest.yaml` + 所含 markdown / yaml / txt 文件的目录：操作者撰写、库可发现、可评审、可组合。`rig context` 名词无投递。无 SQLite 表；后台服务作用域内存缓存。

> 来源：`domain/context-packs/context-pack-types.ts:1-11` @HEAD。

`ContextPackLibraryService.scan()` 遍历根，解析每个 `manifest.yaml`，替换内存索引；碰撞按发现顺序**后者胜出**（workspace > user_file > builtin）。启动接线 builtin 根（`../context-packs`，最先）、配置的 user-file 根（`context.root`，默认 `$OPENRIG_HOME/context`）、其 `system/` 子目录作为规范 System World 根，以及存在且不同的 workspace 本地 `<workspaceRoot>/.openrig/context-packs` 根。包由其类路径 **ref** 寻址（如 `packs/compaction-restore`），它是其唯一身份；不透明条目 id 是 `context-pack:<ref>`（UI 路由键）。冒号 id `context-pack:<name>:<version>` 寻址与 `/library/:id` 路由在 Slice-03 Atom 5 移除。解析仅经 `getByRef` 按 ref 与读/删/预览/片段路由族。启动仅接受普通文件并拒绝上下文包展开；先组合持久 ref，再在需要投递时用专门投递动词。

> 来源：`domain/context-packs/context-pack-library-service.ts:59-94`（scan；后者胜出 L79-81）、`:31-33`（id）；`startup.ts`（`contextPackLibrary` 构造）@HEAD。

解析器纯（无 fs；调用方传原始 YAML）。它拒绝畸形 YAML、缺 `name`/`version`、非数组 `files`、逐文件路径遍历（`..`/前导 `/`）与不支持后缀（`.md .markdown .yaml .yml .txt`）；`version` 强转为字符串。逐文件 token 估计为 `ceil(bytes/4)`。

> 来源：`domain/context-packs/manifest-parser.ts:11`（后缀）、`:13-121`（拒绝；遍历 `:83-89`）；token 估计 `context-pack-library-service.ts:46-48` @HEAD。

`assembleBundle` 把文件拼成一段可直接粘贴字符串，框为 `# OpenRig Context Pack: <name> v<version>` + 可选 purpose + `## File: <path> (role: <role>)` 头。缺失文件**跳过并在 `missingFiles` 呈现**（操作者修复），不硬失败；存在但不可读的文件抛 `file_read_failed`。

> 来源：`domain/context-packs/bundle-assembler.ts:38-39`（前缀）、`:73-100`（缺失跳过 L74-76；读失败抛错 L81-87）@HEAD。

`contextPacksRoutes()` 暴露 ref 优先、无投递的库表面：`GET /library`、`POST /library/sync`、`POST /library/compose`、`GET/DELETE /library/by-ref`、`GET /library/by-ref/preview`、`GET /library/by-ref/pieces`。preview 返回组装的评审形状；pieces 返回有序成员内容加全文纯文本与字节大小。无包自有投递路由。CLI 库动词为 `rig context compose|list|show|preview|sync|add|rm`；投递属于 `rig send --context`、`rig broadcast --context`、`rig walk --through` 与 `rig queue create --body-context`。

> 来源：`routes/context-packs.ts`（完整路由表）；`domain/startup-validation.ts`（仅文件启动契约）；`packages/cli/src/commands/context.ts`、`send.ts`、`broadcast.ts`、`walk.ts`、`queue.ts` @HEAD。

## 2. 智能体镜像（PL-016）—— 0.3.0

**智能体镜像**是一个生产力席位可恢复状态的快照 bundle：运行时专属 resume token（Claude `resume_token` / Codex `thread_id`）、源席位谱系、可选 cwd 增量 + 备注。可由 AgentSpec `session_source: mode: agent_image` 消费。文件系统规范于 `~/.openrig/agent-images/<name>/` + workspace 本地；**无 SQLite 表**。

> 来源：`domain/agent-images/agent-image-types.ts:1-13` @HEAD。

`AgentImageLibraryService` 镜像 `ContextPackLibraryService`（scan / list / get / 后者胜出），有三处源声明差异：`sourceResumeToken` 透传给消费者（实例器消费；操作者表面脱敏）；`stats.json` 是独立可变文件，在 fork 计数递增时原子更新；`.pinned` 哨兵钉住不被剪枝。id 为 `agent-image:<name>:<version>`。

> 来源：`domain/agent-images/agent-image-library-service.ts:5-14`（3 差异注释）、`:38-41`（id）@HEAD。

`discoverResumeToken(db, sourceSession)` 先查 `sessions` 再查 `nodes`，返回类型化失败（`session_not_found`/`runtime_unsupported`）而非编造 token；仅 `claude-code`/`codex` 有原生 fork 原语。Claude 优先用 `context_usage.session_id` 而非持久 `sessions.resume_token`；Codex 用 `resume_token`，`external_cli` 席位回退到 binding 的 `external_session_name`；无时诚实返回 `nativeId: null`。

> 来源：`domain/agent-images/resume-token-discovery.ts:37-85`（诚实 null L84；Claude 优先 L64-69；external_cli L78-83）；诚实注释 `:9-10` @HEAD。

`SnapshotCapturer.capture()` 经 `discoverResumeToken` 路由，失败或缺原生 id 时抛 `AgentImageError`（不编造 token，不自动回退到 fresh），经 `install()` 写 manifest + 空 `stats.json`，重新扫描。捕获的 `nodeCwd` → manifest `source_cwd`，使 Use-as-starter 片段发出 `cwd:`（fork 在父目录启动，即 Claude 项目目录作用域 jsonl 所在处）；后台服务**不**在 fork 派发时覆盖 cwd。

> 来源：`domain/agent-images/snapshot-capturer.ts:60-104`（抛错 L65-79；source_cwd L88-93；install+scan L101-102）；`routes/agent-images.ts:256-265`（不覆盖 cwd 契约）@HEAD。

**证据守卫（CATASTROPHIC-bounce；fail closed）。** `evaluateProtection()` 在任一条件成立时保护镜像不被删除：已钉住；被活跃 `agent.yaml` 引用；被 rig spec 引用；或为受保护镜像的谱系后代（传递，不动点迭代）。Spec 根扫描解析 YAML 结构（非字符串 grep），刻意保守——误报（过度保护）可接受；漏报 = 灾难性数据丢失。`--force` / `?force=true` 覆盖。

> 来源：`domain/agent-images/evidence-guard.ts:1-16`（bounce + fail-closed）、`:53-115`（直接 + 传递；不动点 L92-112）、`:117-122`（保守）@HEAD。

**路由边界处 resume-token 脱敏（承重）。** `/api/agent-images` 在每条操作者面向路径上把 `sourceResumeToken` 脱敏为 `"(redacted)"`；token **从不上线返回**；仅进程内 rigspec 实例器消费真 token。

> 来源：`routes/agent-images.ts:15-17` + `:44-46`（`redactResumeToken`），应用于 `:60`、`:67`、`:94`、`:161`；slice-00 0.3.0-GT §1.9 在 HEAD 标记此点承重。

`agentImagesRoutes()`（挂载 `server.ts:483-485`）：`GET /library`、`POST /library/sync`、`GET /library/:id`、`GET /library/:id/preview`、`POST /library/:id/pin`、`POST /library/:id/unpin`、`DELETE /library/:id`（除非 `force=true` 否则证据守卫）、`POST /snapshot`、`POST /prune`（**默认 dry-run**，`dryRun !== false`）；守卫 `specRoots` 经 `deps.agentImageSpecRoots` 注入。CLI：`rig agent-image list|show|preview|create|delete|pin|unpin|prune|sync`。

> 来源：`routes/agent-images.ts:54-250`（表；prune 默认 L112；delete-guard L224-239）；`server.ts:483-485`；`docs/as-built/cli-reference.md:895-912` @HEAD。

## 3. 插件（plugin-primitive Phase 3a）—— **0.3.1，不是 0.3.0**

> **取证陷阱（slice-00 0.3.0-GT seam (a)）：** plugin-discovery 文件的首次创建提交日期与 0.3.0 发布提交同日，但**不是** `v0.3.0` 的祖先。插件是 **0.3.1**。已在 HEAD 经 §0 标签存在测试重新确认。

`PluginDiscoveryService` 是只读文件系统聚合器——无 SQLite、无变更路由（SC-29 EXCEPTION #8，在源码头逐字声明）。它扫描四种源种类，带来源标签 union：vendored（`~/.openrig/plugins/<id>/`）、Claude 缓存（`~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`）、Codex 缓存（`~/.codex` 下同形）、rig-cwd（`<cwd>/.claude/plugins/*` + `<cwd>/.codex/plugins/*`）。检测 = 存在 `.claude-plugin/plugin.json` 和/或 `.codex-plugin/plugin.json`（声明 `runtimes`）。Slice 28 在列表响应加 `skillCount`（readdir `<plugin>/skills/`），使索引页避免 N+1 详情抓取（SC-29 EXCEPTION #11，逐字）。

> 来源：`domain/plugin-discovery-service.ts:1-29`（SC-29 #8 + 扫描描述）、`:39`（4 种 `PluginSourceKind`）、`listPlugins` `:205-276`（4 扫描块）、`scanCwdBundledPlugins` `:283-307`、`detectPlugin` `:393-453`（标记规则 L399-404；`skillCount` L433-451 + #11 L75-80）@HEAD。

`getPlugin(id)` 返回详情（manifests + skills + hooks + MCP 服务器）；`rig-cwd:` id 可自解析（从 id 前缀解析出 cwd 并重扫，使 `/api/plugins/:id` 不对 `?cwd=` 返回的 id 404）。`findUsedBy(id)` 遍历 `agent.yaml` 文件解析 YAML 结构（非字符串 grep——注释不误报）收集 `resources.plugins[].id` + 引用 profile。

> 来源：`domain/plugin-discovery-service.ts:309-369`（getPlugin；rig-cwd 自解析 L310-321）、`extractCwdFromRigCwdId` `:466-479`、`findUsedBy` `:371-389`、`readResourcesPlugins` `:599-615`、`readProfilesUsingPlugin` `:617-633`（结构非 grep `:20-23`）@HEAD。

`PluginVendorService.ensureLatest()` 运行 `ensureVendored`（从 `packages/daemon/assets/plugins/<name>/` 哈希跳过幂等拷贝到 `~/.openrig/plugins/<name>/`）后 `attemptAutoFetch`（`github.com/mvschwarz/openrig-plugins`，5 秒超时，**404/网络/超时静默容忍**——vendored 永远是回退；上游仓库在 v0 刻意为空，故 404 是常态；v0 不解压 tarball）。启动为 `openrig-core` 接线。

> 来源：`domain/plugin-vendor-service.ts:1-24`、`ensureVendored` `:80-103`（哈希跳过 L97-99）、`attemptAutoFetch` `:111-131`（404 容忍 L116-117；不解压 L123-125）、`ensureLatest` `:138-141`；`startup.ts:434-472` @HEAD。

`pluginsRoutes()`（挂载 `server.ts:478`，只读）：`GET /`（过滤 `?runtime=`、`?source=`、`?cwd=`）、`GET /:id/used-by`、`GET /:id/files/list?path=`、`GET /:id/files/read?path=`（slice 28 文档浏览器）、`GET /:id`。字面子路径挂载在裸 `/:id` 通配**之前**（路由顺序纪律）。files 端点复用路径安全机制，以发现插件的绝对路径作为合成单根白名单（操作者无需在 `OPENRIG_FILES_ALLOWLIST` 声明插件路径；v0 插件文件夹只读，故内容哈希仅信息性）。CLI：`rig plugin list|show|used-by|validate`；v0 无 `install` 动词（推迟到 0.3.2）。

> 来源：`routes/plugins.ts:29-39` + `:107-231`（表；通配前 L128-130/L141-142；`pluginRootAllowlist` :74-92；只读哈希 L182-184）；`server.ts:478`；`docs/as-built/cli-reference.md:943-963` @HEAD。

> **OPEN-A** —— `parseSourceFilter`（`routes/plugins.ts:69-72`）仅接受 `vendored|claude-cache|codex-cache`；它**不**接受 `rig-cwd`，尽管 `PluginSourceKind`（`domain/plugin-discovery-service.ts:39`）与 `ListPluginsOpts.sourceFilter` 含之。`?source=rig-cwd` 在路由被静默丢弃，而 `?cwd=` 仍无过滤地呈现 rig-cwd 条目。原样陈述；意图（rig-cwd 仅经 `?cwd=` 可达）vs 过滤缺口无法仅凭源码解决。

## 4. Claude auto-compaction 强制器（slice 27）—— **0.3.1 头条**

> **无 0.3.0 前身（slice-00 0.3.0-GT map 行 7）。** 强制器文件在 `v0.3.0` 缺席，在 `v0.3.1` 存在（§0）。

`ClaudeCompactionEnforcer.maybeAutoCompact()` 逐席位决定 `ContextMonitor` 是否应发 `/compact`，由操作者 `policies.claude_compaction.*` 设置驱动。与 `ContextMonitor` 调度解耦；`ContextMonitor` 在启动时用强制器构造。

> 来源：`domain/claude-compaction-enforcer.ts:7-12`、`maybeAutoCompact` `:205-331`；`startup.ts:1191-1199`（强制器 → `new ContextMonitor(db, contextUsageStore, claudeAdapter, compactionEnforcer)`）@HEAD。

**防御契约**（源码按已存权限层 foot-gun 规则把压缩生命周期分类为承重）：

- **Opt-in，默认关：** `enabled=false` → 从不触发。
- **运行时过滤：** 仅当 `runtime === "claude-code"` 触发。
- **无效策略 = 禁用：** 手编非整数 / 越出 `[1,100]` 的 `thresholdPercent` 被视为禁用（更安全失败）。
- **经阈值穿越重新武装：** 会话须先跌破阈值才再触发一次 auto-compact；窗口状态**不**持久化（重启重置——更安全失败方向）。
- **发送失败优雅降级：** 返回 `{ triggered: false, reason: "send_failed" }`，从不抛错；去重时间戳仅在成功发送时设置，使瞬时失败在下一拍重试。

> 来源：`domain/claude-compaction-enforcer.ts:14-44`（风险类 + 契约）、运行时 `:206-208`、无效策略 `:224-232`、去重/阈值 `:285-300`、发送失败 `:312-314`/`:323-325` @HEAD。

**活跃握手状态机**（Claude hooks 可提供上下文但不创建新 assistant turn）：(1) **pre-compact 准备** —— 首个合格的超阈值拍发送正常用户通道准备提示；状态 → `prep_prompt_sent`。(2) **/compact** —— 下个合格拍发送 `/compact <instruction> + 信任通道桥接注记`；设去重时间戳 + `triggeredAboveThreshold`；排队后阶段 `turn_boundary`。(3) **post-compact，低于阈值** —— 分阶段发 `turn_boundary`（仅 ack）→ `restore_prompt`（指向待处理标记 `<openrigHome>/compaction/restore-pending/<key>.json`，转录/会话 id 回退）→ `compliance_prompt`（读深审计）；最终阶段设 post-restore 冷却 + 清除超阈值锁存。

> 来源：`domain/claude-compaction-enforcer.ts:71-77`（compact+bridge）、`:79-98`（prep）、`:108-145`（restore + 标记路径）、`:147-163`（compliance）、`:165-171`（turn 边界）、状态机 `:233-330`（低于阈值 L233-283；高于阈值 L302-330）@HEAD。

策略字段经 `SettingsStore.resolveClaudeCompactionPolicy()`：`enabled`、`thresholdPercent`、`preCompactInstruction`、`compactInstruction`、`messageInline`、`messageFilePath`、`postRestoreAuditInstruction`——各自由 `policies.claude_compaction.*` 键 + `OPENRIG_POLICIES_CLAUDE_COMPACTION_*` 环境变量覆盖支撑。默认：去重 `60_000` ms；post-compact restore 冷却 `10 * 60_000` ms。

> 来源：`domain/user-settings/settings-store.ts:553-565`（resolver）、键 `:97-103`、env `:145-151`；`domain/claude-compaction-enforcer.ts:45-46`（默认窗口）@HEAD。

## 5. 横切性质

- **文件系统规范，四者均无新 SQLite**；后台服务内存缓存；压缩窗口状态刻意不持久化（context-pack-types.ts:8-11；agent-image-types.ts:12-13；routes/plugins.ts:6；claude-compaction-enforcer.ts:26-29）@HEAD。
- **诚实失败，不编造** —— 发现返回 null；捕获器抛错；强制器降级 + 从不抛错；证据守卫 fail closed（resume-token-discovery.ts:9-10；snapshot-capturer.ts:11-12；claude-compaction-enforcer.ts:30-33；evidence-guard.ts:16）@HEAD。
- **无供应时 503** 是后端服务不在上下文时统一路由模式（routes/context-packs.ts:31；routes/agent-images.ts:59；routes/plugins.ts:113）@HEAD。

## OPEN 项（保留，不抹平）

- **OPEN-A** —— 插件 `?source=` 过滤漏 `rig-cwd`（§3）；意图 vs 过滤缺口无法仅凭源码解决。
- 无 slice-00 数字漂移 OPEN（1–5）适用——本模块不携带迁移 / 路由组 / PL-004 事件计数。slice-00 0.3.0-GT OPEN-3（For-You 动词子集）超出范围（UI 表面，非内容层）。
