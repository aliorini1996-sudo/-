// صفحة «طرق الدفع» (services/paymentMethodsReport.ts + GET /reports/payment-methods) — البناء الصافي، والمدى بأيام الشركة،
// وحرّاسٌ نصّية على البوّابة والنطاق والعَلَم (ميزة اشتراك مطفأة افتراضياً).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  COLLECTED_CASH_SALE, COLLECTED_RECEIPT, PAYMENT_METHODS, buildPaymentMethodsReport, paymentMethodsRange, rosterOf,
  type CashSaleGroupRow, type ReceiptGroupRow, type RepInfo,
} from '../services/paymentMethodsReport';
import { CASH_VOID_KEEP_COLLECTION_NOTE } from '../lib/ledgerNotes';

const root = process.cwd();
const read = (...p: string[]) => {
  const f = path.join(root, ...p);
  assert.ok(fs.existsSync(f), `ملف غير موجود: ${f}`);
  return fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
};

const REPS = new Map<string, RepInfo>([
  ['r1', { name: 'محمد', isActive: true }],
  ['r2', { name: 'خالد', isActive: true }],
  ['r3', { name: 'سالم', isActive: false }],
]);
const block = (rep: ReturnType<typeof buildPaymentMethodsReport>, m: string) => {
  const b = rep.methods.find((x) => x.method === m);
  assert.ok(b, `جدول ${m} غائب`);
  return b;
};

// ═══ شرط «المحصَّل» على المستند — يُطابَق بمطابقٍ مسطّح كما تطبّقه Prisma على أعمدةٍ نصّية ═══
// يدعم OR/AND وsome/none على مصفوفة علاقة (قيود الحساب) كما تطبّقها Prisma
type Doc = Record<string, unknown>;
const matches = (doc: Doc, where: Record<string, unknown>): boolean => Object.entries(where).every(([k, v]) => {
  if (k === 'OR') return (v as Record<string, unknown>[]).some((w) => matches(doc, w));
  if (k === 'AND') return (v as Record<string, unknown>[]).every((w) => matches(doc, w));
  if (v && typeof v === 'object' && !Array.isArray(v) && ('some' in v || 'none' in v)) {
    const rows = (doc[k] as Doc[] | undefined) ?? [];
    const rel = v as { some?: Record<string, unknown>; none?: Record<string, unknown> };
    if (rel.some) return rows.some((r) => matches(r, rel.some!));
    return !rows.some((r) => matches(r, rel.none!));
  }
  return doc[k] === v;
});

test('السند المحصَّل: الساري وحده — الملغى لا يُعدّ تحصيلاً', () => {
  assert.deepEqual(COLLECTED_RECEIPT, { status: 'ACTIVE' });
  assert.ok(matches({ status: 'ACTIVE', paymentMethod: 'CHEQUE' }, COLLECTED_RECEIPT));
  assert.ok(!matches({ status: 'CANCELLED', paymentMethod: 'CASH' }, COLLECTED_RECEIPT), 'السند الملغى خارج');
});

