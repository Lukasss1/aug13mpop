// generate-og-card.mjs — renders public/brand/og-card.png (1200×630), the
// single social share card every page points its og:image/twitter:image at.
//
// WHY A COMMITTED PNG, NOT A BUILD STEP
// -------------------------------------
// Link-preview crawlers need a 1200×630 raster; the previous og:image was the
// 340×699 transparent mascot (wrong ratio, transparent bg = black card on
// some platforms). This script is a REGENERATION TOOL — run it once, commit
// the PNG, and builds never need chromium. Do NOT wire it into postbuild.
//
// Run: npm run art:og   (needs `npm exec --offline -- playwright install chromium` once,
//                        same as the audit:clicks script)
import { chromium } from 'playwright';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'brand', 'og-card.png');
const asset = (name) => 'file://' + path.join(ROOT, 'public', 'brand', name);
const fontAsset = (name) => 'file://' + path.join(ROOT, 'public', 'fonts', name);

// Brand tokens 1:1 from src/brand.tsx / index.css: caramel #A46832 bg,
// cream #EBDECE, dark #2E2A26, Poppins (the site's display face fallback).
// Everything sits inside 100px safe margins — platforms crop edges.
const html = `<!doctype html>
<html><head>
<style>
  @font-face { font-family: 'Poppins'; src: url('${fontAsset('Poppins-600.woff2')}') format('woff2'); font-weight: 600; font-style: normal; }
  @font-face { font-family: 'Poppins'; src: url('${fontAsset('Poppins-800.woff2')}') format('woff2'); font-weight: 800; font-style: normal; }
</style>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { width: 1200px; height: 630px; overflow: hidden; background: #A46832;
         font-family: 'Poppins', 'Segoe UI', Arial, sans-serif; position: relative; }
  /* soft radial sheen so the flat caramel doesn't read as a solid block */
  .sheen { position: absolute; inset: 0;
           background: radial-gradient(120% 140% at 18% 0%, rgba(255,255,255,.14), transparent 55%); }
  .logo { position: absolute; top: 100px; left: 100px; width: 235px; height: auto; }
  .mascot { position: absolute; right: 100px; bottom: 75px; height: 480px; width: auto;
            filter: drop-shadow(0 18px 30px rgba(46,42,38,.35)); }
  .copy { position: absolute; left: 100px; bottom: 118px; width: 560px; }
  h1 { font-weight: 800; font-size: 58px; line-height: 1.12; color: #FFFFFF;
       letter-spacing: -0.5px; text-shadow: 0 3px 14px rgba(46,42,38,.25); }
  .site { margin-top: 22px; font-weight: 600; font-size: 26px; letter-spacing: 4px;
          text-transform: uppercase; color: #EBDECE; }
</style></head>
<body>
  <div class="sheen"></div>
  <img class="logo" src="${asset('sticker_logo_blue.png')}" />
  <img class="mascot" src="${asset('mascot_wave.webp')}" />
  <div class="copy">
    <h1>Milkshakes, smoothies, soft&nbsp;serve &amp;&nbsp;slush</h1>
    <div class="site">milkpop.uk</div>
  </div>
</body></html>`;

// NOTE: page.setContent() renders on about:blank, which Chromium treats as a
// non-file origin — file:// <img> subresources are silently BLOCKED there.
// Write the HTML to a temp file and navigate to it instead, so the page and
// its images share the file:// scheme.
const TMP = path.join(ROOT, '.og-card.tmp.html');
await writeFile(TMP, html, 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.goto('file://' + TMP, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);           // Poppins loaded (or fell back)
await page.waitForTimeout(150);                            // let drop-shadow paint settle
// Fail loudly if any image didn't load — a blank card must never be committed.
const broken = await page.$$eval('img', (imgs) => imgs.filter((i) => !i.complete || i.naturalWidth === 0).length);
await page.screenshot({ path: OUT });
await browser.close();
await unlink(TMP);
if (broken > 0) { console.error(`og-card: ${broken} image(s) failed to load — aborting`); process.exit(1); }
console.log(`og-card: wrote ${OUT} (1200×630)`);
