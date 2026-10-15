import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldStock, type LoadRow, type InvRow } from '../routes/vanStock';

/**
 * تصفية مخزون السيارة بالتاريخ — الفرق بين الرصيد والتدفّق.
 *
 * الفخّ الذي تحرسه هذه الاختبارات: «المحمَّل» و«المُباع» تدفّقات تُصفَّى بالمدّة،
 * لكن «المتبقّي» **رصيدٌ** لا يخصّ مدّة. لو صُفِّي هو الآخر داخل النافذة لظهر
 * مندوبٌ حُمِّل الشهر الماضي وباع هذا الشهر برصيد **سالب** — وهو رقمٌ يقرأه
 * المالك على أنه عجز في السيارة ولا وجود له.
 *
 * الصفوف تصل هنا مقيَّدةً بنهاية المدّة من الاستعلام، و`from` يُرشَّح داخل الطيّ.
 */

const D = (s: string) => new Date(s + 'T10:00:00.000Z');
const load = (productId: string, qty: number, date: string, type = 'LOAD'): LoadRow =>
  ({ productId, qty, vanLoad: { type, createdAt: D(date) } });
const sale = (productId: string, qty: number, date: string, type = 'CASH', returnToStock: boolean | null = null): InvRow =>
  ({ productId, qty, invoice: { type, returnToStock, invoiceDate: D(date) } });

const remaining = (b: { loaded: number; unloaded: number; adjusted: number; sold: number; returned: number }) =>
  b.loaded - b.unloaded + b.adjusted - b.sold + b.returned;

test('بلا نافذة: التدفّق يساوي الرصيد — السلوك القديم محفوظ حرفياً', () => {
  const { acc, bal } = foldStock([load('p', 100, '2026-08-01')], [sale('p', 30, '2026-08-05')], undefined);
  assert.deepEqual(acc.get('p'), bal.get('p'));
  assert.equal(remaining(bal.get('p')!), 70);
});

test('الفخّ: تحميلٌ قبل المدّة وبيعٌ داخلها لا يُنتج رصيداً سالباً', () => {
  // حُمِّل 100 في أغسطس، بيع 30 في سبتمبر. النافذة سبتمبر وحده.
  const { acc, bal } = foldStock(
    [load('p', 100, '2026-08-01')],
    [sale('p', 30, '2026-09-10')],
    D('2026-09-01'),
  );
  // التدفّق: لا تحميل داخل المدّة، ومبيعات 30
  assert.equal(acc.get('p')!.loaded, 0);
  assert.equal(acc.get('p')!.sold, 30);
  // الرصيد تراكميّ فيبقى موجباً — ولو صُفِّي بالنافذة لصار −30
  assert.equal(remaining(bal.get('p')!), 70);
  assert.ok(remaining(bal.get('p')!) > 0, 'الرصيد لا يجوز أن يكون سالباً هنا');
});

test('صنفٌ لم يتحرّك داخل المدّة يبقى في الجدول برصيده لا يختفي', () => {
  const { acc, bal } = foldStock([load('p', 40, '2026-07-01')], [], D('2026-09-01'));
  assert.equal(acc.has('p'), false, 'لا تدفّق داخل المدّة');
  assert.equal(remaining(bal.get('p')!), 40, 'لكن رصيده قائم');
  // المسار يمرّ على bal لا acc، فهذا الصنف يُعرض بمحمَّل صفر ومتبقٍّ 40
});

test('التصفية تفصل صنفاً عن صنف — لا تسرّب بين المنتجات', () => {
  const { acc, bal } = foldStock(
    [load('a', 10, '2026-09-02'), load('b', 5, '2026-08-02')],
    [sale('a', 4, '2026-09-03')],
    D('2026-09-01'),
  );
  assert.equal(acc.get('a')!.loaded, 10);
  assert.equal(acc.get('a')!.sold, 4);
  assert.equal(acc.has('b'), false);
  assert.equal(remaining(bal.get('a')!), 6);
  assert.equal(remaining(bal.get('b')!), 5);
});

test('حدّ المدّة شامل ليومه — حركةٌ في تاريخ البداية تدخل النافذة', () => {
  const { acc } = foldStock([load('p', 7, '2026-09-01')], [], D('2026-09-01'));
  assert.equal(acc.get('p')!.loaded, 7, 'حركة يوم البداية داخل المدّة');
});

test('المرتجع لا يعود للسيارة إلا بـreturnToStock', () => {
  const noBack = foldStock([], [sale('p', 5, '2026-09-02', 'RETURN', false)], undefined);
  assert.equal(noBack.bal.get('p')!.returned, 0);
  const back = foldStock([], [sale('p', 5, '2026-09-02', 'RETURN', true)], undefined);
  assert.equal(back.bal.get('p')!.returned, 5);
  // ولا يُحسب مبيعاً في الحالتين
  assert.equal(noBack.bal.get('p')!.sold, 0);
});