test('فاتورة البيع النقدي: نقديةٌ مؤكَّدة — الآجلة والمسودة والملغاة والإشعاران خارجها', () => {
  assert.ok(matches({ type: 'CASH', status: 'CONFIRMED', documentKind: null }, COLLECTED_CASH_SALE), 'النقدية القديمة (documentKind فارغ) داخلة');
  assert.ok(matches({ type: 'CASH', status: 'CONFIRMED', documentKind: 'INVOICE' }, COLLECTED_CASH_SALE));
  assert.ok(!matches({ type: 'CASH', status: 'CANCELLED' }, COLLECTED_CASH_SALE), 'الملغاة (سحب الإدارة) خارج');
  // أبطلتها الهيئة واحتُفظ بتحصيلها: نقدٌ قبضه المندوب فعلاً — داخل (القرار ٣)
  const keep = { type: 'INVOICE_CREDIT', description: CASH_VOID_KEEP_COLLECTION_NOTE };
  assert.ok(matches({ type: 'CASH', status: 'CANCELLED', accountEntries: [{ type: 'INVOICE_DEBIT', description: 'x' }, keep] }, COLLECTED_CASH_SALE), 'إبطال الهيئة بتحصيلٍ محفوظ داخل');
  assert.ok(!matches({ type: 'CASH', status: 'CANCELLED', accountEntries: [keep, { type: 'RECEIPT_DEBIT', description: 'y' }] }, COLLECTED_CASH_SALE), 'عُكس تحصيلها (RECEIPT_DEBIT) خارج');
  assert.ok(!matches({ type: 'CASH', status: 'CANCELLED', accountEntries: [{ type: 'INVOICE_CREDIT', description: 'إلغاء عادي' }] }, COLLECTED_CASH_SALE), 'إلغاءٌ بلا الوسم خارج');
  assert.ok(!matches({ type: 'CREDIT', status: 'CANCELLED', accountEntries: [keep] }, COLLECTED_CASH_SALE), 'الآجلة لا تُعدّ ولو حملت الوسم');
  assert.ok(!matches({ type: 'CASH', status: 'DRAFT' }, COLLECTED_CASH_SALE), 'المسودة لم تُصدر');
  assert.ok(!matches({ type: 'CREDIT', status: 'CONFIRMED' }, COLLECTED_CASH_SALE), 'الآجلة تُحصَّل بسند لا بالفاتورة');
  // الإشعار الدائن يُخزَّن RETURN والمدين CREDIT (compliance/zatca/notes.ts) — فلا يطابقان النقدي بلا شرط documentKind
  assert.ok(!matches({ type: 'RETURN', status: 'CONFIRMED', documentKind: 'CREDIT_NOTE' }, COLLECTED_CASH_SALE), 'الإشعار الدائن خارج');
  assert.ok(!matches({ type: 'CREDIT', status: 'CONFIRMED', documentKind: 'DEBIT_NOTE' }, COLLECTED_CASH_SALE), 'الإشعار المدين خارج');
  // التحقّق من أنّ الشرطين بلا notIn/not على عمودٍ فارغٍ في القديم (يُسقط كل فاتورةٍ قديمة)
  assert.ok(!('documentKind' in COLLECTED_CASH_SALE));
});

// ═══ البناء ═══

test('الطرق الخمس حاضرةٌ دائماً بترتيبها — والجدول الفارغ صفوفه فارغة لا غائب', () => {
  const r = buildPaymentMethodsReport([], [], REPS);
  assert.deepEqual(r.methods.map((m) => m.method), [...PAYMENT_METHODS]);
  assert.deepEqual(r.methods.map((m) => m.rows.length), [0, 0, 0, 0, 0]);
  assert.deepEqual(r.total, { amount: 0, count: 0 });
  assert.equal(r.repsCount, 0);
});

test('كل تحصيلٍ في جدول قناته: محمد نقدي / محمد شبكة / محمد شيك', () => {
  const receipts: ReceiptGroupRow[] = [
    { salesRepId: 'r1', paymentMethod: 'CASH', amount: 100, count: 2 },
    { salesRepId: 'r1', paymentMethod: 'POS', amount: 50, count: 1 },
    { salesRepId: 'r1', paymentMethod: 'CHEQUE', amount: 1000, count: 1 },
    { salesRepId: 'r2', paymentMethod: 'BANK_TRANSFER', amount: 300, count: 3 },
    { salesRepId: 'r2', paymentMethod: 'ONLINE', amount: 75.5, count: 1 },
  ];
  const r = buildPaymentMethodsReport(receipts, [], REPS);
  assert.deepEqual(block(r, 'CASH').rows.map((x) => [x.repName, x.amount, x.count]), [['محمد', 100, 2]]);
  assert.deepEqual(block(r, 'POS').rows.map((x) => [x.repName, x.amount, x.count]), [['محمد', 50, 1]]);
  assert.deepEqual(block(r, 'CHEQUE').rows.map((x) => [x.repName, x.amount, x.count]), [['محمد', 1000, 1]]);
  assert.deepEqual(block(r, 'BANK_TRANSFER').rows.map((x) => [x.repName, x.amount, x.count]), [['خالد', 300, 3]]);
  assert.deepEqual(block(r, 'ONLINE').rows.map((x) => [x.repName, x.amount, x.count]), [['خالد', 75.5, 1]]);
  assert.deepEqual(r.total, { amount: 1525.5, count: 8 });
  assert.equal(r.repsCount, 2);
});

