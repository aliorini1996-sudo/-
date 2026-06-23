import sharp from 'sharp';
import { mkdirSync } from 'fs';

mkdirSync('public/icons', { recursive: true });

// أيقونة عادية: خلفية زرقاء + سهم صاعد (هوية تطبيق المبيعات)
const iconSvg = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" rx="112" fill="#1e3a8a"/>
  <g transform="translate(128,128) scale(10.67)" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
    <polyline points="16 7 22 7 22 13"/>
  </g>
</svg>`;

// نسخة maskable: نفس التصميم لكن الأيقونة أصغر داخل المنطقة الآمنة
const maskableSvg = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" fill="#1e3a8a"/>
  <g transform="translate(158,168) scale(8.2)" fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/>
    <polyline points="16 7 22 7 22 13"/>
  </g>
</svg>`;

await sharp(Buffer.from(iconSvg)).resize(192, 192).png().toFile('public/icons/icon-192.png');
await sharp(Buffer.from(iconSvg)).resize(512, 512).png().toFile('public/icons/icon-512.png');
await sharp(Buffer.from(maskableSvg)).resize(512, 512).png().toFile('public/icons/icon-maskable-512.png');
await sharp(Buffer.from(iconSvg)).resize(180, 180).png().toFile('public/icons/apple-touch-icon.png');

console.log('✅ تم توليد الأيقونات');
