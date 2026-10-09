# 发布说明

本目录用于保存 zrig 的轻量级发布历史。

它刻意采用比单一大型 `CHANGELOG.md` 更简单的组织方式。

每个已发布版本都有一份独立说明，例如：

- `v0.1.12.md`
- `v0.2.0.md`
- `v0.3.0.md`
- 后续版本依此类推

## 为什么建立本目录

我们的目标是形成一套务实的发布管理模式，并与 zrig 当前的实际发布方式保持一致：

- 发布 npm package
- 可选创建 Git tag
- 可选创建 GitHub Release
- 用人工撰写的简短摘要说明版本包含的内容

这样可以让发布说明具备以下特点：

- 易于编写
- 易于在 GitHub Releases 中引用
- 易于粘贴到公告中
- 能够随仓库长期保存

## 最小发布流程

每次发布时：

1. 将 `_template.md` 复制为 `vX.Y.Z.md`。
2. 填写版本摘要、所含变更、运维说明、已知限制以及已执行的验证。
3. 在确切的发布切点运行 **substance gate**。该门禁会推导已发布 pack 来源下的每一个文件，验证与文件哈希绑定的人工判断以及每个机械候选项的单独处置结果，扫描由打包器推导出的完整 npm 产物集合，并写入可长期保存的回执。回执同时记录产物列表和已扫描文件列表；“产物减去已扫描文件”的差集必须为空。review JSON 中每个文件对应一个条目：

   ```json
   {
     "surfaces": [{
       "path": "packages/daemon/context-packs-src/example/guide.md",
       "sha256": "<sha256 of the reviewed bytes>",
       "verdict": "ship",
       "reason": "Generic product guidance.",
       "candidateDispositions": []
     }]
   }
   ```

   请先组装 package，再从同一个干净工作树运行指定门禁，并显式提供 judge 和发布切点 SHA。组装过程会输出它实际暂存的 substance roots；门禁本身从不维护另一份根目录列表。不允许发布时，人工 verdict 必须是 `instance-fact`、`internal-path`、`position-knowledge` 或 `lore-class` 之一，并在同一个逐文件条目中给出原因：

   ```bash
   bash scripts/build-package.sh
   npm run gate:substance -- \
     --review /path/to/substance-review.json \
     --receipt /path/to/substance-receipt.json \
     --judge <seat-or-person> \
     --cut-sha "$(git rev-parse HEAD)"
   ```

   如果判断缺失或过期、候选项未处置、包含内部 substance、pack 被归为 `lore-class`、完整产物扫描失败，或者存在未纳入扫描集合的产物，门禁都会拒绝此次发布切点。
4. 为该版本创建 Git tag：

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

5. 使用同一份文件创建 GitHub Release：

   ```bash
   gh release create vX.Y.Z \
     --repo mvschwarz/openrig \
     --title "zrig vX.Y.Z" \
     --notes-file docs/releases/vX.Y.Z.md
   ```

6. 如果发布流程包含 npm package，则发布该 package。

## 编写指引

- 优先使用面向用户的表述，不要写成 commit log。
- 将相关修复归并为少量要点。
- 明确说明会影响运维人员的变更，包括初始化、权限、启动状态、恢复、故障恢复和环境注意事项。
- 除非内部重构会实质改变用户行为或运维人员对系统的信心，否则不要写入发布说明。
- 如果验证范围有限，请直接如实说明。

## 范围

本目录是发布说明归档，并不是一套完整的历史 changelog 分类体系。

如果 zrig 将来需要经过整理的 `CHANGELOG.md`，可以从这里的发布说明生成或汇总。
