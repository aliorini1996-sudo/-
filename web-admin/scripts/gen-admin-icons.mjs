import sharp from 'sharp';
import { mkdirSync } from 'fs';

mkdirSync('public/icons', { recursive: true });

// أيقونة تطبيق الإدارة على الجوال — نفس رمز «المسار الصاعد» من دليل الهوية،
// **بألوان معكوسة** عن أيقونة المندوب: خلفية فحميّة ومسار برتقالي.
//
// لماذا العكس لا رمزٌ آخر: التطبيقان يقعان جنباً إلى جنب على شاشة الجوال نفسها
// أحياناً (مالك يحمل الاثنين)، فيجب أن يُميَّزا **بلمحة** — والعكس يفعل ذلك بلا
// خروج عن الهوية ولا اختراع علامة ثانية.
const route = (stroke, dotFill) => `
  <line x1="32" y1="88" x2="88" y2="32" stroke="${stroke}" stroke-width="15" stroke-linecap="round"/>
  <circle cx="32" cy="88" r="10" fill="${dotFill}"/>
  <circle cx="60" cy="60" r="8" fill="${dotFill}"/>
  <circle cx="88" cy="32" r="13" fill="${stroke}"/>
  <circle cx="88" cy="32" r="7" fill="${dotFill}"/>`;

const BG = '#1F1A13';      // الفحميّ من الهوية
const MARK = '#E15A30';    // البرتقالي
const DOT = '#FAF7F0';     // العاجيّ

const iconSvg = `<svg width="512" height="512" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
  <rect width="120" height="120" rx="26" fill="${BG}"/>
  ${route(MARK, DOT)}
</svg>`;

// maskable: مربع كامل + المسار داخل المنطقة الآمنة (تقصّه الأنظمة دائرياً)
const maskableSvg = `<svg width="512" height="512" viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
  <rect width="120" height="120" fill="${BG}"/>
  <g transform="translate(60,60) scale(0.8) translate(-60,-60)">${route(MARK, DOT)}</g>
</svg>`;

await sharp(Buffer.from(iconSvg)).resize(192, 192).png().toFile('public/icons/admin-192.png');
await sharp(Buffer.from(iconSvg)).resize(512, 512).png().toFile('public/icons/admin-512.png');
await sharp(Buffer.from(maskableSvg)).resize(512, 512).png().toFile('public/icons/admin-maskable-512.png');
await sharp(Buffer.from(iconSvg)).resize(180, 180).png().toFile('public/icons/admin-apple-touch.png');

console.log('✅ تم توليد أيقونات تطبيق الإدارة (عكس ألوان المندوب)');
