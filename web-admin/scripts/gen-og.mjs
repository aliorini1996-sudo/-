import sharp from 'sharp';
import { mkdirSync } from 'fs';

mkdirSync('public', { recursive: true });

// صورة المشاركة الاجتماعية (Open Graph) 1200×630 — نص لاتيني لضمان العرض على أي خادم
const og = `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#FAF7F0"/>
  <circle cx="1130" cy="-30" r="300" fill="#FBEBE2"/>
  <circle cx="40" cy="700" r="240" fill="#E4F1EA" opacity="0.55"/>

  <!-- الشعار: رمز المسار الصاعد -->
  <g transform="translate(110,140)">
    <rect width="150" height="150" rx="32" fill="#E15A30"/>
    <svg x="16" y="16" width="118" height="118" viewBox="0 0 120 120">
      <line x1="32" y1="88" x2="88" y2="32" stroke="#1F1A13" stroke-width="15" stroke-linecap="round"/>
      <circle cx="32" cy="88" r="10" fill="#FAF7F0"/>
      <circle cx="60" cy="60" r="8" fill="#FAF7F0"/>
      <circle cx="88" cy="32" r="13" fill="#1F1A13"/>
      <circle cx="88" cy="32" r="7" fill="#FAF7F0"/>
    </svg>
  </g>

  <text x="292" y="218" font-family="'Segoe UI',Arial,sans-serif" font-size="78" font-weight="700"><tspan fill="#1F1A13">Field</tspan><tspan fill="#E15A30"> Sales</tspan></text>
  <text x="294" y="272" font-family="'Segoe UI',Arial,sans-serif" font-size="30" fill="#6E6557">Field-sales &amp; distribution management platform</text>

  <text x="112" y="420" font-family="'Segoe UI',Arial,sans-serif" font-size="33" font-weight="600" fill="#1F1A13">ZATCA invoices  ·  Collection  ·  Van stock  ·  GPS tracking</text>

  <rect x="112" y="498" width="320" height="72" rx="18" fill="#E15A30"/>
  <text x="272" y="544" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif" font-size="28" font-weight="700" fill="#ffffff">Free 10-day trial</text>
  <text x="1088" y="546" text-anchor="end" font-family="'Segoe UI',Arial,sans-serif" font-size="36" font-weight="700" fill="#1F1A13">fieldsa.net</text>
</svg>`;

await sharp(Buffer.from(og)).png().toFile('public/og-image.png');
console.log('✅ تم توليد صورة OG (1200×630) في public/og-image.png');
