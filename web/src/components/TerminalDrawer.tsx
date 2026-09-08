import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { Session } from "@claudex/shared";
import { cn } from "@/lib/cn";
import { useFocusReturn } from "@/hooks/useFocusReturn";

/**
 * TerminalDrawer — a PTY attached to the session's cwd (worktree if present,
 * else the project root). Works as a bottom sheet on mobile (full screen)
 * and a lower-half panel on desktop. We lean on xterm.js for the actual
 * rendering; our job is the WS plumbing + the layout chrome.
 *
 * WS protocol mirrors server/src/transport/pty.ts:
 *   server → client:
 *     { type: "data",  data: string }
 *     { type: "error", code, message }
 *     { type: "exit",  exitCode, signal }
 *   client → server:
 *     { type: "data",   data: string }
 *     { type: "resize", cols, rows }
 *
 * We don't attempt reconnect — a terminal session is stateful; a transient
 * disconnect is usually more helpful to surface than to paper over.
 *
 * iOS Safari: xterm.js works but the on-screen keyboard can be finicky. We
 * use a textarea-style focus path (tap the terminal → focus) and rely on
 * xterm's own IME handling for text input. `convertEol` makes `\n` coming
 * from server processes render as CRLF, which matters inside a pty on some
 * terminals. We haven't lab-tested this on a physical iOS device; see the
 * README note in the drawer's comment block at the top of the file.
 */
