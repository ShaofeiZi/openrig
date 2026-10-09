// OPR.0.5.6.10——唯一的 taxonomy 定义位置。通过 surface 导出，使 CLI 安装验证器给出的拒绝
// 与后台服务解析器执行的拒绝一致（关于 qitem-20260828092429-d2f94323 T2 的 desk 裁定）。
// 仅 re-export：任何位置出现第二份值列表，正是此 surface 要防止的缺陷。
export { ATOM_TAXONOMIES, TAXONOMY_TEACHING } from "./domain/context-packs/context-pack-types.js";
