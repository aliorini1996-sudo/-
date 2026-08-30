import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * تكافؤ إلزام توزيع سند القبض بين تطبيق المندوب ولوحة الإدارة.
 *
 * الخلل الذي تحرسه هذه الملفّات: الإلزام في الواجهة يُقاس على قائمة الفواتير
 * التي تراها، والخادم يوزّع على قائمةٍ أخرى — كلّ فواتير العميل. وكان
 * `GET /invoices` يفرض على المندوب `salesRepId = معرّفه`، فإن كانت فواتير
 * العميل صادرةً عن مندوبٍ آخر وصلت القائمة فارغة، فسقط الإلزام في التطبيق
 * وحده وبقي قائماً في اللوحة.
 *
 * القاعدة المحروسة: **الواجهتان تسألان الخادم السؤال الذي يجيب عنه الخادم
 * نفسه عند الإنشاء** — نفس العميل، نفس شرط الانفتاح، نفس الترتيب.
 */

const B = process.cwd();
const W = path.join(B, '..', 'web-admin', 'src');
const read = (p: string) => fs.readFileSync(p, 'utf8');

const invoices = read(path.join(B, 'src', 'routes', 'invoices.ts'));
const receipts = read(path.join(B, 'src', 'routes', 'receipts.ts'));
const repApp = read(path.join(W, 'rep', 'RepApp.tsx'));
const modal = read(path.join(W, 'components', 'forms', 'ReceiptModal.tsx'));

/** جسم معالِج `/open` وحده */
function openHandler(): string {
  const i = invoices.indexOf("router.get('/open'");
  assert.ok(i > 0, "مسار GET /invoices/open مفقود");
  return invoices.slice(i, invoices.indexOf('\nrouter.', i));
}

test('مسار الفواتير المفتوحة معرَّف قبل /:id وإلا التقطه كمعرّف', () => {
  const open = invoices.indexOf("router.get('/open'");
  const byId = invoices.indexOf("router.get('/:id'");
  assert.ok(open > 0 && byId > 0, 'أحد المسارين مفقود');
  assert.ok(open < byId, "'/open' معرَّف بعد '/:id' فسيُقرأ كفاتورة اسمها open");
});

test('لا يُقيَّد بمُصدر الفاتورة — وإلا عاد الخلل نفسه', () => {
  const h = openHandler();
  assert.doesNotMatch(h, /isSalesRep/, 'المسار يقيّد المندوب بفواتيره فيسقط الإلزام');
  assert.doesNotMatch(h, /salesRepId/, 'المسار يقيّد بمندوب — قائمة الإلزام تضيق عن قائمة التوزيع');
});

test('محروس بحارس إنشاء السند نفسه — لا يقرأ مندوبٌ فواتير عميلٍ ليس له', () => {
  const h = openHandler();
  assert.match(h, /canAccessCustomer\(req, tid, customerId\)/, 'بلا حارس وصولٍ للعميل');
  assert.match(h, /res\.status\(403\)/, 'لا يردّ 403 على عميل خارج نطاق المندوب');
  assert.match(h, /scopedRecordWhere\(req, SHAPE_INVOICE_RECEIPT\)/, 'نطاق مستخدم الشركة غير مطبَّق');
  assert.match(h, /tenantId: tid/, 'بلا قيد شركة');
});

/**
 * جوهر التكافؤ: الشروط الأربعة التي يختار بها الخادمُ فواتيرَ التوزيع عند
 * الإنشاء يجب أن تكون هي نفسها التي يعرضها هذا المسار — وإلّا حرست الواجهةُ
 * مجموعةً ووزّع الخادم على أخرى.
 */
test('شرط الانفتاح والترتيب مطابقان لما يفعله الخادم عند إنشاء السند', () => {
  const h = openHandler();
  const i = receipts.indexOf('const openInvoices = await prisma.invoice.findMany');
  assert.ok(i > 0, 'تعذّر إيجاد استعلام التوزيع في مسار السندات');
  const server = receipts.slice(i, i + 420);

  for (const cond of [/status: 'CONFIRMED'/, /type: 'CREDIT'/, /remainingAmt: \{ gt: 0\.004 \}/]) {
    assert.match(server, cond, `تغيّر شرط الخادم: ${cond}`);
    assert.match(h, cond, `شرط المسار يخالف الخادم: ${cond}`);
  }
  assert.match(server, /orderBy: \{ invoiceDate: 'asc' \}/, 'تغيّر ترتيب FIFO في الخادم');
  assert.match(h, /orderBy: \{ invoiceDate: 'asc' \}/,
    "الترتيب ليس بالأقدم — فزرّ «التوزيع على الأقدم» يوزّع على غير ما يوزّع عليه الخادم");
});

