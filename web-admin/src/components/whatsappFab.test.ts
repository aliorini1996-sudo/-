import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refFromPath } from './WhatsAppFab';

/**
 * قاعدة الإخفاء منسوخة من WhatsAppFab.tsx عمداً — استيراد المكوّن يجرّ React
 * وDOM إلى بيئة node. النسخ مقبول هنا لأن الاختبار الأخير يمنع الانحراف:
 * يقرأ المصدر ويؤكّد تطابق التعبيرين حرفياً، فأي تعديل هناك بلا تعديل هنا
 * يُفشل الاختبار بدل أن يمرّ صامتاً.
 */
const HIDDEN_ON = /^\/(app|app-r|pos|pos-login|kds|platform|owner|login|verify-email|rep)(\/|$)/;
const shows = (p: string) => !HIDDEN_ON.test(p);

/** كل المسارات التسويقية المسجَّلة في App.tsx — الزرّ إلزامي على كلّها */
const MARKETING = [
  '/', '/about', '/contact', '/pricing', '/privacy', '/terms', '/service-agreement',
  '/blog', '/blog/field-sales-software-sa', '/calculator', '/invoice-generator',
  '/free', '/free/commission', '/free/van', '/free/reps', '/free/aging',
  '/restaurant', '/signup', '/subscribe-request',
  '/قطاعات', '/قطاعات/مواد-غذائية', '/نماذج', '/نماذج/كشف-حساب-عميل',
  '/en', '/en/about', '/en/blog', '/en/blog/field-sales-software-sa', '/en/pricing',
  '/en/calculator', '/en/invoice-generator', '/en/contact', '/en/privacy', '/en/terms',
  '/en/service-agreement', '/en/subscribe-request',
  '/fr', '/fr/about', '/fr/blog', '/fr/pricing', '/fr/calculator', '/fr/contact',
  '/fr/invoice-generator', '/fr/privacy', '/fr/terms', '/fr/service-agreement',
];

/** مسارات التطبيق — الزرّ ممنوع عليها (الرقم رقم مبيعاتنا لا دعم الشركة المشتركة) */
const APP = [
  '/app', '/app/customers', '/app/invoices', '/app/settings',
  '/app-r', '/app-r/menu', '/pos', '/pos/', '/pos-login', '/kds',
  '/platform', '/platform/leads', '/owner', '/login', '/verify-email',
  '/rep', '/rep/',
];

test('الزرّ يظهر على كل صفحة تسويقية بلا استثناء', () => {
  const missing = MARKETING.filter((p) => !shows(p));
  assert.deepEqual(missing, [], `صفحات تسويقية بلا زرّ: ${missing.join(', ')}`);
});

test('الزرّ لا يظهر في أي مسار من مسارات التطبيق', () => {
  const leaked = APP.filter((p) => shows(p));
  assert.deepEqual(leaked, [], `تسرّب الزرّ إلى التطبيق: ${leaked.join(', ')}`);
});

test('حدّ الكلمة يحمي /restaurant من قاعدة /rep', () => {
  // بلا (\/|$) يبتلع `rep` مسارَ `/restaurant` فتفقد صفحة هبوط كاملة زرّها بصمت
  assert.equal(shows('/restaurant'), true);
  assert.equal(shows('/rep'), false);
  assert.equal(shows('/reports'), true); // ليس مسار تطبيق على الجذر
});

test('البادئات المتشابهة لا تُخطئ', () => {
  assert.equal(shows('/privacy'), true);  // ليست /pos
  assert.equal(shows('/pricing'), true);  // ليست /platform
  assert.equal(shows('/about'), true);    // ليست /app
  assert.equal(shows('/apps-guide'), true); // /app يتبعها حرف لا فاصل
});

test('الاستعلام والشرطة الختامية لا يكسران القاعدة', () => {
  assert.equal(shows('/pricing/'), true);
  assert.equal(shows('/blog/x/'), true);
  assert.equal(shows('/app/'), false);
});

test('refFromPath يشتقّ مرجعاً مميّزاً لكل صفحة', () => {
  assert.equal(refFromPath('/'), 'home');
  assert.equal(refFromPath('/pricing/'), 'pricing');
  assert.equal(refFromPath('/blog/field-sales-software-sa/'), 'blog-field-sales-software-sa');
  assert.equal(refFromPath('/free/commission'), 'free-commission');
  // مرجعان مختلفان لصفحتين مختلفتين — وإلا انهار الإسناد لصفحة واحدة
  assert.notEqual(refFromPath('/pricing'), refFromPath('/about'));
});

test('المسار العربي المُرمَّز — كما يصل من location.pathname فعلاً', () => {
  // هذا هو المدخل الحقيقي: المتصفّح يرمّز المسار قبل أن يقرأه الكود.
  // اختباري الأول مرّر عربيةً مفكوكة ففاته أن ثلاث صفحات قطاعات كانت
  // تتقاسم مرجعاً واحداً، وينهار إسنادها كلّه إلى دلو واحد.
  const enc = (p: string) => encodeURI(p);
  assert.equal(refFromPath(enc('/قطاعات/مواد-غذائية')), 'قطاعات-مواد-غذائية');
  assert.equal(refFromPath(enc('/نماذج/كشف-حساب-عميل')), 'نماذج-كشف-حساب-عميل');
});

test('صفحات عربية مختلفة ⇒ مراجع مختلفة (لا انهيار للإسناد)', () => {
  const pages = ['/قطاعات/مواد-غذائية', '/قطاعات/مشروبات', '/قطاعات/مستحضرات-تجميل',
                 '/نماذج/كشف-حساب-عميل', '/نماذج/جرد-مخزون-السيارة'];
  const refs = pages.map((p) => refFromPath(encodeURI(p)));
  assert.equal(new Set(refs).size, pages.length, `مراجع متطابقة: ${refs.join(' | ')}`);
  // ولا يبقى أثر ترميز في المرجع المخزَّن
  assert.equal(refs.some((r) => r.includes('%')), false);
});

test('ترميز تالف لا يُسقط الدالّة', () => {
  assert.equal(typeof refFromPath('/%E0%A4%A'), 'string');
  assert.equal(refFromPath('/'), 'home');
  assert.equal(refFromPath(''), 'home');
});

test('قاعدة الإخفاء هنا تطابق المصدر حرفياً', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./WhatsAppFab.tsx', import.meta.url), 'utf8');
  const m = src.match(/const HIDDEN_ON = (\/\^[^\n]+\/);/);
  assert.ok(m, 'تعذّر العثور على HIDDEN_ON في المصدر');
  assert.equal(m![1], String(HIDDEN_ON), 'القاعدة في الاختبار انحرفت عن المصدر — حدّثها');
});
