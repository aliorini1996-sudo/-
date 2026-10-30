// «تتبّع اللوط» — حرّاس نصّية للحزمة B8 (المواصفة §٨.٣): routes/reports.ts. نصّي على المصدر: لا قاعدة بيانات ولا شبكة.
// السلوك نفسه مختبرٌ فوق Prisma مزيّف في lots-reports.test.ts؛ هنا ما يجب ألا ينجرف بتعديلٍ لاحق.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r\n/g, '\n');
/** يزيل التعليقات مع الحفاظ على عدد الأسطر (نمط lots-static.test.ts) */
const stripComments = (src: string): string => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`])\/\/.*$/gm, (_m, p1: string) => p1);
const reports = (): string => stripComments(read('routes/reports.ts'));
const between = (src: string, a: string, b: string): string => {
  const i = src.indexOf(a);
  const j = src.indexOf(b, i + 1);
  assert.ok(i >= 0 && j > i, `«${a}» قبل «${b}»`);
  return src.slice(i, j);
};

test('B8: /reports/lot-sales تحت canViewReports (الموجّه كله) وrequireLots (العَلَم بعد المحاسبة) — مسجَّلٌ مرةً واحدة', () => {
  const r = reports();
  assert.ok(r.includes("router.use(authenticate, requireAdmin, requireAdminPermission('canViewReports'));"), 'صلاحية التقارير على الموجّه كله');
  assert.ok(r.indexOf('router.use(authenticate') < r.indexOf("router.get('/lot-sales'"), 'حرّاس الموجّه قبل المسار');
  assert.equal(r.split("router.get('/lot-sales'").length - 1, 1);
  assert.ok(r.includes("router.get('/lot-sales', requireLots, async"), 'حارس العَلَم على المسار');
  assert.match(r, /import \{[^}]*\brequireLots\b[^}]*\} from '\.\.\/middleware\/auth';/);
});

test('B8: lot-sales بالنطاق (scopedRecordWhere) والفريق بوسم الفاتورة، والمؤكَّدة وحدها، والشركة شرطٌ على الفاتورة وعلى صفوف اللوط', () => {
  const s = between(reports(), "router.get('/lot-sales'", 'export default router;');
  assert.ok(s.includes('const scope = await scopedRecordWhere(req, SHAPE_INVOICE_RECEIPT);'), 'نطاق المستخدم بشكل الفاتورة');
  assert.ok(s.includes('tenantId: tid, ...scope, ...teamDocWhere(reportTeamOf(req.query.teamId)),'), 'النطاق والفريق في شرط الفاتورة');
  // النطاق مفتاح AND: لا يُنثر بجانب AND آخر فيُكتب فوقه
  assert.ok(!/\.\.\.scope,[^\n]*\bAND:/.test(s) && !/\bAND:[^\n]*\.\.\.scope\b/.test(s), 'نثر النطاق بجانب AND يُسقطه');
  assert.ok(s.includes("status: 'CONFIRMED', invoiceDate, items: { some: { lots: { some: lotWhere } } },"), 'المؤكَّدة ذات صفوف اللوط');
  assert.match(s, /const lotWhere = \{\n\s+tenantId: tid,/, 'الشركة شرطٌ على صفوف اللوط نفسها');
  assert.ok(s.includes('where: { lots: { some: lotWhere } },') && s.includes('select: { lots: { where: lotWhere, select:'), 'بنودٌ وصفوفٌ مرشَّحة بالشرط نفسه');
  assert.ok(s.includes('loadLotMetas(prisma, tid,'), 'البطاقات بالشركة شرطاً (I5)');
  assert.ok(s.includes('prisma.product.findMany({ where: { tenantId: tid, id: { in: pids } }'), 'الأصناف بالشركة شرطاً');
  assert.ok(s.includes('units: ACTIVE_UNITS_SELECT'), 'وحدات الصنف النشطة للعارض (الكمية بالأساس)');
  assert.ok(s.includes('await companyDay(prisma, tid)') && s.includes('zonedStartOfDay('), 'المدى بأيام الشركة');
  assert.ok(s.includes('take: LOT_SALES_MAX_INVOICES + 1,') && s.includes('truncated,'), 'السقف مُعلَن');
  assert.ok(s.includes('scoped: Object.keys(scope).length > 0,'), 'الواجهة تعلم أن النتيجة مقيّدة');
});

test('B8: الكميات بالأساس — صفوف اللوط تُجمع كما هي (D22)، ولا يُجمع أساس صنفٍ إلى آخر في الملخّص', () => {
  const r = reports();
  const agg = between(r, 'export function lotSalesRows(', "router.get('/sales'");
  assert.ok(agg.includes('const q = Number(l.quantity) || 0;'), 'الكمية من صفّ اللوط (أساسية أصلاً)');
  assert.ok(!/\.qty\b/.test(agg) && !/baseQtyOf|unitFactor/.test(agg), 'لا كمية سطرٍ خام ولا تحويل مزدوج في التجميع');
  const at = agg.lastIndexOf('summary: {'); // ملخّص الردّ (لا نوع التوقيع)
  const summary = agg.slice(at, agg.indexOf('},', at));
  assert.ok(summary.includes('customers: all.customers.size'), 'ملخّص الردّ');
  assert.ok(!/sold|returned|net/.test(summary), 'الملخّص عدّاتٌ بلا كمية');
});

test('B8: withLots في تقرير المرتجع خلف الطلب والعَلَم معاً — بلا استعلامٍ إضافي حين يغيب، والشركة شرطٌ في قراءة الصفوف', () => {
  const r = reports();
  const s = between(r, "router.get('/returns'", "router.get('/collections'");
  assert.ok(s.includes("const lotsByItem = (req.query.withLots === '1' || req.query.withLots === 'true') && returns.length > 0 && await lotTrackingOn(tid)"),
    'العَلَم لا يُقرأ إلا مع withLots (1 أو true كقراءات الفاتورة والسيارة) ومرتجعات');
  assert.ok(s.includes('? await itemLotsOf(tid, returns.map((r) => r.id))'));
  assert.ok(s.includes('items: r.items.map(returnLineView).map((line, j) => (lotsByItem ? { ...line, lots: lotsByItem.get(r.items[j].id) ?? [] } : line)),'),
    'الحقل الجديد وحده، ومع الطلب وحده، فوق سطر الوحدة كما هو');
  assert.equal(s.split('invoiceItemLot').length - 1, 0, 'لا قراءة لصفوف اللوط في جسم المسار خارج itemLotsOf');
  const helper = between(r, 'async function itemLotsOf(', 'export interface LotSaleRowIn');
  assert.ok(helper.includes('where: { tenantId: tid, invoiceId: { in: invoiceIds } },'));
  assert.ok(r.includes("select: { lotTrackingEnabled: true } });\n  return t?.lotTrackingEnabled === true;"), 'العَلَم بشرط === true (تعذّر القراءة يُطفئ)');
  // دوال اللوط في مسارين وحدهما: المرتجع (خلف الشرط) وlot-sales (خلف requireLots)
  const body = r.slice(r.indexOf("router.get('/sales'"));
  const callers = (name: string) => body.split(`${name}(`).length - 1;
  assert.deepEqual([callers('lotTrackingOn'), callers('itemLotsOf'), callers('loadLotMetas'), callers('companyDay')], [1, 1, 1, 1]);
});

test('B8: التقارير قراءةٌ خالصة — لا كتابة ولا معاملة ولا قفل لوط ولا طابور في routes/reports.ts (لا تمسّ رصيداً فلا تُنتج سالباً)', () => {
  const r = reports();
  for (const w of ['.create(', '.createMany(', '.update(', '.updateMany(', '.upsert(', '.delete(', '.deleteMany(', '$executeRaw', '$transaction',
    'lockLotProducts', 'acquireLotQueue', 'resolveOrCreateLot', 'recordLotEvent', 'placeViews(']) {
    assert.ok(!r.includes(w), `routes/reports.ts يذكر ${w}`);
  }
});