/**
 * ثلاث شاشات تُصدر سند قبض لا اثنتان: لوحة الإدارة، وتطبيق المندوب، ولوحة
 * الإدارة على الجوال (/m). وإلزامٌ يسري على شاشتين من ثلاث ليس إلزاماً — يكفي
 * أن يفتح المستخدم الشاشة الثالثة ليتجاوزه.
 */
const mobile = read(path.join(W, 'm', 'MReceiptCreate.tsx'));

test('الشاشات الثلاث تسأل المسار الموحّد لا القوائم العامة', () => {
  const rep = repApp.slice(repApp.indexOf('function CreateReceipt'));
  assert.match(rep, /'\/invoices\/open'/, 'تطبيق المندوب ما زال يقرأ القائمة العامة المقيَّدة بمندوبها');
  assert.doesNotMatch(
    rep.slice(0, rep.indexOf('const submit')),
    /repApi\.get\('\/invoices',/,
    'بقي نداء القائمة العامة في مسار التوزيع',
  );
  assert.match(modal, /invoiceApi\.open\(/, 'لوحة الإدارة ما زالت تقرأ القائمة العامة');
  assert.match(mobile, /invoiceApi\.open\(/, 'لوحة الجوال ما زالت تقرأ قائمة مرتَّبة بالأحدث');
  assert.doesNotMatch(mobile, /customerApi\.invoices\(/, 'بقي نداء فواتير العميل المرتَّب بالأحدث');
});

/** الإلزام نفسه في الشاشات الثلاث */
test('حارس نقص التوزيع قائم في الشاشات الثلاث', () => {
  for (const [name, src] of [
    ['تطبيق المندوب', repApp], ['لوحة الإدارة', modal], ['لوحة الجوال', mobile],
  ] as const) {
    assert.match(src, /shortfall > 0\.004/, `${name}: لا حارس على نقص التوزيع`);
  }
  for (const [name, src] of [['تطبيق المندوب', repApp], ['لوحة الإدارة', modal]] as const) {
    assert.match(
      src, /Math\.min\(Number\(amount\) \|\| 0, outstanding\)/,
      `${name}: سقف التوزيع ليس الأصغر بين المبلغ والمديونية`,
    );
  }
  assert.match(mobile, /Math\.min\(amt, outstanding\)/, 'لوحة الجوال: سقف التوزيع مختلف');
  assert.match(mobile, /shortfall <= 0\.004/, 'لوحة الجوال: بوابة الإرسال لا تشترط اكتمال التوزيع');
});

/**
 * فشل جلب القائمة ليس «لا مديونية». كانت اللوحة تُخفي واجهة التوزيع بصمت
 * فيمرّ السند بتوزيع صفر ويقرّر الخادم بدل المستخدم وهو لا يدري.
 */
test('فشل جلب الفواتير يمنع الإصدار ولا يُسقط الإلزام بصمت', () => {
  assert.match(modal, /invoicesFailed/, 'لوحة الإدارة لا تميّز فشل الجلب');
  assert.match(modal, /if \(invoicesFailed\)/, 'فشل الجلب لا يمنع الإرسال في اللوحة');
  assert.match(mobile, /!invQ\.isError/, 'لوحة الجوال تُصدر السند رغم فشل جلب الفواتير');
  assert.match(repApp, /invLoading/, 'التطبيق ما زال يخلط التحميل بالفشل');
});

/** تخصيصٌ فوق مبلغ السند يجعل النقص سالباً فتمرّ البوابة كاذبةً */
test('التوزيع الزائد ممنوع صراحةً لا بالنقص السالب', () => {
  assert.match(modal, /totalAllocated > Number\(amount\) \+ 0\.004/, 'اللوحة تقبل توزيعاً يفوق السند');
  assert.match(repApp, /allocated > Number\(amount\) \+ 0\.004/, 'التطبيق يقبل توزيعاً يفوق السند');
  assert.match(mobile, /overAllocated/, 'لوحة الجوال بلا حارس توزيع زائد');
});

/** المُدخَل يُقصّ عند متبقّي الفاتورة برمجياً — سمة max لا تمنع الكتابة */
test('تخصيص الفاتورة لا يتجاوز متبقّيها في أيّ شاشة', () => {
  for (const [name, src] of [['تطبيق المندوب', repApp], ['لوحة الإدارة', modal]] as const) {
    assert.match(
      src, /Math\.min\(Number\(e\.target\.value\) \|\| 0, Number\(inv\.remainingAmt\) \|\| 0\)/,
      `${name}: التخصيص غير مقصوص عند متبقّي الفاتورة`,
    );
  }
});

/** الخادم يبقى الضمانة الأخيرة مهما قالت الواجهة */
test('الخادم يُكمل أي توزيع ناقص بالأقدم — الواجهة تُلزم والخادم يضمن', () => {
  assert.match(receipts, /fillAllocationsFifo\(/, 'أُزيلت تكملة التوزيع من الخادم');
});

/**
 * ═══ حرّاس التقسيط ═══
 *
 * «تقسيط» جدولُ سدادٍ فوق فاتورة آجلة، لا قيمةٌ رابعة في `Invoice.type`.
 * والسبب ليس ذوقياً: `type` مفتاح تفريع القيود المحاسبية **وأهليّة التوزيع**.
 * قيمةٌ رابعة فيه تُخرج كل فاتورة تقسيط من الاستعلامات الثلاثة أدناه، فيدفع
 * العميل ولا يجد المندوب فاتورةً يوزّع عليها — ويُرفض سنده في وجهه بالميدان.
 * هذه الحرّاس تُسقط البناء إن حاول أحدٌ ذلك لاحقاً.
 */

test('نوع الفاتورة يبقى ثلاث قيم — التقسيط ليس نوعاً رابعاً', () => {
  assert.match(
    invoices, /type: z\.enum\(\['CASH', 'CREDIT', 'RETURN'\]\)/,
    'وُسّع اتحاد نوع الفاتورة — يُخرج التقسيط من التوزيع الإلزامي ومن فحص الحد الائتماني',
  );
});

test('استعلامات التوزيع الثلاثة لا تفلتر على خطة السداد', () => {
  const open = invoices.slice(invoices.indexOf("router.get('/open'"), invoices.indexOf("router.use(requireAdminPermission('canManageInvoices')"));
  const alloc = receipts.slice(receipts.indexOf('const openInvoices = await prisma.invoice.findMany'));
  for (const [name, src] of [['/invoices/open', open], ['توزيع السند', alloc.slice(0, 1200)]] as const) {
    assert.doesNotMatch(src, /paymentPlan/, `${name}: يفلتر على خطة السداد فيُخرج فواتير التقسيط`);
    assert.doesNotMatch(src, /INSTALLMENT/, `${name}: يذكر التقسيط — التقسيط لا يغيّر أهليّة التوزيع`);
  }
});

test('التقسيط بيع آجل حصراً — لا يُجمع مع نقدي ولا مرتجع', () => {
  assert.match(invoices, /wantsPlan && d\.type !== 'CREDIT'/, 'لا حارس يمنع التقسيط على النقدي أو المرتجع');
});

test('البيع بالتقسيط له إذن مستقلّ فوق الآجل', () => {
  assert.match(invoices, /canSellOnInstallment/, 'لا حارس صلاحية على البيع بالتقسيط');
  const schema = fs.readFileSync(path.join(B, 'prisma', 'schema.prisma'), 'utf8');
  assert.match(
    schema, /canSellOnInstallment Boolean\s+@default\(false\)/,
    'صلاحية التقسيط ليست مغلقة افتراضياً — تُفتح لكل مندوب قائم عند النشر',
  );
});

test('جدول الأقساط يُبنى على الخادم ويُحرَس مجموعه قبل الكتابة', () => {
  assert.match(invoices, /buildInstallments\(total,/, 'الجدول لا يُبنى من إجمالي الخادم');
  assert.match(invoices, /تعذر تقسيم إجمالي الفاتورة على الأقساط بالضبط/, 'بلا حارس على مساواة المجموع للإجمالي');
});
