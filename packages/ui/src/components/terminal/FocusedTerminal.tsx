import { useEffect, useRef, useCallback, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { readTerminalBearerToken } from "../mission-control/missionControlAuth.js";
import { useDaemonHealthSignal } from "../../hooks/useDaemonHealth.js";
import {
  LIVE_TERMINAL_RENDER_BACKGROUND,
  LIVE_TERMINAL_COLS,
  LIVE_TERMINAL_ROWS,
  LIVE_TERMINAL_FONT_SIZE,
  LIVE_TERMINAL_LINE_HEIGHT,
  LIVE_TERMINAL_FONT_FAMILY,
} from "./terminal-geometry.js";
import "@xterm/xterm/css/xterm.css";

// OPR.0.4.0.39（选择修复）：实时终端需要适配容器时，通过字号而非 CSS transform
// 缩放。xterm 的鼠标命中测试（文本选择、链接点击）会用变换后的指针偏移除以变换前的
// 单元格尺寸，因此祖先元素的 CSS transform:scale 会使选择位置按缩放比例漂移
//（xterm.js #6023）。通过 fontSize 缩放可保持单元格度量准确，让原生选择正常工作。
// 放大（contain 模式）设有上限以保持文字清晰，与 ScaleToFitTerminal 的
// MAX_CONTAIN_SCALE 一致。
const MAX_FIT_UPSCALE = 2;

const SPECIAL_KEY_MAP: Record<string, string> = {
  "\t": "Tab",
  "\r": "Enter",
  "\x7f": "BSpace",
  "\x1b": "Escape",
  "\x03": "C-c",
  "\x04": "C-d",
  "\x1a": "C-z",
  "\x0c": "C-l",
  "\x01": "C-a",
  "\x05": "C-e",
  "\x0b": "C-k",
  "\x15": "C-u",
  "\x17": "C-w",
};

const ESCAPE_SEQ_MAP: Record<string, string> = {
  "\x1b[A": "Up",
  "\x1b[B": "Down",
  "\x1b[C": "Right",
  "\x1b[D": "Left",
  "\x1b[H": "Home",
  "\x1b[F": "End",
  "\x1b[5~": "PgUp",
  "\x1b[6~": "PgDn",
  "\x1b[3~": "DC",
  "\x1b[2~": "IC",
};

// OPR.0.4.3.21：broker 的通用兜底关闭原因（见 TerminalSessionBroker.ts）。
// 健康感知的消歧逻辑只能替换这一条消息；具体原因（`session not found: …`、
// `pipe-pane failed: …`、`tmux session terminated`、`pipe output file failed: …`）
// 始终原样透传。
const GENERIC_BROKER_UNAVAILABLE = "terminal broker unavailable";
// 当 broker 报告通用兜底原因且后台服务健康检查失败时，显示这条如实反映控制面的消息。
// 它会呈现在“终端不可用：”前缀之后。
const DAEMON_CONTROL_PLANE_UNHEALTHY =
  "后台服务控制面不健康（事件循环饥饿）；只需重启后台服务，你的席位会保留";

type WsMessage = { type: "keys"; keys: string[] } | { type: "text"; text: string };

export function mapXtermInput(data: string): WsMessage[] {
  const messages: WsMessage[] = [];
  let i = 0;
  let textBuf = "";

  const flushText = () => {
    if (textBuf) { messages.push({ type: "text", text: textBuf }); textBuf = ""; }
  };

  while (i < data.length) {
    if (data[i] === "\x1b" && data[i + 1] === "[") {
      const rest = data.slice(i);
      let matched = false;
      for (const [seq, key] of Object.entries(ESCAPE_SEQ_MAP)) {
        if (rest.startsWith(seq)) {
          flushText();
          messages.push({ type: "keys", keys: [key] });
          i += seq.length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        textBuf += data[i]!;
        i++;
      }
    } else {
      const key = SPECIAL_KEY_MAP[data[i]!];
      if (key) {
        flushText();
        messages.push({ type: "keys", keys: [key] });
        i++;
      } else {
        textBuf += data[i]!;
        i++;
      }
    }
  }
  flushText();
  return messages;
}

export function applyOpaqueTerminalBackground(container: HTMLElement): void {
  const surfaces = [
    container,
    container.querySelector<HTMLElement>(".xterm"),
    container.querySelector<HTMLElement>(".xterm-screen"),
    container.querySelector<HTMLElement>(".xterm-viewport"),
    container.querySelector<HTMLElement>(".xterm-rows"),
  ];
  for (const surface of surfaces) {
    if (surface) surface.style.backgroundColor = LIVE_TERMINAL_RENDER_BACKGROUND;
  }
}

export function scrollTerminalViewportToPrompt(container: HTMLElement): void {
  const scroll = () => {
    const cursor = container.querySelector<HTMLElement>("textarea.xterm-helper-textarea");
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    if (!cursor) {
      container.scrollTop = maxScrollTop;
      return;
    }

    const parsedCursorTop = Number.parseFloat(cursor.style.top);
    const cursorTop = Number.isFinite(parsedCursorTop) ? parsedCursorTop : cursor.offsetTop;
    const lineHeight = cursor.offsetHeight || 14;
    const cursorBottom = cursorTop + lineHeight;
    const desiredScrollTop = cursorBottom - container.clientHeight + lineHeight * 3;
    container.scrollTop = Math.min(maxScrollTop, Math.max(0, desiredScrollTop));
  };

  scroll();
  window.requestAnimationFrame(scroll);
  window.setTimeout(scroll, 50);
}

interface FocusedTerminalProps {
  sessionName: string;
  daemonBaseUrl?: string;
  /**
   * OPR.0.4.0.39：实时 xterm 适配容器的方式。"natural"（默认）表示按原生 90x27
   * 尺寸渲染，供信息流卡片等不缩放的调用方使用；"width" 表示通过 fontSize 缩小
   * 以适配容器宽度（绝不放大），供网格、图和表格单元格使用；"contain" 表示通过
   * fontSize 同时适配两个轴，限制放大比例并居中，供节点详情面板使用。使用 fontSize
   * 而不是 CSS transform 缩放，可让 xterm 的选择/点击命中测试保持原生正确（#6023）。
   */
  fit?: "natural" | "width" | "contain";
  /**
   * OPR.0.4.4.20 delta-C（BR-12——终端而非聊天）：首次成功连接时，向目标窗格
   * 预填恰好一个文本帧。它沿用现有文本通路（broker sendText → tmux
   * `send-keys -l --`，不发送 `C-m`），因此不会提交任何内容；光标停在末尾，用户亲自
   * 按 Enter 后才会一并提交前言和消息。每次挂载只发送一次，重连绝不重发。该属性是
   * 唯一新增的终端接线项；这一组件族中没有聊天面板、线程、气泡或编辑框。
   */
  initialText?: string;
}

export function FocusedTerminal({ sessionName, daemonBaseUrl, fit = "natural", initialText }: FocusedTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // OPR.0.4.0.39：适配包装器填满可用容器，内部 containerRef 承载原生尺寸的 xterm。
  // 比较包装器可用尺寸与 xterm 的原生尺寸（按基础字号捕获一次），再设置 xterm 的
  // fontSize 使 90x27 完整放入；不使用 CSS transform，确保选择行为原生正确。
  const fitWrapperRef = useRef<HTMLDivElement>(null);
  const naturalSizeRef = useRef<{ w: number; h: number } | null>(null);
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const termRef = useRef<unknown>(null);
  const wsRef = useRef<WebSocket | null>(null);
  // OPR.0.4.4.20 delta-C：初始文本帧的单次挂载守卫；WS 重连绝不能向窗格重发前言。
  const initialTextSentRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const promptScrollUntilRef = useRef(0);
  // OPR.0.4.0.39：从实时底部向上回滚的行数（0 表示实时）。由滚轮处理器驱动，
  // broker 绘制对应的 tmux 历史窗口。输入内容或滚回 0 时恢复实时状态。
  const scrollOffsetRef = useRef(0);
  const [error, setError] = useState<string | null>(null);

  // OPR.0.4.3.21：共享的后台服务健康信号。它来自上下文；没有 provider 时默认健康，
  // 因而不影响独立终端测试。信号保存在 ref 中，让 ws.onclose 回调无须重新订阅即可读取最新值。
  const health = useDaemonHealthSignal();
  const controlPlaneUnhealthyRef = useRef(false);
  controlPlaneUnhealthyRef.current = health.controlPlaneUnhealthy;

  const sendScroll = useCallback((offset: number) => {
    const wsc = wsRef.current;
    if (wsc && wsc.readyState === WebSocket.OPEN) {
      wsc.send(JSON.stringify({ type: "scroll", offset }));
    }
  }, []);

  // OPR.0.4.0.39（选择修复）：通过字号让 xterm 适配容器，不使用会破坏 xterm 鼠标/
  // 选择坐标的 CSS transform（#6023）。该回调只读取 ref，因此稳定且没有依赖项。
  // natural 是基础字号下捕获一次的 xterm 90x27 像素尺寸，wrapper 是可用空间。
  const applyFontSizeFit = useCallback(() => {
    const mode = fitRef.current;
    if (mode === "natural") return;
    const term = termRef.current as { options: { fontSize: number } } | null;
    const wrapper = fitWrapperRef.current;
    const natural = naturalSizeRef.current;
    if (!term || !wrapper || !natural || natural.w <= 0 || natural.h <= 0) return;
    const availW = wrapper.clientWidth;
    const availH = wrapper.clientHeight;
    if (availW <= 0) return; // not laid out yet (or jsdom) - skip, no crash
    const scale = mode === "contain" && availH > 0
      ? Math.min(MAX_FIT_UPSCALE, availW / natural.w, availH / natural.h)
      : Math.min(1, availW / natural.w); // "width": fit width, never upscale
    const nextFont = Math.max(2, LIVE_TERMINAL_FONT_SIZE * scale);
    try {
      // 仅在发生实质变化时写入，避免抖动和 ResizeObserver 反馈循环。
      if (Math.abs(term.options.fontSize - nextFont) > 0.1) {
        term.options.fontSize = nextFont;
      }
    } catch { /* term not ready / disposed */ }
  }, []);

  const disposeTerminal = useCallback(() => {
    const term = termRef.current as { dispose(): void } | null;
    term?.dispose();
    termRef.current = null;
  }, []);

  const scrollLiveTerminalToPrompt = useCallback((term: { scrollToBottom(): void } | null) => {
    if (term) {
      term.scrollToBottom();
    }
    if (containerRef.current) {
      scrollTerminalViewportToPrompt(containerRef.current);
    }
  }, []);

  const connectForGeneration = useCallback((gen: number) => {
    const base = daemonBaseUrl ?? window.location.origin;
    const wsUrl = base.replace(/^http/, "ws");
    const token = readTerminalBearerToken();
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : "";
    const ws = new WebSocket(`${wsUrl}/api/terminal/${encodeURIComponent(sessionName)}${tokenParam}`);

    ws.onopen = () => {
      if (generationRef.current !== gen) { ws.close(); return; }
      // 后台服务 broker 管理固定的规范几何尺寸（90x27）。客户端保持同一网格，
      // 并在服务端滚动历史记录（逐订阅者 capture-pane）。每次连接或重连都从实时底部开始。
      scrollOffsetRef.current = 0;
      promptScrollUntilRef.current = Date.now() + 2500;
      const term = termRef.current as { scrollToBottom(): void } | null;
      scrollLiveTerminalToPrompt(term);
      // OPR.0.4.4.20 delta-C：每次挂载发送一个文本帧，不发送 Enter 帧。
      if (initialText && !initialTextSentRef.current) {
        initialTextSentRef.current = true;
        ws.send(JSON.stringify({ type: "text", text: initialText }));
      }
    };

    ws.onmessage = (evt) => {
      if (generationRef.current !== gen) return;
      const term = termRef.current as { write(data: string): void; scrollToBottom(): void } | null;
      if (typeof evt.data === "string" && term) {
        term.write(evt.data);
        if (Date.now() <= promptScrollUntilRef.current) {
          scrollLiveTerminalToPrompt(term);
        }
      }
    };

    ws.onclose = (evt) => {
      if (generationRef.current !== gen) return;
      const definitive = evt.code === 1008 || evt.code === 1011 || evt.code === 1001;
      if (definitive) {
        disposeTerminal();
        // OPR.0.4.3.21：健康感知消歧只替换 broker 的通用
        // “terminal broker unavailable”兜底消息，而且仅当后台服务健康状态明确报告
        // 控制面不健康时才替换。所有具体的 broker/会话原因（session not found、
        // pipe-pane failed、tmux session terminated）均原样保留。
        if (evt.reason === GENERIC_BROKER_UNAVAILABLE && controlPlaneUnhealthyRef.current) {
          setError(DAEMON_CONTROL_PLANE_UNHEALTHY);
        } else {
          setError(evt.reason || "终端不可用：此后台服务上未找到该会话");
        }
        return;
      }
      const term = termRef.current as { write(data: string): void } | null;
      if (term) {
        term.write("\r\n\x1b[90m[disconnected - reconnecting...]\x1b[0m\r\n");
      }
      if (mountedRef.current && generationRef.current === gen) {
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current && generationRef.current === gen) connectForGeneration(gen);
        }, 3000);
      }
    };

    wsRef.current = ws;
    return ws;
  }, [sessionName, daemonBaseUrl, disposeTerminal, scrollLiveTerminalToPrompt]);

  useEffect(() => {
    if (!containerRef.current) return;
    mountedRef.current = true;
    generationRef.current++;
    const currentGen = generationRef.current;
    let cleanedUp = false;

    (async () => {
      try {
        if (cleanedUp) return;

        const term = new Terminal({
          cursorBlink: true,
          cols: LIVE_TERMINAL_COLS,
          rows: LIVE_TERMINAL_ROWS,
          fontSize: LIVE_TERMINAL_FONT_SIZE,
          lineHeight: LIVE_TERMINAL_LINE_HEIGHT,
          fontFamily: LIVE_TERMINAL_FONT_FAMILY,
          // xterm 擦除/重绘需要不透明的单元格背景。若 xterm 渲染表面半透明，清屏或
          // 绝对光标重绘后旧 TUI 单元格会透出，导致 Claude/Codex 视图损坏。
          theme: { background: LIVE_TERMINAL_RENDER_BACKGROUND, foreground: "#e0e0e0", cursor: "#e0e0e0" },
          allowTransparency: false,
          allowProposedApi: true,
        });

        term.open(containerRef.current!);
        // 部分 xterm DOM 层不会继承主题背景，因此把每个渲染层固定为不透明，
        // 确保清屏/擦除操作真正擦除内容。
        applyOpaqueTerminalBackground(containerRef.current!);
        term.focus();
        promptScrollUntilRef.current = Date.now() + 2500;
        scrollTerminalViewportToPrompt(containerRef.current!);
        termRef.current = term;

        term.onData((data: string) => {
          const wsc = wsRef.current;
          if (!wsc || wsc.readyState !== WebSocket.OPEN) return;
          // OPR.0.4.0.39：输入前先返回实时底部。
          if (scrollOffsetRef.current > 0) {
            scrollOffsetRef.current = 0;
            sendScroll(0);
          }
          const mapped = mapXtermInput(data);
          for (const msg of mapped) {
            wsc.send(JSON.stringify(msg));
          }
        });

        // OPR.0.4.0.39：滚轮用于在服务端回滚 tmux 历史。向上滚增加偏移并绘制更早的
        // capture-pane 窗口，向下滚则减少偏移，回到 0 时恢复实时。此处自行处理滚轮并
        // 返回 false，避免 xterm 本地的空滚动缓冲区干扰。
        const scrollHandlerTerm = term as {
          attachCustomWheelEventHandler(handler: (ev: WheelEvent) => boolean): void;
        };
        scrollHandlerTerm.attachCustomWheelEventHandler((ev: WheelEvent) => {
          const wsc = wsRef.current;
          if (!wsc || wsc.readyState !== WebSocket.OPEN) return true;
          const STEP = 3;
          if (ev.deltaY < 0) {
            scrollOffsetRef.current += STEP;
          } else if (ev.deltaY > 0) {
            scrollOffsetRef.current = Math.max(0, scrollOffsetRef.current - STEP);
          } else {
            return true;
          }
          sendScroll(scrollOffsetRef.current);
          return false;
        });

        // OPR.0.4.0.38 FR-7：不通过 term.onResize 向 ws 转发调整大小。窗格几何尺寸
        // 在后台服务侧固定，客户端网格与其精确一致，绝不要求窗格调整尺寸。

        connectForGeneration(currentGen);

        // OPR.0.4.0.39（选择修复）：在任何 fontSize 适配前，以基础字号捕获 xterm
        // 原生 90x27 的像素尺寸作为固定参考，再应用初始适配。通过 rAF 等待布局稳定，
        // 并针对尺寸为 0 的 jsdom 环境设置守卫。
        requestAnimationFrame(() => {
          if (cleanedUp || !containerRef.current) return;
          if (!naturalSizeRef.current) {
            const w = containerRef.current.offsetWidth;
            const h = containerRef.current.offsetHeight;
            if (w > 0 && h > 0) naturalSizeRef.current = { w, h };
          }
          applyFontSizeFit();
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "终端初始化失败");
      }
    })();

    return () => {
      cleanedUp = true;
      mountedRef.current = false;
      generationRef.current++;
      if (reconnectTimerRef.current) { clearTimeout(reconnectTimerRef.current); reconnectTimerRef.current = null; }
      const activeWs = wsRef.current;
      if (activeWs) { activeWs.close(); wsRef.current = null; }
      disposeTerminal();
    };
  }, [connectForGeneration, disposeTerminal]);

  // OPR.0.4.0.39（选择修复）：容器尺寸变化时（响应式网格列、窗口尺寸或节点详情面板），
  // 重新适配 xterm 的 fontSize。观察的是填满父级的适配包装器，因此改变内部 xterm
  // 的 fontSize 不会反馈到被观察盒子中。"natural" 模式下不执行任何操作。
  useEffect(() => {
    if (fit === "natural") return undefined;
    const wrapper = fitWrapperRef.current;
    if (!wrapper || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => applyFontSizeFit());
    ro.observe(wrapper);
    applyFontSizeFit();
    return () => ro.disconnect();
  }, [fit, applyFontSizeFit]);

  if (error) {
    return (
      <div
        key={`focused-terminal-error-${sessionName}`}
        data-testid={`focused-terminal-${sessionName}`}
        className="h-full w-full min-h-[200px] flex items-center justify-center px-4 text-center text-stone-400 font-mono text-xs"
      >
        <span className="block max-w-[28ch] whitespace-normal break-all leading-relaxed">
          终端不可用：{error}
        </span>
      </div>
    );
  }

  // xterm 始终按原生完整 90x27 几何尺寸（w-max）渲染，使整个屏幕和光标都可见，
  // 不再使用会隐藏底部行的 min-h/h-full 限制。
  const liveTerminal = (
    <div
      key={`focused-terminal-live-${sessionName}`}
      ref={containerRef}
      data-testid={`focused-terminal-${sessionName}`}
      className="w-max bg-stone-950/85 backdrop-blur-sm"
    />
  );

  // OPR.0.4.0.39（选择修复）："natural" 模式下 xterm 按原生尺寸渲染，不缩放。
  // "width"/"contain" 模式下，它由填满容器的适配包装器包裹；applyFontSizeFit
  // 设置 xterm fontSize，使 90x27 完整放入。这里不使用 CSS transform，因此 xterm
  // 的选择/点击命中测试保持原生正确（#6023）。
  if (fit === "natural") return liveTerminal;

  return (
    <div
      ref={fitWrapperRef}
      data-testid={`focused-terminal-fit-${sessionName}`}
      className={
        fit === "contain"
          ? "flex h-full w-full items-center justify-center overflow-hidden"
          : "w-full overflow-hidden"
      }
    >
      {liveTerminal}
    </div>
  );
}
