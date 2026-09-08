#!/usr/bin/env node
// Render claudex PWA icons from web/public/icon.svg.
//
// Produces three PNGs next to the SVG:
//   icon-192.png            - 192x192 standard
//   icon-512.png            - 512x512 standard
//   icon-maskable-512.png   - 512x512 with a safe-zone padded triangle so
//                             Android's maskable clipping doesn't eat the
//                             logo's tips
//
// Run manually when the logo changes:
//   node web/scripts/gen-icons.mjs
// Not wired into `build` so `pnpm build` stays deterministic and doesn't
// require sharp at install time in CI.

import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pub = path.resolve(here, "..", "public");
const src = path.join(pub, "icon.svg");

if (!fs.existsSync(src)) {
  console.error(`missing ${src}`);
  process.exit(1);
}

const svg = fs.readFileSync(src);

async function render(size, out) {
  await sharp(svg, { density: 300 })
    .resize(size, size, { kernel: "mitchell" })
    .png()
    .toFile(out);
  console.log(`wrote ${out}`);
}

// Maskable icon: Android crops icons to various shapes (circle, squircle)
// and only guarantees the inner ~80% is safe. We inflate the background
// and shrink the pebble to fit that safe zone (content in inner 60%,
// matching the old triangle icon's 20%-on-each-side padding convention).
async function renderMaskable(size, out) {
  const maskableSvg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
      <defs>
        <linearGradient id="g" x1="0.1" y1="0.1" x2="0.9" y2="0.9">
          <stop offset="0%" stop-color="#1A1410" />
          <stop offset="100%" stop-color="#CC785C" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" fill="#faf9f5" />
      <g transform="translate(205 205) scale(0.6)">
        <path d="M 512 200 C 300 210, 200 380, 220 560 C 240 740, 460 830, 660 770 C 840 710, 880 480, 780 320 C 700 210, 620 200, 512 200 Z"
              fill="none" stroke="url(#g)" stroke-width="167"
              stroke-linecap="round" stroke-linejoin="round" />
      </g>
    </svg>
  `;
  await sharp(Buffer.from(maskableSvg), { density: 300 })
    .resize(size, size, { kernel: "mitchell" })
    .png()
    .toFile(out);
  console.log(`wrote ${out}`);
}

await render(192, path.join(pub, "icon-192.png"));
await render(512, path.join(pub, "icon-512.png"));
await renderMaskable(512, path.join(pub, "icon-maskable-512.png"));
