import sharp from 'sharp';
import { mkdirSync } from 'fs';

// ════════════════════════════════════════════════════════════
//  مولّد مواد Google Play — بهوية FieldSales الجديدة (المسار الصاعد المرجاني)
//  ينتج: الصورة الترويجية 1024×500 + 5 لقطات ترويجية 1080×1920 + أيقونة 512
//  ملاحظة: محرك الرسم (resvg) يضبط العربية تلقائياً RTL. نُبقي direction="rtl"
//  فقط مع النص المتوسّط (anchor=middle)؛ ونتجنّبه مع anchor=end/start.
// ════════════════════════════════════════════════════════════

const out = 'C:/Users/ali_h/OneDrive/سطح المكتب/تطبيق المندوب/متجر-جوجل-بلاي';
mkdirSync(out, { recursive: true });

const C = {
  coral: '#E15A30', coralDark: '#C94E28', coralLight: '#FBEBE2',
  cream: '#FAF7F0', white: '#FFFFFF', ink: '#1F1A13',
  gray: '#6E6557', border: '#E9E1D3', green: '#1E7A52', faint: '#9A8F7E',
};
const F = "'Segoe UI', 'Tahoma', 'Arial', sans-serif";

// نص متوسّط (للعناوين والنصوص المختلطة) — direction=rtl آمن هنا
const mid = (x, y, s, w, fill, t, extra = '') =>
  `<text x="${x}" y="${y}" text-anchor="middle" direction="rtl" font-family="${F}" font-size="${s}" font-weight="${w}" fill="${fill}" ${extra}>${t}</text>`;
// نص محاذٍ يمين (نهايته عند x) — بدون direction
const rt = (x, y, s, w, fill, t) =>
  `<text x="${x}" y="${y}" text-anchor="end" font-family="${F}" font-size="${s}" font-weight="${w}" fill="${fill}">${t}</text>`;
// نص محاذٍ يسار (بدايته عند x) — للأرقام
const lt = (x, y, s, w, fill, t) =>
  `<text x="${x}" y="${y}" text-anchor="start" font-family="${F}" font-size="${s}" font-weight="${w}" fill="${fill}">${t}</text>`;

// رمز «المسار الصاعد» داخل مربع مرجاني — مطابق لدليل الهوية
const icon = (x, y, s, rx = 0.233) => `
  <g transform="translate(${x},${y}) scale(${s / 120})">
    <rect width="120" height="120" rx="${120 * rx}" fill="${C.coral}"/>
    <polyline points="32,88 60,60 90,32" stroke="${C.ink}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <circle cx="32" cy="88" r="8" fill="${C.cream}"/>
    <circle cx="60" cy="60" r="6" fill="${C.cream}"/>
    <circle cx="90" cy="32" r="12" fill="${C.ink}"/>
    <circle cx="90" cy="32" r="5.5" fill="${C.cream}"/>
  </g>`;

// المسار المعكوس (بلا خلفية) للخلفيات الداكنة
const markOnDark = (x, y, s) => `
  <g transform="translate(${x},${y}) scale(${s / 120})">
    <polyline points="32,88 60,60 90,32" stroke="${C.coral}" stroke-width="14" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
    <circle cx="32" cy="88" r="8" fill="${C.cream}"/>
    <circle cx="60" cy="60" r="6" fill="${C.cream}"/>
    <circle cx="90" cy="32" r="12" fill="${C.coral}"/>
    <circle cx="90" cy="32" r="5.5" fill="${C.ink}"/>
  </g>`;

// شريحة (chip) — نص متوسّط
const chip = (x, y, w, t, bg, fg) =>
  `<g transform="translate(${x},${y})"><rect width="${w}" height="50" rx="25" fill="${bg}"/>${mid(w / 2, 33, 26, 600, fg, t)}</g>`;

