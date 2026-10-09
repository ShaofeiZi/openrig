---
kind: as-built
title: 打包、Bootstrap、Bundle、旧版安装引擎
status: active
topics: [specification-and-bundles, release-and-versioning]
domains: [engineering-advisor, operating-advisor]
applies-when: |
  需要了解 rig/pod bundle 如何装配（schema-version-2 vs 旧版 v1）、bundle
  create/inspect/install 与 /api/up 如何跨源种类路由、staged
  BootstrapOrchestrator plan/apply 流程，或哪些旧版安装引擎接缝仍为重启前数据交付。
siblings: [agent-spec-and-startup.md, plugin-agent-image-context-pack.md]
prerequisite-reads: [../README.md, agent-spec-and-startup.md]
last-verified-against-source: 7eaf524c
last-updated: 2026-05-16
---

# 打包、Bootstrap、Bundle、旧版安装引擎

OpenRig 如何把拓扑打包成可分享 bundle，并在另一台主机上重建。完全双格式：schema-version-2 pod bundle 加旧版 v1 工件，由 bootstrap 编排器确定性路由。

> 已对照 HEAD `7eaf524c`（`git describe` → `v0.3.1-6-g7eaf524c`）核验。包版本 **0.3.1**（slice-00 §1.1）。源码按 `architecture.md` 标题（§5 Bundle/bootstrap/旧版兼容、§6 Bundle create/inspect/install + /api/up、§11 兼容注 3）依 slice-08 §10.1 定位——行号仅供参考。

## 1. Bundle、bootstrap、旧版领域服务

（`architecture.md` §5“Bundle、bootstrap 与旧版兼容”）

- `pod-bundle-assembler.ts` —— schema-version-2 bundle 装配器。重新确认：发出 `schemaVersion: 2`（`pod-bundle-assembler.ts:167`）。
- `bundle-types.ts` —— v1 与 v2 manifest 类型加 parse/validate/serialize。重新确认：v2 `PodBundleManifest` 类型带 `schemaVersion: 2`（`:23`）；`validatePodBundleManifest` 仅当 `schema_version === 2` 才接受（`:38`）；`serializePodBundleManifest` 写 `schema_version: 2`（`:62`）；`parsePodBundleManifest`（`:87`）；旧版路径 `validateLegacyBundleManifest`（`:143`）——两格式同居一文件。
- `bundle-source-resolver.ts` —— `LegacyBundleSourceResolver`（`bundle-source-resolver.ts:25`）加 `PodBundleSourceResolver`（`:132`）。
- `bootstrap-orchestrator.ts` —— staged bootstrap 流程，带直接 pod 感知 rig 与 v2 bundle 委托。`BootstrapMode = "plan" | "apply"`（`bootstrap-orchestrator.ts:26`）。
- `up-command-router.ts` —— `/api/up` 的 spec/bundle 源分类。`SourceKind = "rig_spec" | "rig_bundle" | "rig_name"`（`up-command-router.ts:6`）。

全部已在 HEAD `packages/daemon/src/domain/` 重新确认存在。

## 2. Bundle create / inspect / install

（`architecture.md` §6“Bundle create / inspect / install”）

`routes/bundles.ts` 完全双格式：

- **create** —— 检测 pod 感知 RigSpec 并用 `PodBundleAssembler`（接受可选 `rigRoot`）；旧版 create 仍用 `LegacyBundleAssembler`。
- **inspect** —— 安全解包归档，检测 `schema_version`；v2 返回 `schemaVersion: 2`、`agents[]` 与完整性数据；v1 返回旧版 manifest 形状。
- **install** —— 用完整 bootstrap plan/apply；bootstrap 窥视 manifest 并确定性路由到 `pod_bundle` 或 `rig_bundle`。已在源码重新确认：`bootstrap-orchestrator.ts:134-143`——当 `sourceKind === "rig_bundle"` 时解包到临时窥视目录，读 `bundle.yaml`，并在路由前调用 `parsePodBundleManifest(...)` 检测 schema 版本。

## 3. `/api/up` 源路由

（`architecture.md` §6“`/api/up`”）

`UpCommandRouter` + `BootstrapOrchestrator` 拥有：

- 直接 pod 感知 rig spec，
- 旧版 rig spec，
- v1 bundle 安装，
- v2 pod-bundle 安装。

plan 模式与 apply 模式跨这些源种类都工作。

> 定义性注（保留，非数字漂移）——`architecture.md` §6 描述 bootstrap 路由到 `pod_bundle` / `rig_bundle`。`UpCommandRouter` 的*分类*枚举是 `SourceKind = "rig_spec" | "rig_bundle" | "rig_name"`（`up-command-router.ts:6`）；`pod_bundle` vs `rig_bundle` 区分在 `bootstrap-orchestrator.ts` 更深一层经窥视 manifest schema 版本解析（`:134-143`）。两条陈述在不同层都准确；在此记录以使分层显式，而非看似矛盾。

## 4. 旧版安装引擎（仍交付）

（`architecture.md` §5“仍交付的旧版系统” + §11 兼容注 3）

这些重启前接缝为向后兼容保持活跃：

- 包安装引擎：`package-install-service.ts`、`package-manifest.ts`、`package-repository.ts`、`install-engine.ts`、`conflict-detector.ts`、`role-resolver.ts`（全部已在 HEAD 重新确认存在）。
- bootstrap 与需求探针支持。
- discovery 与 claim 服务。
- tmux/cmux 适配器与 resume 适配器。

> Drift-check D-pkg —— `architecture.md` §5/§6 在此内容上无 slice-00 数字漂移；v2 bundle-assembler + 双格式流程已在 HEAD 核验准确（上文 §1–§3）。**确已**陈旧的足迹/迁移计数落在 `daemon-core.md`，不在此。

兼容注 3（逐字保留，`architecture.md` §11）：“Legacy compatibility seams still ship for pre-reboot data and v1 artifacts.”（完整 §11 清单见 `architecture-rules-and-event-system.md`。）

> 来源注（保留，不断言）：`bootstrap-orchestrator.ts:3-5` 仍导入 `LegacyRigSpec` / `LegacyRigSpecCodec` / `LegacyRigSpecSchema`，带源码内 `TODO: AS-T08b — migrate to pod-aware RigSpec` 标记，且 `:16` `TODO: AS-T12 — migrate to pod-aware bundle source resolver`。旧版接缝是刻意的、进行中的迁移脚手架——原样记录，不抹平。

## OPEN / 保留项

- **D-pkg（已解析为当前）：** 本模块拆分内容无 slice-00 数字漂移；v2 装配器 + 双格式流程在 HEAD 核验准确。Bundle 路由分层显式记录，以预先排除 §6-vs-源码的表面矛盾。
- 旧版迁移 TODO 从源码逐字保留（AS-T08b / AS-T12）。

## 另见

- `agent-spec-and-startup.md` —— `RigInstantiator` / `PodRigInstantiator` 与 bundle 所包裹的双格式 spec 接缝。
- `plugin-agent-image-context-pack.md` —— 0.3.0/0.3.1 可复用 starter-state / 内容来源簇（在 8.4b 单独撰写）。
- `daemon-core.md` —— `/api/up` + `/api/bundles` 在 49 个路由挂载之中；`BootstrapOrchestrator` 在 createDaemon 序列中构造。
- 源码根：`packages/daemon/src/domain/{pod-bundle-assembler,bundle-types,bundle-source-resolver,bootstrap-orchestrator,up-command-router}.ts`、`packages/daemon/src/routes/{bundles,up}.ts`。