test('النقدي = سندات القبض النقدية + فواتير البيع النقدي، بشقّين منفصلين', () => {
  const receipts: ReceiptGroupRow[] = [{ salesRepId: 'r1', paymentMethod: 'CASH', amount: 200, count: 2 }];
  const sales: CashSaleGroupRow[] = [
    { salesRepId: 'r1', amount: 115, count: 3 },
    { salesRepId: 'r2', amount: 40, count: 1 }, // مندوبٌ باع نقداً ولم يُصدر سنداً
  ];
  const cash = block(buildPaymentMethodsReport(receipts, sales, REPS), 'CASH');
  const m = cash.rows.find((x) => x.salesRepId === 'r1')!;
  assert.deepEqual(
    [m.amount, m.count, m.receiptsAmount, m.receiptsCount, m.invoicesAmount, m.invoicesCount],
    [315, 5, 200, 2, 115, 3],
  );
  const k = cash.rows.find((x) => x.salesRepId === 'r2')!;
  assert.deepEqual([k.amount, k.receiptsAmount, k.invoicesAmount], [40, 0, 40]);
  assert.deepEqual(
    [cash.total.amount, cash.total.count, cash.total.receiptsAmount, cash.total.invoicesAmount, cash.total.invoicesCount],
    [355, 6, 200, 155, 4],
  );
  // فواتير البيع النقدي لا تقع في غير النقدي
  for (const b of buildPaymentMethodsReport(receipts, sales, REPS).methods) {
    if (b.method !== 'CASH') assert.equal(b.total.invoicesCount, 0, b.method);
  }
});

test('بلا مندوب (سند الإدارة أو مندوبٌ حُذف): خارج الصفوف والإجماليات، ومذكورٌ منفصلاً', () => {
  const receipts: ReceiptGroupRow[] = [
    { salesRepId: null, paymentMethod: 'BANK_TRANSFER', amount: 900, count: 2 },
    { salesRepId: 'r2', paymentMethod: 'BANK_TRANSFER', amount: 100, count: 1 },
  ];
  const sales: CashSaleGroupRow[] = [{ salesRepId: null, amount: 60, count: 1 }];
  const r = buildPaymentMethodsReport(receipts, sales, REPS);
  const bt = block(r, 'BANK_TRANSFER');
  assert.deepEqual(bt.rows.map((x) => x.salesRepId), ['r2'], 'لا صفّ بلا مندوب');
  assert.deepEqual([bt.total.amount, bt.total.count], [100, 1], 'إجمالي الجدول للمناديب وحدهم');
  assert.deepEqual(bt.noRep, { amount: 900, count: 2 });
  assert.deepEqual(block(r, 'CASH').noRep, { amount: 60, count: 1 });
  assert.deepEqual(r.total, { amount: 100, count: 1 });
  assert.deepEqual(r.noRep, { amount: 960, count: 3 });
});

