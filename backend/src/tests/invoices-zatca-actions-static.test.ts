// ZATCA المرحلة الثانية (Z5.4) — حرّاس ثابتة على مسارَي السحب وإعادة الإصدار والقراءة بالمرجع وعلى كتالوج الأخطاء.
//
// هذه أخطاءٌ لا تكشفها اختبارات السلوك لأنّها تُسكِت الميزة بدل أن تُعطبها: مسارٌ يُعرَّف بعد `/:id` فيُقرأ كمعرّف
// فاتورة، وإجراءٌ إداريّ بلا حارس نطاق يعمل على فاتورة خارج نطاق المستخدم، ورسالةٌ إنجليزية تصل المندوب.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const B = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(B, 'src', p), 'utf8');

const invoices = read(path.join('routes', 'invoices.ts'));
const branch = read(path.join('routes', 'invoicesZatca.ts'));
const deps = read(path.join('routes', 'invoicesZatcaDeps.ts'));
const submitSvc = read(path.join('services', 'zatcaSubmit.ts'));
const voidSvc = read(path.join('services', 'invoiceVoid.ts'));

import { ZATCA_ERROR_CATALOGUE } from '../compliance/zatca/errors';

/** جسم معالِج بين تعريفه وتعريف المسار التالي. */
function handler(marker: string): string {
  const i = invoices.indexOf(marker);
  assert.ok(i > 0, `المسار مفقود: ${marker}`);
  const next = invoices.indexOf('\nrouter.', i + marker.length);
  return invoices.slice(i, next > 0 ? next : undefined);
}

// ═══ ترتيب المسارات ═══

test('القراءة بالمرجع معرَّفة قبل /:id — وإلّا قُرئت «by-client-ref» معرّفَ فاتورة', () => {
  const ref = invoices.indexOf("router.get('/by-client-ref/:clientRef'");
  const byId = invoices.indexOf("router.get('/:id'");
  assert.ok(ref > 0, 'مسار القراءة بالمرجع مفقود');
  assert.ok(byId > 0 && ref < byId, 'عُرِّف بعد /:id فلن يُستدعى أبداً');
});

test('الإجراءان تحت بوابة صلاحية الفواتير وحارس الأدمن', () => {
  const guard = invoices.indexOf("router.use(requireAdminPermission('canManageInvoices')");
  for (const m of ["router.post('/:id/einvoice/withdraw'", "router.post('/:id/einvoice/reissue'", "router.post('/:id/einvoice/retry'"]) {
    const i = invoices.indexOf(m);
    assert.ok(i > guard, `${m}: خارج بوابة صلاحية الفواتير`);
    assert.match(invoices.slice(i, i + 120), /requireAdmin,/, `${m}: بلا حارس أدمن — يسحب مندوبٌ فاتورةً ضريبية`);
  }
});

test('الإجراءان يقرآن الفاتورة داخل نطاق المستخدم لا بمعرّفها وحده', () => {
  for (const m of ["router.post('/:id/einvoice/withdraw'", "router.post('/:id/einvoice/reissue'", "router.post('/:id/einvoice/retry'"]) {
    const h = handler(m);
    assert.match(h, /scopedInvoiceId\(req, tid\)/, `${m}: بلا حارس نطاق`);
    assert.match(h, /res\.status\(404\)/, `${m}: لا يردّ 404 على ما خارج النطاق`);
  }
  const scoped = invoices.slice(invoices.indexOf('async function scopedInvoiceId'), invoices.indexOf('async function scopedInvoiceId') + 400);
  assert.match(scoped, /scopedRecordWhere\(req, SHAPE_INVOICE_RECEIPT\)/, 'نطاق مستخدم الشركة غير مطبَّق');
  assert.match(scoped, /tenantId: tid/, 'بلا قيد شركة');
});

test('إعادة الإصدار تحرس القدرات (نقد 6): الرمز الجديد لا يصل حزمةً تبني QR المرحلة الأولى', () => {
  const h = handler("router.post('/:id/einvoice/reissue'");
  assert.match(h, /capsGate\(capsFromHeaders\(req\.headers\)\)/, 'بلا حارس قدرات');
  const gate = h.indexOf('capsGate');
  const work = h.indexOf('reissuePhase2Invoice');
  assert.ok(gate > 0 && work > gate, 'الحارس بعد العمل — أي بعد استهلاك ICV');
});

