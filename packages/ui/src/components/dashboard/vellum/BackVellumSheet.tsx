// 第 1 层 —— 背面羊皮纸衬底。
//
// 从页面边缘向内做小幅错位（12–16px），使背面层在羊皮纸边缘周围
// 恰好露出一圈。视觉上先在页面边缘看到清晰的黑色内容，再向内数像素
// 处看到同一内容在羊皮纸后方被模糊——这条由清晰到模糊的细微过渡
// 完成了"物体垫在纸下"的视错觉，同时不牺牲衬底宽度。每侧偏移量不对称，
// 营造手工摆放的质感。
//
// 按创始者选择：平铺 bg-surface-lowest/40 + backdrop-blur-[20px]。
// 视觉渐变由背面内容透过不均匀模糊自然形成。

export function BackVellumSheet() {
  return (
    <div
      data-testid="back-vellum-sheet"
      aria-hidden="true"
      className="absolute top-[14px] bottom-[12px] left-[16px] right-[14px] z-[5] bg-surface-lowest/40 backdrop-blur-[20px] pointer-events-none"
    />
  );
}