test('الترتيب بالمبلغ تنازلياً ثم العدد؛ والموقوف يبقى بتحصيله موسوماً', () => {
  const receipts: ReceiptGroupRow[] = [
    { salesRepId: 'r1', paymentMethod: 'POS', amount: 10, count: 1 },
    { salesRepId: 'r3', paymentMethod: 'POS', amount: 500, count: 4 },
    { salesRepId: 'r2', paymentMethod: 'POS', amount: 10, count: 3 },
  ];
  const rows = block(buildPaymentMethodsReport(receipts, [], REPS), 'POS').rows;
  assert.deepEqual(rows.map((x) => x.salesRepId), ['r3', 'r2', 'r1']);
  assert.equal(rows[0].repActive, false, 'سالم موقوف ويبقى تحصيله');
  assert.equal(rows[1].repActive, true);
});

test('التقريب بثلاث منازل، وإجمالي الجدول مجموع صفوفه المعروضة', () => {
  const receipts: ReceiptGroupRow[] = [
    { salesRepId: 'r1', paymentMethod: 'CASH', amount: 0.1 + 0.2, count: 1 }, // 0.30000000000000004
    { salesRepId: 'r2', paymentMethod: 'CASH', amount: 10.0004, count: 1 },
  ];
  const cash = block(buildPaymentMethodsReport(receipts, [], REPS), 'CASH');
  assert.deepEqual(cash.rows.map((x) => x.amount), [10, 0.3]);
  assert.equal(cash.total.amount, 10.3);
});

test('قيمة طريقةٍ خارج الخمس (سجلٌّ قديم) لا تسقط: جدولٌ يُلحق بعدها', () => {
  const r = buildPaymentMethodsReport([{ salesRepId: 'r1', paymentMethod: 'LEGACY', amount: 5, count: 1 }], [], REPS);
  assert.deepEqual(r.methods.map((m) => m.method), [...PAYMENT_METHODS, 'LEGACY']);
  assert.equal(r.total.amount, 5);
});

test('مبالغ غير رقمية من القاعدة تُعدّ صفراً لا NaN يُفسد الإجمالي', () => {
  const r = buildPaymentMethodsReport([{ salesRepId: 'r1', paymentMethod: 'CASH', amount: Number.NaN, count: 1 }], [], REPS);
  assert.equal(r.total.amount, 0);
  assert.equal(r.total.count, 1);
});

// ═══ المدى بأيام الشركة ═══

test('الافتراض «اليوم» بتوقيت الشركة لا UTC — الساعة ١:٣٠ فجراً في الرياض يومٌ جديد', () => {
  const now = new Date('2026-10-20T22:30:00.000Z'); // ٢١ أكتوبر ١:٣٠ بتوقيت الرياض
  const r = paymentMethodsRange(undefined, undefined, 'Asia/Riyadh', now);
  assert.ok(r.ok);
  assert.equal(r.from, '2026-10-21');
  assert.equal(r.to, '2026-10-21');
  assert.equal(r.gte.toISOString(), '2026-10-20T21:00:00.000Z');
  assert.equal(r.lt.toISOString(), '2026-10-21T21:00:00.000Z');
});

test('مدى أيام: من منتصف ليل «من» إلى منتصف ليل ما بعد «إلى» بتوقيت الشركة', () => {
  const r = paymentMethodsRange('2026-10-01', '2026-10-31', 'Asia/Riyadh');
  assert.ok(r.ok);
  assert.equal(r.gte.toISOString(), '2026-09-30T21:00:00.000Z');
  assert.equal(r.lt.toISOString(), '2026-10-31T21:00:00.000Z');
  const dubai = paymentMethodsRange('2026-10-01', '2026-10-01', 'Asia/Dubai');
  assert.ok(dubai.ok);
  assert.equal(dubai.gte.toISOString(), '2026-09-30T20:00:00.000Z');
});

