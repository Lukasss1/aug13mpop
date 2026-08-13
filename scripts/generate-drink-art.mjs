#!/usr/bin/env node
/**
 * generate-drink-art.mjs — builds the /public/brand/drinks/*.svg product set.
 *
 * Style is traced from the reference product photo (clear cup, cream shake,
 * chocolate drizzle, blue wave band, caramel "milk pop" wordmark on the cup)
 * and parameterised per flavour. Deterministic: same input → same SVG.
 *
 * Run:  node scripts/generate-drink-art.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const OUT = join(ROOT, 'public', 'brand', 'drinks');
mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ */
/* Pull the real brand geometry straight out of brand.tsx              */
/* ------------------------------------------------------------------ */
const brandSrc = readFileSync(join(ROOT, 'src', 'brand.tsx'), 'utf8');
const vertMatch = brandSrc.match(/viewBox="0 0 400 316"[^>]*>\s*<path d="([^"]+)"/);
const waveMatch = brandSrc.match(/WAVE_PATH = "([^"]+)"/);
if (!vertMatch || !waveMatch) throw new Error('Could not extract brand paths from brand.tsx');
const LOGO_D = vertMatch[1];
const WAVE_D = waveMatch[1]; // viewBox 0 0 400 130, band fills downward

const C = {
  caramel: '#A46832', caramelDark: '#8F5322', blue: '#7CC0C7', blueDeep: '#5FA9B1',
  ink: '#2E2A26', cream: '#F7EFE6', bg: '#F2EFE9', plastic: '#D8D3CB',
  choc: '#4A2C1A', chocLight: '#6B3E22', wafer: '#E7CFA0',
};