// ─── الصورة الترويجية (Feature Graphic) 1024×500 ───
const feature = `<svg width="1024" height="500" viewBox="0 0 1024 500" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="glow" cx="0.5" cy="0.35" r="0.8">
      <stop offset="0" stop-color="#2a221a"/>
      <stop offset="1" stop-color="${C.ink}"/>
    </radialGradient>
  </defs>
  <rect width="1024" height="500" fill="url(#glow)"/>
  <polyline points="-40,470 220,360 470,400 720,210 1080,250" stroke="${C.coral}" stroke-width="3" opacity="0.18" fill="none" stroke-linecap="round"/>
  <circle cx="220" cy="360" r="6" fill="${C.coral}" opacity="0.30"/>
  <circle cx="720" cy="210" r="9" fill="${C.coral}" opacity="0.35"/>
  <circle cx="880" cy="110" r="240" fill="${C.coral}" opacity="0.05"/>
  <circle cx="150" cy="430" r="170" fill="${C.coral}" opacity="0.05"/>
  ${icon(437, 56, 150, 0.28)}
  <text x="512" y="300" text-anchor="middle" font-family="${F}" font-size="72" font-weight="800" fill="${C.white}">Field<tspan fill="${C.coral}">Sales</tspan></text>
  ${mid(512, 352, 28, 600, '#D8CFC0', 'منصّة إدارة وتتبّع مبيعات المناديب الميدانيين')}
  ${chip(640, 398, 244, 'فواتير ضريبية ZATCA', C.coral, C.white)}
  <g transform="translate(430,398)"><rect width="190" height="44" rx="22" fill="#2e2620" stroke="${C.coral}" stroke-opacity="0.4"/>${mid(95, 29, 20, 600, '#E8DFD2', 'سندات قبض')}</g>
  <g transform="translate(220,398)"><rect width="190" height="44" rx="22" fill="#2e2620" stroke="${C.coral}" stroke-opacity="0.4"/>${mid(95, 29, 20, 600, '#E8DFD2', 'كشوف حساب')}</g>
</svg>`;

// ════════════ لقطات ترويجية 1080×1920 ════════════
const W = 1080, H = 1920;

const screen = (headline, sub, card) => `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="${C.cream}"/>
  <path d="M0 0 H${W} V760 Q540 850 0 760 Z" fill="${C.coral}"/>
  <polyline points="60,150 180,90 320,120" stroke="#ffffff" stroke-opacity="0.25" stroke-width="4" fill="none" stroke-linecap="round"/>
  ${icon(W - 230, 90, 96, 0.28)}
  <text x="${W - 254}" y="158" text-anchor="end" font-family="${F}" font-size="40" font-weight="800" fill="${C.white}">Field<tspan fill="${C.ink}">Sales</tspan></text>
  ${mid(W / 2, 380, 68, 800, C.white, headline)}
  ${mid(W / 2, 470, 36, 500, '#FCE6DC', sub)}
  <g transform="translate(90,600)">
    <rect width="900" height="1060" rx="44" fill="${C.white}" stroke="${C.border}" stroke-width="2"/>
    ${card}
  </g>
  ${markOnDark(W / 2 - 26, 1772, 52)}
</svg>`;

// صف (label يمين، value يسار) داخل البطاقة عرضها 900
const row = (y, label, value, vColor = C.ink) =>
  `${rt(852, y, 30, 500, C.gray, label)}${lt(48, y, 32, 700, vColor, value)}`;

// (1) الفواتير الضريبية ZATCA
const cardInvoice = `
  ${rt(852, 90, 40, 800, C.ink, 'فاتورة ضريبية')}
  ${chip(48, 60, 210, 'معتمدة · ZATCA', C.coralLight, C.coralDark)}
  <line x1="48" y1="150" x2="852" y2="150" stroke="${C.border}" stroke-width="2"/>
  ${row(225, 'الإجمالي قبل الضريبة', '1,000.00 ﷼')}
  ${row(290, 'ضريبة القيمة المضافة 15%', '150.00 ﷼')}
  <line x1="48" y1="335" x2="852" y2="335" stroke="${C.border}" stroke-width="2"/>
  ${rt(852, 408, 34, 700, C.ink, 'الإجمالي شامل الضريبة')}
  ${lt(48, 410, 40, 800, C.coral, '1,150.00 ﷼')}
  <g transform="translate(330,470)">
    <rect x="-30" y="-30" width="300" height="300" rx="20" fill="${C.cream}"/>
    <g fill="${C.ink}">
      <rect x="0" y="0" width="70" height="70" rx="6"/><rect x="14" y="14" width="42" height="42" fill="${C.cream}"/><rect x="26" y="26" width="18" height="18" fill="${C.ink}"/>
      <rect x="170" y="0" width="70" height="70" rx="6"/><rect x="184" y="14" width="42" height="42" fill="${C.cream}"/><rect x="196" y="26" width="18" height="18" fill="${C.ink}"/>
      <rect x="0" y="170" width="70" height="70" rx="6"/><rect x="14" y="184" width="42" height="42" fill="${C.cream}"/><rect x="26" y="196" width="18" height="18" fill="${C.ink}"/>
      <rect x="100" y="10" width="20" height="20"/><rect x="130" y="40" width="20" height="20"/><rect x="100" y="70" width="20" height="20"/><rect x="160" y="100" width="20" height="20"/>
      <rect x="100" y="130" width="20" height="20"/><rect x="130" y="160" width="20" height="20"/><rect x="100" y="190" width="20" height="20"/><rect x="190" y="160" width="20" height="20"/>
      <rect x="220" y="120" width="20" height="20"/><rect x="190" y="100" width="20" height="20"/><rect x="220" y="200" width="20" height="20"/><rect x="160" y="200" width="20" height="20"/>
      <rect x="40" y="110" width="20" height="20"/><rect x="10" y="120" width="20" height="20"/><rect x="40" y="150" width="20" height="20"/>
    </g>
  </g>
  ${mid(426, 840, 26, 500, C.gray, 'رمز QR متوافق مع هيئة الزكاة والضريبة')}`;

