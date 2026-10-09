# openrig 中文化台账 — 恢复中（部分完成，未全量验收）

- 更新时间：2026-09-29（本轮恢复）
- 基线：git HEAD `57380a25`；未提交未推送；本轮为轻量状态/台账维护，未碰业务源码、未跑测试/build/tsc。
- 台账总量：3062，零缺口。

## 状态分布（真实计数，非百分比）
| status | 数量 | 说明 |
| --- | ---: | --- |
| pending | 1804 | 本轮恢复为待处理，reason_class=uncovered（从未分派，仍需翻译） |
| done | 976 | 各分区自报完成；validation_state=self_reported，**未经验证即不算验收通过** |
| failed | 187 | reason_class=needs_review（worker 已尝试但 notes 无具体原因，待复核） |
| skipped | 95 | 排除/不译（_excluded 45 + 各组自判 50） |

## reason_class 分布
| reason_class | 数量 | 去向 |
| --- | ---: | --- |
| uncovered | 1804 | failed -> pending，待分派翻译 |
| needs_review | 187 | 保持 failed，待区分 translation_error / baseline_test_failure / new_regression |

- 其余 reason_class（translation_error / baseline_test_failure / new_regression）当前 0：现有 failed notes 无具体证据，**不凭猜测归类为缺陷**，统一先置 needs_review。
- done 的 976 全部 validation_state=self_reported；实际验收通过的 validation_state=validated 数当前为 0。

## 明确声明
- 旧“92% 完成”等百分比口径**作废**；本报告只用真实计数。
- done 976 是分区自报，不是全量验收通过。
- 全量测试套件未运行、未通过；baseline 既有失败 + 可能新增回归尚未分列（待统一验证任务）。
- 原文保留；中文伴随版 34 篇（含 .github 2 篇）。

## 状态机新用法
```
cd /Users/bytedance/openrig
# 认领待处理文件（pending -> in_progress）
python3 .codex/translation/scripts/state.py claim <owner> <source>
# 重开一个 failed 文件直接进入处理（failed -> pending，附原因分类）
python3 .codex/translation/scripts/state.py reopen <owner> <source> <reason_class>
# 或认领时带 --reopen（failed -> in_progress）
python3 .codex/translation/scripts/state.py claim <owner> <source> --reopen
# 完成；done 默认 validation_state=self_reported
python3 .codex/translation/scripts/state.py done <owner> <source> [说明]
# 失败并标注原因分类
python3 .codex/translation/scripts/state.py fail <owner> <source> <reason_class> [说明]
python3 .codex/translation/scripts/state.py skip <owner> <source> [说明]
# 验收通过后把自报 done 升级为已验证
python3 .codex/translation/scripts/state.py set-validation <owner> <source> validated
python3 .codex/translation/scripts/state.py show [owner]
```
reason_class 取值：uncovered / translation_error / baseline_test_failure / new_regression / needs_review。

## 产物
- 台账 `.codex/translation/plan.md`；规范 `style-spec.md`/`execution-spec.md`；清单 `manifests/<owner>.json`；脚本 `scripts/state.py`（fcntl 锁 + 原子写）；备份 `.claude/translation/backup/plan-init/`。
