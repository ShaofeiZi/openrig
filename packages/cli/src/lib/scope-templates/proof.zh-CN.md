# 证明 — {{id}} {{title}}

> **由谁、何时填写：**在切片关闭时，由负责该切片的实现/QA 搭档填写。在本文件存在且每个 `SPEC.md` 证明契约项都有一一对应的证据（产物位于 `proof/`）之前，切片**不算完成**。具体流程见 `mission-slice-sop` skill 和约定的唯一事实源（仓库中的 `docs/reference/sdlc-conventions.md`；已安装软件包中的 `$OPENRIG_HOME/reference/sdlc-conventions.md`）。
>
> **如何写入（使用 drop 动作，不要手工放置）：**先将媒体文件放到 `proof/` 下，再执行 `zrig proof add {{id}} --artifact-type qa --verdict PASS --candidate-sha <tip> --money-evidence "<one line>" --evidences "1" --media "screenshot-01.png"` 附加文件。drop 会写入 C1 header，Living Notes 的 DELIVERED 配对将依据该 header 建立关联。只手工放入文件而不执行 drop，会使交付物保持未配对和 `unverified` 状态。

关闭人：<seat>   日期：<date>   结论：<pass | pass-with-residue | ...>

## 本证明验证了什么

<用 1–3 句话说明切片此前提出、现已得到验证的主张>

## 产物（proof/ 中的媒体）

通过 `zrig proof add … --evidences … --media …` 写入（每项结论执行一次 drop；媒体必须附加，不能只手工列出）：

- proof/screenshot-01.png — <该文件展示的内容>
- proof/capture-behavior.gif — <该文件展示的内容>
- proof/command-output.txt — <该文件证明的内容>

## 遗留项 / 注意事项（如有）

<记录尚未覆盖的内容，以及其后续跟踪位置>
