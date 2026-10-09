# 冻结：restore schema drift-catcher 真实失败修复

日期：2026-10-08
失败：packages/cli/test/restore-packet.test.ts:177 `M2a R2 drift-catcher` — TS 常量 `RESTORE_SUMMARY_SCHEMA` 与 canonical JSON 深等失败，差异仅 title/description。

## 根因
- canonical JSON `packages/cli/src/schemas/restore-summary.schema.json` 为英文（机器资产，下游 IDE/JSON-Schema 工具直接消费）。
- TS 内嵌常量 `packages/cli/src/restore-packet/schema-validator.ts` 被上一轮翻译误改为中文（title="恢复包摘要" 等 11 处 description）。
- 漂移捕获测试强制两者逐字等价 → 失败。

## 修复
保持 canonical JSON（英文机器 schema）不变；将 TS 内嵌常量的 title + 全部 description 逐字恢复为与 JSON 一致的英文。仅改自然语言描述串，未动字段名/enum/minLength/pattern/type 等机器结构。

## 验证证据（静态，未跑测试）
- JSON 中文字符串 = 0；TS 常量内字符串已全英文（剩余中文均为 `//` 注释，符合中文注释要求）。
- 5 组关键串（title / description / role_pointer / message_count / bound）inTS=True 且与 JSON 逐字相等。

## 请定向复验
- packages/cli/test/restore-packet.test.ts（重点 M2a R2 drift-catcher，全文件回归）
- 生产源改动：packages/cli/src/restore-packet/schema-validator.ts
