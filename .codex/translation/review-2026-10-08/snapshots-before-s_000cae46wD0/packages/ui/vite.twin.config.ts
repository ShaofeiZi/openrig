// OPR.0.4.1.11.1（FR-5）——仅开发用的 twin 构建目标。把真实的 @openrig/ui App
// （twin/ 入口）构建成一个自包含、可双击打开的 `intent.html`。独立配置，
// 以免打扰产品构建。下面这个单文件内联插件用的是 vite-plugin-singlefile 相同的
// generateBundle 技术，保持无依赖（worktree 与主分支共享 node_modules；本目标不新增安装依赖）。

import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// 把单个 JS chunk 与 CSS 资源内联进 HTML，再作为 intent.html 发出。
// 二进制资源（字体）已通过 assetsInlineLimit 内联为 base64 data: URL，
// 因此发出的 HTML 完全自包含——无需同级资源目录即可打开。
function singleFileInline(): Plugin {
  return {
    name: "twin-single-file-inline",
    enforce: "post",
    generateBundle(_options, bundle) {
      const htmlEntry = Object.values(bundle).find(
        (b) => b.type === "asset" && b.fileName.endsWith(".html"),
      );
      if (!htmlEntry || htmlEntry.type !== "asset") return;
      let html = String(htmlEntry.source);

      for (const item of Object.values(bundle)) {
        if (item.type === "chunk") {
          const scriptTag = new RegExp(
            `<script[^>]*\\ssrc="[^"]*${escapeRe(item.fileName)}"[^>]*></script>`,
            "g",
          );
          // 函数替换器（不是字符串）——打包后的 JS 含 `$&`/`$1` 模式
          // （例如 React 的转义键 `.replace(B,"$&/")`），String.replace 会把它们展开
          // 进匹配到的标签，从而损坏内联代码。
          html = html.replace(scriptTag, () => `<script type="module">\n${item.code}\n</script>`);
          delete bundle[item.fileName];
        } else if (item.fileName.endsWith(".css")) {
          const linkTag = new RegExp(
            `<link[^>]*\\shref="[^"]*${escapeRe(item.fileName)}"[^>]*>`,
            "g",
          );
          html = html.replace(linkTag, () => `<style>\n${String(item.source)}\n</style>`);
          delete bundle[item.fileName];
        }
      }

      delete bundle[htmlEntry.fileName];
      this.emitFile({ type: "asset", fileName: "intent.html", source: html });
    },
  };
}

// 本构建的 intent.html 落点界面。逐 slice 创作时设置，例如
// `TWIN_ROUTE=/topology/rig/rig_delivery npm run twin:build`。默认 = 仪表盘。
const twinRoute = process.env.TWIN_ROUTE && process.env.TWIN_ROUTE.length > 0 ? process.env.TWIN_ROUTE : "/";

// 0.4.3.29 主题——为构建出的 twin 可选指定调色板种子（dark|light|system）。
const twinTheme =
  process.env.TWIN_THEME && /^(dark|light|system)$/.test(process.env.TWIN_THEME) ? process.env.TWIN_THEME : "";

export default defineConfig({
  root: path.resolve(__dirname, "twin"),
  define: {
    __TWIN_ROUTE__: JSON.stringify(twinRoute),
    __TWIN_THEME__: JSON.stringify(twinTheme),
  },
  plugins: [react(), singleFileInline()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  build: {
    outDir: path.resolve(__dirname, "twin-out"),
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000, // 把所有二进制资源（字体）内联为 base64 data: URL
    cssCodeSplit: false,
    chunkSizeWarningLimit: 100_000, // 按创始人意见，沉重的单文件可接受
    rollupOptions: {
      output: {
        inlineDynamicImports: true, // 折叠成单一 JS chunk，便于干净地单文件内联
        entryFileNames: "twin.js",
        assetFileNames: "twin.[ext]",
      },
    },
  },
});
