import { useId } from "react";

/**
 * claudex brand mark — "Portal Pebble" variant.
 *
 * An asymmetric closed loop stroked with an ink → Claude-coral gradient,
 * round caps, no interior ornament. Canonical rendition that matches the
 * favicon.svg / icon.svg / PWA PNGs shipped in web/public/.
 *
 * Render at any size via Tailwind classes on the wrapping svg:
 *   <Logo className="w-5 h-5" />
 *
 * Every instance gets its own gradient id (via useId) so multiple Logos
 * on one page don't fight over a shared `#logo-grad` reference.
 *
 * The mark is decorative in every call site — accompanying "claudex"
 * text serves as the accessible label — so aria-hidden is baked in.
 */
export function Logo({ className }: { className?: string }) {
  const rawId = useId();
  // Strip the colons React's useId returns (`:r0:` → `r0`) so the id is
  // safe inside a url(#…) stroke reference on older WebKit.
  const gradId = `logo-grad-${rawId.replace(/:/g, "")}`;
  return (
    <svg
      viewBox="0 0 1024 1024"
      className={className}
      aria-hidden
    >
      <defs>
        <linearGradient id={gradId} x1="0.1" y1="0.1" x2="0.9" y2="0.9">
          <stop offset="0%" stopColor="#1A1410" />
          <stop offset="100%" stopColor="#CC785C" />
        </linearGradient>
      </defs>
      <path
        d="M 512 200 C 300 210, 200 380, 220 560 C 240 740, 460 830, 660 770 C 840 710, 880 480, 780 320 C 700 210, 620 200, 512 200 Z"
        fill="none"
        stroke={`url(#${gradId})`}
        strokeWidth={100}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