test('طرفٌ واحد: «من» وحدها حتى اليوم، و«إلى» وحدها يومٌ واحد', () => {
  const now = new Date('2026-10-21T09:00:00.000Z');
  const a = paymentMethodsRange('2026-10-15', '', 'Asia/Riyadh', now);
  assert.ok(a.ok);
  assert.deepEqual([a.from, a.to], ['2026-10-15', '2026-10-21']);
  const b = paymentMethodsRange('', '2026-10-10', 'Asia/Riyadh', now);
  assert.ok(b.ok);
  assert.deepEqual([b.from, b.to], ['2026-10-10', '2026-10-10']);
  const c = paymentMethodsRange('2026-11-05', undefined, 'Asia/Riyadh', now);
  assert.ok(c.ok, '«من» بعد اليوم بلا «إلى» يومٌ واحد لا خطأ');
  assert.deepEqual([c.from, c.to], ['2026-11-05', '2026-11-05']);
});

test('تاريخٌ غير صالح أو مقلوب يُرفض صراحةً — لا يُسقَط إلى كل الفترات', () => {
  assert.deepEqual(paymentMethodsRange('2026-02-30', '2026-03-01', 'Asia/Riyadh'), { ok: false, message: 'تاريخ غير صالح' });
  assert.deepEqual(paymentMethodsRange('21/10/2026', undefined, 'Asia/Riyadh'), { ok: false, message: 'تاريخ غير صالح' });
  assert.equal(paymentMethodsRange(['2026-10-01'], undefined, 'Asia/Riyadh').ok, true, 'مصفوفة qs تُهمل كالغياب');
  assert.deepEqual(paymentMethodsRange('2026-10-10', '2026-10-01', 'Asia/Riyadh'), { ok: false, message: 'تاريخ البداية بعد تاريخ النهاية' });
});

// ═══ حرّاس نصّية: البوّابة والنطاق والعَلَم ═══

test('المسار خلف صلاحية التقارير وحارس العَلَم، ونطاقه نطاق تقارير التحصيل', () => {
  const r = read('src', 'routes', 'reports.ts');
  assert.match(r, /router\.use\(authenticate, requireAdmin, requireAdminPermission\('canViewReports'\)\);/, 'الراوتر كلّه خلف canViewReports');
  const i = r.indexOf("router.get('/payment-methods'");
  assert.ok(i > r.indexOf("router.get('/rep-ranking'"), 'المسار بعد آخر مسار (حرّاس الشرائح في teams.test تقطع على المسارات)');
  const seg = r.slice(i, r.indexOf('export default router'));
  assert.ok(seg.startsWith("router.get('/payment-methods', requirePaymentMethods, async"), 'حارس العَلَم على المسار');
  assert.ok(seg.includes('const docScope = await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT);'), 'نطاق المستند (المقيَّد ومشرف الفرق)');
  assert.equal(seg.split('...teamDocWhere(team), ...docScope }').length - 1, 1, 'السندات بفلتر الفريق ونطاق المستند');
  assert.ok(seg.includes('AND: [COLLECTED_CASH_SALE, teamDocWhere(team), docScope]'), 'والفواتير النقدية كذلك — في AND لأنّ شرطها فيه OR');
  assert.ok(seg.includes('...COLLECTED_RECEIPT, receiptDate: { gte: range.gte, lt: range.lt }'), 'السندات السارية بتاريخ السند');
  assert.ok(seg.includes('where: { tenantId: tid, invoiceDate: { gte: range.gte, lt: range.lt }, AND: [COLLECTED_CASH_SALE'), 'الفواتير النقدية المحصَّلة بتاريخ الفاتورة');
  assert.ok(seg.includes('const tz = await tenantTz(tid);'), 'المدى بتوقيت الشركة');
  assert.ok(!/notIn|\{ not:/.test(seg), 'لا notIn/not: يُسقطان الفواتير القديمة ذات الأعمدة الفارغة');
  assert.ok(!/\.\.\.\(await adminRepFilter\(req\)\)/.test(seg), 'لا نثر لقيد المندوب');
});

test('الحارس: مطفأ افتراضياً (`!== true`)، والمحاسبة المطفأة تمنع قبله، والشركة من الطلب', () => {
  const s = read('src', 'middleware', 'auth.ts');
  const i = s.indexOf('export async function requirePaymentMethods');
  assert.ok(i > 0, 'الحارس مفقود');
  const g = s.slice(i, s.indexOf('\n}\n', i));
  assert.match(g, /const tid = req\.user\?\.tenantId;/, 'tenantId(req) ترمي للسوبر أدمن فتحوّل ٤٠٣ إلى ٥٠٠');
  assert.match(g, /t\?\.paymentMethodsEnabled !== true/, 'الشرط `!== true`');
  assert.doesNotMatch(g, /paymentMethodsEnabled === false/, '`=== false` يفتح الميزة حين يتعذّر قراءة الصفّ');
  assert.match(g, /code: 'PAYMENT_METHODS_NOT_ALLOWED'/);
  assert.ok(g.indexOf("code: 'ACCOUNTING_NOT_ALLOWED'") > 0 && g.indexOf("code: 'ACCOUNTING_NOT_ALLOWED'") < g.indexOf("code: 'PAYMENT_METHODS_NOT_ALLOWED'"), 'المحاسبة أولاً');
});

test('العَلَم: عمودٌ مطفأ افتراضياً، في تحديث الشركة لا إنشائها، و/company بـ=== true', () => {
  assert.match(read('prisma', 'schema.prisma'), /paymentMethodsEnabled\s+Boolean\s+@default\(false\)/);
  const t = read('src', 'routes', 'tenants.ts');
  const c = t.indexOf('const createTenantSchema');
  const u = t.indexOf('const updateTenantSchema');
  assert.ok(c >= 0 && u > c);
  assert.doesNotMatch(t.slice(c, u), /paymentMethodsEnabled/, 'لا يُقبل عند الإنشاء');
  assert.match(t.slice(u, t.indexOf('});', u)), /paymentMethodsEnabled: z\.boolean\(\)\.optional\(\)/, 'مفقود من مخطّط التحديث');
  const co = read('src', 'routes', 'company.ts');
  assert.match(co, /paymentMethodsEnabled: true \}/, 'مفقود من select');
  assert.match(co, /paymentMethodsEnabled: tenant\?\.paymentMethodsEnabled === true/, '=== true (مطفأ افتراضياً)');
});