export function TerminalDrawer({
  session,
  projectPath,
  onClose,
}: {
  session: Session;
  /** Falls back to the project root when the session isn't on a worktree. */
  projectPath: string | null;
  onClose: () => void;
}) {
  useFocusReturn();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [phase, setPhase] = useState<
    "connecting" | "open" | "closed" | "error"
  >("connecting");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  // Show the mobile keybar on touch devices or narrow viewports. Re-evaluate
  // on orientation / window resize so an iPad going landscape can fall back
  // to hardware keys if the user attaches one.
  const [showKeybar, setShowKeybar] = useState<boolean>(() => detectMobile());
  useEffect(() => {
    const update = () => setShowKeybar(detectMobile());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const cwd = session.worktreePath ?? projectPath ?? "(project)";

  // Send a raw byte sequence to the PTY as if the user had typed it. Mirrors
  // the term.onData path so everything funnels through the same server code.
  const sendSeq = (seq: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "data", data: seq }));
    }
    // Return focus to the terminal so the user can keep typing afterwards.
    termRef.current?.focus();
  };

  // Handle a "printable" keybar tap. If Ctrl is armed, translate to the
  // corresponding control byte (Ctrl+a = 0x01, Ctrl+z = 0x1a, Ctrl+[ = 0x1b,
  // Ctrl+c = 0x03, …). Otherwise send the character as-is.
  const tapPrintable = (ch: string) => {
    if (ctrlArmed) {
      const code = ch.toUpperCase().charCodeAt(0) - 64;
      if (code >= 0 && code <= 31) {
        sendSeq(String.fromCharCode(code));
      } else {
        // Not a control-mappable char; fall back to the literal.
        sendSeq(ch);
      }
      setCtrlArmed(false);
      return;
    }
    sendSeq(ch);
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily:
        '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      // convertEol MUST be false for PTY-backed terminals: node-pty already
      // emits CRLF, and vim's alt-screen cursor sequences can contain bare
      // \n that this flag would rewrite to \r\n, injecting phantom carriage
      // returns that corrupt the redraw — symptom is "vim looks frozen"
      // even though input is flowing.
      convertEol: false,
      // Desktop-only improvement: let Option-x on macOS emit Meta-x so vim
      // M-combos work. Harmless on mobile (no Option key).
      macOptionIsMeta: true,
      allowProposedApi: false,
      // Match the app's light palette (see web/tailwind.config / globals.css).
      // background == canvas, foreground == ink, cursor == klein.
      theme: {
        background: "#faf9f5",
        foreground: "#1f1e1d",
        cursor: "#cc785c",
        cursorAccent: "#faf9f5",
        selectionBackground: "#cc785c33",
        // Keep ANSI colors reasonable on a light background. Defaults are
        // tuned for dark, so we nudge a few toward readability.
        black: "#1f1e1d",
        red: "#b91c1c",
        green: "#15803d",
        yellow: "#a16207",
        blue: "#1e40af",
        magenta: "#9d174d",
        cyan: "#0e7490",
        white: "#3a3936",
        brightBlack: "#6b6967",
        brightRed: "#dc2626",
        brightGreen: "#16a34a",
        brightYellow: "#ca8a04",
        brightBlue: "#2563eb",
        brightMagenta: "#be185d",
        brightCyan: "#0891b2",
        brightWhite: "#1f1e1d",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    // First fit — measure actual available space.
    try {
      fit.fit();
    } catch {
      /* element not sized yet — ResizeObserver below will pick it up */
    }
    const initialCols = term.cols || 80;
    const initialRows = term.rows || 24;

    // --- open websocket ---
    const wsUrl = buildWsUrl(session.id, initialCols, initialRows);
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setPhase("open");
      // Try to focus the terminal so keyboard goes straight in. On iOS this
      // might not actually pop the keyboard until the user taps — that's
      // expected.
      requestAnimationFrame(() => term.focus());
      // Send an explicit resize frame right after open. On iOS the
      // ResizeObserver doesn't always fire until user interaction, which
      // leaves vim/less reading the initial ioctl geometry from the query
      // string only — and if the drawer animates in, that geometry can be
      // stale. Re-fit and publish the true terminal size so TUIs lay out
      // correctly from the first frame.
      try {
        fit.fit();
      } catch {
        /* host may not be laid out yet; ResizeObserver will retry */
      }
      const cols = term.cols || initialCols;
      const rows = term.rows || initialRows;
      try {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      } catch {
        /* ignore */
      }
    };
    ws.onmessage = (ev) => {
      let frame: { type?: string; data?: unknown; code?: string; message?: string; exitCode?: number };
      try {
        frame = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      if (frame.type === "data" && typeof frame.data === "string") {
        term.write(frame.data);
        return;
      }
      if (frame.type === "error") {
        setErrMsg(`${frame.code ?? "error"}: ${frame.message ?? ""}`);
        setPhase("error");
        term.write(
          `\r\n\x1b[31m[claudex] ${frame.code ?? "error"}: ${frame.message ?? ""}\x1b[0m\r\n`,
        );
        return;
      }
      if (frame.type === "exit") {
        const code = frame.exitCode ?? 0;
        term.write(
          `\r\n\x1b[2m[claudex] shell exited (${code}). Close and reopen to start a new one.\x1b[0m\r\n`,
        );
        setPhase("closed");
        return;
      }
    };
    ws.onclose = () => {
      if (phase !== "error") setPhase("closed");
    };
    ws.onerror = () => {
      setPhase("error");
      setErrMsg((m) => m ?? "WebSocket 错误");
    };

    // --- term → ws ---
    const dataSub = term.onData((chunk) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "data", data: chunk }));
      }
    });

    // --- resize observer ---
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        return;
      }
      const cols = term.cols;
      const rows = term.rows;
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      }
    });
    ro.observe(host);

    // --- cleanup ---
    return () => {
      dataSub.dispose();
      ro.disconnect();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      try {
        term.dispose();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
      termRef.current = null;
      fitRef.current = null;
    };
    // We intentionally only run this on session.id — remount the terminal if
    // the user switches sessions (unlikely here since the component is
    // mounted from the Chat screen keyed to a specific session, but safe).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  return (
    <div className="fixed inset-0 z-40 flex items-end md:items-stretch md:justify-end">
      <button
        aria-label="关闭终端"
        onClick={onClose}
        className="absolute inset-0 bg-ink/30 backdrop-blur-sm"
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="终端"
        className={cn(
          "relative bg-canvas border-t border-line shadow-card flex flex-col",
          // Mobile: full-height bottom sheet (feels right at 390px — anything
          // shorter and the keyboard eats the prompt).
          "w-full h-full",
          // Desktop: lower half, right side. Terminal is traditionally a
          // bottom pane; we put it there.
          "md:h-[55vh] md:rounded-t-xl md:border md:rounded-xl md:w-[min(920px,90vw)] md:m-6",
        )}
      >
        <header className="flex items-center gap-2 px-3 py-2 border-b border-line bg-paper/40 shrink-0">
          <span className="mono text-ui text-ink-muted uppercase tracking-[0.12em]">
            终端
          </span>
          <span className="mono text-ui text-ink-soft truncate" title={cwd}>
            {cwd}
          </span>
          <span
            className={cn(
              "ml-auto mono text-ui-sm",
              phase === "open" && "text-success",
              phase === "connecting" && "text-ink-muted",
              phase === "closed" && "text-ink-muted",
              phase === "error" && "text-danger",
            )}
          >
            {phase === "connecting"
              ? "连接中…"
              : phase === "open"
                ? "● 已连接"
                : phase === "closed"
                  ? "已关闭"
                  : `出错`}
          </span>
          <button
            onClick={onClose}
            aria-label="关闭终端"
            className="h-7 w-7 rounded-sm border border-line bg-canvas flex items-center justify-center hover:bg-paper transition-colors"
          >
            <X className="w-3.5 h-3.5 text-ink-soft" />
          </button>
        </header>
        {errMsg && phase === "error" && (
          <div className="px-3 py-1.5 text-ui text-danger bg-danger-wash/30 border-b border-danger/30">
            {errMsg}
          </div>
        )}
        {/*
          The terminal host. xterm renders into a positioned child, so the
          wrapper needs to be a positioned container with a stable size. We
          give it full flex-grow + a tiny padding so the text doesn't touch
          the border.
        */}
        <div className="flex-1 min-h-0 bg-canvas p-2">
          <div
            ref={hostRef}
            className="w-full h-full"
            // xterm handles its own focus; the parent click should fall through
            onClick={() => termRef.current?.focus()}
          />
        </div>
        {showKeybar && (
          <MobileKeybar
            ctrlArmed={ctrlArmed}
            onToggleCtrl={() => setCtrlArmed((v) => !v)}
            onEsc={() => {
              // Esc is also a natural "cancel Ctrl" signal.
              sendSeq("\x1b");
              setCtrlArmed(false);
            }}
            onTab={() => sendSeq("\t")}
            onColon={() => tapPrintable(":")}
            onSlash={() => tapPrintable("/")}
            onQuestion={() => tapPrintable("?")}
            onArrow={(dir) => {
              const map = {
                up: "\x1b[A",
                down: "\x1b[B",
                right: "\x1b[C",
                left: "\x1b[D",
              } as const;
              sendSeq(map[dir]);
              setCtrlArmed(false);
            }}
            onCtrlLetter={(letter) => {
              // Explicit Ctrl+<letter> tap when the sticky toggle feels clunky.
              const code = letter.toUpperCase().charCodeAt(0) - 64;
              if (code >= 0 && code <= 31) {
                sendSeq(String.fromCharCode(code));
              }
              setCtrlArmed(false);
            }}
            onSaveQuit={() => {
              // Esc + :wq + CR — a common "get me out" sequence. Sent as one
              // stream so vim sees a clean command line.
              sendSeq("\x1b:wq\r");
              setCtrlArmed(false);
            }}
            onEnter={() => {
              sendSeq("\r");
              setCtrlArmed(false);
            }}
          />
        )}
      </aside>
    </div>
  );
}

