/**
 * Copy text to the clipboard with a hidden-textarea fallback for
 * non-secure contexts (claudex runs over HTTP through frpc).
 * Returns true on success, false on complete failure.
 */
export async function copyText(text: string): Promise<boolean> {
  // Prefer the async clipboard API — fast and respects user gestures in
  // secure contexts.
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === "function" &&
    window.isSecureContext
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to execCommand
    }
  }

  // Fallback — hidden textarea + document.execCommand("copy"). Works on
  // HTTP, works on old Safari, works when the async API rejects due to a
  // missing user gesture.
  if (typeof document === "undefined") return false;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "-1000px";
  ta.style.left = "0";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  const active = document.activeElement as HTMLElement | null;
  try {
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand("copy");
    return ok;
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
    // Restore focus so the user's current input doesn't lose it.
    if (active && typeof active.focus === "function") {
      try {
        active.focus();
      } catch {
        /* ignore */
      }
    }
  }
}
