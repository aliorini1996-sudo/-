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

/**
 * قرار المالك: الضغط على «إصدار» قبل ظهور قائمة الفواتير، أو بعد فشل تحميلها،
 * لا يُصدر سنداً — يتوقّف حتى تُحمَّل القائمة ويُسنَد السند إلى فاتورة. كان
 * الإرسال يمرّ حينها بتوزيع صفر فيختار الخادم الفاتورة بالأقدم بدل المستخدم.
 */
test('التحميل الجاري وفشله يوقفان الإصدار في الشاشات الثلاث', () => {
  assert.match(modal, /const invoicesLoading = !!customerId && \(invoicesPending \|\| invoicesFetching\)/,
    'لوحة الإدارة لا تعرف أن الفواتير قيد التحميل');
  assert.match(modal, /if \(invoicesLoading\) \{/, 'لوحة الإدارة تُصدر السند قبل وصول الفواتير');
  assert.match(modal, /disabled=\{mutation\.isPending \|\| invoicesLoading \|\| invoicesFailed\}/,
    'زرّ الإصدار في اللوحة متاح أثناء التحميل أو بعد فشله');

  assert.match(mobile, /const invBusy = !!customerId && \(invQ\.isPending \|\| invQ\.isFetching\)/,
    'لوحة الجوال لا تعرف أن الفواتير قيد التحميل');
  assert.match(mobile, /&& !invBusy && !invQ\.isError && shortfall <= 0\.004/,
    'بوابة الإرسال في الجوال لا تنتظر الفواتير');

  const rep = repApp.slice(repApp.indexOf('function CreateReceipt'));
  const submit = rep.slice(rep.indexOf('const submit'), rep.indexOf('const pickPhotos'));
  assert.match(submit, /if \(invLoading\) \{/, 'تطبيق المندوب يُصدر السند أثناء تحميل الفواتير');
  assert.match(submit, /if \(invFailed\) \{/, 'تطبيق المندوب يُصدر السند بعد فشل تحميل الفواتير');
  // فشلٌ ردّ به الخادم يختلف عن انقطاع الشبكة — الأول يوقف، والثاني مسار الأوف‑لاين
  assert.match(rep, /setInvFailed\(!offline\)/, 'تطبيق المندوب يخلط فشل الخادم بانقطاع الشبكة');
  // قائمةٌ غابت لانقطاعٍ تُعاد لحظة الإصدار — ولا يُرسَل سندٌ حيّ بلا قائمة
  assert.match(submit, /const fresh = await loadOpenInvoices\(\)/, 'لا إعادة جلب للفواتير لحظة الإصدار');
  assert.match(submit, /if \(offlineOnly\) \{ await queueOffline\(\); return; \}/,
    'سندٌ بلا قائمة فواتير يُرسَل حيّاً بدل التقاطه أوف‑لاين');
  assert.match(rep, /disabled=\{loading \|\| invLoading \|\| invFailed\}/, 'زرّ الإصدار متاح أثناء التحميل أو بعد فشله');
});

/** ردّ الإنشاء يحمل روابط السند — منها يُطبع «مقابل الفاتورة رقم …» فور الإصدار */
test('ردّ إنشاء السند وإعادتاه المتطابقتان تحمل روابط الفواتير', () => {
  const post = receipts.slice(receipts.indexOf("router.post('/'"), receipts.indexOf("router.patch('/:id/cancel'"));
  assert.equal((post.match(/include: RECEIPT_LINKS/g) || []).length, 3,
    'أحد ردود الإنشاء (الجديد أو الإعادتان) بلا روابط الفواتير');
  assert.match(receipts, /invoiceItems: \{ select: \{ amount: true, invoice: \{ select: \{ id: true, number: true \} \} \} \}/,
    'روابط الردّ تكشف صفّ الفاتورة كاملاً أو فقدت رقمها');
});

/** طلب المالك: كل فاتورة في شاشة إصدار السند تُظهر تاريخ إصدارها بجانب رقمها */
test('تاريخ الفاتورة يظهر في قائمة التوزيع — والمسار يُرجعه', () => {
  assert.match(openHandler(), /select: \{[^}]*invoiceDate: true/, 'مسار الفواتير المفتوحة لا يُرجع تاريخ الفاتورة');
  const rep = repApp.slice(repApp.indexOf('function CreateReceipt'));
  const list = rep.slice(rep.indexOf('openInv.map(inv =>'), rep.indexOf('openInv.map(inv =>') + 1800);
  assert.match(list, /formatDateShort\(inv\.invoiceDate\)/, 'تطبيق المندوب لا يعرض تاريخ الفاتورة');
  assert.match(modal, /<th>\{tr\('تاريخ الفاتورة'\)\}<\/th>/, 'لوحة الإدارة بلا عمود تاريخ الفاتورة');
  assert.match(modal, /formatDate\(inv\.invoiceDate\)/, 'لوحة الإدارة لا تعرض تاريخ الفاتورة');
  assert.match(mobile, /formatDate\(inv\.invoiceDate\)/, 'لوحة الجوال لا تعرض تاريخ الفاتورة');
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

// ═══ ZATCA المرحلة الثانية (Z5.4، F2) ═══
//
// القاعدة الجديدة فوق التكافؤ نفسه: **فاتورةٌ لم تصر نهائية عند الهيئة لا تُحصَّل**. والمواضع ثلاثة (قائمة الواجهة،
// توزيع الخادم، رابط الدفع الإلكتروني) — فإن حرس موضعان وأفلت ثالثٌ لم يُحرَس شيء: يكفي أن يفتح المستخدم الشاشة
// التي تصدر الرابط. ولذلك نسخةٌ واحدة من الشرط (`ALLOCATION_ALLOWED_WHERE`) تُنثر في الاستعلامين، ومصدرها نفسه
// (`ALLOCATION_BLOCKED_MIRRORS`) يحرس الرابط — لا ثلاث نسخ نصّية تتباعد مع الوقت.

import { ALLOCATION_ALLOWED_WHERE, ALLOCATION_BLOCKED_MIRRORS } from '../compliance/zatca/status';

const paylink = read(path.join(B, 'src', 'services', 'paylink.ts'));

test('الشرط نسخةٌ واحدة تُنثر في الاستعلامين — لا نصّان يتباعدان', () => {
  assert.match(openHandler(), /\.\.\.ALLOCATION_ALLOWED_WHERE/, 'قائمة /invoices/open بلا شرط المرحلة الثانية');
  const server = receipts.slice(receipts.indexOf('const openInvoices = await prisma.invoice.findMany'), receipts.indexOf('const filled ='));
  assert.match(server, /\.\.\.ALLOCATION_ALLOWED_WHERE/, 'توزيع الخادم بلا شرط المرحلة الثانية — يوزّع على ما لا تعرضه الواجهة');
});

test('الشرط يمنع الأربع ويسمح بالمرحلة الأولى (فخّ NULL مذكور صراحةً)', () => {
  assert.deepEqual(
    [...ALLOCATION_BLOCKED_MIRRORS].sort(),
    ['clearance_blocked', 'clearance_pending', 'rejected', 'withdrawn'],
    'تغيّرت قائمة المرايا الممنوعة',
  );
  const or = (ALLOCATION_ALLOWED_WHERE as { OR: { einvoiceStatus: unknown }[] }).OR;
  assert.equal(or.length, 2, 'الشرط ليس بشقّين');
  assert.equal(or[0].einvoiceStatus, null, 'شقّ NULL مفقود — NOT IN وحده يُسقط كلّ صفوف المرحلة الأولى');
  assert.deepEqual(or[1].einvoiceStatus, { notIn: [...ALLOCATION_BLOCKED_MIRRORS] }, 'الشقّ الثاني لا يطابق القائمة');
  // المرحلة الأولى (generated/pending) تمرّ — وإلا توقّف التحصيل عن كل الشركات يوم النشر
  for (const legacy of ['generated', 'pending', 'submitted', 'cleared', 'not_implemented', 'error']) {
    assert.ok(!(ALLOCATION_BLOCKED_MIRRORS as readonly string[]).includes(legacy), `حالة المرحلة الأولى ${legacy} مُنعت`);
  }
});

test('نقد 22: الشرط OR أعلى المستوى لا AND — وإلا دهس نطاق مستخدم الشركة', () => {
  assert.ok(!Object.prototype.hasOwnProperty.call(ALLOCATION_ALLOWED_WHERE, 'AND'), 'مفتاح AND يدهس scopedRecordWhere');
  const open = openHandler();
  const scope = open.indexOf('scopedRecordWhere');
  const cond = open.indexOf('ALLOCATION_ALLOWED_WHERE');
  assert.ok(scope > 0 && cond > scope, 'الشرط قبل نطاق المستخدم أو أحدهما مفقود');
});

test('رابط الدفع يحرس الشرط نفسه من المصدر نفسه', () => {
  assert.match(paylink, /ALLOCATION_BLOCKED_MIRRORS/, 'رابط الدفع يُصدَر على فاتورة لم تعتمدها الهيئة');
  const issue = paylink.slice(paylink.indexOf('export async function issueLink'), paylink.indexOf('const existing = await prisma.customerPaymentLink'));
  assert.match(issue, /einvoiceStatus/, 'حالة الفوترة غير مقروءة في مسار إصدار الرابط');
  assert.match(issue, /einvoiceStatus !== null/, 'فخّ NULL: الشرط لا يذكر NULL صراحةً');
});

test('نقد 13: المتبقّي يُقرأ مقفلاً قبل الكتابة المطلقة (السند ورابط الدفع)', () => {
  const tx = receipts.slice(receipts.indexOf('const remainingById = new Map'), receipts.indexOf('const rcp = await tx.receipt.create'));
  assert.match(tx, /FOR UPDATE/, 'توزيع السند يقرأ المتبقّي بلا قفل ثم يكتب قيمة مطلقة');
  assert.match(tx, /ORDER BY id/, 'بلا ترتيب ثابت للقفل — سندان متزامنان يتشابكان');
  const confirm = paylink.slice(paylink.indexOf('const collected = roundHalfUp'), paylink.indexOf('await postReceiptEntries'));
  assert.match(confirm, /FOR UPDATE/, 'تأكيد الدفع يقرأ المتبقّي بلا قفل');
});

test('نقد 13: تخصيص أوف-لاين تجاوز المتبقّي يُقلَّم للمرحلة الثانية ولا يُرمى 500', () => {
  const tx = receipts.slice(receipts.indexOf('for (const alloc of allocations)'), receipts.indexOf('const rcp = await tx.receipt.create'));
  assert.match(tx, /phase2ById\.get\(alloc\.invoiceId\)/, 'لا تمييز بين المرحلتين — إمّا 500 للجميع أو تغيير سلوك المرحلة الأولى');
  assert.match(tx, /alloc\.amount = clean\(Math\.max\(0, remaining\)\)/, 'لا تقليم — يبقى الرمي 500 فيتوقّف صندوق عمل الهاتف');
  assert.match(tx, /throw new Error\('مبلغ التخصيص أكبر من المتبقي على إحدى الفواتير'\)/, 'سلوك المرحلة الأولى تغيّر');
});
