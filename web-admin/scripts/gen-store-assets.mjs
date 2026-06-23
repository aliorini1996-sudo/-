import sharp from 'sharp';
import { mkdirSync } from 'fs';

const out = 'C:/Users/ali_h/OneDrive/سطح المكتب/تطبيق المندوب/متجر-جوجل-بلاي';
mkdirSync(out, { recursive: true });

// شعار FieldSales (الأيقونة) كـ SVG قابل للتضمين
const logoMark = (x, y, s) => `
  <g transform="translate(${x},${y}) scale(${s / 512})">
    <rect width="512" height="512" rx="115" fill="url(#fg)"/>
    <g fill="#4aa3ff">
      <rect x="118" y="190" width="96"  height="28" rx="14"/>
      <rect x="118" y="250" width="128" height="28" rx="14"/>
      <rect x="118" y="310" width="80"  height="28" rx="14"/>
    </g>
    <g fill="#ffffff">
      <rect x="292" y="148" width="50"  height="216" rx="16"/>
      <rect x="292" y="148" width="122" height="50"  rx="16"/>
      <rect x="292" y="232" width="94"  height="46"  rx="14"/>
    </g>
  </g>`;

// الصورة الترويجية (Feature Graphic) — 1024×500
const feature = `<svg width="1024" height="500" viewBox="0 0 1024 500" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1d4f9c"/>
      <stop offset="1" stop-color="#0b1e३a".replace("३","3")/>
    </linearGradient>
    <linearGradient id="fg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#e8f1ff"/>
    </linearGradient>
  </defs>
  <rect width="1024" height="500" fill="#0d2440"/>
  <rect width="1024" height="500" fill="url(#bgGrad)" opacity="0.55"/>
  <circle cx="880" cy="120" r="260" fill="#ffffff" opacity="0.04"/>
  <circle cx="170" cy="430" r="190" fill="#ffffff" opacity="0.04"/>
  ${logoMark(90, 150, 200)}
  <text x="320" y="240" font-family="Arial, sans-serif" font-size="74" font-weight="800" fill="#ffffff">Field<tspan fill="#38bdf8">Sales</tspan></text>
  <text x="322" y="300" font-family="Arial, sans-serif" font-size="30" fill="#cbd5e1" direction="rtl">منصة ادارة مبيعات المناديب الميدانيين</text>
  <text x="322" y="350" font-family="Arial, sans-serif" font-size="23" fill="#7fb3ff" direction="rtl">فواتير · سندات قبض · كشوف حساب · ادارة عملاء</text>
</svg>`;

// تصحيح اللون (تفادي رمز عربي أُقحم بالخطأ)
const featureFixed = feature.replace('#0b1e३a".replace("३","3")', '#0b1e3a"');

await sharp(Buffer.from(featureFixed)).png().toFile(out + '/feature-graphic-1024x500.png');
console.log('✅ تم إنشاء الصورة الترويجية في: ' + out);
