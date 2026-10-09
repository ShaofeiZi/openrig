# OPR.0.5.6.23 — 静默擦除链路清点（base f1737b9100150298b488e329a5d50ad6b444d20f）

最初基于 1f6675b09 创建；经过两次 restack 后重新绑定到当前 base f1737b910——frontier delta（43e4c8f49..f1737b910）包含 **0 行** sessionSource 代码（重新推导：`git diff 1f6675b09..f1737b910 -- packages/daemon/src | grep -c "sessionSource\|session_source"`），因此第 1–13 行结论在此 base 上保持不变。

使用一条命令重新推导 sessionSource 链路（仅代码行；经检查排除 type/comment）：

    grep -rn "sessionSource\|session_source" packages/daemon/src --include='*.ts'

该缺陷类通过**本次清点**关闭，而不是通过修复点名实例关闭。此 base 的 union 可选字段包括：`ref.value`（fork arm）、`ref.version`（agent_image arm）；rebuild 的 `ref.value` 为必填字段。成员级可选字段通过同一个 serialize seam 传递；只要一个 parse 链路携带它们，而相邻链路将其丢弃，就属于同一静默擦除缺陷类。

**第二个经裁决的缺陷类成员**（desk transition 45061，记录于 qitem-20260829221752-0f8e2d7d，2026-08-30T00:40Z；R2 HOLD B-1）：该缺陷类还覆盖 codec seam 顶层可选 SPEC FAMILY。使用一条命令重新推导 family 覆盖范围：

    grep -n "spec\.\(summary\|cultureFile\|permissionPolicy\|docs\|startup\|services\|workspace\)" packages/daemon/src/domain/rigspec-codec.ts

| # | Family 链路 | 类型 | 处置 |
|---|---|---|---|
| 14 | domain/rigspec-codec.ts serialize `spec.services` | transform | **FIXED-HERE（成员 c）**：parse 会验证并规范化 services（rigspec-schema :109/:197），但 serialize 未读取 `spec.services`，导致整个 family 在 export-YAML → re-import 时消失。现已通过完整性固定的 emitter record（`{[K in keyof Required<RigServicesSpec>]}`）输出：新增 services 字段会导致编译失败，并点名缺失 key |
| 15 | domain/rigspec-codec.ts serialize，其余可选 family（summary、culture_file、permission_policy、docs、startup、workspace） | transform | **AFFIRMATIVELY-CLEARED**：在此 base 上，每个 family 的 seam 都有输出行（上方单命令 grep 会为每个 family 返回 serialize 命中）；services 是唯一存在 parse 链路却没有 serialize 链路的 family |

| # | 链路（file:line） | 类型 | 处置 |
|---|---|---|---|
| 1 | domain/rigspec-codec.ts:80-83 serialize member.session_source | transform | **FIXED-HERE（成员 a）**：曾输出 `kind` + 条件式 `value`，但从不输出 `version`；现已替换为保持字段存在性不变量的输出 |
| 2 | domain/rigspec-codec.ts member block（同一函数） | transform | **FIXED-HERE（披露的第三个成员）**：parse 会携带 `compaction_strategy`（schema :1058），但 serialize 从不输出它——同一缺陷类、同一 seam |
| 3 | domain/rigspec-schema.ts:1013,1025,1033-1037 normalize | transform | **AFFIRMATIVELY-CLEARED**：携带 `value`，携带经 String 强制转换的 `version`，并携带 `compaction_strategy`（:1058） |
| 4 | routes/rigs.ts:95-141 add-member ingress | transform | **AFFIRMATIVELY-CLEARED（S03-lineage）**：fork 的 `value` 按条件携带；agent_image 的 `version` 经 String 强制转换（OPR.0.5.6.3 修复注释位于原处）；无效结构按 RAW 传递，字段存在不会被转换成缺失 |
| 5 | domain/rig-expansion-service.ts:170 expand mapping | transform | **FIXED-BY-S03**：使用全对象 spread（`...("sessionSource" in member ...)`） |
| 6 | routes/agent-images.ts:203-262 fork ingress + memberFragment | transform | **FIXED-HERE（成员 b，desk 裁决 22:22Z）**：sessionSource 在起点就是完整的（agent_image version 始终存在；fork value 始终存在），但 memberFragment 只转发 runtime/agent_ref/profile/cwd/codex_config_profile/permission_policy，会**丢弃** node 携带的 `model`、`role`、`restore_policy`、`label`——fork 后的席位会静默丢失其 model pin（0.4.6.PI1 缺陷类）。`compaction_strategy` **不是** nodes 列，因此 **CLEARED-WITH-REASON**：该链路无法转发 node 记录中不存在的内容 |
| 7 | domain/agent-images/evidence-guard.ts:180 | read-only | **OUT-OF-CLASS**：脱敏字段存在性检查，不转换任何内容 |
| 8 | domain/bundle-agent-images-router.ts | — | **0 条 sessionSource 链路——明确 SKIP。**推导依据：清点 grep 在此文件中没有命中；没有可审计内容是一项正向发现，不是静默 green |
| 9 | domain/rigspec-instantiator.ts:1827-1875 launch consumption | consume | **AFFIRMATIVELY-CLEARED**：完整消费 fork ref；消费 agent_image `version` 时采用记录在文档中的 `?? "1"` 默认值；rebuild 的 `value` 为必填 |
| 10 | domain/session-source-rebuild-resolver.ts:84 | consume | **AFFIRMATIVELY-CLEARED**：消费必填的 `ref.value`，没有可选字段经过 |
| 11 | adapters/terminal-adapter.ts:41、adapters/stub-runtime-adapter.ts:169 | reject | **OUT-OF-CLASS**：错误字符串拒绝，不转换字段 |
| 12 | domain/types.ts:937-、:1026、:1288 | types | **OUT-OF-CLASS**：声明，不是链路 |
| 13 | startup.ts、domain/startup-orchestrator.ts、domain/runtime-adapter.ts、domain/agent-images/agent-image-types.ts | comments | **OUT-OF-CLASS**：代码行命中为 0（只有文档引用） |

S20 A3 R-b 邻接检查（最小需求 4）：fork-ingress 链路不提供 occupant-generation（routes/agent-images.ts fork handler 及其 resolveForkSourceNode/discoverResumeToken 输入都不携带 generation 字段），因此预先命名的 STOP 不会触发；此处记录为已检查、字段不存在。
