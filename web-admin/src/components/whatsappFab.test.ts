import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import WhatsAppFab, { refFromPath } from './WhatsAppFab';

/**
 * قاعدة الإخفاء منسوخة من WhatsAppFab.tsx عمداً — التعبير غير مُصدَّر من المكوّن.
 * النسخ مقبول هنا لأن اختبارَي الانحراف في آخر الملف يمنعانه: يقرآن المصدر وApp.tsx
 * ويؤكّدان تطابق التعبيرات حرفياً، فأي تعديل هناك بلا تعديل هنا يُفشل الاختبار بدل
 * أن يمرّ صامتاً. وسلوك المكوّن نفسه يُختبر برسمه فعلاً (renderToStaticMarkup).
 */
const HIDDEN_ON = /^\/(app|platform|owner|login|verify-email|rep|m|q-fs7k2m|hx|c|pay|e|ax)(\/|$)/;
const shows = (p: string) => !HIDDEN_ON.test(p);

/** كل المسارات التسويقية المسجَّلة في App.tsx — الزرّ إلزامي على كلّها */
const MARKETING = [
  '/', '/about', '/contact', '/pricing', '/privacy', '/terms', '/service-agreement',
  '/blog', '/blog/field-sales-software-sa', '/calculator', '/invoice-generator',
  '/free', '/free/commission', '/free/van', '/free/reps', '/free/aging',
  '/signup', '/subscribe-request',
  '/قطاعات', '/قطاعات/مواد-غذائية', '/نماذج', '/نماذج/كشف-حساب-عميل',
  '/en', '/en/about', '/en/blog', '/en/blog/field-sales-software-sa', '/en/pricing',
  '/en/calculator', '/en/invoice-generator', '/en/contact', '/en/privacy', '/en/terms',
  '/en/service-agreement', '/en/subscribe-request',
  '/fr', '/fr/about', '/fr/blog', '/fr/pricing', '/fr/calculator', '/fr/contact',
  '/fr/invoice-generator', '/fr/privacy', '/fr/terms', '/fr/service-agreement',
];

/**
 * صفحات عامة لعملائنا نحن خارج القمع التسويقي — الزرّ إلزامي عليها أيضاً.
 * `/payment/success` عودة ميسر بعد دفع اشتراك الشركة أو تجديد بوت واتساب، وتطلب من
 * العميل «تواصل معنا» عند تعذّر التحقق أو انتهاء الرابط ولا وسيلة تواصل فيها غير الزرّ.
 */
const OUR_CUSTOMERS = ['/payment/success', '/payment/success/'];

/**
 * مسارات التطبيق والبوابات الخاصة وصفحات عملاء عملائنا — الزرّ ممنوع عليها
 * (الرقم رقم مبيعاتنا لا دعم الشركة المشتركة، والإحصاءات للموقع العام وحده).
 */
const APP = [
  '/app', '/app/customers', '/app/invoices', '/app/settings',
  '/platform', '/platform/leads', '/owner', '/login', '/verify-email',
  '/rep', '/rep/', '/ax', '/ax/', '/q-fs7k2m',
  '/hx', '/hx/', '/c/tenant1/rep1', '/c/tenant1/rep1/', '/pay/tok123', '/pay/tok123/',
];

test('الزرّ يظهر على كل صفحة تسويقية بلا استثناء', () => {
  const missing = MARKETING.filter((p) => !shows(p));
  assert.deepEqual(missing, [], `صفحات تسويقية بلا زرّ: ${missing.join(', ')}`);
});

test('الزرّ يظهر في صفحة عودة الدفع لعملائنا (/payment/success)', () => {
  const missing = OUR_CUSTOMERS.filter((p) => !shows(p));
  assert.deepEqual(missing, [], `صفحات عملائنا بلا زرّ: ${missing.join(', ')}`);
});

test('الزرّ لا يظهر في أي مسار من مسارات التطبيق', () => {
  const leaked = APP.filter((p) => shows(p));
  assert.deepEqual(leaked, [], `تسرّب الزرّ إلى التطبيق: ${leaked.join(', ')}`);
});

test('حدّ الكلمة يمنع قاعدة /rep من ابتلاع مسار تسويقيّ يبدأ بحروفها', () => {
  assert.equal(shows('/rep'), false);
  assert.equal(shows('/reports'), true); // ليس مسار تطبيق على الجذر
});

