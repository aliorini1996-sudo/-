import sharp from 'sharp';
import { mkdirSync } from 'fs';

mkdirSync('public/icons', { recursive: true });

// عناصر شعار FieldSales: حرف F أبيض + 3 خطوط زرقاء فاتحة
const brandMarks = `
  <g fill="#4aa3ff">
    <rect x="118" y="190" width="96"  height="28" rx="14"/>
    <rect x="118" y="250" width="128" height="28" rx="14"/>
    <rect x="118" y="310" width="80"  height="28" rx="14"/>
  </g>
  <g fill="#ffffff">
    <rect x="292" y="148" width="50"  height="216" rx="16"/>
    <rect x="292" y="148" width="122" height="50"  rx="16"/>
    <rect x="292" y="232" width="94"  height="46"  rx="14"/>
  </g>`;

// أيقونة عادية: خلفية متدرجة بزوايا دائرية
const iconSvg = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2f72d8"/>
      <stop offset="1" stop-color="#13284a"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="115" fill="url(#bg)"/>
  ${brandMarks}
</svg>`;

// نسخة maskable: خلفية كاملة + العناصر داخل المنطقة الآمنة
const maskableSvg = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#2f72d8"/>
      <stop offset="1" stop-color="#13284a"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <g transform="translate(256,256) scale(0.76) translate(-256,-256)">${brandMarks}</g>
</svg>`;

await sharp(Buffer.from(iconSvg)).resize(192, 192).png().toFile('public/icons/icon-192.png');
await sharp(Buffer.from(iconSvg)).resize(512, 512).png().toFile('public/icons/icon-512.png');
await sharp(Buffer.from(maskableSvg)).resize(512, 512).png().toFile('public/icons/icon-maskable-512.png');
await sharp(Buffer.from(iconSvg)).resize(180, 180).png().toFile('public/icons/apple-touch-icon.png');
// أيقونة بدقة عالية لمتجر Google Play (512×512 PNG)
await sharp(Buffer.from(iconSvg)).resize(512, 512).png().toFile('public/icons/playstore-512.png');

console.log('✅ تم توليد أيقونات FieldSales');