/* small seeded PRNG so speckles are stable between runs */
function rng(seed) {
  let s = 0; for (const ch of seed) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const r2 = (n) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* Shared scaffolding                                                  */
/* ------------------------------------------------------------------ */
const W = 800, H = 1000;
// Cup geometry (front-facing tapered cup like the photo)
const RIM_Y = 268, RIM_HW = 188, BOT_Y = 872, BOT_HW = 126, CX = 400;
const wallX = (y, side) => CX + side * (RIM_HW + (BOT_HW - RIM_HW) * ((y - RIM_Y) / (BOT_Y - RIM_Y)));

function cupBodyPath() {
  const l1 = wallX(RIM_Y, -1), r1 = wallX(RIM_Y, 1), l2 = wallX(BOT_Y, -1), r2v = wallX(BOT_Y, 1);
  return `M ${l1} ${RIM_Y} L ${l2} ${BOT_Y - 14} Q ${l2} ${BOT_Y} ${l2 + 14} ${BOT_Y} L ${r2v - 14} ${BOT_Y} Q ${r2v} ${BOT_Y} ${r2v} ${BOT_Y - 14} L ${r1} ${RIM_Y} Z`;
}

function speckles(rand, color, count, yTop, yBot, opacity = 0.9, rMin = 2, rMax = 5.5) {
  let out = '';
  for (let i = 0; i < count; i++) {
    const y = yTop + rand() * (yBot - yTop);
    const inset = 14 + rand() * 10;
    const xl = wallX(Math.min(y, BOT_Y), -1) + inset, xr = wallX(Math.min(y, BOT_Y), 1) - inset;
    const x = xl + rand() * (xr - xl);
    const rr = rMin + rand() * (rMax - rMin);
    const sq = 0.55 + rand() * 0.45;
    out += `<ellipse cx="${r2(x)}" cy="${r2(y)}" rx="${r2(rr)}" ry="${r2(rr * sq)}" fill="${color}" opacity="${opacity}" transform="rotate(${r2(rand() * 90 - 45)} ${r2(x)} ${r2(y)})"/>`;
  }
  return out;
}

/** Blobby shake dome mounded above the rim, like whipped-soft shake in the photo. */
function dome(bodyColor, lift = 96) {
  const l = CX - RIM_HW + 6, r = CX + RIM_HW - 6, t = RIM_Y - lift;
  return `<path d="M ${l} ${RIM_Y + 8}
    C ${l - 6} ${RIM_Y - 30} ${l + 30} ${t + 26} ${CX - 120} ${t + 18}
    C ${CX - 96} ${t - 12} ${CX - 40} ${t - 8} ${CX - 18} ${t + 6}
    C ${CX + 4} ${t - 16} ${CX + 70} ${t - 10} ${CX + 96} ${t + 14}
    C ${CX + 140} ${t + 2} ${r - 24} ${t + 30} ${r + 4} ${RIM_Y - 26}
    C ${r + 10} ${RIM_Y - 6} ${r} ${RIM_Y + 8} ${r} ${RIM_Y + 8} Z"
    fill="${bodyColor}"/>
    <path d="M ${l + 28} ${RIM_Y - 24} C ${l + 60} ${t + 30} ${CX - 60} ${t + 34} ${CX - 30} ${RIM_Y - 40}" stroke="#FFFFFF" stroke-opacity="0.5" stroke-width="10" fill="none" stroke-linecap="round"/>`;
}

/** Clear-plastic cup rendering: rim flange, wall highlights, base. */
function plasticShell() {
  const l1 = CX - RIM_HW, r1 = CX + RIM_HW;
  return `
  <!-- rim flange -->
  <ellipse cx="${CX}" cy="${RIM_Y}" rx="${RIM_HW + 16}" ry="30" fill="none" stroke="#FFFFFF" stroke-opacity="0.9" stroke-width="7"/>
  <ellipse cx="${CX}" cy="${RIM_Y}" rx="${RIM_HW + 16}" ry="30" fill="none" stroke="${C.plastic}" stroke-opacity="0.8" stroke-width="2.5"/>
  <path d="M ${l1 - 16} ${RIM_Y} A ${RIM_HW + 16} 30 0 0 1 ${r1 + 16} ${RIM_Y}" fill="none" stroke="#FFFFFF" stroke-opacity="0.55" stroke-width="12" stroke-linecap="round"/>
  <!-- cup outline -->
  <path d="${cupBodyPath()}" fill="none" stroke="${C.plastic}" stroke-width="3" stroke-opacity="0.9"/>
  <!-- wall sheen -->
  <path d="M ${l1 + 26} ${RIM_Y + 40} L ${wallX(BOT_Y - 30, -1) + 22} ${BOT_Y - 40}" stroke="#FFFFFF" stroke-opacity="0.35" stroke-width="16" stroke-linecap="round"/>
  <path d="M ${l1 + 52} ${RIM_Y + 60} L ${wallX(BOT_Y - 60, -1) + 44} ${BOT_Y - 90}" stroke="#FFFFFF" stroke-opacity="0.18" stroke-width="7" stroke-linecap="round"/>
  <path d="M ${r1 - 30} ${RIM_Y + 50} L ${wallX(BOT_Y - 40, 1) - 26} ${BOT_Y - 60}" stroke="#FFFFFF" stroke-opacity="0.22" stroke-width="9" stroke-linecap="round"/>
  <!-- base foot -->
  <path d="M ${wallX(BOT_Y, -1) + 6} ${BOT_Y} q -8 20 4 24 h ${(BOT_HW - 10) * 2 - 8} q 12 -4 4 -24 Z" fill="#FFFFFF" opacity="0.35" stroke="${C.plastic}" stroke-width="2.5"/>`;
}

/** Brand blue wave band across the lower cup, clipped to the cup. */
function blueBand(clipId, topY = 690) {
  const scaleX = (RIM_HW * 2 + 40) / 400;
  return `<g clip-path="url(#${clipId})">
    <g transform="translate(${CX - 200 * scaleX} ${topY}) scale(${r2(scaleX)} 1.6)">
      <path d="${WAVE_D}" fill="${C.blue}"/>
    </g>
    <rect x="${CX - RIM_HW}" y="${topY + 160}" width="${RIM_HW * 2}" height="${H}" fill="${C.blue}"/>
    <path d="M ${wallX(topY + 130, -1)} ${topY + 130} L ${wallX(BOT_Y, -1)} ${BOT_Y} L ${wallX(BOT_Y, -1) + 26} ${BOT_Y} Z" fill="#FFFFFF" opacity="0.18"/>
  </g>`;
}

/** Organic drizzle swiped across the inside wall, echoing the photo. */
function drizzle(color, rand) {
  const y0 = RIM_Y + 40;
  let d = `M ${CX + 40} ${y0 - 60} C ${CX + 150} ${y0 + 40} ${CX + 60} ${y0 + 150} ${CX + 130} ${y0 + 235} C ${CX + 165} ${y0 + 285} ${CX + 60} ${y0 + 320} ${CX - 10} ${y0 + 380} C ${CX - 120} ${y0 + 470} ${CX - 40} ${y0 + 470} ${CX - 150} ${y0 + 560} L ${CX - 178} ${y0 + 640} L ${CX - 120} ${y0 + 620} C ${CX - 20} ${y0 + 540} ${CX - 70} ${y0 + 540} ${CX + 60} ${y0 + 430} C ${CX + 150} ${y0 + 355} ${CX + 195} ${y0 + 300} ${CX + 168} ${y0 + 220} C ${CX + 150} ${y0 + 150} ${CX + 190} ${y0 + 60} ${CX + 96} ${y0 - 40} Z`;
  let drips = '';
  for (let i = 0; i < 4; i++) {
    const x = CX - 130 + rand() * 260, len = 40 + rand() * 90, w = 7 + rand() * 7, y = RIM_Y - 10 + rand() * 30;
    drips += `<path d="M ${r2(x)} ${y} q ${r2(w / 2)} ${r2(len)} 0 ${r2(len + w)} q ${r2(-w / 2)} ${r2(-w)} 0 ${r2(-len - w)}" fill="${color}" opacity="0.95"/>`;
  }
  return `<path d="${d}" fill="${color}" opacity="0.96"/>${drips}`;
}

function logoOnCup(y = 452, w = 170, fill = C.caramel, opacity = 0.95) {
  const s = w / 400;
  return `<g transform="translate(${CX - w / 2} ${y}) scale(${r2(s)})" opacity="${opacity}"><path d="${LOGO_D}" fill="${fill}" fill-rule="evenodd"/></g>`;
}

const shadow = (rx = 215, cy = 918) =>
  `<ellipse cx="${CX}" cy="${cy}" rx="${rx}" ry="26" fill="#000" opacity="0.12" filter="url(#soft)"/>`;

const svgOpen = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img">
  <defs>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="9"/></filter>
    <clipPath id="cup"><path d="${cupBodyPath()}"/></clipPath>
    <linearGradient id="glass" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.30"/><stop offset="0.18" stop-color="#FFFFFF" stop-opacity="0"/>
      <stop offset="0.85" stop-color="#FFFFFF" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0.07"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="${C.bg}"/>`;

/* ------------------------------------------------------------------ */
/* Topping mini-illustrations (drawn on the dome around y≈150–235)     */
/* ------------------------------------------------------------------ */
const T = {
  kinder() { // two bueno-style pillows: one whole with ridges, one cross-section
    const pillow = (x, y, rot) => `<g transform="rotate(${rot} ${x} ${y})">
      <rect x="${x - 62}" y="${y - 34}" width="124" height="68" rx="32" fill="${C.chocLight}"/>
      <rect x="${x - 62}" y="${y - 34}" width="124" height="68" rx="32" fill="none" stroke="#3C2312" stroke-width="3"/>
      ${[-30, -10, 10, 30].map(o => `<path d="M ${x + o} ${y - 33} q 6 33 0 66" stroke="#3C2312" stroke-width="4" fill="none" opacity="0.65"/>`).join('')}
      <path d="M ${x - 50} ${y - 22} q 40 -14 96 -2" stroke="#9A6B45" stroke-width="6" fill="none" opacity="0.7" stroke-linecap="round"/></g>`;
    const cut = (x, y, rot) => `<g transform="rotate(${rot} ${x} ${y})">
      <rect x="${x - 58}" y="${y - 32}" width="116" height="64" rx="30" fill="${C.chocLight}" stroke="#3C2312" stroke-width="3"/>
      <ellipse cx="${x - 58}" cy="${y}" rx="14" ry="32" fill="${C.wafer}" stroke="#3C2312" stroke-width="3"/>
      <ellipse cx="${x - 58}" cy="${y}" rx="7" ry="18" fill="#C9A15E"/>
      ${[-22, 0, 22].map(o => `<path d="M ${x + o + 8} ${y - 31} q 5 31 0 62" stroke="#3C2312" stroke-width="4" fill="none" opacity="0.6"/>`).join('')}</g>`;
    return cut(318, 170, -14) + pillow(478, 186, 10);
  },
  ferrero() {
    const ball = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})">
      <circle r="46" fill="#5A3A22"/><circle r="46" fill="none" stroke="#3C2312" stroke-width="3"/>
      ${Array.from({ length: 14 }, (_, i) => { const a = i * 26; const px = Math.cos(a) * (12 + (i % 4) * 8), py = Math.sin(a * 1.7) * (10 + (i % 3) * 9); return `<circle cx="${r2(px)}" cy="${r2(py)}" r="${4 + (i % 3)}" fill="#C99A5B"/>`; }).join('')}
      <path d="M -26 -26 a 36 36 0 0 1 30 -12" stroke="#8A5E38" stroke-width="7" fill="none" stroke-linecap="round" opacity="0.8"/></g>`;
    return ball(330, 176, 1) + ball(462, 168, 0.86) +
      `<circle cx="402" cy="216" r="18" fill="#8A5A2B" stroke="#5A3A22" stroke-width="3"/><path d="M 396 206 q 8 -6 14 2" stroke="#5A3A22" stroke-width="3" fill="none"/>`;
  },
  oreo() {
    const cookie = (x, y, rot, cream) => `<g transform="rotate(${rot} ${x} ${y})">
      ${cream ? `<ellipse cx="${x}" cy="${y + 8}" rx="52" ry="16" fill="#F6F1E7" stroke="#D9CFBE" stroke-width="2"/>` : ''}
      <circle cx="${x}" cy="${y}" r="50" fill="#2B2622"/><circle cx="${x}" cy="${y}" r="50" fill="none" stroke="#171310" stroke-width="3"/>
      <circle cx="${x}" cy="${y}" r="34" fill="none" stroke="#463F38" stroke-width="4"/>
      ${Array.from({ length: 12 }, (_, i) => { const a = (i / 12) * Math.PI * 2; return `<circle cx="${r2(x + Math.cos(a) * 42)}" cy="${r2(y + Math.sin(a) * 42)}" r="3.4" fill="#463F38"/>`; }).join('')}
      <circle cx="${x}" cy="${y}" r="9" fill="#463F38"/></g>`;
    return cookie(324, 176, -10, true) + cookie(470, 184, 12, false) +
      `<path d="M 396 226 l 26 -8 12 22 -30 6 z" fill="#2B2622" stroke="#171310" stroke-width="2"/>`;
  },
  snickers() {
    const chunk = (x, y, rot) => `<g transform="rotate(${rot} ${x} ${y})">
      <rect x="${x - 52}" y="${y - 30}" width="104" height="60" rx="12" fill="#5C3319" stroke="#3C2312" stroke-width="3"/>
      <rect x="${x - 52}" y="${y - 8}" width="104" height="16" fill="#C98F3F" opacity="0.95"/>
      ${[-30, -4, 24].map(o => `<ellipse cx="${x + o}" cy="${y - 16}" rx="11" ry="8" fill="#D9B074" stroke="#A97F44" stroke-width="2"/>`).join('')}</g>`;
    return chunk(322, 176, -12) + chunk(474, 182, 9) +
      `<ellipse cx="398" cy="222" rx="12" ry="9" fill="#D9B074" stroke="#A97F44" stroke-width="2"/>`;
  },
  kitkat() {
    const finger = (x, y, rot) => `<g transform="rotate(${rot} ${x} ${y})">
      <rect x="${x - 78}" y="${y - 24}" width="156" height="48" rx="10" fill="#6B4023" stroke="#3C2312" stroke-width="3"/>
      <rect x="${x - 58}" y="${y - 14}" width="116" height="28" rx="8" fill="#7E4E2C"/>
      <path d="M ${x - 78} ${y} h 156" stroke="#3C2312" stroke-width="2" opacity="0.4"/>
      <rect x="${x - 40}" y="${y - 8}" width="80" height="16" rx="6" fill="none" stroke="#4A2C1A" stroke-width="2" opacity="0.7"/></g>`;
    return finger(346, 168, -10) + finger(452, 200, 8);
  },
  caramelTop() {
    return `<path d="M 300 156 C 340 128 460 128 500 158 C 520 176 500 196 470 192 q -10 34 6 52 q -22 10 -30 -18 q -14 30 -40 22 q -6 -26 4 -44 q -34 12 -44 -8 q -26 14 -46 -4 C 288 182 284 168 300 156 Z" fill="#C98F3F" stroke="#A5642B" stroke-width="3"/>
      <path d="M 330 150 q 70 -18 140 4" stroke="#E8C08A" stroke-width="7" fill="none" stroke-linecap="round" opacity="0.8"/>
      ${[[352, 214], [432, 224], [402, 190]].map(([x, y]) => `<rect x="${x - 14}" y="${y - 12}" width="28" height="24" rx="6" fill="#B0702F" stroke="#8F5322" stroke-width="2.5" transform="rotate(${(x % 20) - 10} ${x} ${y})"/>`).join('')}`;
  },
  biscoff() {
    const b = (x, y, rot, s = 1) => `<g transform="rotate(${rot} ${x} ${y}) translate(${x} ${y}) scale(${s})">
      <rect x="-58" y="-38" width="116" height="76" rx="16" fill="#B96F35" stroke="#8F5322" stroke-width="3"/>
      <rect x="-46" y="-26" width="92" height="52" rx="10" fill="none" stroke="#8F5322" stroke-width="2.5" opacity="0.8"/>
      <path d="M -20 -12 h 40 M -20 0 h 40 M -20 12 h 40" stroke="#8F5322" stroke-width="3" opacity="0.7"/></g>`;
    return b(330, 178, -12) + b(468, 184, 10, 0.82) +
      Array.from({ length: 7 }, (_, i) => `<circle cx="${372 + i * 12}" cy="${230 + (i % 3) * 6}" r="${3 + (i % 3)}" fill="#8F5322"/>`).join('');
  },
  vanillaTop() {
    return `<g><path d="M 400 108 q 34 4 30 30 q 40 0 34 32 q 36 8 18 38 q -46 24 -164 0 q -20 -28 16 -38 q -8 -32 32 -32 q -2 -26 34 -30 Z" fill="#FBF6EC" stroke="#E4D8C4" stroke-width="3"/>
      ${Array.from({ length: 16 }, (_, i) => `<circle cx="${330 + (i * 37) % 150 + (i % 4) * 6}" cy="${150 + (i * 23) % 60}" r="1.8" fill="#5A4A38"/>`).join('')}</g>`;
  },
  strawberryTop() {
    const half = (x, y, rot, s = 1) => `<g transform="rotate(${rot} ${x} ${y}) translate(${x} ${y}) scale(${s})">
      <path d="M 0 -44 C 34 -44 46 -14 40 10 C 34 34 14 50 0 52 C -14 50 -34 34 -40 10 C -46 -14 -34 -44 0 -44 Z" fill="#E4556C" stroke="#B93A50" stroke-width="3"/>
      <path d="M 0 -36 C 24 -36 34 -12 29 8 C 24 28 10 42 0 44 C -10 42 -24 28 -29 8 C -34 -12 -24 -36 0 -36 Z" fill="#F6C9D0"/>
      <path d="M 0 -30 L 0 38 M -18 -20 L -6 30 M 18 -20 L 6 30" stroke="#E4556C" stroke-width="3" opacity="0.7"/>
      <path d="M -16 -44 q 16 -14 32 0 l -8 8 q -8 -8 -16 0 Z" fill="#5CA459"/></g>`;
    return half(330, 176, -12) + half(468, 182, 10, 0.85);
  },
  bananaTop() {
    const slice = (x, y, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})">
      <circle r="34" fill="#F2E2A7" stroke="#D9C079" stroke-width="3"/><circle r="22" fill="none" stroke="#E5D08C" stroke-width="4"/>
      <circle r="5" fill="#C9AE5F"/><path d="M -12 -12 l 8 8 M 10 -14 l 6 8 M -14 10 l 8 6" stroke="#D9C079" stroke-width="3" stroke-linecap="round"/></g>`;
    return slice(324, 178) + slice(408, 158, 0.9) + slice(482, 184, 0.95);
  },
  berries(kind) { // blueberry/raspberry/blackberry cluster for smoothie tops
    const blue = (x, y, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})"><circle r="24" fill="#4A5C8F" stroke="#33406B" stroke-width="3"/><path d="M -6 -3 l 5 -6 5 6 -3 6 -4 0 Z" fill="#33406B"/><circle cx="-9" cy="-10" r="5" fill="#8FA0D0" opacity="0.8"/></g>`;
    const rasp = (x, y, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})">${[[0, -14], [-13, -4], [13, -4], [-8, 10], [8, 10], [0, 20], [0, 2]].map(([a, b]) => `<circle cx="${a}" cy="${b}" r="10" fill="${kind === 'black' ? '#3A2C42' : '#C0455E'}" stroke="${kind === 'black' ? '#241A2B' : '#93314A'}" stroke-width="2"/>`).join('')}</g>`;
    return blue(322, 182) + rasp(400, 168, 1.05) + blue(472, 188, 0.85) + rasp(452, 210, 0.7);
  },
  mangoTop() {
    return `<g transform="translate(330 176) rotate(-10)"><path d="M -44 0 C -44 -30 -12 -44 12 -34 C 40 -22 46 8 28 28 C 8 48 -44 34 -44 0 Z" fill="#F0A93B" stroke="#C9821B" stroke-width="3"/><path d="M -30 -6 C -30 -24 -6 -32 10 -24" stroke="#F8CD86" stroke-width="6" fill="none" stroke-linecap="round"/></g>
    <g transform="translate(462 182)"><circle r="40" fill="#7A4A22" stroke="#5A3517" stroke-width="3"/><circle r="30" fill="#E8B93C"/>${Array.from({ length: 9 }, (_, i) => { const a = (i / 9) * Math.PI * 2; return `<ellipse cx="${r2(Math.cos(a) * 16)}" cy="${r2(Math.sin(a) * 16)}" rx="5" ry="7" fill="#3A2C10" transform="rotate(${r2(a * 57)} ${r2(Math.cos(a) * 16)} ${r2(Math.sin(a) * 16)})"/>`; }).join('')}</g>`;
  },
  acaiTop() {
    return this.berries('black') + `<g transform="translate(400 214)"><path d="M -20 0 q 20 -26 40 0 q -20 16 -40 0 Z" fill="#5CA459" stroke="#3E7A3C" stroke-width="2.5"/><path d="M -18 0 q 20 -4 38 0" stroke="#3E7A3C" stroke-width="2.5" fill="none"/></g>`;
  },
};

