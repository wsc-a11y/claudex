import { useEffect } from "react";
import { X } from "lucide-react";
import { TasksList } from "@/components/TasksList";
import { useFocusReturn } from "@/hooks/useFocusReturn";
import type { UIPiece } from "@/state/sessions";

/**
 * Mobile bottom-sheet Tasks drawer for the Chat screen.
 *
 * Matches the overlay pattern from mockup s-05 (dim backdrop + drawer pinned
 * to the bottom, pushed up to cover most of the viewport) and reuses the
 * exact same grouped body as the desktop right-rail via <TasksList />. The
 * header reads "Tasks" (not "Subagents") because this drawer shows every
 * tool call, with Subagents as just one group inside it.
 *
 * Closes on:
 *   - backdrop tap
 *   - Esc key
 *   - the × button in the header
 * Focus is restored to whatever opened the drawer via `useFocusReturn`.
 */
export function TasksDrawer({
  pieces,
  sessionId,
  onReveal,
  onClose,
}: {
  pieces: UIPiece[];
  /** Scope persisted collapse state — same storage as the desktop rail
   * so a group toggled open on one surface stays open on the other. */
  sessionId?: string;
  onReveal?: (attr: "tool-use-id", id: string) => void;
  onClose: () => void;
}) {
  useFocusReturn();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-sm flex items-end justify-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="任务"
        className="w-full bg-canvas border-t border-line rounded-t-[20px] shadow-overlay flex flex-col max-h-[85vh] min-h-[55vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag-handle strip — purely decorative, matches s-13 iPhone frame. */}
        <div className="flex justify-center pt-3 shrink-0">
          <span className="h-1 w-12 bg-line-strong rounded-full" aria-hidden />
        </div>
        <div className="px-4 py-3 border-b border-line flex items-center shrink-0">
          <span className="caps text-ink-muted">任务</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭任务"
            className="ml-auto h-8 w-8 rounded-sm border border-line bg-canvas flex items-center justify-center"
          >
            <X className="w-4 h-4 text-ink-soft" aria-hidden />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0">
          <TasksList
            pieces={pieces}
            sessionId={sessionId}
            onReveal={(attr, id) => {
              // Clicking a row on mobile should dismiss the drawer and
              // then scroll the transcript — otherwise the user taps and
              // nothing visible happens behind the sheet.
              onReveal?.(attr, id);
              onClose();
            }}
          />
        </div>
        <div className="mt-auto p-3 border-t border-line flex items-center gap-2 text-ui text-ink-muted shrink-0">
          <span>新到旧 · 按工具分组</span>
          <span className="ml-auto mono">实时</span>
        </div>
      </div>
    </div>
  );
}
