// Generates the BangerBox app-icon set from a single source-of-truth glyph — spec §2.4
// (SVG master + 192/512 PNG + separate 512 maskable PNG; the maskable asset carries
// safe-zone padding and is never the `any` icon reused).
//
// The glyph is a dark rounded plate carrying a 4×4 grid of sampler pads with an amber
// gradient sheen — the BangerBox pad bank. SVG is the master; the raster fallbacks are
// rendered with the Playwright engine already used by the browser smoke (system Edge
// channel first — no browser download), so this script adds no dependency.
//
//   npm run icons
//
// Outputs into public/icons/: bangerbox.svg, icon-192.png, icon-512.png,
// maskable-512.png, apple-touch-icon.png.
import { fileURLToPath } from 'node:url';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const OUT_DIR = fileURLToPath(new URL('../public/icons/', import.meta.url));

const round = (n) => Math.round(n * 100) / 100;

/** Amber sheen gradient spanning the glyph's bounding box (userSpaceOnUse so the pad
 *  strokes don't collapse onto their own bounding boxes). */
function sheenDef(box) {
  const a = box.x;
  const b = box.x + box.s;
  return `<linearGradient id="sheen" gradientUnits="userSpaceOnUse" x1="${a}" y1="${a}" x2="${b}" y2="${b}">
      <stop offset="0" stop-color="#ffd27a" />
      <stop offset="0.5" stop-color="#f5a524" />
      <stop offset="1" stop-color="#e07000" />
    </linearGradient>`;
}

/** The BangerBox pad-bank glyph for a square bounding box `{ x, s }`: a dark rounded
 *  plate with a 4×4 grid of rounded pads, stroked with the amber sheen. Proportions
 *  scale with the box so every size renders identically. */
function glyph({ x, s }) {
  const plateStroke = round(s * 0.055);
  const plateRx = round(s * 0.13);
  const inset = round(s * 0.14);
  const gap = round(s * 0.035);
  const padStroke = round(s * 0.03);
  const padRx = round(s * 0.045);

  const region = s - 2 * inset;
  const cell = round((region - 3 * gap) / 4);
  const positions = [];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) {
      positions.push([round(x + inset + col * (cell + gap)), round(x + inset + row * (cell + gap))]);
    }
  }
  // The top-right pad is filled solid — the "hit" pad that gives the mark its identity.
  const pads = positions
    .map(([px, py], index) => {
      const fill = index === 3 ? ' fill="url(#sheen)"' : '';
      return `<rect x="${px}" y="${py}" width="${cell}" height="${cell}" rx="${padRx}"${fill} />`;
    })
    .join('');

  return `
    <rect x="${x}" y="${x}" width="${s}" height="${s}" rx="${plateRx}" fill="#141317" />
    <g fill="none" stroke="url(#sheen)" stroke-linejoin="round" stroke-linecap="round">
      <rect x="${x}" y="${x}" width="${s}" height="${s}" rx="${plateRx}" stroke-width="${plateStroke}" />
      <g stroke-width="${padStroke}">${pads}</g>
    </g>`;
}

/** Compose a full 512×512 icon document. `any` icons fill the canvas with transparency
 *  outside the plate; opaque icons (maskable/iOS) add a full-bleed backdrop and shrink
 *  the glyph into the maskable safe zone so platform masking can't clip the border. */
function iconSvg({ opaque }) {
  const box = opaque ? { x: 86, s: 340 } : { x: 48, s: 416 };
  const backdrop = opaque ? '<rect width="512" height="512" fill="#141317" />' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="BangerBox">
  <defs>${sheenDef(box)}</defs>
  ${backdrop}${glyph(box)}
</svg>
`;
}

async function rasterise(browser, svg, size, opaque) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const sized = svg.replace('width="512" height="512" role', `width="${size}" height="${size}" role`);
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0}</style>${sized}`,
  );
  const png = await page.screenshot({
    omitBackground: !opaque,
    clip: { x: 0, y: 0, width: size, height: size },
  });
  await page.close();
  return png;
}

/** Launch a Chromium engine: system Edge first (locked decision §1.3 #13 — no browser
 *  binary download), then Chrome, then any bundled build. */
async function launchChromium() {
  const attempts = [{ channel: 'msedge' }, { channel: 'chrome' }, {}];
  let lastErr;
  for (const opts of attempts) {
    try {
      return await chromium.launch(opts);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const transparent = iconSvg({ opaque: false });
  const opaque = iconSvg({ opaque: true });

  await writeFile(resolve(OUT_DIR, 'bangerbox.svg'), transparent, 'utf8');

  const browser = await launchChromium();
  try {
    const outputs = [
      ['icon-192.png', transparent, 192, false],
      ['icon-512.png', transparent, 512, false],
      ['maskable-512.png', opaque, 512, true],
      ['apple-touch-icon.png', opaque, 180, true],
    ];
    for (const [name, svg, size, isOpaque] of outputs) {
      const png = await rasterise(browser, svg, size, isOpaque);
      await writeFile(resolve(OUT_DIR, name), png);
      console.log(`  wrote ${name} (${size}×${size})`);
    }
  } finally {
    await browser.close();
  }
  console.log('Icon set generated in', OUT_DIR);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
