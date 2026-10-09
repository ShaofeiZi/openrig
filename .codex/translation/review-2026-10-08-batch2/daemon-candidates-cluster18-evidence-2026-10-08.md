# daemon self-reported CLUSTER18 审读证据（2026-10-08 batch2）

范围：`packages/daemon/src/domain/{agent-images,context-packs,model-divergence,permission-policy,policies}/**`，排除 .generated.ts。
整文件审读注释 + 人类错误/日志串 + 机器边界。机器协议不译。

## 总分母总账
- `packages/daemon/src/domain/**` .ts 总数：**401**
- 合法 skip（生成物，不审）：**1** —— `scope/attestation-lineage.generated.ts`
- 可审非 generated 分母：**400**
- 本批前已审（20+next20+next40+cluster3~17）：360
- 本批 cluster18 新审：**32**
- 累计已审：**392 / 400**
- 未审：8（下一批收尾，均为 domain 顶层/子目录零散未列文件）

## 结论
32 源均早已全中文（头部 doc、人类错误串均译），无自然语言残留，未做机械改。无源码改动 → 相关全套覆盖，日志关联后台账记 validated。

## 文件清单（路径 + sha256 前16）
| # | 路径 | sha256 |
|---|---|---|
| 1 | domain/agent-images/agent-image-library-service.ts | 47f7461a9db0f616 |
| 2 | domain/agent-images/agent-image-types.ts | 5e85a5f08549a9a1 |
| 3 | domain/agent-images/evidence-guard.ts | d0ab4ac21cdc9efc |
| 4 | domain/agent-images/manifest-parser.ts | 9b8ba7ebe2567359 |
| 5 | domain/agent-images/resume-token-discovery.ts | fe0bf93bb705fb6 |
| 6 | domain/agent-images/snapshot-capturer.ts | ffbb6aac06b908c3 |
| 7 | domain/context-packs/bundle-assembler.ts | 92eb726fda0e512b |
| 8 | domain/context-packs/context-pack-library-service.ts | 852847757a87a72 |
| 9 | domain/context-packs/context-pack-types.ts | 50f0ca997339dc3e |
| 10 | domain/context-packs/manifest-parser.ts | ef4b471cfef1424 |
| 11 | domain/context-packs/probe-eval-bridge.ts | 68fa8740eae529d0 |
| 12 | domain/context-packs/profile-composer.ts | 901e3ddb274541ec |
| 13 | domain/context-packs/profile-source-resolver.ts | 888cea26981a9a1 |
| 14 | domain/context-packs/ref-safety.ts | ba222bfe84ec264b |
| 15 | domain/context-packs/seat-recap-store.ts | 35353a14700f400b |
| 16 | domain/context-packs/token-estimate.ts | 9ee3692c9f11b1b6 |
| 17 | domain/model-divergence/current-generation-record.ts | 952f27ffe7ded64a |
| 18 | domain/model-divergence/effective-model-readers.ts | 69673794c7b58ff3 |
| 19 | domain/model-divergence/model-divergence-monitor.ts | 548d521a0edd8045 |
| 20 | domain/permission-policy/policy-ref.ts | b3df5ebf9744e02 |
| 21 | domain/permission-policy/policy-spec.ts | 8531bf1ec80632a7 |
| 22 | domain/policies/artifact-pool-helpers.ts | df501ff74c7e4937 |
| 23 | domain/policies/artifact-pool-ready.ts | be1bd66d825b6dd |
| 24 | domain/policies/context-usage-threshold.ts | 67066c3be2a4fe1 |
| 25 | domain/policies/delivery-deferral.ts | 1f7a754cacdc8b00 |
| 26 | domain/policies/delivery-digest-flush.ts | c4d36a7b2d703bb1 |
| 27 | domain/policies/edge-artifact-required.ts | a63f251a7ccfc0a5 |
| 28 | domain/policies/idle-gate-qitem.ts | 91be5a5b5168d935 |
| 29 | domain/policies/parked-owner-consumer.ts | 6e35da2a54782d37 |
| 30 | domain/policies/periodic-reminder.ts | 9e8dafe318da6888 |
| 31 | domain/policies/types.ts | 2832bd86a14878e8 |
| 32 | domain/policies/workflow-keepalive.ts | 4547d627a5aecad4 |

## 机器分类（保留英文不译）
- 协议：agent-image manifest.yaml + stats.json、context_pack manifest.yaml、permission_policy REF vs SPEC body、PolicyEvaluation/evaluate(job)、workflow_instances SQL、DEFERRED DELIVERY / ONE-SHOT transition
- 组件：AgentImageLibraryService / ContextPackLibraryService / ModelDivergenceMonitor / PermissionPolicyRef / WorkflowKeepalive
- 引用：PL-014/PL-016/PL-004、OPR.0.5.3.5/0.5.6.1/0.5.6.24 F-14/0.4.8.3、POC lib/policies/*.mjs 移植

## 验证请求
未改源，相关全套覆盖，日志关联后台账 validated。本轮无源码改动。