/* ------------------------------------------------------------------ */
/* Renderers per product family                                        */
/* ------------------------------------------------------------------ */
function shakeSVG({ id, body, fleck, fleckAlt, drizzleColor, topping, domeColor }) {
  const rand = rng(id);
  const dc = domeColor || body;
  return `${svgOpen}
  ${shadow()}
  <g clip-path="url(#cup)">
    <rect x="${CX - RIM_HW - 4}" y="${RIM_Y - 4}" width="${RIM_HW * 2 + 8}" height="${BOT_Y - RIM_Y + 8}" fill="${body}"/>
    ${speckles(rand, fleck, 120, RIM_Y + 30, BOT_Y - 30)}
    ${fleckAlt ? speckles(rand, fleckAlt, 55, RIM_Y + 60, BOT_Y - 60, 0.8, 1.6, 3.4) : ''}
    ${drizzleColor ? drizzle(drizzleColor, rand) : ''}
  </g>
  ${blueBand('cup')}
  <g clip-path="url(#cup)"><rect x="${CX - RIM_HW - 4}" y="${RIM_Y - 4}" width="${RIM_HW * 2 + 8}" height="${BOT_Y - RIM_Y + 8}" fill="url(#glass)"/></g>
  ${logoOnCup()}
  ${dome(dc)}
  ${speckles(rng(id + 'dome'), fleck, 34, RIM_Y - 78, RIM_Y - 6, 0.9, 1.8, 4)}
  ${topping ? topping : ''}
  ${plasticShell()}
</svg>`;
}

