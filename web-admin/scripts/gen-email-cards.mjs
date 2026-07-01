import sharp from 'sharp';
import { mkdirSync } from 'fs';

// بطاقة بريد تسويقية احترافية بهوية Field Sales (نص لاتيني لضمان العرض على أي خادم)
// تُصدَّر PNG وتُخدَم على fieldsa.net/email/hero.png ثم تُدمج أعلى البريد التسويقي.
mkdirSync('public/email', { recursive: true });

const W = 1200, H = 460;

// أيقونة مصغّرة لكل ميزة (SVG بسيط أبيض)
function chip(x, y, label) {
  return `
    <g transform="translate(${x},${y})">
      <circle cx="9" cy="9" r="7" fill="none" stroke="#E15A30" stroke-width="3"/>
      <circle cx="9" cy="9" r="2.5" fill="#E15A30"/>
      <text x="26" y="15" font-family="'Segoe UI',Arial,sans-serif" font-size="24" font-weight="600" fill="#EDE7DC">${label}</text>
    </g>`;
}

const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#211B14"/>
      <stop offset="1" stop-color="#171310"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  <circle cx="1140" cy="-40" r="260" fill="#E15A30" opacity="0.12"/>
  <circle cx="60" cy="520" r="220" fill="#1E7A52" opacity="0.10"/>

  <!-- الشعار: رمز المسار الصاعد -->
  <g transform="translate(90,80)">
    <rect width="126" height="126" rx="30" fill="#E15A30"/>
    <g transform="translate(14,14)">
      <polyline points="27,74 50,50 76,27" stroke="#1F1A13" stroke-width="11" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <circle cx="27" cy="74" r="7" fill="#FAF7F0"/>
      <circle cx="50" cy="50" r="5" fill="#FAF7F0"/>
      <circle cx="76" cy="27" r="10" fill="#1F1A13"/>
      <circle cx="76" cy="27" r="4.5" fill="#FAF7F0"/>
    </g>
  </g>

  <text x="252" y="140" font-family="'Segoe UI',Arial,sans-serif" font-size="70" font-weight="700"><tspan fill="#FFFFFF">Field</tspan><tspan fill="#E15A30"> Sales</tspan></text>
  <text x="255" y="188" font-family="'Segoe UI',Arial,sans-serif" font-size="27" fill="#B7AE9E">Field-sales &amp; distribution management platform</text>

  <!-- شريط الميزات -->
  ${chip(92, 258, 'ZATCA e-invoicing')}
  ${chip(390, 258, 'Collections &amp; receivables')}
  ${chip(92, 300, 'Van inventory')}
  ${chip(390, 300, 'Live GPS rep tracking')}

  <!-- CTA -->
  <rect x="92" y="360" width="300" height="66" rx="16" fill="#E15A30"/>
  <text x="242" y="402" text-anchor="middle" font-family="'Segoe UI',Arial,sans-serif" font-size="26" font-weight="700" fill="#ffffff">Start your free trial</text>
  <text x="1108" y="404" text-anchor="end" font-family="'Segoe UI',Arial,sans-serif" font-size="34" font-weight="700" fill="#FFFFFF">fieldsa.net</text>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile('public/email/hero.png');
console.log('✅ تم توليد بطاقة البريد (1200×460) في public/email/hero.png');
