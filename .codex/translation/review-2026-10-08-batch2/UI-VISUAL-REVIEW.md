# UI 目视复核 batch2（s_000cae46wD0，2026-10-08）

> 本文件为独立批次记录，不改动已交付的 `review-2026-10-08/UI-REVIEW-2026-10-08.md`。

## 方法与边界
- 在浏览器打开真实产品自包含样机 `packages/ui/twin-out/intent.html`（真实 App 组件树 + 打桩 fetch/SSE + 种子数据），无真 daemon / 付费席位 / 真实 hooks trust。
- **该样机为 9/30 旧构建，非当前源码，不算本轮验收**；仅作旧样机参考观察，不能据此关闭三个 src 的 needs_review。

## 目视结论（shots/）
| 文件 | 表面 | 观察 |
| --- | --- | --- |
| twin-01-dashboard-zh.png | 库/托管应用详情 | 顶栏 ZRIG、左侧导航、面包屑、按钮（复制安装提示词/导入）、卡片标签（格式/类型/专家智能体/POD/成员/边）、标签页（拓扑/配置/环境/YAML）均中文，无截断。 |
| twin-02-project-badges-zh.png | 项目工作区 | MissionStatusBadge 绿色"进行中"正常；标签页（概览/故事/进展/产物/校验/队列/工作流）中文；日期"9月1日 11:10"中文；计数"N 个队列项/N 个已校验"中文。 |
| twin-03-topology-table-zh.png | 拓扑表格 | 列头（工作组/POD/智能体/运行时/上下文/令牌/状态/操作）全中文；状态"活跃/空闲"、占位符"筛选智能体…"中文；运行时 CLAUDE/CODEX 保留；列宽无溢出。 |

## 未目视 / 待重 build
- 错误上下文表面（BundleInspector"检查失败："、PackageList"加载旧版包失败："）：旧样机不含新前缀，且需失败态 fixture。
- MissionStatusBadge aria-label 为读屏属性，截图不可见，已由单测锁定。
- 图表/为你推荐/设置/抽屉/终端表面未截图。

## 请验证者安排（确切命令/路径，已读源码确认）
- twin 构建配置：`packages/ui/vite.twin.config.ts`（root=`packages/ui/twin`，输出 `packages/ui/twin-out/intent.html` 自包含单文件）。
- 落点路由由环境变量 `TWIN_ROUTE` 控制（见 vite.twin.config.ts 注释）。建议：
  - `TWIN_ROUTE=/bundles/inspect npm run twin:build`（再经 fetch-stub 制造 inspect 失败，以目视"检查失败："）
  - 包列表错误路由对应 `packages/ui/src/hooks/usePackages.ts:18` 的 `!res.ok` 分支；需在 `packages/ui/twin/fetch-stub.ts` 对 `/api/...packages` 返回 `{ok:false,status:500}` 以目视"加载旧版包失败：HTTP 500"。
- 上述 fixture 改动仅落在 `packages/ui/twin/`（开发打桩），不动产品源码；由验证者 build。

## 6 个关键 UI 文件全文复审（2026-10-08）
| 文件 | 结论 |
| --- | --- |
| components/for-you/FeedCard.tsx | 干净：类型标签（需要处理/需要批准/已交付/进行中/观察）、结果句（已由 X 批准/拒绝/转交/挂起/丢弃/标注）、aria"关闭卡片"、"查看上下文/评审 →/证据包·"均中文；英文均为机器枚举/会话名，保留正确。 |
| components/system/SettingsExplorer.tsx | 干净：设置/策略/日志/状态全中文。 |
| components/system/LogPage.tsx | 干净：标题"日志"、空态"日志安静/活动事件将在此流式显示"；evt.type 为机器事件名，保留。 |
| components/drawer-viewers/FileViewer.tsx | 干净：无内容/加载中/文件不可用/二进制文件/无法解析。224 行裸 error.message 属已知类别（已列观察项，非本批新问题）。 |
| components/feed/cards/storytelling-cards.tsx | 干净：标记为完成/批准/拒绝/打开任务/打开详情/打开概念/进度 N%。340 行"状态：{slice.status}"直出枚举值，列观察项（是否需状态 token 化待定）。 |
| components/review/TranscriptDrillPanel.tsx | **修复 1 处**：131 行加载态原为 `正在加载{state.mode}…`（tail/grep/full 英文外露），改为 `正在加载{DRILL_MODE_LABEL_ZH[state.mode]}…`（尾部/搜索/全文）。枚举与行为不变。无既有测试锁定该文案。 |

### 本批新增改动（待 needs_review，视觉未验）
- `packages/ui/src/components/review/TranscriptDrillPanel.tsx`：加载态 mode 英文→中文映射。
- 建议回归：任意挂载该面板并在 loading 期断言含"正在加载尾部…"；无新断言语义被删。