// (2) الطباعة الحرارية 58مم
const cardThermal = `
  ${rt(852, 90, 40, 800, C.ink, 'طباعة حرارية 58مم')}
  ${chip(48, 60, 230, 'بلوتوث · مدمجة', C.coralLight, C.coralDark)}
  <g transform="translate(310,150)">
    <rect width="280" height="780" rx="10" fill="${C.cream}" stroke="${C.border}" stroke-width="2"/>
    <circle cx="140" cy="70" r="34" fill="${C.coral}"/>
    <polyline points="124,86 138,72 158,56" stroke="${C.white}" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    ${mid(140, 140, 24, 700, C.ink, 'شركتك التجارية')}
    ${mid(140, 172, 16, 400, C.gray, 'فاتورة ضريبية مبسطة')}
    <line x1="20" y1="196" x2="260" y2="196" stroke="${C.border}" stroke-width="2" stroke-dasharray="4 4"/>
    ${[230, 268, 306, 344].map((yy, i) => `<rect x="20" y="${yy}" width="${[150, 180, 130, 160][i]}" height="12" rx="6" fill="#D9D0C2"/><rect x="200" y="${yy}" width="40" height="12" rx="6" fill="#D9D0C2"/>`).join('')}
    <line x1="20" y1="392" x2="260" y2="392" stroke="${C.border}" stroke-width="2" stroke-dasharray="4 4"/>
    ${rt(258, 436, 20, 700, C.ink, 'الإجمالي')}
    ${lt(22, 436, 22, 800, C.coral, '1,150.00')}
    <rect x="95" y="470" width="90" height="90" rx="8" fill="${C.ink}"/>
    <rect x="108" y="483" width="64" height="64" fill="${C.cream}"/>
    <rect x="120" y="495" width="40" height="40" fill="${C.ink}"/>
    <line x1="20" y1="600" x2="260" y2="600" stroke="${C.border}" stroke-width="2" stroke-dasharray="4 4"/>
    ${mid(140, 640, 16, 400, C.gray, 'شكراً لتعاملكم معنا')}
  </g>
  ${mid(426, 990, 26, 500, C.gray, 'اطبع الفاتورة فوراً من الميدان')}`;

// (3) سندات القبض والتحصيل
const cardReceipt = `
  ${rt(852, 90, 40, 800, C.ink, 'سند قبض')}
  ${chip(48, 60, 150, 'نشط', '#E3F2E9', C.green)}
  <line x1="48" y1="150" x2="852" y2="150" stroke="${C.border}" stroke-width="2"/>
  ${row(225, 'العميل', 'مؤسسة الأمل', C.ink)}
  ${row(290, 'المبلغ المستلم', '500.00 ﷼', C.green)}
  <line x1="48" y1="335" x2="852" y2="335" stroke="${C.border}" stroke-width="2"/>
  ${rt(852, 412, 30, 500, C.gray, 'طريقة الدفع')}
  ${chip(560, 388, 130, 'نقدي', '#E3F2E9', C.green)}
  ${chip(420, 388, 120, 'تحويل', C.coralLight, C.coralDark)}
  ${chip(290, 388, 110, 'شبكة', '#EDE7F6', '#5E35B1')}
  ${mid(426, 560, 30, 700, C.ink, 'يُربط تلقائياً بفواتير العميل')}
  <g transform="translate(306,640)">
    <rect width="240" height="170" rx="24" fill="${C.coralLight}"/>
    <rect x="30" y="50" width="180" height="100" rx="16" fill="${C.coral}"/>
    <circle cx="180" cy="100" r="18" fill="${C.cream}"/>
  </g>
  ${mid(426, 900, 26, 500, C.gray, 'تحصيل فوري وتحديث الرصيد لحظياً')}`;

