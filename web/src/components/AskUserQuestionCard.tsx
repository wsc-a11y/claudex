import { useEffect, useMemo, useState } from "react";
import { ChevronDown, MessageCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import type { AskUserQuestionItem } from "@claudex/shared";

export interface AskUserQuestionCardProps {
  askId: string;
  questions: AskUserQuestionItem[];
  // Present when the user has already answered (persisted or just-submitted).
  // The card renders read-only in that case.
  answers?: Record<string, string>;
  onSubmit: (
    answers: Record<string, string>,
    annotations?: Record<string, { notes?: string; preview?: string }>,
  ) => void;
}

// The SDK's AskUserQuestion tool automatically supplies an "Other" option —
// we add it client-side and reveal a free-text input when it's selected.
const OTHER_LABEL = "Other";

/**
 * In-transcript multiple-choice card for the SDK's `AskUserQuestion` tool.
 * Distinct from `PermissionCard` — this isn't a security gate, it's a friendly
 * ask for user input. Uses the klein-wash language instead of warn-wash.
 *
 * Rendering contract:
 *   - one question per block, with a caps "question · claude" header strip
 *   - radios for single-select, checkboxes for multi-select
 *   - each option shows label + muted description; `preview` (if any) is
 *     revealed in a mono <pre> when the option is focused or hovered
 *   - an "Other" option is appended client-side with a free-text input
 *   - submit button is klein-filled, disabled until every question is
 *     answered; after submit the card defaults to a collapsed "receipt" that
 *     lists every question and its chosen answer on one line. A per-row
 *     caret peeks the chosen option's description/preview; "Expand all" in
 *     the footer flips back to the full read-only card (tab strip + option
 *     cards) for anyone who wants to re-read the raw options.
 */
export function AskUserQuestionCard({
  askId,
  questions,
  answers: answersProp,
  onSubmit,
}: AskUserQuestionCardProps) {
  const isAnswered = answersProp != null;

  // Per-question selection state. For multi-select we store a Set of labels;
  // for single-select a plain string. We keep both shapes in one map so the
  // readiness + submit paths are uniform.
  const [selections, setSelections] = useState<
    Record<string, string | string[]>
  >({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});

  // Which question is currently being shown. Multi-question asks now render
  // one-at-a-time with a tab strip on top; single-question cards hide the
  // strip entirely and look identical to the old layout.
  const [activeIdx, setActiveIdx] = useState(0);
  const safeIdx = Math.min(activeIdx, Math.max(0, questions.length - 1));

  // After-submit UX. By default the answered card collapses into a one-line
  // receipt per question (`expandedOverride=false`); clicking "Expand all"
  // flips back to the full tab-strip + option-card read-only view so the
  // reader can re-study the raw options. `peeked` tracks which collapsed
  // rows have been individually un-folded to show their chosen option's
  // description/preview inline — independent of the global flag.
  const [expandedOverride, setExpandedOverride] = useState(false);
  const [peeked, setPeeked] = useState<Set<string>>(() => new Set());
  // On transition into the answered state, reset view to collapsed so an
  // expand/collapse the user did on a previous answered card instance
  // doesn't leak into the fresh receipt.
  useEffect(() => {
    if (isAnswered) {
      setExpandedOverride(false);
      setPeeked(new Set());
    }
  }, [isAnswered]);

  // Per-question readiness — used both for the global submit gate and for
  // the "done" dots on each tab.
  const perQuestionReady = useMemo(() => {
    return questions.map((q) => {
      const sel = selections[q.question];
      if (q.multiSelect) {
        const arr = (sel as string[] | undefined) ?? [];
        if (arr.length === 0) return false;
        if (arr.includes(OTHER_LABEL) && !otherText[q.question]?.trim()) {
          return false;
        }
        return true;
      }
      const v = typeof sel === "string" ? sel : "";
      if (!v) return false;
      if (v === OTHER_LABEL && !otherText[q.question]?.trim()) return false;
      return true;
    });
  }, [questions, selections, otherText]);

  // Readiness: every question has a non-empty answer (for "Other" the
  // free-text box must be filled).
  const ready = useMemo(() => {
    if (isAnswered) return false;
    return perQuestionReady.every(Boolean);
  }, [isAnswered, perQuestionReady]);

  // After submit, mark every tab done so the read-only view shows all dots lit.
  const tabDone = (idx: number) =>
    isAnswered ? true : perQuestionReady[idx] === true;

  function handleSubmit() {
    if (!ready) return;
    const out: Record<string, string> = {};
    for (const q of questions) {
      const sel = selections[q.question];
      if (q.multiSelect) {
        const arr = (sel as string[] | undefined) ?? [];
        const mapped = arr.map((v) =>
          v === OTHER_LABEL ? otherText[q.question]?.trim() || OTHER_LABEL : v,
        );
        // SDK expects comma-separated values for multi-select.
        out[q.question] = mapped.join(", ");
      } else {
        const v = typeof sel === "string" ? sel : "";
        out[q.question] =
          v === OTHER_LABEL
            ? otherText[q.question]?.trim() || OTHER_LABEL
            : v;
      }
    }
    onSubmit(out);
  }

  // Parses a stored answer back into the concrete label(s) the user picked
  // and whether it was the free-text "Other" branch. Multi-select answers
  // are comma-joined by the submit path above.
  function parseAnswer(q: AskUserQuestionItem, raw: string) {
    const rawLabels = q.multiSelect
      ? raw.split(",").map((s) => s.trim()).filter(Boolean)
      : [raw];
    return rawLabels.map((label) => {
      const matched = q.options.find((o) => o.label === label);
      if (matched) return { kind: "option" as const, option: matched };
      if (label === OTHER_LABEL)
        return { kind: "other" as const, text: OTHER_LABEL };
      // Free-text Other answer — the user typed something that doesn't
      // match any of the canned options, which is how the submit path
      // encodes the OTHER_LABEL branch.
      return { kind: "other" as const, text: label };
    });
  }

  const showCollapsedReceipt = isAnswered && !expandedOverride;

  function togglePeek(question: string) {
    setPeeked((prev) => {
      const next = new Set(prev);
      if (next.has(question)) next.delete(question);
      else next.add(question);
      return next;
    });
  }

  return (
    <div
      data-ask-id={askId}
      className="rounded-xl border border-klein/30 bg-klein-wash/30 p-3 max-w-[72ch] min-w-0"
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="h-7 w-7 rounded bg-klein-wash border border-klein/40 flex items-center justify-center text-klein">
          <MessageCircle className="w-3.5 h-3.5" />
        </span>
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm border border-klein/30 bg-klein-wash/60 text-klein-ink text-ui-sm font-medium uppercase tracking-widest">
          询问 · claude
        </span>
        {showCollapsedReceipt ? (
          <span className="ml-auto mono text-ui text-ink-muted tabular-nums">
            {questions.length} 已回答
          </span>
        ) : null}
      </div>

      {showCollapsedReceipt ? (
        <CollapsedReceipt
          questions={questions}
          answers={answersProp ?? {}}
          peeked={peeked}
          onTogglePeek={togglePeek}
          parseAnswer={parseAnswer}
        />
      ) : (
        <>
          {questions.length > 1 ? (
        <div className="flex items-center gap-1 mb-3 overflow-x-auto -mx-1 px-1 pb-1">
          {questions.map((q, idx) => {
            const active = idx === safeIdx;
            const done = tabDone(idx);
            return (
              <button
                key={q.question}
                type="button"
                onClick={() => setActiveIdx(idx)}
                className={cn(
                  "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-sm mono text-ui-sm uppercase tracking-widest transition-colors shrink-0",
                  active
                    ? "bg-klein text-canvas border border-klein"
                    : "border border-line bg-canvas/60 text-ink-muted hover:border-klein/40 hover:text-ink transition-colors",
                )}
                aria-pressed={active}
              >
                <span>{`Q${idx + 1}`}</span>
                <span className="opacity-70">/</span>
                <span>{questions.length}</span>
                {done ? (
                  <span
                    className={cn(
                      "inline-block h-1.5 w-1.5 rounded-full",
                      active ? "bg-canvas" : "bg-klein",
                    )}
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <div>
        {(() => {
          const q = questions[safeIdx];
          if (!q) return null;
          const optionsWithOther = [
            ...q.options,
            { label: OTHER_LABEL, description: "其他答案 —— 请在下方输入。" },
          ];
          const selected = selections[q.question];
          const chosenLabel = answersProp?.[q.question];

          return (
            <div key={q.question} className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-ui-heading leading-snug text-ink display break-words [overflow-wrap:anywhere] min-w-0 flex-1">
                  {q.question}
                </div>
                {q.header ? (
                  <span className="mono text-ui-sm text-ink-muted uppercase tracking-[0.08em] shrink-0">
                    {q.header}
                  </span>
                ) : null}
              </div>

              <div className="space-y-1.5">
                {optionsWithOther.map((opt) => {
                  const isChosenByUser = q.multiSelect
                    ? ((selected as string[] | undefined) ?? []).includes(
                        opt.label,
                      )
                    : selected === opt.label;
                  // Read-only: highlight whichever label(s) match `answersProp`.
                  const isChosenAfterSend =
                    isAnswered &&
                    (q.multiSelect
                      ? (chosenLabel ?? "")
                          .split(",")
                          .map((s) => s.trim())
                          .includes(opt.label)
                      : chosenLabel === opt.label ||
                        // Match a free-text "Other" back onto the Other row.
                        (opt.label === OTHER_LABEL &&
                          chosenLabel != null &&
                          !q.options.some((o) => o.label === chosenLabel)));

                  const highlighted = isAnswered
                    ? isChosenAfterSend
                    : isChosenByUser;

                  return (
                    <label
                      key={opt.label}
                      className={cn(
                        "block rounded border p-2.5 cursor-pointer transition-colors",
                        highlighted
                          ? "border-klein bg-klein-wash/60 ring-1 ring-klein/40"
                          : "border-line bg-canvas/60 hover:border-klein/30 transition-colors",
                        isAnswered && "cursor-default",
                      )}
                    >
                      <div className="flex items-start gap-2">
                        <input
                          type={q.multiSelect ? "checkbox" : "radio"}
                          name={`ask-${askId}-${q.question}`}
                          value={opt.label}
                          checked={Boolean(highlighted)}
                          disabled={isAnswered}
                          onChange={(e) => {
                            if (isAnswered) return;
                            // Read `checked` synchronously off the event —
                            // never from inside the state updater. React
                            // nulls `e.currentTarget` after the handler
                            // returns, and in concurrent rendering the
                            // updater can be invoked later than the handler
                            // (or twice under StrictMode), which turns
                            // `e.currentTarget.checked` into
                            // `null.checked` → TypeError → the whole
                            // transcript white-screens because this card
                            // isn't behind an error boundary.
                            const checked = e.currentTarget.checked;
                            if (q.multiSelect) {
                              setSelections((prev) => {
                                const prevArr =
                                  (prev[q.question] as string[] | undefined) ??
                                  [];
                                const next = checked
                                  ? [...prevArr, opt.label]
                                  : prevArr.filter((v) => v !== opt.label);
                                return { ...prev, [q.question]: next };
                              });
                            } else {
                              setSelections((prev) => ({
                                ...prev,
                                [q.question]: opt.label,
                              }));
                              // Auto-advance to the next unanswered tab when
                              // the user picks a concrete option. Skip for
                              // "Other" because they still need to fill the
                              // free-text box on this tab.
                              if (
                                opt.label !== OTHER_LABEL &&
                                questions.length > 1
                              ) {
                                const currentIdx = safeIdx;
                                const nextIdx = (() => {
                                  for (
                                    let step = 1;
                                    step < questions.length;
                                    step++
                                  ) {
                                    const cand =
                                      (currentIdx + step) % questions.length;
                                    if (!perQuestionReady[cand]) return cand;
                                  }
                                  return currentIdx;
                                })();
                                if (nextIdx !== currentIdx) {
                                  // Defer so the selection commit lands first.
                                  queueMicrotask(() => setActiveIdx(nextIdx));
                                }
                              }
                            }
                          }}
                          className="mt-0.5 accent-klein shrink-0"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-ui font-medium text-ink break-words [overflow-wrap:anywhere]">
                            {opt.label}
                          </div>
                          {opt.description ? (
                            <div className="text-ui text-ink-muted leading-snug break-words [overflow-wrap:anywhere]">
                              {opt.description}
                            </div>
                          ) : null}
                          {opt.preview ? (
                            <pre className="mono text-ui text-canvas bg-ink rounded-sm mt-1.5 px-2 py-1.5 whitespace-pre-wrap break-all overflow-x-auto max-w-full dark-scroll">
                              {opt.preview}
                            </pre>
                          ) : null}
                          {/* Free-text input when Other is selected and not
                              yet submitted. Hidden in the read-only state
                              because the chosen free-text appears in the
                              chip at the top-right of this block below. */}
                          {opt.label === OTHER_LABEL &&
                          !isAnswered &&
                          (q.multiSelect
                            ? (
                                (selections[q.question] as
                                  | string[]
                                  | undefined) ?? []
                              ).includes(OTHER_LABEL)
                            : selected === OTHER_LABEL) ? (
                            <input
                              type="text"
                              value={otherText[q.question] ?? ""}
                              onChange={(e) =>
                                setOtherText((prev) => ({
                                  ...prev,
                                  [q.question]: e.target.value,
                                }))
                              }
                              placeholder="请输入你的答案…"
                              className="mt-1.5 w-full bg-canvas border border-line rounded-sm px-2 py-1 text-ui text-ink focus:outline-none focus:border-klein/60"
                            />
                          ) : null}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>

              {/* Read-only footer: when the chosen label was free-text
                  ("Other"), surface the actual answer text the user typed. */}
              {isAnswered && chosenLabel != null &&
                !q.options.some((o) => o.label === chosenLabel) &&
                chosenLabel !== OTHER_LABEL ? (
                <div className="text-ui text-ink-muted italic pl-1">
                  答案：<span className="text-ink">{chosenLabel}</span>
                </div>
              ) : null}
            </div>
          );
        })()}
      </div>
        </>
      )}

      {isAnswered ? (
        <div className="mt-3 pt-2 border-t border-klein/15 flex items-center gap-2">
          <span className="mono text-ui text-ink-muted flex items-center gap-1.5">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-klein/70" />
            已发送
          </span>
          <button
            type="button"
            onClick={() => setExpandedOverride((v) => !v)}
            className="ml-auto h-7 px-2.5 rounded-sm border border-klein/30 bg-canvas text-klein-ink text-ui mono hover:bg-klein-wash/60 transition-colors"
          >
            {expandedOverride ? "收起" : "全部展开"}
          </button>
        </div>
      ) : (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!ready}
            className={cn(
              "h-9 px-4 rounded text-ui font-medium transition-colors",
              ready
                ? "bg-klein text-canvas hover:bg-klein/90 transition-colors"
                : "bg-klein/30 text-canvas/70 cursor-not-allowed",
            )}
          >
            发送
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Compact "receipt" view that replaces the full option-card body after the
 * user has submitted. One row per question: `Q{i}·{total} | question |
 * • answer | caret`. Clicking the caret peeks the chosen option's
 * description + preview inline under that row only — adjacent rows stay
 * folded so it doesn't turn into an accordion-of-accordions.
 */
function CollapsedReceipt({
  questions,
  answers,
  peeked,
  onTogglePeek,
  parseAnswer,
}: {
  questions: AskUserQuestionItem[];
  answers: Record<string, string>;
  peeked: Set<string>;
  onTogglePeek: (question: string) => void;
  parseAnswer: (
    q: AskUserQuestionItem,
    raw: string,
  ) => Array<
    | { kind: "option"; option: AskUserQuestionItem["options"][number] }
    | { kind: "other"; text: string }
  >;
}) {
  const total = questions.length;
  return (
    <ol className="divide-y divide-klein/15">
      {questions.map((q, idx) => {
        const raw = answers[q.question] ?? "";
        const parts = parseAnswer(q, raw);
        const isOpen = peeked.has(q.question);
        const hasPeekableDetail = parts.some(
          (p) =>
            p.kind === "option" && (p.option.description || p.option.preview),
        );
        return (
          <li
            key={q.question}
            className={cn(
              "py-2.5 px-1 grid grid-cols-[40px_minmax(0,1fr)_auto] items-start gap-2",
              isOpen && "bg-klein-wash/40 -mx-1.5 rounded-sm px-2.5",
            )}
          >
            <span className="mono text-[10.5px] text-klein tabular-nums pt-[3px]">
              Q{idx + 1}·{total}
            </span>
            <div className="min-w-0">
              <div className="text-ui text-ink-soft leading-snug break-words [overflow-wrap:anywhere]">
                {q.question}
              </div>
              <AnswerLine parts={parts} />
              {isOpen ? <PeekBody parts={parts} /> : null}
            </div>
            <button
              type="button"
              onClick={() => onTogglePeek(q.question)}
              disabled={!hasPeekableDetail}
              aria-expanded={isOpen}
              aria-label={isOpen ? "收起详情" : "展开详情"}
              className={cn(
                "h-6 w-6 flex items-center justify-center rounded-xs transition-colors shrink-0",
                hasPeekableDetail
                  ? "text-ink-faint hover:text-klein hover:bg-klein-wash/60 transition-colors"
                  : "text-ink-faint/40 cursor-default",
              )}
            >
              <ChevronDown
                className={cn(
                  "w-3.5 h-3.5 transition-transform",
                  isOpen && "rotate-180 text-klein",
                )}
              />
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function AnswerLine({
  parts,
}: {
  parts: Array<
    | { kind: "option"; option: AskUserQuestionItem["options"][number] }
    | { kind: "other"; text: string }
  >;
}) {
  return (
    <div className="flex items-start gap-1.5 mt-1 flex-wrap">
      <span className="h-1.5 w-1.5 rounded-full bg-klein shrink-0 mt-[7px]" />
      {parts.map((p, i) => {
        const sep = i < parts.length - 1 ? "," : "";
        if (p.kind === "option") {
          return (
            <span
              key={i}
              className="text-ui text-ink font-medium break-words [overflow-wrap:anywhere]"
            >
              {p.option.label}
              {sep}
            </span>
          );
        }
        // Free-text Other branch. When the user typed something, show
        // "Other → <mono chip>"; when the answer is literally "Other"
        // (placeholder), just render the word so the row isn't broken.
        if (p.text === OTHER_LABEL) {
          return (
            <span
              key={i}
              className="text-ui text-ink font-medium italic"
            >
              {OTHER_LABEL}
              {sep}
            </span>
          );
        }
        return (
          <span
            key={i}
            className="flex items-center gap-1.5 flex-wrap"
          >
            <span className="text-ui text-ink font-medium italic">
              {OTHER_LABEL}
            </span>
            <span className="text-ui text-ink-muted">→</span>
            <span className="mono text-ui text-ink bg-canvas border border-line rounded-xs px-1.5 py-[1px] break-all">
              {p.text}
            </span>
            {sep ? <span className="text-ink-muted">,</span> : null}
          </span>
        );
      })}
    </div>
  );
}

function PeekBody({
  parts,
}: {
  parts: Array<
    | { kind: "option"; option: AskUserQuestionItem["options"][number] }
    | { kind: "other"; text: string }
  >;
}) {
  // Only option-branch parts have description/preview to peek; free-text
  // Other answers are already fully rendered in AnswerLine.
  const options = parts.filter(
    (p): p is { kind: "option"; option: AskUserQuestionItem["options"][number] } =>
      p.kind === "option",
  );
  if (options.length === 0) return null;
  return (
    <div className="mt-1.5 rounded-sm border border-klein/30 bg-canvas p-2 space-y-2">
      {options.map((p, i) => (
        <div key={i} className={i > 0 ? "pt-2 border-t border-klein/15" : ""}>
          <div className="text-ui font-medium text-ink">
            {p.option.label}
          </div>
          {p.option.description ? (
            <div className="text-ui text-ink-muted leading-snug mt-0.5 break-words [overflow-wrap:anywhere]">
              {p.option.description}
            </div>
          ) : null}
          {p.option.preview ? (
            <pre className="mono text-ui text-canvas bg-ink rounded-xs mt-1.5 px-2 py-1.5 whitespace-pre-wrap break-all overflow-x-auto max-w-full dark-scroll">
              {p.option.preview}
            </pre>
          ) : null}
        </div>
      ))}
    </div>
  );
}
