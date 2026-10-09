---
name: development-team
description: 当开发 pod 开始或交接实现、QA 或设计工作时使用。
---

# 开发团队

此 pod 把分配的用户结果转化为可工作的软件。构建者、QA 和设计师都是能力；除非明确选择了独立性要求，否则相邻角色可以由同一席位承担。

## 从工作本身开始

运行 `zrig whoami --json`，然后依次解析 `project.yaml -> mission.yaml -> active slice.yaml -> selected component or wave map -> addressed context`。完整的查找与优先级规则见 `docs/reference/product-journey-sdlc.md#resolve-the-selected-path`（安装后路径：`$OPENRIG_HOME/reference/product-journey-sdlc.md#resolve-the-selected-path`）。读取此任务所需的选定地址与源材料；profile 中可用的 Skill 是能力集合，不是强制阅读清单。没有组合配置时，采用轻量 Part A。角色名称和空闲席位不会增加门禁。明确指定的严谨度与作者划定的 wave 边界，仍需保留各自具名检查。

## 构建与验证

澄清会产生重要影响的不确定性，检查已有边界，然后完成一个连贯结果。修复缺陷前先复现；使用能够区分失败的测试，并通过公开界面验证。只要结果与文件负责区域允许，工作块应尽量保持完整。TDD 是反馈循环，不是双席位协议。

构建者应汇报准确的候选结果、已变更行为、命令与观察到的结果，并说明剩余不确定性。这里不隐含通用的编辑前提案、QA 批准或编辑后门禁。如果明确选择了某项要求，应遵守其边界，并把相关证据直接发送给负责人。

## QA 与设计

QA 将交付行为与真实契约进行比较。阅读 diff 并实际操作结果；避免只重复实现逻辑的测试。小型变更中，构建者可以兼任 QA。如果选择独立 QA，则作者不得担任。wave 只在作者划定的边界接受独立审查，而不是每个切片都审查。

结果需要设计时，设计角色负责澄清用户流程与含糊行为。Browser 和 dogfood Skill 应针对相关 UI 旅程加载，而不是每项任务都加载。在被分配的 dogfood 中，只能在授权范围内修复并重新测试；只读任务必须保持只读。如果测试者转为作者，在需要独立评估时应保留这一归属信息。

## 阻塞与返回

遇到意外失败时使用 `systematic-debugging`；声称成功前使用 `verification-before-completion`。权限提示是具体阻塞项；应报告命令及其后果，而不是把它标成进展。缺失的决定应交给有权作出决定的负责人。

通过选定的交接方式返回候选结果与证据。不要仅为让空闲的 QA、guard 或 reviewer 有事可做而制造义务。质量的含义是产品可工作且证据诚实，而不是交接次数多。