// (4) كشوف حساب العملاء
const cardStatement = `
  ${rt(852, 90, 40, 800, C.ink, 'كشف حساب العميل')}
  ${chip(48, 60, 230, 'الرصيد: 650.00 ﷼', C.coralLight, C.coralDark)}
  <line x1="48" y1="150" x2="852" y2="150" stroke="${C.border}" stroke-width="2"/>
  ${rt(852, 205, 26, 700, C.gray, 'البيان')}
  ${mid(430, 205, 26, 700, C.gray, 'مدين')}
  ${mid(180, 205, 26, 700, C.gray, 'دائن')}
  ${[
    ['فاتورة #1024', '1,150', '—', 270, true],
    ['سند قبض #530', '—', '500', 332, false],
    ['فاتورة #1031', '850', '—', 394, true],
    ['مرتجع #88', '—', '230', 456, false],
  ].map(([b, d, c, yy, alt]) => `
    <rect x="40" y="${yy - 36}" width="820" height="52" rx="12" fill="${alt ? '#FBF8F2' : C.white}"/>
    ${rt(852, yy, 28, 400, C.ink, b)}${mid(430, yy, 28, 600, C.coral, d)}${mid(180, yy, 28, 600, C.green, c)}`).join('')}
  <line x1="48" y1="500" x2="852" y2="500" stroke="${C.border}" stroke-width="2"/>
  ${rt(852, 568, 34, 800, C.ink, 'الرصيد الحالي')}
  ${lt(48, 570, 38, 800, C.coral, '650.00 ﷼')}
  ${chip(300, 650, 460, 'تصدير Excel · مشاركة PDF', C.cream, C.gray)}
  ${mid(426, 820, 26, 500, C.gray, 'كل حركات العميل في كشف واحد')}`;

// (5) لوحة الأداء والإحصائيات
const cardDash = `
  ${rt(852, 90, 40, 800, C.ink, 'لوحة الأداء')}
  ${chip(48, 60, 170, 'اليوم', C.coralLight, C.coralDark)}
  <g transform="translate(40,140)"><rect width="390" height="170" rx="22" fill="${C.coralLight}"/>${rt(350, 64, 28, 600, C.coralDark, 'صافي المبيعات')}${lt(40, 130, 44, 800, C.coral, '12,480 ﷼')}</g>
  <g transform="translate(470,140)"><rect width="390" height="170" rx="22" fill="#E3F2E9"/>${rt(350, 64, 28, 600, C.green, 'التحصيل')}${lt(40, 130, 44, 800, C.green, '8,900 ﷼')}</g>
  ${rt(852, 400, 30, 700, C.ink, 'المبيعات الأسبوعية')}
  ${[120, 200, 150, 260, 190, 300, 230].map((hh, i) => {
    const bx = 90 + i * 108;
    return `<rect x="${bx}" y="${720 - hh}" width="66" height="${hh}" rx="10" fill="${i === 5 ? C.coral : C.coralLight}"/>`;
  }).join('')}
  <line x1="48" y1="722" x2="852" y2="722" stroke="${C.border}" stroke-width="2"/>
  <g transform="translate(40,778)"><rect width="820" height="120" rx="22" fill="${C.cream}"/>
    <circle cx="760" cy="60" r="34" fill="${C.coral}"/><text x="760" y="72" text-anchor="middle" font-family="${F}" font-size="30" font-weight="800" fill="${C.white}">1</text>
    ${rt(700, 52, 30, 700, C.ink, 'أفضل مندوب: خالد')}
    ${rt(700, 92, 24, 400, C.gray, '42 فاتورة · 5,200 ﷼')}
  </g>
  ${mid(426, 990, 26, 500, C.gray, 'تابع أداء فريقك لحظة بلحظة')}`;

const screens = [
  ['screenshot-1-invoice.png', screen('فواتير ضريبية فورية', 'متوافقة مع هيئة الزكاة ورمز QR', cardInvoice)],
  ['screenshot-2-thermal.png', screen('طباعة حرارية مباشرة', 'طابعة بلوتوث أو مدمجة بعرض 58مم', cardThermal)],
  ['screenshot-3-receipt.png', screen('سندات القبض والتحصيل', 'نقدي · تحويل · شبكة · شيكات', cardReceipt)],
  ['screenshot-4-statement.png', screen('كشوف حساب لحظية', 'أرصدة وحركات كاملة لكل عميل', cardStatement)],
  ['screenshot-5-dashboard.png', screen('لوحة أداء ذكية', 'مبيعاتك وتحصيلاتك في الوقت الفعلي', cardDash)],
];

// أيقونة المتجر 512×512
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">${icon(0, 0, 512, 0.233)}</svg>`;

// ─── التوليد ───
await sharp(Buffer.from(feature)).png().toFile(out + '/feature-graphic-1024x500.png');
for (const [name, svg] of screens) {
  await sharp(Buffer.from(svg)).png().toFile(out + '/' + name);
}
await sharp(Buffer.from(appIcon)).png().toFile(out + '/app-icon-512.png');

console.log('✅ تم إنشاء مواد Google Play بالهوية الجديدة في:\n   ' + out);
console.log('   • feature-graphic-1024x500.png');
console.log('   • screenshot-1..5 (1080×1920)');
console.log('   • app-icon-512.png');
