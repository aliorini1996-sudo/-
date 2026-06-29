// يولّد favicon.ico (متعدّد الأحجام) + favicon.svg من شعار الهوية «المسار الصاعد»
// يُشغَّل من مجلّد web-admin: node scripts/gen-favicon.mjs
import sharp from 'sharp';
import fs from 'fs';

// شعار FieldSales — نسخة محسّنة للأحجام الصغيرة (خط أعرض ونقاط أكبر للوضوح في نتائج البحث)
const svg = `<svg width="120" height="120" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
  <rect width="120" height="120" rx="26" fill="#E15A30"/>
  <polyline points="30,90 60,60 90,30" stroke="#1F1A13" stroke-width="15" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  <circle cx="30" cy="90" r="9" fill="#FAF7F0"/>
  <circle cx="60" cy="60" r="7" fill="#FAF7F0"/>
  <circle cx="90" cy="30" r="13" fill="#1F1A13"/>
  <circle cx="90" cy="30" r="6.5" fill="#FAF7F0"/>
</svg>`;

const sizes = [16, 32, 48];
const pngs = await Promise.all(
  sizes.map((s) => sharp(Buffer.from(svg)).resize(s, s).png().toBuffer())
);

// تجميع حاوية ICO تحتوي PNG لكل حجم (مدعومة في كل المتصفحات وجوجل)
const count = pngs.length;
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);      // محجوز
header.writeUInt16LE(1, 2);      // النوع = أيقونة
header.writeUInt16LE(count, 4);  // عدد الصور

const dir = Buffer.alloc(count * 16);
let offset = 6 + count * 16;
pngs.forEach((png, i) => {
  const s = sizes[i];
  const o = i * 16;
  dir.writeUInt8(s >= 256 ? 0 : s, o);      // العرض
  dir.writeUInt8(s >= 256 ? 0 : s, o + 1);  // الارتفاع
  dir.writeUInt8(0, o + 2);                 // عدد الألوان
  dir.writeUInt8(0, o + 3);                 // محجوز
  dir.writeUInt16LE(1, o + 4);              // الطبقات
  dir.writeUInt16LE(32, o + 6);             // بت/بكسل
  dir.writeUInt32LE(png.length, o + 8);     // حجم البيانات
  dir.writeUInt32LE(offset, o + 12);        // الإزاحة
  offset += png.length;
});

const ico = Buffer.concat([header, dir, ...pngs]);
fs.writeFileSync('public/favicon.ico', ico);
fs.writeFileSync('public/favicon.svg', svg);
await sharp(Buffer.from(svg)).resize(48, 48).png().toFile('public/favicon-48.png');

console.log('✅ favicon.ico:', ico.length, 'bytes | أحجام:', sizes.join(','), '| + favicon.svg + favicon-48.png');