## TUI 纯产品离线渲染证据（2026-10-08 21:31 CST，dist rc0）
- 调用 `packages/tui/dist` 已编译产物（无 daemon/无测试框架）：`demoSnapshot()` → `createViewState` → `renderScreen(view.get(), snap, {cols:140, rows:34})`，产物屏输出见 `batch2/tui-render-output.txt`，harness=`batch2/tui-render-harness.mjs`。
- dist sha256 采样：text-width.js `1101d7be…e65904`、render.js `0b0933fb…515d81`、demo-data.js `5ac205fb…09cdb9`、state.js `e152e2a1…e3a5ddac`。视图 140×34。
- 已目视文本（有限面，不泛称全 TUI）：左导航（拓扑/规范/项目/终端/待关注/系统）、tab（资源管理器/拓扑/表格/近期/概览/图/健康）、席位列头（席位/运行时/模型/上下文/状态/队列/工作/现在/动作）、状态（工作中/空闲/未知/需要你）、脚注（↑↓移动 · ←→窗格 · ⏎打开 · :命令 · /过滤 · S启动 · v选择/复制 · f页脚 · q退出）、占位"/ 过滤智能体…"、事件行中文。
- **宽度对齐仅为静态文本检查**：上述 ┃ 对齐判断是读 `screen.lines` 文本所得，**非真实 Terminal 目视**；真实终端字宽/换行/列偏移未验。
- **真实 Terminal 截图未做（桌面阻塞）**：cu 桌面控制对子代理被平台拒绝，原始错误：`Subagent暂不支持操作电脑相关操作，请在MainAgent完成`（调用 `mac_computer_use_tool` plane="cu"）；向 Main 即时消息工具同样被拒、未送达。无法启动 Terminal.app，不绕过（不用 shell/appleScript）。Main 可执行 `cat /Users/bytedance/openrig/.codex/translation/review-2026-10-08-batch2/tui-render-output.txt` 于等宽终端截图。

## twin 失败 fixture 冻结（s_000cae46wD0，2026-10-08）
真实路由/接口（已读源码确认，非泛说）：
- 包列表：UI 路由 `/packages`，接口 `GET /api/packages/summary`（usePackages.ts:17，!res.ok→`HTTP {status}`）。
- bundle 检查：UI 路由 `/bundles/inspect`，接口 `POST /api/bundles/inspect`（useBundles.ts:50）。

改动（仅 twin 开发打桩，默认行为不变；改前快照在 snapshots-before-s_000cae46wD0/）：
- `packages/ui/vite.twin.config.ts`：新增 `__TWIN_FAIL_MODE__` define（空=旧行为）与 `TWIN_OUT` 输出文件名。
- `packages/ui/twin/fetch-stub.ts`：`FAIL_MODE==="packages"` 对 `/api/packages/summary` 返回 500 空 body；`"inspect"` 对 `/api/bundles/inspect` 返回 500 空 body。空 body 无 error 字段→钩子落到 !res.ok→`HTTP 500`。
- `packages/ui/test/transcript-drill-panel.test.tsx`（新增）：加载态 tail/grep/full→尾部/搜索/全文中文断言 + grep 无匹配空态。

请验证者串行执行（cwd=packages/ui）：
```
# 1) 包列表错误表面 → twin-out/packages-error.html
TWIN_ROUTE=/packages TWIN_FAIL_MODE=packages TWIN_OUT=packages-error npm run twin:build
cp twin-out/packages-error.html <证据目录>/

# 2) bundle 检查错误表面 → twin-out/inspect-error.html（注意 emptyOutDir 会清空 twin-out）
TWIN_ROUTE=/bundles/inspect TWIN_FAIL_MODE=inspect TWIN_OUT=inspect-error npm run twin:build
cp twin-out/inspect-error.html <证据目录>/
```
目视：#1 应见"加载旧版包失败：HTTP 500"；#2 点"检查"按钮后应见"检查失败：HTTP 500"。

建议回归测试文件（串行、隔离 HOME/OPENRIG_HOME）：
- packages/ui/test/transcript-drill-panel.test.tsx（新增）
- packages/ui/test/package-list.test.tsx、packages/ui/test/bundle-inspector.test.tsx（前缀+原错断言，复跑确认未受 fixture 改动影响）

## UI 运行表面完整审读（续批，静态文本/源码，非目视）
扫 `packages/ui/src/components`（186 个 tsx）可见英文启发式：无残留英文 JSX 可见文本；命中的英文均为路径示例（/path/to/...）、机器字段名（qitem_id/verb/reason/member@rig）或文件名（agent.yaml），按协议保留。

裸 error.message 表面复核（5 文件）：
- AuditHistoryView:133 `错误：{query.error.message}`、LaunchRecoveryModal:194 `无法获取规划：{...}`、:228 裸 `{...}`（228 行无中文前缀）。
- AgentSpecReview:68、RigSpecReview:92：**裸 error.message、无中文前缀**（其上加载态已是"正在加载评审…"）。与 BundleInspector/PackageList 带前缀不一致，建议下一批补"评审失败："前缀并加前缀+原错断言；本批不扩范围、不改。
- ClaudeCompactionPolicyForm:78：裸 error.message，同列观察。

