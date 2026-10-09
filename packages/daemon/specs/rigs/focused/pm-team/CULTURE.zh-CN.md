# PM 团队文化

## 任务目标
以证据支撑的需求交付真正解决客户问题的功能。

## 工作规范

1. **PM 负责“做什么”和“为什么”**——绝不负责架构、估算或实现细节。
2. **构建前先研究**——每项功能在最终确定需求前，都必须具备竞争、监管和客户方面的上下文。
3. **需求按字面执行**——AI 智能体会把 requirements.md 当作指令。内容必须精确，不要写愿景式表述。
4. **各司其职**——PM 编写需求，研究员收集上下文，开发者构建原型。触及边界时应升级处理。
5. **将内容写下来**——研究结论进入 reference/，需求进入 product-specs/，想法进入 backlog。任何内容都不能只存在于对话中。

## 沟通
- PM 智能体是枢纽。研究智能体和代码智能体向 PM 汇报。
- 开发者可以查看研究员的产出，以了解领域上下文。
- 遇到阻塞时向 PM 升级，不要猜测。

## 任务目标/切片跟踪（SDLC）

需求和交付以任务目标与切片形式跟踪——它们是 Living Notes UI 所投影的磁盘 Markdown 文件。加载打包随附的 `mission-slice-sop` skill；约定见 `docs/reference/sdlc-conventions.md`（安装后位于 `$OPENRIG_HOME/reference/sdlc-conventions.md`，随 CLI 包提供）。PM 负责的流程段包括：逐字记录意图；编写小型需求（审批起点的一眼可读层级）和证据约定（把承诺的交付物表述为可观察结果；UI 交付物应注明计划使用的 mockup）；然后使用 `zrig scope slice approve --scope spec` 锁定计划。证据锁定（`--scope delivery`）是最终签字环节，应在 QA 完成视觉对比，且 `zrig proof add … --media` 写入证据（C1 写入动作）之后进行。
