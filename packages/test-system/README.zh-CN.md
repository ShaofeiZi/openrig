# 51-03 种子场景——十个（再加一个）

这是 zrig 容器化测试系统的仅组合 L2 场景集合（任务目标 release-0.5.1）。每个场景固定对应 0.4.8/0.5.0 长期攻坚过程中出现的一个**具名缺陷类**，并成为常驻基础设施，而不是一次性手工探针。

## 编写权威来源（编写时已验证）

- 51-03 规范：README `99f35af5c2d854a7` / PRD `aa0638f161cc3b82`（已验证 hash）。
- **格式采用已锁定的 51-02 规范**（README `b157f5bc68940963` / PRD `1bf3340188e39212`），并遵循具有约束力的架构形态 `ARCH-SHAPE-scenario-format-and-runner`，其 sha256 为 `fc30a736c104863a…`。第 11 个场景的后台服务生命周期步骤动词由 `ARCH-RULING-51-09-host-identity-and-51-02-step-verb` 裁定：在共享 env-helper 的生命周期界面使用 `daemon: {op: sigterm|restart}`。
- `emit.behavior` 词汇表是 51-01 已锁定的四项集合 `{compaction, slow_output, mid_turn_death, restore}`。`usage_limit` 仅适用于真实运行时，在 stub 拓扑中必须明确验证失败；本目录没有场景使用它。
- 断言**只能**使用已发布的可观察界面集合：`ps`、`queue`、`stream`、`scope`、`proof`、`pane`、`transcript`、`tui_socket`、`policy_provenance`。不得探查内部数据库。

## 布局

- `scenarios/*.yaml`——11 个场景（§6 中的十个，加上 A1 的第十一个），每个文件对应一个场景，场景名称即其缺陷类名称。
- `fixtures/*.yaml`——拓扑工作组规范，席位均为 `runtime: stub`。
- `scripts/`——按场景解析的 stub 脚本（遵循 51-01 scripted-response 契约）；场景未指定脚本时，使用 51-01 内置默认脚本。
- `ROUTING.md`——本集合依赖的每项能力，都必须由已锁定的 51-02/51-01 构建在场景运行**之前**交付。根据 51-03 最小需求 2，这些能力只能路由，绝不能在本目录加入 shim。

## 种子契约（逐场景、有约束力——消除不可证伪的 RED 风险）

每个场景都包含一个 `seed_regression: {class: …}` 步骤，并在 header 中包含一个 **SEED 定义**：准确说明该缺陷类的种子回归会植入什么，以及为什么场景的 `expect` 链路必须捕获它。每个场景的验收由一对结果组成：在已发布 tip 上为 GREEN；在种子运行中为 RED，且 runner diff（expected 与 last-observed）点名对应缺陷类。无法证明会变为 RED 的场景，不算交付。

## 如实记录运行状态（在 runner 存在之前编写）

YAML 编写工作会先于 51-02 runner 获得通过（调度权威）。这些文件是 runner 的验收目标；它们按照已锁定格式编写，在 51-02 交付 runner + env-helper、且 51-01 交付 emit repertoire（第 5–8 项）之前**不会运行**。场景 #11 采用 RED-FIRST：它的 GREEN 结果取决于 51-06 事务性 execution-closure 修复；在此之前，预期为 RED 的运行应如实记录为 expected-RED，绝不能人为修饰。逐项依赖关系见 `ROUTING.md`。