function smoothieSVG({ id, body, bodyDeep, fleck, topping }) {
  const rand = rng(id);
  return `${svgOpen}
  ${shadow()}
  <g clip-path="url(#cup)">
    <rect x="${CX - RIM_HW - 4}" y="${RIM_Y - 4}" width="${RIM_HW * 2 + 8}" height="${BOT_Y - RIM_Y + 8}" fill="${body}"/>
    <path d="M ${CX - RIM_HW} ${RIM_Y + 170} q ${RIM_HW} 60 ${RIM_HW * 2} 0 V ${BOT_Y} H ${CX - RIM_HW} Z" fill="${bodyDeep}" opacity="0.55"/>
    ${speckles(rand, fleck, 70, RIM_Y + 40, BOT_Y - 40, 0.55, 1.6, 4)}
    ${speckles(rand, '#FFFFFF', 26, RIM_Y + 30, RIM_Y + 200, 0.35, 2, 5)}
  </g>
  ${blueBand('cup')}
  <g clip-path="url(#cup)"><rect x="${CX - RIM_HW - 4}" y="${RIM_Y - 4}" width="${RIM_HW * 2 + 8}" height="${BOT_Y - RIM_Y + 8}" fill="url(#glass)"/></g>
  ${logoOnCup()}
  ${dome(body, 70)}
  ${topping}
  ${plasticShell()}
</svg>`;
}