本批累计实质审读单元 20+（含此前 MissionStatusBadge/BundleInspector/PackageList/FeedCard/SettingsExplorer/FileViewer/LogPage/storytelling-cards/TranscriptDrillPanel/AgentSpecReview/RigSpecReview/AuditHistoryView/ClaudeCompactionPolicyForm/LaunchRecoveryModal/ImportFlow/BootstrapWizard/ErrorBoundary/empty-state/SeatNotificationBanner/App 等）。

## 当前 rc0 构建错误态目视（bu 真实浏览器，2026-10-08）
证据：batch2/twin-evidence/{packages-error.html,inspect-error.html}（当前源码 twin 产物）。
- shots/packages-error-zh.png：路由 /packages 显示"加载旧版包失败：HTTP 500"（中文前缀 + 保留原错 HTTP 500）。
- shots/inspect-error-zh.png：路由 /bundles/inspect，输入 /tmp/fake.rigbundle 点"检查"，红色"检查失败：HTTP 500"。
- shots/current-project-zh.png、current-topology-zh.png：同 build 内导航项目/拓扑，进行中徽章、标签页、日期、列头全中文。
- 结论：本批两处新增错误前缀在当前源码 build 下目视成立；前缀为诊断上下文，error.message(HTTP 500) 原样保留。
- AgentSpecReview/RigSpecReview 裸 error.message：按用户口径，前缀≠翻译，不强行加前缀凑数；若裸错来自用户/第三方则保留，仅在确有诊断价值时加上下文+测试。本批不改。

## 3 个 needs_review 全文审读 + 错误消息来源说明（关闭视觉阻塞）
- **MissionStatusBadge.tsx（全文 115 行）**：可见标签全中文（进行中/已暂停/已发布/已阻塞/空闲/空/草稿）；aria-label 回退 `MISSION_STATUS_LABEL_ZH[status]`（本批修复）；机器枚举 `MissionStatus` 与 `data-testid=mission-status-${status}` 不变。`parseMissionStatus` 为内部解析、非可见。单测 + aria 目视（项目徽章绿色"进行中"）已过。
- **BundleInspector.tsx（全文 197 行）**：可见串全中文（检查包/包路径/检查中…/检查失败：/规格/摘要/完整性/智能体/包/来源/兼容性/文件完整性/安装此包）。第 40 行 `检查失败：{error.message}`：error.message 来自 `useBundles.ts:56 data.error`（后台服务返回的错误串，外部内容）或 :57 `HTTP {status}`（客户端派生）。**外部/后台内容原样保留，中文前缀仅诊断上下文，不替代/不假装已译**。目视 inspect-error 已见"检查失败：HTTP 500"。
- **PackageList.tsx（全文 181 行）**：可见串全中文（已应用/已回滚/失败/无、来源/安装次数/加载旧版包失败：/暂无旧版包安装/导入 RigSpec/引导初始化/旧版包工具）。第 101 行 `加载旧版包失败：{error.message}`：error.message 来自 `usePackages.ts:18 HTTP {status}`（客户端派生错误）。外部/协议内容原样保留，前缀为诊断上下文。目视 packages-error 已见"加载旧版包失败：HTTP 500"。
- 结论：3 文件全文审读完成、无残留可见英文、机器边界未触碰、单测+目视双证，**可关闭视觉阻塞**（组件全文审读充分性由本记录为据）。

## LibraryReview 裸 error.message 追溯（决定：不改）
:242 `description={(error as Error)?.message ?? "无法加载规格。"}` 的 error 来自 `useLibraryReview`→`useSpecLibrary.ts:98-101`：后台 `data.error` 或 `HTTP {status}`。**已有中文标题"未找到规格"作诊断上下文**，与 BundleInspector/PackageList 同型但本就带前缀；外部/后台错误串原样保留，不再加前缀。

## 全量可复核字符串提取（脚本 extract-visible-strings.py）
- 脚本：batch2/extract-visible-strings.py，抓全部 packages/ui/src/**/*.tsx 的 JSX 文本节点 + 可见 props（aria-label/placeholder/title/label/description 等）字符串字面量。
- 分母：189 个 tsx；flagged 候选 61 条，人工逐条判别后**全部为机器/协议内容**：CLI 命令（zrig up / zrig config get set reset / zrig config set feed.subscriptions.<kind>）、路径占位（/path/to/*、.openrig/skills/、<slice-dir>/timeline.md、/PROOF.md）、枚举（execute_external_installs/install_packages/import_rig/mission_control_actions）、seat 示例邮箱（driver@openrig-velocity 等）、代码片段（boolean | Promise、kind: incident-timeline、systemPackages: Array）。
- 结论：**运行源树零散文英文可见残留**，无需改动。机器/外部动态源（error.message、statusLabel 枚举映射、后端 data.*）按既有口径原样保留中文上下文。
