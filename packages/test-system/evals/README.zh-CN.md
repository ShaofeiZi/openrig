# test-system/evals——live-model eval harness（与 scenarios 不同的门禁）

两道门禁分别回答两类问题；这是 desk 裁定的清晰拆分（qitem-20260824042353-045e8f4a）：

- `../scenarios/` = **确定性**门禁。使用 stub 席位和脚本化回复，不进行主观判断。它回答：**结构**是否成立？（`run-scenarios.mjs`、`packages/daemon/test/helpers/scenario-*.ts`）
- `./`（evals）= **LIVE-MODEL** 门禁。一个**真实**席位收到**自然语言**提示后自行**决策**。它回答：席位是否会在行动**之前**获取正确的上下文入口，并在加载**之后**遵循其内容？（`run-evals.mjs`、`packages/daemon/test/helpers/eval-*.ts`）

一个 eval harness 通过统一、可移植的 `EvalCase` 结构同时服务两个切片，避免分叉；该裁决同时修订 slice-05 Q3，使整个系统只有一套 eval 约定，而不是两套：

- slice-07：**先选择、后加载**——席位收到自然语言提示时，是否会执行 `zrig context get <ref>`？
- slice-05：**交付后的行为**——席位是否遵循已经加载的内容？

评分方式：

- DOOR grade = 确定性的预期命令模式匹配，并检查加载顺序：get 必须先于 action。这是 CE-08 thinning gate 使用的结果。
- Rubric（1–5）作为人工编写文本随每个 case 保存；LLM judge 是**可选且暂缓**的能力（需要 API，采用 agent-browser 的 `--judge` 形式），以后启用时无需重新编写 case。

目录布局：

- `cases/*.ts`——selection + loading `EvalCase`，包括自然语言提示、预期模式、顺序和 rubric。
- `fixtures/`——只为结构化 canonical-ref 检查提供对应 pack。LIVE 运行**不会**让席位指向这些 fixture；根据 Repair 2，eval 会针对**准确的生产软件包**解析 ref，该软件包由 `generate-context-packs.mjs` 构建，因此 fixture 与生产内容漂移时会在结构检查中失败。
- runner + grader 代码位于 `packages/daemon/test/helpers/eval-*.ts`（通过 vitest 接入）；独立 live 入口是 `packages/daemon/scripts/run-evals.mjs`，通过 `npm run eval -w packages/daemon -- [args]` 运行，因为 TypeScript helper 需要该命令提供的 tsx loader。这与场景系统的 node/tsx/vitest 拆分方式一致。

状态：RED-first 构建进行中（slice-07 R6）。锁定修订（07 proof-contract + PRD R6；05 Q3）通过 dev-planner + r1 重新盖章，并且必须在 R6 fold **之前**落地；与此同时，构建依据该裁决继续进行。