test('بندٌ بلا معرّف منتج يُتجاهل ولا يفتح صفّاً بمفتاح فارغ', () => {
  const { bal } = foldStock([], [{ productId: null, qty: 9, invoice: { type: 'CASH', returnToStock: null, invoiceDate: D('2026-09-02') } }], undefined);
  assert.equal(bal.size, 0);
});

test('التنزيل والتسوية يدخلان النافذة كما يدخل التحميل', () => {
  const { acc, bal } = foldStock(
    [load('p', 100, '2026-08-01'), load('p', 20, '2026-09-05', 'UNLOAD'), load('p', 3, '2026-09-06', 'ADJUST')],
    [],
    D('2026-09-01'),
  );
  assert.equal(acc.get('p')!.unloaded, 20);
  assert.equal(acc.get('p')!.adjusted, 3);
  assert.equal(acc.get('p')!.loaded, 0, 'تحميل أغسطس خارج المدّة');
  assert.equal(remaining(bal.get('p')!), 83, '100 − 20 + 3');
});

// ═══ «المرتجع التالف» في السيارة (طلب المالك ١٥ أكتوبر ٢٠٢٦): رصيدٌ لا يُباع منذ DAMAGED_VAN_SINCE ═══
import { DAMAGED_VAN_SINCE, isDamagedVanReturn } from '../routes/vanStock';

const after = new Date(DAMAGED_VAN_SINCE.getTime() + 60_000);
const before = new Date(DAMAGED_VAN_SINCE.getTime() - 60_000);
const ret = (qty: number, returnReason: string, createdAt: Date, returnToStock: boolean | null, returnExpired?: boolean): InvRow =>
  ({ productId: 'p', qty, returnExpired, invoice: { type: 'RETURN', returnToStock, invoiceDate: createdAt, returnReason, createdAt } });
const avail = (b: { loaded: number; unloaded: number; adjusted: number; sold: number; returned: number }) =>
  b.loaded - b.unloaded + b.adjusted - b.sold + b.returned;

test('التالف بعد البدء: يدخل «المرتجع التالف» مهما كانت returnToStock، ولا يُحسب في المتاح', () => {
  const { bal } = foldStock([load('p', 20, '2026-10-01')], [
    ret(3, 'DAMAGED', after, true), // سياسة الصنف «يعود للمخزون» لا تجعله قابلاً للبيع
    ret(2, 'DAMAGED', after, false),
    ret(1, 'NORMAL', after, true), // العادي يعود للمتاح كما اليوم
  ], undefined);
  const b = bal.get('p')!;
  assert.equal(b.damagedIn, 5);
  assert.equal(b.returned, 1);
  assert.equal(avail(b), 21, 'المتاح لا يحمل التالف');
});

test('التالف قبل البدء: حسابه كما كان (لا رصيد تالف بأثرٍ رجعي)', () => {
  const { bal } = foldStock([], [ret(4, 'DAMAGED', before, true), ret(6, 'DAMAGED', before, false)], undefined);
  const b = bal.get('p')!;
  assert.equal(b.damagedIn, 0);
  assert.equal(b.returned, 4, 'القديم الذي عاد للمخزون يبقى في المتاح');
  assert.equal(isDamagedVanReturn({ returnReason: 'DAMAGED', createdAt: null }), false, 'بلا لحظة تسجيل: لا يُعدّ');
  assert.equal(isDamagedVanReturn({ returnReason: 'DAMAGED', createdAt: DAMAGED_VAN_SINCE }), true, 'لحظة البدء نفسها تُعدّ');
});

test('التالف المنتهي صلاحيته يدخل «منتهي الصلاحية» (الأسبقية للمنتهي كما كانت)', () => {
  const { bal } = foldStock([], [ret(2, 'DAMAGED', after, false, true)], undefined);
  const b = bal.get('p')!;
  assert.equal(b.expiredIn, 2);
  assert.equal(b.damagedIn, 0);
});

test('إزالة التالف تنقص رصيده هو لا المتاح ولا المنتهي، وليست تسوية', () => {
  const { bal, acc } = foldStock(
    [load('p', 10, '2026-10-01'), load('p', 2, '2026-10-20', 'DAMAGED_OUT')],
    [ret(3, 'DAMAGED', after, null)], D('2026-10-18'));
  const b = bal.get('p')!;
  assert.equal(b.damagedIn - b.damagedOut, 1);
  assert.equal(b.adjusted, 0, 'الإزالة ليست تسوية');
  assert.equal(b.expiredOut, 0);
  assert.equal(avail(b), 10);
  assert.equal(acc.get('p')!.damagedOut, 2, 'الإزالة داخل النافذة تدفّق');
});

