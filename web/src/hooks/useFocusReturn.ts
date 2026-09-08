import { useEffect } from "react";

/**
 * Save the currently-focused element on mount, restore on unmount.
 * Pass `active` to gate — only captures while true. Use in sheet/modal
 * components so closing them returns focus to whatever opened them.
 */
export function useFocusReturn(active: boolean = true): void {
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    if (!previous || previous === document.body) return;
    return () => {
      // Defer one tick so React's unmount/remove finishes first.
      requestAnimationFrame(() => {
        if (previous && typeof previous.focus === "function") {
          previous.focus({ preventScroll: true });
        }
      });
    };
  }, [active]);
}
