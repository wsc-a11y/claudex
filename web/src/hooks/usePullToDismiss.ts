import { useRef, useState } from "react";

/**
 * Pull-to-dismiss behavior for mobile bottom-sheet components.
 *
 * Attach `handlers` to the drag-handle region (ideally the whole top strip
 * that contains the pill, so the hit area is comfortable), and apply
 * `style` to the outer sheet card. While the user drags down, the sheet
 * translates 1:1 with the pointer; an upward drag clamps to 0. On release
 * past `threshold` (default 80px) we call `onDismiss`; otherwise we spring
 * back to 0 with a short transition.
 *
 * The hook is mobile-only by convention — desktop layouts should either
 * not attach it or gate on a media query. Mouse pointers are ignored so
 * desktops with overflow (e.g. narrow windows) don't accidentally drag.
 *
 * `releasing` is true while the spring-back animation is running — wire
 * it into a `transition-transform duration-200` class so only the release
 * animates, and live drag tracking stays direct/snappy.
 */
export function usePullToDismiss(
  onDismiss: () => void,
  opts: { threshold?: number } = {},
) {
  const threshold = opts.threshold ?? 80;
  const [dy, setDy] = useState(0);
  const [releasing, setReleasing] = useState(false);
  const startRef = useRef<{ y: number; pid: number } | null>(null);

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      // Skip mouse — desktop uses a different layout / should not drag.
      if (e.pointerType === "mouse") return;
      startRef.current = { y: e.clientY, pid: e.pointerId };
      setReleasing(false);
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* some browsers throw on capture of already-released pointers */
      }
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!startRef.current) return;
      if (e.pointerId !== startRef.current.pid) return;
      const next = e.clientY - startRef.current.y;
      setDy(Math.max(0, next));
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (!startRef.current) return;
      if (e.pointerId !== startRef.current.pid) return;
      const finalDy = e.clientY - startRef.current.y;
      startRef.current = null;
      if (finalDy > threshold) {
        // Let the caller close; no need to animate back since the sheet
        // unmounts.
        onDismiss();
        return;
      }
      setReleasing(true);
      setDy(0);
      window.setTimeout(() => setReleasing(false), 220);
    },
    onPointerCancel: (e: React.PointerEvent) => {
      if (startRef.current && e.pointerId !== startRef.current.pid) return;
      startRef.current = null;
      setReleasing(true);
      setDy(0);
      window.setTimeout(() => setReleasing(false), 220);
    },
  };

  return {
    handlers,
    style: dy ? { transform: `translateY(${dy}px)` } : undefined,
    releasing,
  };
}
