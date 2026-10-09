# Skills 变更日志

这是 canonical skill 集合的仅追加变更日志。根据 `operating-the-skill-library/SKILL.md` v1.9 §8 中针对 `skills/CHANGELOG.md` 的规则，每个策展周期结束时更新本文件，最新条目位于顶部。

每个条目都应说明周期日期、变更内容及受影响的 skill，使跟踪该 skill 集合的用户能够独立于后台服务二进制版本获取更新。

---

## 2026-05-10——0.3.0 入门 skill 策展

从内置入门 skill 集合中移除了已弃用、面向 HA 的 skill。入门智能体现在依赖范围更窄的角色、流程及 compact-in-place skill，与其发布的启动指引保持一致。

实现方式：从 `packages/daemon/specs/agents/shared/` 中移除该 skill，更新共享 AgentSpec 资源池，并将更新后的 canonical 清单镜像到 `skills/_canonical/`。

---

## 2026-05-09——首次发布：skills hub 启动

首次将 canonical skills 从 `packages/daemon/specs/agents/shared/skills/` 镜像到 `<repo-root>/skills/_canonical/`。共发布 27 个 skill，分为 4 个类别（`core/`、`pm/`、`pods/`、`process/`），另有 `claude-compact-in-place/`、`rig-architect/` 等未分类的顶层 skill。

实现方式：`npm run mirror-skills` 调用 `scripts/mirror-skills.mjs` 中的 Node 脚本执行 rsync；`npm run mirror-skills:check` 接入 `npm run test:repo`，用于检测漂移。

目的：在仓库根目录公开 skill 集合，使用户无需深入查找 `packages/daemon/specs/` 即可发现面向公众的 skill 库。目录结构遵循 `_canonical/` 的严格所有权约定，使手工维护的顶层文件（本 CHANGELOG、README、LICENSE 以及未来的插件 manifest）在每次镜像时都能保留。

参考：

- `operating-the-skill-library/SKILL.md` v1.9 §8 的“In-repo skills hub”规则及“skills/CHANGELOG.md”规则。
- 机制比较：`substrate/shared-docs/openrig-work/lab/skill-authoring-techniques/findings/skills-hub-mirror-mechanism-comparison.md`。
