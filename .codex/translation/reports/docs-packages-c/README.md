# docs-packages-c 中文化验证记录

> 本文件仅记录本 owner 的轻量静态验证；不替代统一集成验证。

## 范围

- Owner：`docs-packages-c`
- 执行模式：串行
- 规范：`.codex/translation/execution-spec.md`、`.codex/translation/style-spec.md`
- 状态来源：`.codex/translation/manifests/docs-packages-c.json`（只通过 `state.py` 更新）

## 已执行检查

1. `git diff --check -- <所有 done target>`：退出码 0。
2. verifier-hub `rubric check-file-format <target> --expected-ext .md`：64/64 通过，0 失败（包含主线程此前已完成的 7 项）。
3. 原文保护检查 `git diff --quiet -- <每个 done source>`：无 source 被本轮修改。
4. 结构对照：逐文件对比标题与围栏数量；无不一致。对含表格、world-claim、模板占位符的文件额外核对对应计数。
5. 品牌命令检查：已完成译本中未发现可执行的裸 `rig <verb>`；用户命令使用 `zrig`。内部 `rig` 字段、参数、ID、路径和兼容性说明按规范保留。
6. 英文自然语言启发式扫描：命中均为代码块、路径、固定英文流程链或必须保留的测试字面值；未发现整段未翻译正文。
7. URL 集合对照：64/64 source/target 无差异。
8. 内容完整性：64/64 目标文件均包含中文且以换行结束。
9. Policy 机器字段检查：`locked` / `standard` 的 18 个关键字段值全部与英文源一致。

## 未执行

- 未运行 build、类型检查、测试、daemon、真实席位、tmux 或浏览器。当前 owner 仅新增 Markdown 伴随译本；重型验证按统一验证任务执行。
- UI/TUI 运行和截图不适用于本 owner 的文档伴随版，且执行约束明确禁止启动 daemon/真实席位。

## 镜像项

11 个 `packages/daemon/specs/agents/shared/skills/...` source 与 `skills/_canonical/...` source 逐字一致。`extras` owner 完成后，已复核其状态、源文件一致性、标题/围栏/表格结构和品牌命令，再将中文译本逐字复制到本 owner 的 target。复制后 11/11 通过 `cmp`。

## 最终结果

- Manifest 总计：64
- Done：64
- Pending / in_progress / failed / skipped：0 / 0 / 0 / 0
- 本执行者新增译本：57（另有 7 项由主线程此前完成）
- 未翻译英文正文启发式扫描：0
- 可执行裸 `rig <verb>` 残留：0
