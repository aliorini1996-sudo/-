import sharp from 'sharp';
import { mkdirSync } from 'fs';

mkdirSync('public/icons', { recursive: true });

// رمز «المسار الصاعد» — مطابق لدليل الهوية الرسمي (FieldSales)
const route = (stroke, endDot) => `
  <line x1="32" y1="88" x2="88" y2="32" stroke="${stroke}" stroke-width="15" stroke-linecap="round"/>
  <circle cx="32" cy="88" r="10" fill="#FAF7F0"/>
  <circle cx="60" cy="60" r="8" fill="#FAF7F0"/>
  <circle cx="88" cy="32" r="13" fill="${endDot}"/>
  <circle cx="88" cy="32" r="7" fill="#FAF7F0"/>`;

const iconSvg = `<svg width="512" height="512" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
  <rect width="120" height="120" rx="26" fill="#E15A30"/>
  ${route('#1F1A13', '#1F1A13')}
</svg>`;

// maskable: مربع كامل + المسار داخل المنطقة الآمنة
const maskableSvg = `<svg width="512" height="512" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
  <rect width="120" height="120" fill="#E15A30"/>
  <g transform="translate(60,60) scale(0.8) translate(-60,-60)">${route('#1F1A13', '#1F1A13')}</g>
</svg>`;

await sharp(Buffer.from(iconSvg)).resize(192, 192).png().toFile('public/icons/icon-192.png');
await sharp(Buffer.from(iconSvg)).resize(512, 512).png().toFile('public/icons/icon-512.png');
await sharp(Buffer.from(maskableSvg)).resize(512, 512).png().toFile('public/icons/icon-maskable-512.png');
await sharp(Buffer.from(iconSvg)).resize(180, 180).png().toFile('public/icons/apple-touch-icon.png');
await sharp(Buffer.from(iconSvg)).resize(512, 512).png().toFile('public/icons/playstore-512.png');

console.log('✅ تم توليد أيقونات FieldSales (رمز المسار الصاعد)');