function buildWsUrl(
  sessionId: string,
  cols: number,
  rows: number,
): string {
  const loc = window.location;
  const proto = loc.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({
    sessionId,
    cols: String(cols),
    rows: String(rows),
  });
  return `${proto}//${loc.host}/pty?${params.toString()}`;
}

// Touch device OR narrow viewport counts as mobile. We show the keybar there
// because iOS/Android soft keyboards don't expose Esc, arrows, Ctrl, etc.
function detectMobile(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.matchMedia("(pointer: coarse)").matches) return true;
  } catch {
    /* older browsers — fall through to viewport check */
  }
  return window.innerWidth < 768;
}

/**
 * A single-row, horizontally scrollable keybar for keys that the iOS/Android
 * soft keyboard doesn't surface. Minimal by design — the goal is "vim is
 * usable on a phone", not "replicate a full keyboard".
 *
 * Ctrl is a sticky modifier: tap Ctrl, then the next C/D/Z/etc. is translated
 * to the corresponding control byte by the parent's tapPrintable().
 */
function MobileKeybar({
  ctrlArmed,
  onToggleCtrl,
  onEsc,
  onTab,
  onColon,
  onSlash,
  onQuestion,
  onArrow,
  onCtrlLetter,
  onSaveQuit,
  onEnter,
}: {
  ctrlArmed: boolean;
  onToggleCtrl: () => void;
  onEsc: () => void;
  onTab: () => void;
  onColon: () => void;
  onSlash: () => void;
  onQuestion: () => void;
  onArrow: (dir: "up" | "down" | "left" | "right") => void;
  onCtrlLetter: (letter: string) => void;
  onSaveQuit: () => void;
  onEnter: () => void;
}) {
  const keyBase =
    "mono text-ui h-9 min-w-9 px-2 rounded-sm border border-line bg-paper text-ink active:bg-line/60 flex items-center justify-center shrink-0 select-none";
  return (
    <div
      // Keep taps from stealing focus from the xterm textarea (so the keybar
      // buttons don't dismiss the iOS keyboard between presses). The actual
      // send path re-focuses the terminal anyway.
      onMouseDown={(e) => e.preventDefault()}
      onTouchStart={(e) => {
        // Allow scroll in the bar itself, but prevent focus loss on taps.
        const t = e.target as HTMLElement;
        if (t.tagName === "BUTTON") e.preventDefault();
      }}
      className="shrink-0 border-t border-line bg-canvas/95 backdrop-blur px-2 py-1.5 flex items-center gap-1.5 overflow-x-auto"
      role="toolbar"
      aria-label="终端键盘栏"
    >
      <button type="button" className={keyBase} onClick={onEsc} aria-label="Esc 键">
        Esc
      </button>
      <button type="button" className={keyBase} onClick={onTab} aria-label="Tab 键">
        Tab
      </button>
      <button
        type="button"
        className={cn(
          keyBase,
          ctrlArmed && "bg-klein text-white border-klein",
        )}
        onClick={onToggleCtrl}
        aria-pressed={ctrlArmed}
        aria-label="Ctrl 粘滞键"
        title="先点此键，再点字母即可发送 Ctrl+字母"
      >
        Ctrl
      </button>
      <button type="button" className={keyBase} onClick={() => onCtrlLetter("c")} aria-label="Ctrl+C">
        ^C
      </button>
      <button type="button" className={keyBase} onClick={() => onCtrlLetter("d")} aria-label="Ctrl+D">
        ^D
      </button>
      <span className="w-px h-5 bg-line shrink-0" aria-hidden />
      <button type="button" className={keyBase} onClick={onColon} aria-label="冒号键">
        :
      </button>
      <button type="button" className={keyBase} onClick={onSlash} aria-label="斜杠键">
        /
      </button>
      <button type="button" className={keyBase} onClick={onQuestion} aria-label="问号键">
        ?
      </button>
      <span className="w-px h-5 bg-line shrink-0" aria-hidden />
      <button type="button" className={keyBase} onClick={() => onArrow("left")} aria-label="左箭头">
        ←
      </button>
      <button type="button" className={keyBase} onClick={() => onArrow("down")} aria-label="下箭头">
        ↓
      </button>
      <button type="button" className={keyBase} onClick={() => onArrow("up")} aria-label="上箭头">
        ↑
      </button>
      <button type="button" className={keyBase} onClick={() => onArrow("right")} aria-label="右箭头">
        →
      </button>
      <span className="w-px h-5 bg-line shrink-0" aria-hidden />
      <button type="button" className={keyBase} onClick={onEnter} aria-label="回车键">
        ↵
      </button>
      <button
        type="button"
        className={keyBase}
        onClick={onSaveQuit}
        aria-label="Esc，再输入 :wq，然后回车"
        title="vim：保存并退出"
      >
        Esc:wq↵
      </button>
    </div>
  );
}
