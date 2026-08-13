// generate-icons.mjs — renders public/brand/favicon.svg to the two PNG icon
// fallbacks that SVG can't cover:
//
//   public/brand/apple-touch-icon.png  180×180, cream background (iOS puts
//                                      BLACK behind transparent touch icons)
//   public/brand/favicon-192.png       192×192, transparent (Google favicon
//                                      guidelines: square, ≥48px; also the
//                                      Android/tab fallback for old browsers)
//
// Same pattern as generate-og-card.mjs: a one-off REGENERATION TOOL — run
// once, commit the PNGs, builds never need chromium. Not a build step.
//
// Run: npm run art:icons   (needs `npm exec --offline -- playwright install chromium` once)
import { chromium } from 'playwright';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRAND = path.join(ROOT, 'public', 'brand');
const svgUrl = 'file://' + path.join(BRAND, 'favicon.svg');

// The mark's viewBox is 400×296 (wider than tall) — center it in a square
// with breathing room so iOS's corner rounding doesn't clip the strokes.
const page4 = (size, bg, pad) => `<!doctype html>
<html><head><style>
  * { margin: 0; padding: 0; }
  body { width: ${size}px; height: ${size}px; background: ${bg};
         display: flex; align-items: center; justify-content: center; overflow: hidden; }
  img { width: ${size - pad * 2}px; height: auto; }
</style></head><body><img src="${svgUrl}" /></body></html>`;

const browser = await chromium.launch();

for (const [file, size, bg, pad] of [
  ['apple-touch-icon.png', 180, '#EBDECE', 22],   // brand cream, mark ≈75% width
  ['favicon-192.png', 192, 'transparent', 16],
]) {
  // setContent() = about:blank origin, which blocks file:// <img> loads —
  // navigate to a real temp file so page and image share the file:// scheme.
  const tmp = path.join(ROOT, `.icon-${size}.tmp.html`);
  await writeFile(tmp, page4(size, bg, pad), 'utf8');
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.goto('file://' + tmp, { waitUntil: 'networkidle' });
  const broken = await page.$$eval('img', (imgs) => imgs.filter((i) => !i.complete || i.naturalWidth === 0).length);
  if (broken > 0) { console.error(`icons: ${file} — SVG failed to load, aborting`); process.exit(1); }
  await page.screenshot({ path: path.join(BRAND, file), omitBackground: bg === 'transparent' });
  await page.close();
  await unlink(tmp);
  console.log(`icons: wrote public/brand/${file} (${size}×${size})`);
}

await browser.close();
