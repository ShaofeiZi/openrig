// V0.3.1 slice 15 walk-items 6 + 11 —— 通用文件链接基元。
//
// 为 UI 中任意文件引用加包裹：点击即在 SharedDetailDrawer 中打开
// 对应的查看器。它是对现有 FileReferenceTrigger 的薄封装：API 更简单
// （只需 `path` + `root`，不必构造完整的 FileViewerData），让各调用点
// 可以零成本接入。
//
// FileViewer 在渲染时按扩展名推断文件类型（见
// drawer-viewers/FileViewer.tsx :: inferKind），因此 FileLink 不再走自己的
// 推断路径——图片扩展名（.png/.jpg/.jpeg/.gif/.webp/.svg）会经由抽屉自动
// 渲染为 `<img>`。walk-item 6（"images show as binary"）由此得到解决：把
// 图片类型的文件引用都路由到本基元，而不是单纯地渲染文件名文本。

import type { ReactNode, CSSProperties } from "react";
import { FileReferenceTrigger } from "../drawer-triggers/FileReferenceTrigger.js";
import type { FileKind, FileViewerData } from "../drawer-viewers/FileViewer.js";

export interface FileLinkProps {
  /** 展示用路径。当未提供 `readPath` 时，它同时作为 `root` 下的相对读取路径。 */
  path: string;
  /** 允许读取的根名称。当提供了 `absolutePath` 时可省略
   *  （由 FileViewer 的解析器挑选匹配的根）。 */
  root?: string;
  /** `root` 下显式指定的相对路径；省略时默认为 `path`。
   *  当 `path` 是与磁盘相对路径不同的展示标签时有用。 */
  readPath?: string;
  /** 文件系统绝对路径；未提供 `root` 时由 FileViewer 对照 /api/files/roots 解析。 */
  absolutePath?: string | null;
  /** 可选的显式类型覆盖。省略时 FileViewer 在渲染时按 `path` 扩展名推断。 */
  kind?: FileKind;
  /** 渲染在可点击包裹层内的子节点。省略时默认展示原始 `path` 字符串。 */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  testId?: string;
}

export function FileLink({
  path,
  root,
  readPath,
  absolutePath,
  kind,
  children,
  className,
  style,
  testId,
}: FileLinkProps) {
  const data: FileViewerData = {
    path,
    ...(root !== undefined ? { root } : {}),
    ...(readPath !== undefined ? { readPath } : {}),
    ...(absolutePath !== undefined ? { absolutePath } : {}),
    ...(kind !== undefined ? { kind } : {}),
  };
  return (
    <FileReferenceTrigger
      data={data}
      className={className}
      style={style}
      testId={testId ?? "file-link"}
    >
      {children ?? path}
    </FileReferenceTrigger>
  );
}