function slushSVG({ id, body, deep, stripe }) {
  const rand = rng(id);
  const straw = `<g transform="rotate(9 470 140)">
    <rect x="452" y="-30" width="34" height="330" rx="16" fill="#FFFFFF" stroke="#D8D3CB" stroke-width="3"/>
    ${Array.from({ length: 6 }, (_, i) => `<rect x="452" y="${-16 + i * 52}" width="34" height="20" fill="${stripe}" opacity="0.9"/>`).join('')}
  </g>`;
  return `${svgOpen}
  ${shadow()}
  <g clip-path="url(#cup)">
    <rect x="${CX - RIM_HW - 4}" y="${RIM_Y - 4}" width="${RIM_HW * 2 + 8}" height="${BOT_Y - RIM_Y + 8}" fill="${body}"/>
    ${speckles(rand, '#FFFFFF', 130, RIM_Y + 10, BOT_Y - 20, 0.5, 2, 6)}
    ${speckles(rand, deep, 60, RIM_Y + 40, BOT_Y - 30, 0.45, 2.4, 6)}
  </g>
  ${blueBand('cup', 716)}
  <g clip-path="url(#cup)"><rect x="${CX - RIM_HW - 4}" y="${RIM_Y - 4}" width="${RIM_HW * 2 + 8}" height="${BOT_Y - RIM_Y + 8}" fill="url(#glass)"/></g>
  ${logoOnCup(468)}
  <path d="M ${CX - RIM_HW + 4} ${RIM_Y + 6} C ${CX - 150} ${RIM_Y - 66} ${CX - 40} ${RIM_Y - 84} ${CX} ${RIM_Y - 58} C ${CX + 60} ${RIM_Y - 88} ${CX + 150} ${RIM_Y - 56} ${CX + RIM_HW - 4} ${RIM_Y + 6} Z" fill="${body}"/>
  ${speckles(rng(id + 'top'), '#FFFFFF', 26, RIM_Y - 60, RIM_Y, 0.55, 2, 5)}
  ${straw}
  ${plasticShell()}
</svg>`;
}