test('القراءة بالمرجع: نطاق العميل ونطاق المندوب قبل أيّ ردّ، وقراءة محضة بلا نداء للهيئة', () => {
  const h = handler("router.get('/by-client-ref/:clientRef'");
  // مراجعة عدائية: القراءة بالمرجع كانت findUnique بلا نطاق — فتسرّب فاتورةَ مندوبٍ خارج النطاق لمن يعرف مرجعها
  assert.match(h, /scopedRecordWhere\(req, SHAPE_INVOICE_RECEIPT\)/, 'نطاق مستخدم الشركة (المندوب) غير مطبَّق على القراءة بالمرجع');
  assert.doesNotMatch(h, /findUnique/, 'قراءةٌ بالمفتاح الفريد وحده تتخطّى نثر النطاق');
  assert.match(h, /canAccessCustomer\(req, tid, invoice\.customerId\)/, 'بلا حارس عميل — يُكشف عميل خارج النطاق لمن يعرف المرجع');
  assert.match(h, /role === 'SALES_REP' && invoice\.salesRepId !== req\.user\.id/, 'مندوبٌ يقرأ فاتورة زميله');
  assert.match(h, /phase2ReadBody/, 'لا يُرفق إسقاط المستند');
  assert.doesNotMatch(h, /phase2ReplayBody|submitInline/, 'القراءة بالمرجع تنادي الهيئة — وهي قراءة محضة');
});

// ═══ الاعتماد الحيّ ═══

test('الاعتماد الحيّ للقياسية وحدها، وبعد الالتزام والبثّ لا داخل المعاملة', () => {
  const i = branch.indexOf("if (prepared.subtype === '01')");
  assert.ok(i > 0, 'فرع القياسية مفقود');
  const publish = branch.indexOf('deps.publish(ctx.tenantId)');
  assert.ok(publish > 0 && publish < i, 'الاعتماد قبل البثّ/الالتزام');
  assert.match(branch.slice(i, i + 400), /clearStandardInline/, 'الفرع لا يستدعي الاعتماد الحيّ');
  // لا نداء شبكيّ داخل معاملة الإصدار
  const tx = branch.indexOf('transaction: () => deps.transaction(');
  const txEnd = branch.indexOf('if (!created)');
  assert.doesNotMatch(branch.slice(tx, txEnd), /submitInline|clearStandardInline/, 'نداء الهيئة داخل معاملة الإصدار');
});

test('غياب الاعتماد الحيّ ⇒ «بانتظار الاعتماد» لا انهيار (سلوك Z5.2 نفسه)', () => {
  assert.match(branch, /if \(!submit\) return pendingResult\(data, 'IN_FLIGHT'\)/, 'غياب الحقن غير معالَج');
  assert.match(branch, /submitInline\?: InlineSubmitFn \| null/, 'الحقن ليس اختيارياً — يكسر كل اختبارات Z5.2');
});

test('القرار يُقرأ من الصفّ المخزَّن لا من قيمة الاستدعاء (انهيارٌ أو سبقُ عاملٍ يُقرأ منه أيضاً)', () => {
  const fn = branch.slice(branch.indexOf('async function clearStandardInline'));
  assert.match(fn, /loadProjection\(ref\.tenantId, ref\.invoiceId\)/, 'لا يُعاد قراءة المستند بعد المحاولة');
  assert.match(fn, /clearanceOutcome\(p\.status, '01'\)/, 'القرار ليس من حالة المستند');
  assert.match(fn, /body\.status = 'CANCELLED'/, 'الردّ لا يعكس إبطال الفاتورة المرفوضة');
});

/* مراجعة عدائية ٢ (النتيجة 10): ردّ إعادة الرفع كان يقول «بانتظار حسم الهيئة» عن فاتورةٍ سُحبت وأُلغيت. */
test('إعادة الرفع: كل حالةٍ محسومة لها ردّها — والسحب ليس انتظاراً', () => {
  const fn = branch.slice(branch.indexOf('function replayReply('), branch.indexOf('export async function phase2ReplayBody'));
  for (const kind of ['rejected', 'cleared_no_xml', 'withdrawn', 'pending']) {
    assert.match(fn, new RegExp(`outcome\.kind === '${kind}'`), `ردّ إعادة الرفع يُغفل ${kind}`);
  }
  assert.ok(fn.indexOf("'withdrawn'") < fn.indexOf("'pending'"), 'السحب يسقط في فرع الانتظار العامّ');
});

