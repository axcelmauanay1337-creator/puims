// Renders PUIMS app icons (PNG) from inline SVG using Playwright's Chromium.
// Usage: node scripts/generate-icons.mjs   (no network access needed)
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const svg = (size, pad) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="${pad ? 0 : 22}" fill="#e7f0eb"/>
  <g transform="translate(50 50) scale(${pad ? 0.62 : 0.8}) translate(-50 -50)">
    <text x="50" y="66" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="800" font-size="46" fill="#2f604a">P+</text>
  </g>
</svg>`;

const targets = [
  ["public/icons/icon-192.png", 192, false],
  ["public/icons/icon-512.png", 512, false],
  ["public/icons/icon-maskable-512.png", 512, true],
  ["src/app/icon.png", 64, false],
  ["src/app/apple-icon.png", 180, true],
];

mkdirSync("public/icons", { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [out, size, maskable] of targets) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(size, maskable)}</body></html>`);
  await page.locator("svg").screenshot({ path: out, omitBackground: true });
  console.log("wrote", out);
}
await browser.close();