function softServeSVG({ id, kind }) {
  const swirl = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})">
    <path d="M 0 -150 C 26 -142 30 -118 12 -106 C 52 -104 62 -72 34 -58 C 84 -54 92 -14 52 -2 C 96 6 100 48 54 58 L -54 58 C -100 48 -96 6 -52 -2 C -92 -14 -84 -54 -34 -58 C -62 -72 -52 -104 -12 -106 C -30 -118 -26 -142 0 -150 Z"
      fill="#FBF6EC" stroke="#E4D8C4" stroke-width="4"/>
    <path d="M -40 -54 q 40 -14 78 0 M -50 -2 q 50 -16 100 0 M -34 -104 q 34 -10 66 0" stroke="#E9DCC6" stroke-width="6" fill="none" stroke-linecap="round"/>
  </g>`;
  if (kind === 'cone') {
    return `${svgOpen}
    ${shadow(150, 928)}
    <g transform="translate(0 40)">
      <path d="M 300 430 L 400 900 L 500 430 Z" fill="#C98F3F" stroke="#8F5322" stroke-width="4"/>
      <g clip-path="url(#coneClip)">${Array.from({ length: 7 }, (_, i) => `<path d="M ${240 + i * 46} 420 L ${340 + i * 46} 910" stroke="#8F5322" stroke-width="4" opacity="0.6"/><path d="M ${560 - i * 46} 420 L ${460 - i * 46} 910" stroke="#8F5322" stroke-width="4" opacity="0.6"/>`).join('')}</g>
      <defs><clipPath id="coneClip"><path d="M 300 430 L 400 900 L 500 430 Z"/></clipPath></defs>
      <ellipse cx="400" cy="430" rx="104" ry="26" fill="#B0702F" stroke="#8F5322" stroke-width="4"/>
      ${swirl(400, 320, 1.15)}
    </g>
  </svg>`;
  }
  // cup soft serve (classic/premium)
  const tubTop = 470, tubBot = 830, tubHWt = 168, tubHWb = 138;
  const tub = `M ${CX - tubHWt} ${tubTop} L ${CX - tubHWb} ${tubBot - 14} Q ${CX - tubHWb} ${tubBot} ${CX - tubHWb + 14} ${tubBot} L ${CX + tubHWb - 14} ${tubBot} Q ${CX + tubHWb} ${tubBot} ${CX + tubHWb} ${tubBot - 14} L ${CX + tubHWt} ${tubTop} Z`;
  const premium = kind === 'premium'
    ? `<path d="M 352 336 q 10 60 -6 96 M 400 322 q 4 70 -8 120 M 448 338 q 2 58 -14 96" stroke="#C98F3F" stroke-width="12" fill="none" stroke-linecap="round"/>
       <g transform="translate(452 300) rotate(18)"><rect x="-14" y="-58" width="28" height="116" rx="8" fill="#E7CFA0" stroke="#C9A15E" stroke-width="3"/><path d="M -14 -30 h 28 M -14 0 h 28 M -14 30 h 28 M 0 -58 v 116" stroke="#C9A15E" stroke-width="2.5"/></g>`
    : '';
  return `${svgOpen}
  ${shadow(190, 900)}
  <defs><clipPath id="tub"><path d="${tub}"/></clipPath></defs>
  <path d="${tub}" fill="${kind === 'premium' ? C.blue : '#FFFFFF'}" stroke="${C.plastic}" stroke-width="3"/>
  <g clip-path="url(#tub)">
    ${kind === 'premium'
      ? `<g transform="translate(${CX - 200 * ((tubHWt * 2 + 30) / 400)} ${tubBot - 190}) scale(${r2((tubHWt * 2 + 30) / 400)} 1.5)"><path d="${WAVE_D}" fill="#FFFFFF" opacity="0.9"/></g><rect x="200" y="${tubBot - 40}" width="400" height="60" fill="#FFFFFF" opacity="0.9"/>`
      : `<g transform="translate(${CX - 200 * ((tubHWt * 2 + 30) / 400)} ${tubBot - 190}) scale(${r2((tubHWt * 2 + 30) / 400)} 1.5)"><path d="${WAVE_D}" fill="${C.blue}"/></g><rect x="200" y="${tubBot - 40}" width="400" height="60" fill="${C.blue}"/>`}
    <path d="M ${CX - tubHWt + 24} ${tubTop + 20} L ${CX - tubHWb + 20} ${tubBot - 30}" stroke="#FFFFFF" stroke-opacity="0.4" stroke-width="14" stroke-linecap="round"/>
  </g>
  <g transform="translate(${CX - 65} 540) scale(0.325)"><path d="${LOGO_D}" fill="${kind === 'premium' ? '#FFFFFF' : C.caramel}" fill-rule="evenodd"/></g>
  <ellipse cx="${CX}" cy="${tubTop}" rx="${tubHWt}" ry="30" fill="#FBF6EC" stroke="${C.plastic}" stroke-width="3"/>
  ${swirl(CX, 350, 1.25)}
  ${premium}
  <path d="M ${CX - tubHWt} ${tubTop} A ${tubHWt} 30 0 0 1 ${CX + tubHWt} ${tubTop}" fill="none" stroke="#FFFFFF" stroke-opacity="0.7" stroke-width="8" stroke-linecap="round"/>
