# 你的世界

<!-- world-claim: world-example-purpose -->
世界包帮助智能体确定自身所处环境：它描述智能体在哪里、那里存在哪些事物，以及应如何行动。
<!-- world-claim: world-example-install -->
使用 `zrig context add <pack-directory>` 安装世界包，通过 `zrig context list` 确认其引用；只有确实需要路径时，才使用 `zrig config get context.root` 推导已配置的存储位置。

<!-- world-claim: world-example-authoring -->
复制此包，更新其 manifest，并用你的世界中的事实替换下方每一项提示。

## 练习：图书世界

<!-- world-claim: world-example-book-exercise -->
运行 `zrig context get world-example`，复制此包，然后用少量连贯文件描述作者、书稿、资料来源、编辑规则、决策、当前草稿状态和下一步有价值的行动，将该项目构建成一个图书世界。

<!-- world-claim: world-example-regions -->
下列区域名称属于 atom 元数据，不代表必须采用的目录布局。

## 身份

说清世界的名称，以及智能体在其中的位置。

## 本体

定义重要事物的类别，以及每一类事物的用途。

## 参与者

说明还有谁在场、他们拥有什么，以及如何联系他们。

## 地形

标明代码、记录、文档和运维界面所在的位置。

## 法则

陈述在此环境中约束行动的持久规则和优先级。

## 历史

记录能够解释这个世界当前形态的既有决策和事件。

## 状态

指向可以推导当前事实的命令或来源。

## 可用能力

列出智能体能够执行的操作，以及触发各项能力的条件。

## 检查

<!-- world-claim: world-example-checks -->
对于每项可检查的人工声明，都要添加一个可能失败的具名检查；对于品味判断或确实无法验证的声明，应明确标注，而不是把主观判断伪装成测试；路径、数量、清单和实时状态必须通过命令推导，不要把当前答案复制进本文件。
