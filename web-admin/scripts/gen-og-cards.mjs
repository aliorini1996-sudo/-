// يولّد بطاقات صور احترافية (OG cards) لكل مقال SEO بلغاته الثلاث — بهوية FieldSales.
// المخرجات: public/og/{slug}-{lang}.jpg (1200×630). تُستخدم كصورة مشاركة (og:image)،
// وصورة رأس المقال، وفي خريطة صور Google. يُشغَّل يدوياً: npm run og:cards
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import { cardCatalog } from '../src/blog/seo/catalog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../public/og');
const LANGS = ['ar', 'en', 'fr'];

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const font = (L) => (L === 'ar' ? 'Tahoma, sans-serif' : 'Arial, sans-serif');

// تقسيم النص إلى أسطر بحدّ أقصى للأحرف
function wrap(text, maxChars) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

const tag = (L) => (L === 'ar' ? 'دليل عملي · fieldsa.net' : L === 'fr' ? 'Guide pratique · fieldsa.net' : 'Practical guide · fieldsa.net');

export function buildSvg({ label, country, accent }, L) {
  const rtl = L === 'ar';
  const headline = label[L];
  const countryName = country ? country[L] : (L === 'ar' ? 'الدول العربية' : L === 'fr' ? 'Pays arabes' : 'Arab countries');
  const maxChars = rtl ? 26 : 24;
  const lines = wrap(headline, maxChars).slice(0, 3);
  const fs2 = lines.length >= 3 ? 52 : 64;
  const lh = Math.round(fs2 * 1.18);

  // محاذاة: العربية إلى اليمين (text-anchor=end)، اللاتينية إلى اليسار.
  // ملاحظة: لا نضيف direction='rtl' لأن librsvg يعكس معها معنى text-anchor فيقصّ النص.
  const x = rtl ? 1120 : 80;
  const anchor = rtl ? 'end' : 'start';
  const dir = '';
  const topY = 300 - Math.round(((lines.length - 1) * lh) / 2);

  const headlineTspans = lines
    .map((ln, i) => `<tspan x='${x}' y='${topY + i * lh}'>${esc(ln)}</tspan>`)
    .join('');
  const countryY = topY + lines.length * lh + 20;

  return `<svg width='1200' height='630' viewBox='0 0 1200 630' xmlns='http://www.w3.org/2000/svg'>
  <defs>
    <radialGradient id='g1' cx='18%' cy='20%' r='55%'>
      <stop offset='0%' stop-color='${accent}' stop-opacity='0.16'/><stop offset='100%' stop-color='${accent}' stop-opacity='0'/>
    </radialGradient>
    <radialGradient id='g2' cx='90%' cy='85%' r='55%'>
      <stop offset='0%' stop-color='#1E7A52' stop-opacity='0.12'/><stop offset='100%' stop-color='#1E7A52' stop-opacity='0'/>
    </radialGradient>
    <radialGradient id='g3' cx='78%' cy='12%' r='45%'>
      <stop offset='0%' stop-color='#C99A2E' stop-opacity='0.12'/><stop offset='100%' stop-color='#C99A2E' stop-opacity='0'/>
    </radialGradient>
  </defs>
  <rect width='1200' height='630' fill='#FAF7F0'/>
  <rect width='1200' height='630' fill='url(#g1)'/>
  <rect width='1200' height='630' fill='url(#g2)'/>
  <rect width='1200' height='630' fill='url(#g3)'/>
  <rect x='0' y='0' width='1200' height='12' fill='${accent}'/>
  <rect x='0' y='618' width='1200' height='12' fill='#1F1A13'/>

  <!-- زخرفة: مسار التوزيع الصاعد (علامة مائية) -->
  <g opacity='0.10' transform='translate(940,360) scale(2.4)'>
    <line x1='26' y1='70' x2='70' y2='26' stroke='#1F1A13' stroke-width='12' stroke-linecap='round'/>
    <circle cx='26' cy='70' r='9' fill='#1F1A13'/><circle cx='48' cy='48' r='7' fill='#1F1A13'/><circle cx='70' cy='26' r='11' fill='#1F1A13'/>
  </g>

  <!-- الشعار (أعلى اليسار) -->
  <g transform='translate(80,64)'>
    <rect width='84' height='84' rx='19' fill='#E15A30'/>
    <line x1='23' y1='61' x2='61' y2='23' stroke='#1F1A13' stroke-width='11' stroke-linecap='round'/>
    <circle cx='23' cy='61' r='7' fill='#FAF7F0'/><circle cx='42' cy='42' r='5.5' fill='#FAF7F0'/>
    <circle cx='61' cy='23' r='9' fill='#1F1A13'/><circle cx='61' cy='23' r='4.5' fill='#FAF7F0'/>
  </g>
  <text x='182' y='120' font-family='Georgia, serif' font-weight='700' font-size='42'><tspan fill='#1F1A13'>Field</tspan><tspan fill='#E15A30'> Sales</tspan></text>

  <!-- العنوان -->
  <text font-family="${font(L)}" font-weight='800' font-size='${fs2}' fill='#1F1A13' text-anchor='${anchor}'${dir}>${headlineTspans}</text>
  <!-- اسم الدولة -->
  <text x='${x}' y='${countryY}' font-family="${font(L)}" font-weight='700' font-size='46' fill='${accent}' text-anchor='${anchor}'${dir}>${esc(countryName)}</text>

  <!-- شريط سفلي -->
  <text x='${x}' y='585' font-family="${font(L)}" font-weight='600' font-size='26' fill='#6E6557' text-anchor='${anchor}'${dir}>${esc(tag(L))}</text>
</svg>`;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const force = process.argv.includes('--force'); // بلا force: يولّد الناقص فقط (مقالات جديدة)
  const cards = cardCatalog();
  let n = 0, skipped = 0;
  for (const card of cards) {
    for (const L of LANGS) {
      const out = path.join(OUT, `${card.slug}-${L}.jpg`);
      if (!force && fs.existsSync(out)) { skipped++; continue; }
      const svg = buildSvg(card, L);
      await sharp(Buffer.from(svg), { density: 144 }).jpeg({ quality: 80, mozjpeg: true }).toFile(out);
      n++;
    }
  }
  console.log(`✅ og cards: ${n} بطاقة جديدة (+${skipped} موجودة) — ${cards.length} مقال × ${LANGS.length} لغات في public/og/`);
}

import { pathToFileURL } from 'url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('تعذّر توليد البطاقات:', e); process.exit(1); });
}