// ═══ عهدة أدوات السيارة (طلب المالك ١٥ أكتوبر ٢٠٢٦): دفتر حركات تسليم/استلام والرصيد مشتقّ ═══
import fs from 'node:fs';
import path from 'node:path';
import { foldTools, toolCountsByRep, toolKey } from '../routes/vanStock';

test('العهدة: الرصيد لكل أداة = المسلَّم − المستلَم، والاسم بلا فروق المسافات، والصفري لا يظهر', () => {
  const out = foldTools([
    { toolName: 'عربة تحميل', qty: 1, type: 'ISSUE' },
    { toolName: ' سلة ', qty: 5, type: 'ISSUE' },
    { toolName: 'سلة', qty: 2, type: 'RETURN' },
    { toolName: 'ميزان', qty: 1, type: 'ISSUE' },
    { toolName: 'ميزان', qty: 1, type: 'RETURN' },
  ]);
  assert.deepEqual(out, [{ toolName: 'سلة', qty: 3 }, { toolName: 'عربة تحميل', qty: 1 }]);
  assert.equal(toolKey('  Cart   XL '), 'cart xl');
});

test('العهدة: عدد أدوات كل مندوب من المجموع المجمَّع، وصفوف بلا مندوب (محذوف) تُهمل', () => {
  const m = toolCountsByRep([
    { salesRepId: 'r1', type: 'ISSUE', _sum: { qty: 6 } },
    { salesRepId: 'r1', type: 'RETURN', _sum: { qty: 2 } },
    { salesRepId: 'r2', type: 'ISSUE', _sum: { qty: 1 } },
    { salesRepId: null, type: 'ISSUE', _sum: { qty: 9 } },
  ]);
  assert.equal(m.get('r1'), 4);
  assert.equal(m.get('r2'), 1);
  assert.equal(m.size, 2);
});

test('حارس نصّي: العهدة تكتبها الإدارة وحدها بقفلٍ للمندوب، والملخّص يحمل التالف والأدوات، والقاعدة في الطرفين واحدة', () => {
  const van = fs.readFileSync(path.join(process.cwd(), 'src', 'routes', 'vanStock.ts'), 'utf8');
  assert.ok(van.includes("router.post('/tools', requireAdmin, async"), 'تسليم/استلام الأدوات للإدارة وحدها');
  const post = van.slice(van.indexOf("router.post('/tools'"));
  assert.ok(post.indexOf('await assertRepInScope(req, tid, data.salesRepId);') > 0, 'نطاق المندوب');
  assert.ok(post.indexOf("pg_advisory_xact_lock(hashtext(${'van-tools:' + data.salesRepId}))") < post.indexOf("if (data.type === 'RETURN')"), 'الفحص بعد القفل');
  assert.ok(van.includes("createdById: actor"), 'جلسة المالك تُسجَّل OWNER: (actorOf)');
  const get = van.slice(van.indexOf("router.get('/tools'"), van.indexOf("router.post('/tools'"));
  assert.ok(get.includes('await assertRepInScope(req, tid, salesRepId);') && get.includes("const salesRepId = isRep ? req.user!.id"), 'المندوب يرى عهدته وحده');
  assert.ok(van.includes('totalDamaged: roundDecimal(') && van.includes('toolsCount: toolsByRep.get(r.id) ?? 0'));
  // نسخة الواجهة من لحظة البدء تطابق الخادم حرفياً
  const web = fs.readFileSync(path.join(process.cwd(), '..', 'web-admin', 'src', 'lib', 'vanDamaged.ts'), 'utf8');
  assert.ok(web.includes(`new Date('${DAMAGED_VAN_SINCE.toISOString()}')`), 'لحظة بدء التالف في الواجهة تخالف الخادم');
});

test('حارس نصّي (مراجعة ١٥ أكتوبر): معرّف المندوب من الاستعلام نصاً وحده، وأخطاء 4xx بحالتها، ومجموع التالف موجبٌ', () => {
  const van = fs.readFileSync(path.join(process.cwd(), 'src', 'routes', 'vanStock.ts'), 'utf8');
  // ?salesRepId[in][]=A&salesRepId[in][]=B كائنٌ يصير شرط Prisma فيتجاوز حارس النطاق
  assert.ok(!/req\.query\.salesRepId as string/.test(van), 'معرّف مندوب من الاستعلام بلا فحص نوع');
  assert.equal(van.split('queryRepId(req)').length - 1, 6, 'كل مسارات القراءة تمرّ بـqueryRepId');
  assert.ok(van.includes("if (typeof salesRepId !== 'string' || !salesRepId) throw"), 'حارس النطاق يرفض غير النصّ');
  assert.ok(van.includes('status >= 400 && status < 500') && van.indexOf('router.use((err: unknown') < van.indexOf('export default router;'));
  assert.ok(van.includes('s + Math.max(0, x.damaged)'), 'رصيدٌ سالب لصنف لا يُخفي تالف صنفٍ آخر');
});
