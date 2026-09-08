// Image extraction helpers.
//
// Transcript events can carry images in a couple of shapes:
//   1. A base64 data URL embedded in a tool_result or user_message content
//      string — `data:image/(png|jpeg|jpg|gif|webp);base64,...`.
//   2. A `/api/attachments/:id/raw` path pointing at the attachments feature.
//
// `extractImagesFromText` finds both, returns an ImageRef[] and the same
// text with the matched tokens stripped so the caller can render them as
// thumbnails above the remaining (now image-free) text body.
//
// The regexes are intentionally narrow and anchored to token characters so
// they don't catch URL fragments mid-word or produce quadratic backtracking
// on large tool_result bodies. The caller should still `useMemo` per-piece
// — we're not reaching for this helper in a hot render loop.

export interface ImageRef {
  src: string;
  alt: string;
}

// Base64 data URL for a supported image mime. We allow the common image/*
// families claude can emit (PNG screenshots, JPEG photos, GIFs, WebP).
// Base64 chars + padding only — stops at the first non-base64 character so
// neighboring text is preserved.
const DATA_URL_RE =
  /data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+/g;

// Attachment reference served by the backend. We don't know the id format
// (the attachments feature is in flight), so we match any non-slash id.
const ATTACHMENT_RE = /\/api\/attachments\/[^/\s)"'<>]+\/raw/g;

// Claude Agent SDK image block, stringified by agent-runner.ts before it hits
// the tool_result event payload (see server/src/sessions/agent-runner.ts —
// non-text content blocks get `JSON.stringify`'d into the content string).
// Shape is Anthropic's standard image block:
//   {"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBO..."}}
// We reconstruct a data URL from `media_type` + `data` so the existing
// ImageThumbs path can render it. The regex is lenient about key order
// (`media_type` / `data` may come in either order) and tolerant of
// whitespace from a `JSON.stringify(x, null, 2)` sender — but anchored on
// `"type":"image"` so we don't eat unrelated JSON.
const SDK_IMAGE_BLOCK_RE =
  /\{\s*"type"\s*:\s*"image"\s*,\s*"source"\s*:\s*\{[^}]*?"media_type"\s*:\s*"(image\/(?:png|jpe?g|gif|webp))"[^}]*?"data"\s*:\s*"([A-Za-z0-9+/=]+)"[^}]*\}\s*\}/g;

// Same as above but with `data` before `media_type` — we can't express that
// alternation in a single non-backtracky pattern without regex lookarounds
// that aren't available cross-browser. Keep it as a second pass.
const SDK_IMAGE_BLOCK_RE_ALT =
  /\{\s*"type"\s*:\s*"image"\s*,\s*"source"\s*:\s*\{[^}]*?"data"\s*:\s*"([A-Za-z0-9+/=]+)"[^}]*?"media_type"\s*:\s*"(image\/(?:png|jpe?g|gif|webp))"[^}]*\}\s*\}/g;

export function extractImagesFromText(text: string): {
  images: ImageRef[];
  remainingText: string;
} {
  if (!text) return { images: [], remainingText: text };
  // Fast path: if no marker is present, short-circuit.
  const hasDataUrl = text.includes("data:image/");
  const hasAttachment = text.includes("/api/attachments/");
  const hasSdkBlock =
    text.includes('"type":"image"') || text.includes('"type": "image"');
  if (!hasDataUrl && !hasAttachment && !hasSdkBlock) {
    return { images: [], remainingText: text };
  }
  const images: ImageRef[] = [];
  let remaining = text;

  // Strip data URLs first (longer, more specific).
  remaining = remaining.replace(DATA_URL_RE, (match) => {
    images.push({ src: match, alt: mimeFromDataUrl(match) ?? "image" });
    return "";
  });
  remaining = remaining.replace(ATTACHMENT_RE, (match) => {
    images.push({ src: match, alt: "attachment" });
    return "";
  });
  if (hasSdkBlock) {
    remaining = remaining.replace(
      SDK_IMAGE_BLOCK_RE,
      (_full, mime: string, data: string) => {
        images.push({ src: `data:${mime};base64,${data}`, alt: mime });
        return "";
      },
    );
    remaining = remaining.replace(
      SDK_IMAGE_BLOCK_RE_ALT,
      (_full, data: string, mime: string) => {
        images.push({ src: `data:${mime};base64,${data}`, alt: mime });
        return "";
      },
    );
  }

  return { images, remainingText: remaining };
}

function mimeFromDataUrl(url: string): string | null {
  const m = url.match(/^data:(image\/[a-z]+);/);
  return m ? m[1] : null;
}