test('قائمة المناديب: كلّ النشطين في النطاق ومن حصّل ولو موقوفاً، بلا تكرار، مرتَّبين بالاسم', () => {
  const active = [{ id: 'r2', name: 'خالد', isActive: true }, { id: 'r1', name: 'محمد', isActive: true }, { id: 'r4', name: 'بدر', isActive: true }];
  const collected = new Map<string, RepInfo>([['r1', { name: 'محمد', isActive: true }], ['r3', { name: 'سالم', isActive: false }]]);
  const list = rosterOf(active, collected);
  assert.deepEqual(list.map((r) => r.salesRepId), ['r4', 'r2', 'r3', 'r1'], 'بالاسم: بدر، خالد، سالم، محمد');
  assert.equal(list.find((r) => r.salesRepId === 'r3')!.repActive, false, 'الموقوف الذي حصّل باقٍ موسوماً');
  assert.equal(list.filter((r) => r.salesRepId === 'r1').length, 1, 'بلا تكرار');
  assert.deepEqual(rosterOf([], new Map()), []);
});

test('المسار يعيد القائمة بنطاق تقارير الأداء: مناديب النطاق النشطون (adminRepFilter + الفريق)', () => {
  const r = read('src', 'routes', 'reports.ts');
  const seg = r.slice(r.indexOf("router.get('/payment-methods'"), r.indexOf('export default router'));
  assert.ok(seg.includes("where: { tenantId: tid, isActive: true, AND: [await adminRepFilter(req), teamRepOrDocsWhere(team)] },"), 'نطاق المستخدم ومشرف الفريق');
  assert.ok(seg.includes('roster: rosterOf(activeReps, repInfo)'));
});