test('الإرسال الحيّ في الإنتاج لا يرمي أبداً (الفاتورة التُزمت فعلاً)', () => {
  const i = deps.indexOf('submitInline:');
  assert.ok(i > 0, 'الحقن غير موصول بالإنتاج');
  const fn = deps.slice(i, i + 500);
  assert.match(fn, /try \{/, 'بلا التقاط — عطل الهيئة يُسقط طلباً التُزمت فاتورته');
  assert.match(fn, /inline: true/, 'لا يأخذ المقعد المحجوز للطلب الحيّ');
});

// ═══ الإبطال داخل معاملة النتيجة (نقد 7) ═══

test('خطّاف الإبطال موصول بالإنتاج داخل المعاملة، وما بعد الالتزام خارجها', () => {
  assert.match(submitSvc, /onRejectedInTx: async \(tx, info\)/, 'الخطّاف غير موصول — لا تُبطل فاتورة مرفوضة أبداً');
  assert.match(submitSvc, /voidInvoiceInTx\(tx as unknown as VoidTx/, 'الإبطال خارج معاملة النتيجة');
  assert.match(submitSvc, /onCommit\(tx, \(\) => afterVoidCommit/, 'إماتة روابط الدفع داخل المعاملة (نداء شبكيّ تحت قفل)');
  const hook = submitSvc.slice(submitSvc.indexOf('onRejectedInTx:'), submitSvc.indexOf('publish: publishInvoicesChanged'));
  assert.match(hook, /info\.subtype !== '01'/, 'المبسّطة تمرّ إلى الإبطال — وورقتها مع المشتري');
});

test('الإبطال يقفل الفاتورة ثمّ العميل (الترتيب نفسه في مسار الإصدار)', () => {
  assert.match(voidSvc, /FROM invoices WHERE id = \$\{invoiceId\} FOR UPDATE/, 'صفّ الفاتورة لا يُقفل');
  const lock = voidSvc.indexOf('FOR UPDATE');
  const reverse = voidSvc.indexOf('await reverseInvoiceInTx(tx as unknown as LedgerTx');
  assert.ok(lock > 0 && reverse > lock, 'القيود تُعكس قبل قفل الفاتورة');
});

test('مسار الإلغاء القديم صار ينادي النسخة المشتركة بالوضع CANCEL، وردّه كما هو', () => {
  const h = handler("router.patch('/:id/cancel'");
  assert.match(h, /reverseInvoiceInTx\(/, 'الإلغاء لم يُوصل بالنسخة المشتركة — نسختان تتباعدان');
  assert.match(h, /'CANCEL',/, 'وضع العكس غير مصرَّح به — الافتراضي قد يتغيّر');
  assert.match(h, /res\.json\(\{ success: true, data: updated \}\)/, 'ردّ الإلغاء تغيّر');
  assert.doesNotMatch(h, /reverseCashInvoiceEntries|reverseReturnEntries/, 'بقي فرع العكس القديم مكرّراً');
});

/* مراجعة عدائية ٢ (النتيجتان 2 و5): الإلغاء اليدويّ يعكس القيود ولا يمسّ zatca_documents، فكان المسح يواصل إرسال
 * مستند فاتورةٍ عُكست قيودها — ضريبة مخرجات مُقرَّة على بيعٍ مُلغى بلا إشعار دائن. */
test('الإلغاء اليدويّ محروسٌ بالمرحلة الثانية قبل أيّ كتابة، ويوجّه إلى السحب أو الإشعار الدائن', () => {
  const h = handler("router.patch('/:id/cancel'");
  const guard = h.indexOf('zatcaPhase === 2');
  assert.ok(guard > 0, 'مسار الإلغاء بلا فحص zatcaPhase — يُرسَل مستند فاتورةٍ عُكست قيودها');
  assert.match(h.slice(guard, guard + 260), /ZATCA_CANCEL_NOT_ALLOWED/, 'الرفض بلا رمز الكتالوج');
  const write = h.indexOf('prisma.$transaction');
  assert.ok(write > guard, 'الحارس بعد الكتابة — تُعكس القيود ثمّ يُرفض');
  const msg = ZATCA_ERROR_CATALOGUE.ZATCA_CANCEL_NOT_ALLOWED.messageAr;
  assert.ok(msg.includes('اسحب') && msg.includes('إشعار'), 'الرسالة لا ترشد إلى المخرجين المحروسين');
});

test('حزامٌ ثانٍ: استعلاما الاستيلاء يستبعدان مستند فاتورةٍ ملغاة', () => {
  const store = read(path.join('compliance', 'zatca', 'documentStore.prisma.ts'));
  const claim = store.slice(store.indexOf('async claim(id, opts)'), store.indexOf('async claimBatch('));
  const batch = store.slice(store.indexOf('async claimBatch('), store.indexOf('async applyOutcome('));
  for (const [name, sql] of [['claim', claim], ['claimBatch', batch]] as const) {
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM invoices i WHERE i\.id = \S+\."invoiceId" AND i\.status = 'CANCELLED'\)/,
      `${name}: يستولي على مستند فاتورةٍ ملغاة فيرسلها إلى الهيئة`);
  }
});

/* مراجعة عدائية ٢ (النتيجة 9): الإعادة اليدوية كانت تأخذ مقعد **المسح** بلا مهلة، فينتظر المديرُ خلف دفعة المسح
 * كاملةً ثمّ ثلاثين ثانية أخرى بلا ردّ. */
test('الإعادة اليدوية تأخذ المقعد المحجوز للطلب الحيّ بمهلة صريحة، وتردّ 202 حين تنقضي', () => {
  const fn = submitSvc.slice(submitSvc.indexOf('export async function retryPhase2Document'));
  assert.match(fn, /slot: 'inline'/, 'تأخذ مقعد المسح فتنتظر خلف طابوره');
  assert.match(fn, /withDeadline\(/, 'بلا مهلة — الطلب يعلّق حتى مهلة الاستدعاء كاملة');
  assert.match(fn, /INLINE_CLEARANCE_CALL_TIMEOUT_MS/, 'مهلة الاستدعاء غير مقيَّدة بنافذة الطلب الحيّ');
  assert.match(fn, /pending: true/, 'انقضاء المهلة يُقرأ فشلاً بدل «يكمل في الخلفية»');
  const route = handler("router.post('/:id/einvoice/retry'");
  assert.match(route, /res\.status\(r\.pending === true \? 202 : 200\)/, 'ردّ «تمّ» عن إرسالٍ لم يُحسم بعد');
  // ولا يُخلط المقعد بالاستراتيجية: `inline: true` يتخطّى requeue فيصير المستند المحجوب غير قابل للاستيلاء
  assert.doesNotMatch(fn, /inline: true/, 'inline: true يتخطّى إعادة الإدراج فلا يُستولى على المحجوب');
});

// ═══ كتالوج الأخطاء ═══

test('رموز Z5.4 موجودة بحالات HTTP صحيحة ورسائل عربية ترشد إلى الفعل', () => {
  const expect: Record<string, number> = {
    ZATCA_CLEARANCE_PENDING: 202, ZATCA_CLEARED_NO_XML: 202, ZATCA_REJECTED: 422,
    ZATCA_ALLOCATION_BLOCKED: 409, ZATCA_WITHDRAW_NOT_ALLOWED: 409, ZATCA_REISSUE_NOT_ALLOWED: 409,
    ZATCA_RETRY_NOT_ALLOWED: 409, ZATCA_CANCEL_NOT_ALLOWED: 409, ZATCA_WITHDRAWN: 409,
  };
  for (const [code, status] of Object.entries(expect)) {
    const entry = ZATCA_ERROR_CATALOGUE[code as keyof typeof ZATCA_ERROR_CATALOGUE];
    assert.ok(entry, `الرمز ${code} مفقود من الكتالوج`);
    assert.equal(entry.status, status, code);
    assert.ok(/[؀-ۿ]/.test(entry.messageAr), `${code}: الرسالة ليست عربية`);
    assert.ok(entry.messageAr.length > 20, `${code}: رسالة أقصر من أن تُفهم`);
    assert.doesNotMatch(entry.messageAr, /[A-Za-z]{4,}/, `${code}: تسرّب نصّ إنجليزي إلى رسالة المستخدم`);
  }
  // 202 نجاحٌ لا خطأ: الفاتورة صدرت فعلاً وإن لم تُعتمد
  for (const code of ['ZATCA_CLEARANCE_PENDING', 'ZATCA_CLEARED_NO_XML'] as const) {
    assert.ok(ZATCA_ERROR_CATALOGUE[code].status < 400, `${code}: يُعامَل خطأً فيُخفي فاتورةً التُزمت`);
  }
});

test('رسالة «بانتظار الاعتماد» ترشد المندوب إلى مذكّرة التسليم (قرار المالك D5)', () => {
  const m = ZATCA_ERROR_CATALOGUE.ZATCA_CLEARANCE_PENDING.messageAr;
  assert.ok(m.includes('مذكرة التسليم'), 'لا ترشد إلى ما يُسلَّم بدل الفاتورة الضريبية');
  assert.ok(ZATCA_ERROR_CATALOGUE.ZATCA_ALLOCATION_BLOCKED.messageAr.includes('انتظر'), 'رفض التحصيل بلا إرشاد');
});