test('البادئات المتشابهة لا تُخطئ', () => {
  assert.equal(shows('/privacy'), true);
  assert.equal(shows('/pricing'), true);  // ليست /platform
  assert.equal(shows('/about'), true);    // ليست /app
  assert.equal(shows('/apps-guide'), true); // /app يتبعها حرف لا فاصل
  // `c` حرف واحد: بلا حدّ النهاية لابتلع التواصل والحاسبة
  assert.equal(shows('/contact'), true);
  assert.equal(shows('/calculator'), true);
  assert.equal(shows('/en/contact'), true);
  assert.equal(shows('/payments-guide'), true); // ليست /pay
  assert.equal(shows('/payment/success'), true); // `pay` بحدّ نهاية لا يبتلع `/payment`
  assert.equal(shows('/hookb'), true);          // ليست /hx
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

/**
 * قاعدة واحدة لا قاعدتان: ما يستثنيه VisitTracker من الإحصاءات (ليس موقعنا العام)
 * يُخفى فيه الزرّ أيضاً — وإلا أنشأ الزرّ معرّف زائر وسجّل نقرةً حيث لا نسجّل زيارة.
 */
test('قاعدة الإخفاء تطابق استثناءات VisitTracker في App.tsx حرفياً', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  const tracker = app.match(/function VisitTracker\(\)[\s\S]*?\.test\(pathname\)\) return;/);
  assert.ok(tracker, 'تعذّر العثور على قاعدة VisitTracker');
  const re = tracker![0].match(/(\/\^\\\/\([^)]*\)\(\\\/\|\$\)\/)/);
  assert.ok(re, 'تعذّر استخراج تعبير VisitTracker');
  assert.equal(re![1], String(HIDDEN_ON), 'الزرّ العائم وVisitTracker يستثنيان مسارات مختلفة — وحّدهما');
});

/* ─── رسم المكوّن فعلاً ────────────────────────────────────────────────────
 * الخلل الأصلي لم يكن في النقر بل في الرسم: `waHref` تستدعي `anonId()` فتكتب
 * `fs_anon` في متصفّح زبون الشركة المشتركة بمجرّد فتح منيو المندوب أو صفحة الدفع. */

function renderAt(path: string): { html: string; store: Map<string, string> } {
  const store = new Map<string, string>();
  const g = globalThis as unknown as Record<string, unknown>;
  const values: Record<string, unknown> = {
    window: {},
    navigator: {},
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    },
  };
  const saved = Object.keys(values).map((k) => [k, Object.getOwnPropertyDescriptor(g, k)] as const);
  for (const k of Object.keys(values)) Object.defineProperty(g, k, { value: values[k], configurable: true, writable: true });
  try {
    const html = renderToStaticMarkup(createElement(StaticRouter, { location: path }, createElement(WhatsAppFab)));
    return { html, store };
  } finally {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  }
}

test('الرسم: لا زرّ ولا fs_anon في البوابات الخاصة وصفحات عملاء عملائنا', () => {
  for (const p of ['/hx', '/c/tenant1/rep1', '/pay/tok123', '/app', '/ax']) {
    const { html, store } = renderAt(p);
    assert.equal(html, '', `الزرّ ظهر على ${p}`);
    assert.equal(store.has('fs_anon'), false, `أُنشئ fs_anon على ${p}`);
  }
});

test('الرسم: الزرّ يظهر على الصفحة التسويقية (ضابط للاختبار السابق)', () => {
  const { html, store } = renderAt('/pricing');
  assert.match(html, /class="wa-fab"/);
  assert.match(html, /ref=pricing/);
  // بلا هذا الضابط قد يمرّ الاختبار السابق لأن البيئة نفسها تمنع الكتابة لا لأن الزرّ مخفيّ
  assert.equal(store.has('fs_anon'), true);
});

test('الرسم: الزرّ يظهر في صفحة عودة الدفع لعملائنا، ومرجعه من المسار وحده', () => {
  // الاستعلام (`?id=` من ميسر) لا يصل إلى StaticRouter كمسار، والمرجع يُشتقّ من pathname فقط
  const { html } = renderAt('/payment/success?id=pay_abc123&status=paid');
  assert.match(html, /class="wa-fab"/);
  assert.match(html, /ref=payment-success/);
  assert.doesNotMatch(html, /pay_abc123/);
});
