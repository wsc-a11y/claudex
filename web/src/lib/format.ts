// Shared formatters. Keep this file small and side-effect-free — it is
// imported from both leaf components and screens.
//
// Historical note: prior to consolidation each of Settings / ImportSessionsSheet
// / SessionSettingsSheet carried its own near-identical relative-time or
// bytes formatter. The inputs differed slightly (raw ISO strings vs Date
// objects, some tolerated null, others threw) and thresholds drifted enough
// that the UI output was subtly inconsistent. This module picks one clean
// variant of each and every caller now uses it.

type TimeInput = string | Date | number | null | undefined;

/** Normalize {string, Date, number} → epoch ms. Returns NaN on failure so
 *  callers can bail with the placeholder. */
function toMs(input: TimeInput): number {
  if (input == null) return NaN;
  if (typeof input === "number") return input;
  if (typeof input === "string") return Date.parse(input);
  return input.getTime();
}

/** "05-10 14:23" for current-year timestamps, "2024-11-30 14:23" for
 *  earlier years. Compact but still carries the time of day, which is the
 *  whole point of switching to absolute format in the first place. Uses
 *  local time — callers want human-readable wall-clock, not UTC. */
function formatAbsolute(t: number): string {
  const d = new Date(t);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const sameYear = yyyy === new Date().getFullYear();
  return sameYear ? `${mm}-${dd} ${hh}:${mi}` : `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

/** Threshold — anything past this falls out of relative-time land and we
 *  show an absolute clock value instead. Relative times become genuinely
 *  confusing around the day mark ("3d ago" → which day exactly?), and
 *  "2w ago" / "2025-05-01" are both harder to read at a glance than
 *  "05-01 14:23". */
const ABSOLUTE_THRESHOLD_MS = 24 * 60 * 60 * 1000;

/** "3s ago" / "2m ago" / "5h ago" — short form for the past 24h, then
 *  flips to absolute "MM-DD HH:mm" (or "YYYY-MM-DD HH:mm" for older
 *  years). Sub-minute precision so fast events (a Bash call that just
 *  finished, a session that just flipped to idle) don't all collapse into
 *  the vague "just now" bucket. `<3s` still shows "now" since second-
 *  level ticking at that granularity reads as jitter, not freshness. */
export function timeAgoShort(input: TimeInput): string {
  const t = toMs(input);
  if (!Number.isFinite(t)) return "—";
  const delta = Math.max(0, Date.now() - t);
  if (delta >= ABSOLUTE_THRESHOLD_MS) return formatAbsolute(t);
  const s = Math.floor(delta / 1000);
  if (s < 3) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(s / 3600);
  return `${h}h ago`;
}

/** "3 seconds ago" / "2 minutes ago" etc — long form, for audit rows
 *  and similar. Same 24h → absolute handoff as `timeAgoShort`. */
export function timeAgoLong(input: TimeInput): string {
  const t = toMs(input);
  if (!Number.isFinite(t)) return "—";
  const delta = Math.max(0, Date.now() - t);
  if (delta >= ABSOLUTE_THRESHOLD_MS) return formatAbsolute(t);
  const s = Math.floor(delta / 1000);
  if (s < 3) return "just now";
  if (s < 60) return `${s} second${s === 1 ? "" : "s"} ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.floor(s / 3600);
  return `${h} hour${h === 1 ? "" : "s"} ago`;
}

/** Bidirectional — "in 5m" / "5m ago" / "in 2h" / "2h ago" within 24h
 *  of now in either direction, then flips to absolute "MM-DD HH:mm".
 *  Used by Routines for the last/next-run columns where the value can
 *  sit on either side of now. */
export function timeAgoOrInShort(input: TimeInput): string {
  const t = toMs(input);
  if (!Number.isFinite(t)) return "—";
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  if (abs >= ABSOLUTE_THRESHOLD_MS) return formatAbsolute(t);
  const future = diff > 0;
  const mins = Math.round(abs / 60_000);
  if (mins < 1) return future ? "soon" : "just now";
  if (mins < 60) return future ? `in ${mins}m` : `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return future ? `in ${hrs}h` : `${hrs}h ago`;
}

/** Bytes → short human-readable ("4.2 KB"). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}
