import sharp from 'sharp';
import { mkdirSync } from 'fs';

mkdirSync('public', { recursive: true });

/**
 * بطاقة المشاركة (Open Graph) 1200×630 — تظهر عند إرفاق fieldsa.net أو أي مسار فرعي.
 *
 * ⚠️ **تُشغَّل يدوياً على ويندوز فقط** (`node scripts/gen-og.mjs`)، والناتج
 * `public/og-image.png` **يُودَع في المستودع**. السبب: النصّ العربي هنا يُرسَم
 * بخطوط النظام عبر librsvg، وخوادم البناء على Render بلا خطوط عربية — فتوليدها
 * هناك يُخرج مربّعات فارغة أو حروفاً مفكّكة. توليدها محلياً وإيداعها يغلق الباب.
 *
 * الهوية (من دليل العلامة): مرجاني #E15A30 · حبر #1F1A13 · كريمي #FAF7F0
 * والرمز «المسار الصاعد» بهندسته المعتمدة: خط مستقيم 32,88→88,32 عرض 15،
 * ونقطة انطلاق ومحطة كريميّتان، ومحطة الوصول حلقة حبرية بمركز كريمي.
 *
 * الخطوط: العربية **Dubai** (أقرب المتاح لـIBM Plex Sans Arabic المعتمد)،
 * واللاتينية للاسم اللفظي **Cambria** (بديل IBM Plex Serif في الأصل النقطي).
 */

const SLOGAN = 'بخطوات جريئة نعيد تعريف الميدان';
const AR = "Dubai, 'Segoe UI', Tahoma, Arial, sans-serif";
const SERIF = "Cambria, Georgia, 'Times New Roman', serif";
const SANS = "'Segoe UI', Arial, sans-serif";

// الرمز: مربّع مرجاني + المسار الصاعد. مقاس الرسم 120، يُحجَّم بالمعامل s.
const mark = (x, y, s) => `
  <g transform="translate(${x},${y}) scale(${s / 120})">
    <rect width="120" height="120" rx="24" fill="#E15A30"/>
    <line x1="32" y1="88" x2="88" y2="32" stroke="#1F1A13" stroke-width="15" stroke-linecap="round"/>
    <circle cx="32" cy="88" r="10" fill="#FAF7F0"/>
    <circle cx="60" cy="60" r="8" fill="#FAF7F0"/>
    <circle cx="88" cy="32" r="13" fill="#1F1A13"/>
    <circle cx="88" cy="32" r="7" fill="#FAF7F0"/>
  </g>`;

const og = `<svg width="1200" height="630" viewBox="0 0 1200 630" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="630" fill="#FAF7F0"/>

  <!-- أشكال الهوية: هالة مرجانية أعلى اليمين، وأخرى خضراء أسفل اليسار -->
  <circle cx="1160" cy="-60" r="290" fill="#FBEBE2"/>
  <circle cx="-40" cy="700" r="250" fill="#E4F1EA" opacity="0.5"/>

  <!-- كتلة العلامة: الرمز + الاسم اللفظي، متمركزة أفقياً -->
  ${mark(437, 96, 84)}
  <text x="545" y="163" font-family="${SERIF}" font-size="62" font-weight="700">
    <tspan fill="#1F1A13">Field</tspan><tspan fill="#E15A30" dx="20">Sales</tspan>
  </text>

  <!-- الشعار التسويقي — بطل البطاقة -->
  <text x="600" y="330" text-anchor="middle" font-family="${AR}" font-size="72" font-weight="700" fill="#1F1A13">${SLOGAN}</text>

  <!-- فاصل مرجاني قصير -->
  <rect x="530" y="378" width="140" height="6" rx="3" fill="#E15A30"/>

  <!-- سطر التموضع: بلا ادّعاء اعتماد ضريبي -->
  <text x="600" y="452" text-anchor="middle" font-family="${AR}" font-size="34" fill="#6E6557">نظام إدارة المناديب والتوزيع الميداني — عربيّ أولاً</text>

  <!-- النطاق -->
  <text x="600" y="556" text-anchor="middle" font-family="${SANS}" font-size="40" font-weight="700" fill="#1F1A13">fieldsa.net</text>
</svg>`;

await sharp(Buffer.from(og)).png().toFile('public/og-image.png');
console.log('✅ بطاقة OG (1200×630) في public/og-image.png — أودِعها في المستودع');
