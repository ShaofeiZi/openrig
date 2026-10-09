---
kind: as-built
title: Living Notes 评审表面 —— intent→plan→delivered 投影
status: active
topics: [knowledge-and-context, observability, sdlc]
domains: [engineering-advisor, operating-advisor, product-advisor]
applies-when: |
  正在开发或消费组合出的 slice/mission 评审表面——/api/review/* 路由、
  ComposedSliceReview 契约、它所投影的磁盘 SDLC 约定、staged-approval 锁、
  证明工件与 C1 头、freeze 导出、评审证据的媒体服务，或跨 host FLEET
  聚合（/api/review/fleet，fleet composer 的 union/one-count 接缝，v0.4.6 MH-5）。
siblings: [content-surfaces.md, workspace-primitive.md, mission-control.md]
prerequisite-reads: [workspace-primitive.md]
last-verified-against-source: c8341f72
last-updated: 2026-07-08
---

# Living Notes 评审表面（v0.4.4）

评审表面是**把磁盘 markdown 纯投影成每个 slice 一个可评审结构**：INTENT → PLAN → DELIVERED。智能体改文件；后台服务重新投影；此处除两处刻意的审批戳与 freeze 导出外，不写任何产品状态。随 0.4.4 living-notes 切片交付（19 信号层、20 composer/表面、22 rig agents 高度、23 SDLC 运营化），以及把表面收敛到此处所述单一结构的**纠正性重建**（2026-07-05/06）。下文一切在 `bb5ad219` 核验。

## 1. 唯一契约 —— `ComposedSliceReview`

`packages/daemon/src/domain/review/types.ts` 定义所有消费者共享的读契约（slice Review 标签页、mission U5 行展开、For-You 展开——从不为每消费者开第二个端点）：

- **identity + phase**：`slice`、`sliceId`、`title`、`missionId`、`phase`（五向，读时派生：`locked > review > building > spec > intent`，`compose.ts` 中 `derivePhase`）、`laneLabel`（SS14 词汇 INTENT / PLAN / BUILD / REVIEW / LOCKED）。
- **`intent`**：`{text, media[], ssotPath, degrade}`——slice README 的 `## Intent` 节逐字（`extractSection`），加其内嵌入的任何媒体。
- **`plan`**：`{concise: {text, media[]}, lockedArtifacts[], lock, ssotPath}`——PRD 的 pinned `## Mini-requirements` 层 + 计划 mockup；pinned 工件集是一次 **frontmatter 读取**（slice README 上 `locked-artifacts:` 列表——无新写机制）；`lock` 是 spec 作用域 staged-approval 戳（§3）。
- **`delivered`**：`{items[], extraProof[], lock, proofDirPath}`——重新设计的 join（§4）：每个 `## Proof contract` 交付物配对其策展证明媒体与 QA 记录的比较信号。`lock` 是 delivery 作用域戳；`proofDirPath` 是通往完整 fix-loop 历史的钻入门。
- **保留的正交带**：`needsYou`（两源一队列：智能体路由项 ∪ 派生 ▲ 异常带内联证据）、`agents`（作用域参数化 `slice:<id> | mission:<id> | rig`——一个契约，所有作用域）、`lineage`（`VerifyLineage`：候选/合并/tip 事实 + 四个门 `VerdictCell` 逐字渲染记录 token）、`defects`（slice 外媒体引用被呈现，从不静默丢弃）、`composedAt`。

**被纠正删除（2026-07-05，创始人否决原版）：** 四个并行可渲染结构（`sections`、`acceptance`、`compare`、`join`）与同列 `green` 字段。它们在类型、composer 输出、UI hook、fixture 中均不存在；后台服务路由测试断言线上**无**这些键（`test/review-composer.test.ts`、`test/review-routes.test.ts`）。记录 verdict green 仅在两处存活：逐交付物 `verified` 信号（§4）与 mission 台账的完成事实（§6）——从不是 slice-review 结构。

## 2. Composer + gatherer 拆分

- `compose.ts` **纯**：`(gathered inputs) → composed doc`；相同输入（含调用方提供的 `nowIso`/git 事实）产生字节相同输出——幂等由构造持有，并由测试钉住。
- `gather.ts`（`ReviewGatherer`）是不纯外壳：从磁盘读 slice 文档 + `proof/*.md` 工件，从 SQLite 读 attention/agent 行，从 frontmatter 读审批戳（对照审计日志交叉核对，§3），从工作区默认仓库读 git 谱系事实。每个不可读来源诚实降级（null / "unknown"）——composer 渲染命名的 degrade，从不编造内容。

## 3. 两把锁 = 已交付的 staged-approval 戳

`plan.lock` 与 `delivered.lock` 是 **staged-approval 动词**的投影（`rig scope slice|mission approve --scope spec|delivery`——见 cli-reference“SDLC control plane verbs”）：后台服务侧写的 frontmatter 戳（`approved-spec-by/-at`、`approved-by/-at`）连同 append-only `mission_control_actions` 审计行（无半戳）。gatherer 把每个戳对照 pinned 作用域审批 `audit_notes_json` 形状（`approval_scope` + 作用域身份）交叉核对；无匹配行的戳投影 `auditVerified: false` 并渲染为未核验戳——可见，从不阻塞。审批是 freeze/签字，**从不是** proven-green（BR-6）。

## 4. DELIVERED —— 承诺 ↔ 策展证明 ↔ verified

`composeDelivered` 把 PRD 的 `## Proof contract` checkbox 项（`extractProofContract`；checkbox 行上可选 markdown 图成为交付物的 `plannedRef` mockup）join 到 `<slice>/proof/` 中 C1 头的证明工件：

- 工件在其 C1 `evidences:` 列表命名该项（精确文本或 1 基索引）时**覆盖**一个交付物。
- `verified` 绑定到已交付 C1 字段，从不仅是在场：**verified** = 一个覆盖性 `qa|adjudication` 工件记录了比较（`self_check`）且其记录 verdict 通过；**unverified** = 某些覆盖工件无通过的记录 QA 比较（QA 退回原因 `note` 仍呈现）；**missing** = 已承诺、无交付。三者都是渲染态——构造上 fail-open。
- 策展证明集是覆盖工件的 body 媒体引用（`ProofArtifact.mediaRefs`，由 `rig proof add --media` 或工件 body 中 markdown 引用填充），规范化为 slice 相对；逃出 slice 目录的引用成为 `defects` 发现，从不被服务或内联。未映射工件媒体作为 `extraProof` 有界渲染。
- ▲ 证明不足的 NEEDS-YOU 异常从 delivered MISSING 计数触发（`deriveExceptions`）。

## 5. 路由、freeze、媒体服务

- `packages/daemon/src/routes/review.ts`，挂载于 `/api/review`（`server.ts` 路由挂载）：`GET /slice/:name`、`GET /mission/:name`、`GET /rig`（OPR.0.4.4.22 rig-agents 高度根）、`GET /agents?scope=slice:<id>|mission:<id>|rig`、`POST /freeze`。
- **Freeze**（`freeze.ts`）：唯一同步 compose-and-freeze 路径，在 delivery 戳 + 审计行提交后调用。把组合评审渲染为单个自包含 HTML 文件（slice 目录中 `REVIEW-<id>-<date>.html`）：CSS 内联，图片在 slice 目录 containment 下 data-URI 内联（resolve-prefix + realpath——遍历/符号链接引用渲染为 muted 的 slice 外分支，从不内联），视频经链接 + 封面。经白名单治理的原子写服务独占创建；重调用幂等 no-op；失败渲染绝不取消审批。携带 `MISSION_BRIEF.md` 的旧 mission 仍可获得节作用域 brief-spine 折叠；新脚手架不创建该已退役 web-UI 时代文件。
- 评审证据的**媒体服务**在两个资源路由族上都按区间（iOS-Safari 级播放器要求 `206`）：`GET /api/files/asset`（`routes/files.ts`——单区间解析，`206`/`416`，`Accept-Ranges: bytes`；`.html` 仅在显式 `?render=1` 选择下渲染为 text/html）与 `GET /api/slices/:name/proof-asset/*`（`routes/slices.ts`——经 `fileAssetResponse` 同样区间语义，由纠正性 QA fixback 加入；保留不可变缓存姿态）。

## 6. Mission + rig 高度

`composeMissionReview` 消费每 slice `{review, green}` 条目：board（阶段特定单元格重新绑定到收敛契约——spec 戳状态、delivered n/m、GREEN·merge 对、戳）、完成**台账**（对 slice 集的查询，从不 authored 列表；此处 `green` 是来自 `computeRecordedGreen` 的记录 verdict 事实——regime 1 = 四个通过门 verdict，regime 2 = 通过 adjudication）、`cutComplete`（仅当 cut 内每个 slice 都 green 且 merged 且零 open needs-human 项时为 TRUE）、以及 union NEEDS-YOU（去重身份——从 N 个高度看到的一项是一项）。`composeRigAgents` 服务独立 rig 高度（花名册 ∪ 最近持有，park/health/settled 来自队列转换日志）。

## 7. FLEET 高度 —— 跨 host 聚合兄弟（v0.4.6，OPR.0.4.6.MH5）

`GET /api/review/fleet` 把每个已注册 host 组合出的 ▲/● 集聚合为一屏例外管理概览。它是**兄弟聚合端点**，从不是第四个 `AgentsScope` 值（arch Q2）：作用域语法严格保持 `slice:* | mission:* | rig`，本地 composer 保持对本地状态的纯函数。`domain/review/fleet-compose.ts` 是唯一允许导入 hosts transport/registry 的 review 域模块——该边界由 `review-import-audit` 静态测试机械强制（零 I/O 的 `fanout-contract` 类型模块是其他处唯一白名单 hosts 导入）。

**Fan-out 已组合集（arch Q1）：** ▲ 种类在各自 host 的时钟上按时间派生，故 fleet 根 fan-out 每个 host 已组合的 rig 根（`GET /api/review/rig` 经 `remoteJsonRequest`，在具名读类时限下并发；本地 host 经同一 gatherer 进程内加入——零自传输），仅做 **union + host 维度 + 计数**。它从不重算异常真相（composer 经测试钉住为无时钟），故跨 host 时钟偏移永不扭曲 ▲。逐 host 失败降级为封闭 `PerHostStatus` 诚实契约；失败 host 的计数在其 `FleetHostRollup` 中**缺席**——类型中缺席非零。

**跨 fleet 单计数（arch Q4）：** 去重 `Set` 住在 fleet composer——唯一位置——以 `hostId|identity` 为键（在展开抽屉逐字渲染）；host 内多高度可见性折叠为一行，带 `seenFrom` 来源；MH-3 转发的 qitem 只活在其 origin host 的 DB，故构造上不双计。

**组合钉住接缝（arch Q3，经验法则）：** 方向性与调用方选 TRANSPORT 接缝（MH-4 的 CLI 直连动词）；当组合存在时——fleet union/one-count 是正确性规则——接缝钉在后台服务侧：一个 composer、一个端点、每个消费者（今日 `/fleet` 路由页与 FLEET 带经共享 `useFleet` hook；TUI/CLI fleet 消费者为具名后续）读同一个。UI 节奏是有界具名 `FLEET_POLL_INTERVAL_MS` 带 feed 节奏类下限，环境带把 FETCH 门控在 fleet 存在上（FS-1 放大器纪律；规模化启用仍是 FS-1 发布验证门）。仅读 + 呈现：对远端 host 项的动作骑 MH-3/MH-4。

## 8. 它所投影的磁盘约定（SDLC 控制面）

该表面投影 OPR.0.4.4.23 运营化的 markdown 控制面形状——约定 SSOT `docs/reference/sdlc-conventions.md`：`## Intent`（README）/ `## Mini-requirements` + `## Proof contract`（PRD）/ `proof/` C1 头工件 + `PROOF.md`，由 `rig scope slice create` 为每种模板类脚手架生成，并由 `rig scope audit` 仅建议性检查（+ `rig doctor` SDLC 行）。本表面的 UI 半壁（slice Review 标签页、mission board、For-You approve+chat）见 [`../ui/project-and-for-you.md`](../ui/project-and-for-you.md)。