</svg>`;
}

function extraSVG({ id, motif }) {
  return `${svgOpen}
  <circle cx="400" cy="470" r="250" fill="${C.cream}"/>
  <circle cx="400" cy="470" r="250" fill="none" stroke="#EBDECE" stroke-width="4"/>
  ${shadow(200, 770)}
  ${motif}
  <g transform="translate(${400 - 130 / 2} 812) scale(${r2(130 / 400)})"><path d="${LOGO_D}" fill="${C.caramel}" fill-rule="evenodd" opacity="0.9"/></g>
</svg>`;
}

const EXTRA_MOTIFS = {
  whip: `<g transform="translate(400 480) scale(1.5)">
    <path d="M 0 -120 C 24 -112 28 -90 12 -80 C 48 -78 56 -50 32 -38 C 76 -34 82 4 46 14 C 86 22 88 60 44 68 L -44 68 C -88 60 -86 22 -46 14 C -82 4 -76 -34 -32 -38 C -56 -50 -48 -78 -12 -80 C -28 -90 -24 -112 0 -120 Z" fill="#FBF6EC" stroke="#E4D8C4" stroke-width="4"/>
    <path d="M -36 -36 q 36 -12 70 0 M -44 14 q 44 -14 88 0" stroke="#E9DCC6" stroke-width="5" fill="none" stroke-linecap="round"/></g>`,
  nutella: `<g transform="translate(400 470)">
    <path d="M -110 60 C -150 20 -120 -60 -50 -80 C 10 -98 90 -80 116 -20 C 138 30 100 84 30 92 C -30 100 -80 92 -110 60 Z" fill="${C.choc}"/>
    <path d="M -70 -30 C -30 -60 50 -56 84 -18" stroke="#7A4A26" stroke-width="14" fill="none" stroke-linecap="round"/>
    <path d="M -80 30 C -20 60 60 52 96 16" stroke="#2E1A0E" stroke-width="12" fill="none" stroke-linecap="round" opacity="0.7"/>
    <path d="M -20 -96 q 20 -18 40 0 q -8 22 -20 22 q -12 0 -20 -22 Z" fill="${C.choc}"/>
    <circle cx="66" cy="-64" r="20" fill="#8A5A2B" stroke="#5A3A22" stroke-width="3"/></g>`,
  crumbs: `<g transform="translate(400 500)">${Array.from({ length: 26 }, (_, i) => { const a = (i / 26) * Math.PI * 2; const rr = 40 + (i * 53 % 120); const x = Math.cos(a * 3.1) * rr, y = Math.sin(a * 2.3) * rr * 0.55 - 10; const s = 8 + (i % 5) * 6; return `<rect x="${r2(x - s / 2)}" y="${r2(y - s / 2)}" width="${s}" height="${s * 0.8}" rx="${s / 4}" fill="${i % 3 ? '#8F5322' : '#B96F35'}" transform="rotate(${i * 37 % 90 - 45} ${r2(x)} ${r2(y)})" stroke="#5A3517" stroke-width="1.5"/>`; }).join('')}
    <path d="M -140 84 q 140 46 280 0 q -140 26 -280 0 Z" fill="#B96F35" opacity="0.5"/></g>`,
  marshmallow: `<g transform="translate(400 470)">${[[-80, 20, -14, '#FFFFFF'], [60, 34, 10, '#F6D7DE'], [-6, -44, 4, '#FFFFFF']].map(([x, y, rot, fill]) => `<g transform="rotate(${rot} ${x} ${y})"><rect x="${x - 56}" y="${y - 44}" width="112" height="88" rx="30" fill="${fill}" stroke="#E4D8C4" stroke-width="4"/><ellipse cx="${x}" cy="${y - 44}" rx="56" ry="16" fill="#FFFFFF" stroke="#E4D8C4" stroke-width="3"/></g>`).join('')}</g>`,
  mix: `<g transform="translate(400 470)">
    <g transform="translate(-70 0) rotate(-8)"><path d="M -60 -90 L -44 90 Q -42 104 -28 104 L 28 104 Q 42 104 44 90 L 60 -90 Z" fill="#F5CDD3" stroke="${C.plastic}" stroke-width="4"/><ellipse cx="0" cy="-90" rx="62" ry="16" fill="none" stroke="${C.plastic}" stroke-width="5"/></g>
    <g transform="translate(84 6) rotate(9)"><path d="M -60 -90 L -44 90 Q -42 104 -28 104 L 28 104 Q 42 104 44 90 L 60 -90 Z" fill="#E7CFA0" stroke="${C.plastic}" stroke-width="4"/><ellipse cx="0" cy="-90" rx="62" ry="16" fill="none" stroke="${C.plastic}" stroke-width="5"/></g>
    <circle cx="8" cy="-140" r="42" fill="${C.caramel}"/><path d="M -12 -140 h 40 M 8 -160 v 40" stroke="#FFFFFF" stroke-width="10" stroke-linecap="round"/></g>`,
};

/* ------------------------------------------------------------------ */
/* The product registry — one entry per menu item id                   */
/* ------------------------------------------------------------------ */
const PRODUCTS = [
  { id: 'm1', kind: 'shake', body: '#EBDCC4', fleck: '#7A5230', fleckAlt: '#C9A15E', drizzleColor: C.choc, topping: T.kinder() },
  { id: 'm2', kind: 'shake', body: '#D9BFA0', fleck: '#5A3A22', fleckAlt: '#8A5E38', drizzleColor: C.choc, topping: T.ferrero() },
  { id: 'm3', kind: 'shake', body: '#E9E6E1', fleck: '#2B2622', fleckAlt: '#5A544C', drizzleColor: '#2B2622', topping: T.oreo() },
  { id: 'm4', kind: 'shake', body: '#E2CBA8', fleck: '#5C3319', fleckAlt: '#C98F3F', drizzleColor: '#C98F3F', topping: T.snickers() },
  { id: 'm5', kind: 'shake', body: '#E4D2BC', fleck: '#6B4023', fleckAlt: '#9A6B45', drizzleColor: C.choc, topping: T.kitkat() },
  { id: 'm6', kind: 'shake', body: '#EFD9B4', fleck: '#B0702F', fleckAlt: '#D9B074', drizzleColor: '#B0702F', topping: T.caramelTop() },
  { id: 'm7', kind: 'shake', body: '#E8CFA9', fleck: '#8F5322', fleckAlt: '#B96F35', drizzleColor: '#B96F35', topping: T.biscoff() },
  { id: 'm8', kind: 'shake', body: '#F5EEDF', fleck: '#5A4A38', fleckAlt: null, drizzleColor: null, topping: T.vanillaTop(), domeColor: '#FBF6EC' },
  { id: 'm9', kind: 'shake', body: '#F5CDD3', fleck: '#E58AA0', fleckAlt: '#C94F6D', drizzleColor: '#D6647E', topping: T.strawberryTop() },
  { id: 'm10', kind: 'shake', body: '#F4E7BE', fleck: '#D9C079', fleckAlt: null, drizzleColor: null, topping: T.bananaTop() },

  { id: 'sm1', kind: 'smoothie', body: '#EE8FA4', bodyDeep: '#D6647E', fleck: '#F4E7BE', topping: T.strawberryTop() + T.bananaTop().replace('translate(324 178)', 'translate(398 214) scale(0.7)') },
  { id: 'sm2', kind: 'smoothie', body: '#6C4470', bodyDeep: '#4C2E52', fleck: '#3A2C42', topping: T.acaiTop() },
  { id: 'sm3', kind: 'smoothie', body: '#F0A93B', bodyDeep: '#D98A18', fleck: '#F8CD86', topping: T.mangoTop() },
  { id: 'sm4', kind: 'smoothie', body: '#8F4468', bodyDeep: '#6C2F4E', fleck: '#C0455E', topping: T.berries('mixed') },

  { id: 'ss1', kind: 'soft', variant: 'classic' },
  { id: 'ss2', kind: 'soft', variant: 'premium' },
  { id: 'ss3', kind: 'soft', variant: 'cone' },

  { id: 'sl1', kind: 'slush', body: '#7FC5EC', deep: '#3E8FC7', stripe: '#3E8FC7' },
  { id: 'sl2', kind: 'slush', body: '#EE6070', deep: '#C22B44', stripe: '#C22B44' },

  { id: 'e1', kind: 'extra', motif: EXTRA_MOTIFS.mix },
  { id: 'e2', kind: 'extra', motif: EXTRA_MOTIFS.whip },
  { id: 'e3', kind: 'extra', motif: EXTRA_MOTIFS.nutella },
  { id: 'e4', kind: 'extra', motif: EXTRA_MOTIFS.crumbs },
  { id: 'e5', kind: 'extra', motif: EXTRA_MOTIFS.marshmallow },
];

for (const p of PRODUCTS) {
  let svg;
  if (p.kind === 'shake') svg = shakeSVG(p);
  else if (p.kind === 'smoothie') svg = smoothieSVG(p);
  else if (p.kind === 'slush') svg = slushSVG(p);
  else if (p.kind === 'soft') svg = softServeSVG({ id: p.id, kind: p.variant });
  else svg = extraSVG(p);
  writeFileSync(join(OUT, `${p.id}.svg`), svg.replace(/\n\s+/g, ' ').replace(/> </g, '><') + '\n');
  console.log(`✔ ${p.id}.svg`);
}
console.log(`\nWrote ${PRODUCTS.length} product illustrations to public/brand/drinks/`);
