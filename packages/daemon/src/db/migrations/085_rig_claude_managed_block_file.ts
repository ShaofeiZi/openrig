import type { Migration } from "../migrate.js";

/**
 * #25——rigs.claude_managed_block_file 列。
 *
 * 保存 rig 级 `managed_blocks.claude-code` 选择（`CLAUDE.md` 或 `CLAUDE.local.md`），
 * 实例化时由 RigRepository.setRigClaudeManagedBlockFile 写入。启动投递、销毁和导出会读回它，
 * 因此 launch、restore replay、relaunch 和新增成员都会写入同一文件。Handover 不写指导内容；
 * 继任者读取现有文件。NULL = CLAUDE.md 默认值。镜像迁移 056（rigs.permission_policy）。
 */
export const rigClaudeManagedBlockFileSchema: Migration = {
  name: "085_rig_claude_managed_block_file.sql",
  sql: `
    ALTER TABLE rigs ADD COLUMN claude_managed_block_file TEXT;
  `,
};
