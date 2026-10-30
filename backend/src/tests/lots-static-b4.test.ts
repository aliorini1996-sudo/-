// «تتبّع اللوط» — حرّاس نصّية للحزمة B4 (المواصفة §٨.٣): مسار حركات السيارة في routes/vanStock.ts وservices/lotsVan.ts.
// نصّي على المصدر: لا قاعدة بيانات ولا شبكة. سلوك المسار نفسه في lots-van.test.ts.
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
const between = (src: string, from: string, to: string): string => {
  const i = src.indexOf(from);
  assert.ok(i >= 0, `بداية المقطع مفقودة: ${from}`);
  const j = src.indexOf(to, i + from.length);
  assert.ok(j > i, `نهاية المقطع مفقودة: ${to}`);
  return src.slice(i, j);
};

const van = read('routes/vanStock.ts');
const post = between(van, "router.post('/loads'", "router.get('/current'");
const LOT_BLOCK_START = 'if (preTracked.size) {';
const lotBlock = between(post, LOT_BLOCK_START, "\n    const load = outBucket");

test('POST /van-stock/loads: قفل الدلو ثم lockLotProducts( ثم assertOutAvailable ثم planVanMovementInTx ثم createLoad — داخل معاملةٍ بمهلة اللوط بعد الطابور', () => {
  const steps = [
    'const { day } = await companyDay(prisma, tid);',
    'const release = await acquireLotQueue(tid, preTracked);',
    'const out = await prisma.$transaction(async (tx) => {',
    "if (outBucket) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`van-${outBucket}:` + salesRepId}))`;",
    'const locked = await lockLotProducts(tx, tid, productIds);',
    'if (outBucket) await assertOutAvailable(outBucket);',
    'const plan = await planVanMovementInTx(tx, {',
    'return { load: await createLoad(tx, plan), warnings: plan.warnings };',
    '}, { maxWait: 10_000, timeout: 20_000 });',
    'throw asLotBusy(e) ?? e;',
    'release();',
  ];
  let at = -1;
  for (const s of steps) {
    const i = lotBlock.indexOf(s);
    assert.ok(i > at, `الترتيب: «${s}»`);
    at = i;
  }
  // ترتيب §٣.١: قفل الدلو قبل صفوف الأصناف وأقفال اللوط، وفحص رصيد الإزالة القائم بعدهما (return-links.test.ts)
  assert.ok(van.indexOf('await assertOutAvailable(outBucket);') > van.indexOf('pg_advisory_xact_lock'));
  // الطابور يُحرَّر في finally، ويُؤخذ قبل المعاملة لا داخلها
  assert.match(lotBlock, /\} finally \{\s*release\(\);\s*\}/);
  assert.ok(lotBlock.indexOf('acquireLotQueue(') < lotBlock.indexOf('prisma.$transaction('));
});

test('R1: مسار التحميل لا يستدعي دوال اللوط إلا داخل شرط العلم والصنف المتتبَّع، ونداء vanLoad.create واحد', () => {
  const code = stripComments(post);
  const gate = code.indexOf(LOT_BLOCK_START);
  assert.ok(gate > 0);
  for (const fn of ['companyDay(', 'acquireLotQueue(', 'lockLotProducts(', 'planVanMovementInTx(', 'asLotBusy(']) {
    const i = code.indexOf(fn);
    assert.ok(i > gate, `${fn} قبل شرط الصنف المتتبَّع`);
  }
  // الصنف المتتبَّع لا يُعرف إلا من قراءة الأصناف حين الميزة مفعّلة: preTracked فارغة ⇒ المسار القائم
  assert.ok(code.includes("const preTracked = new Set((lotProducts ?? []).filter(p => p.lotTracked === true).map(p => p.id));"));
  assert.ok(code.includes('const lotProducts = lotsOn'));
  assert.ok(code.includes('const lotsOn = gone !== null || rep?.tenant?.lotTrackingEnabled === true;'));
  // أعمدة البند وضمّ تشغيلاته في نداء الإنشاء الوحيد بشرط الخطة وحدها
  // بموضع السطر في الطلب (i.at) كما عرّفت به الخطة أسطرها — لا بموضعه بعد ترشيح الأصفار
  assert.ok(code.includes('...(plan && vanItemLotColumns(plan, i.at, {'));
  assert.ok(code.includes('const items = data.items.map((i, at) => ({ ...i, at })).filter(i => i.qty !== 0);'));
  assert.ok(code.includes('idx: i.at, productId: i.productId,'));
  assert.ok(code.includes('...(plan && { lots: ITEM_LOTS_INCLUDE })'));
  assert.equal((stripComments(van).match(/\.vanLoad\.(create|createMany|upsert)\(/g) ?? []).length, 1, 'نداء إنشاء الحركة واحد (locations.test.ts)');
  // deletedVanOf (D30) لا يُستدعى إلا بحقله
  assert.ok(code.includes('const gone = data.deletedSalesRepId !== undefined ? await deletedVanOf(req, tid, data) : null;'));
});

test('§١٠.١: العلمان في قراءة المندوب القائمة، والمطفأة بالعدّ القائم والمعاملة القائمة بلا مهلة جديدة', () => {
  assert.ok(post.includes('include: { tenant: { select: { locationsEnabled: true, lotTrackingEnabled: true, warehouseEnabled: true } } } });'), 'لا استعلام للعلم');
  assert.ok(post.includes('const valid = await prisma.product.count({ where: { id: { in: productIds }, tenantId: tid } });'));
  const legacy = between(post, '\n    const load = outBucket', 'res.status(201).json({ success: true, data: load });');
  assert.ok(legacy.includes('? await prisma.$transaction(async (tx) => {'));
  assert.ok(!legacy.includes('maxWait'), 'المسار القائم بلا خيارات (D13)');
  assert.ok(legacy.includes(': await createLoad(prisma);'));
  // الأجسام الجديدة اختيارية بلا تحقق في المخطط: أجسام الشركة المطفأة تُقبل كما كانت
  const schema = between(van, 'const loadSchema = z.object({', '\n});');
  for (const f of ['lots', 'lotNumber', 'productionDate', 'expiryDate', 'lotReason']) assert.ok(schema.includes(`${f}: z.unknown().optional(),`), f);
  assert.ok(schema.includes('deletedSalesRepId: z.string().optional(),'));
});

test('القراءات: withLots=1 وحده يقرأ العلم (D11)، وGET /lot-balances بنطاق المندوب وLOTS_NOT_ALLOWED', () => {
  const w = between(van, 'async function withLotsOf(', '\n}\n');
  assert.ok(w.indexOf("if (v !== '1' && v !== 'true') return false;") < w.indexOf('prisma.tenant.findUnique'), 'بلا المعامل لا استعلام');
  assert.equal(van.split('const withLots = await withLotsOf(req, tid);').length - 1, 2, '/loads و/movements');
  const lb = between(van, "router.get('/lot-balances'", "router.get('/suggest'");
  assert.ok(lb.includes('const salesRepId = isRep ? req.user!.id : queryRepId(req);'));
  assert.ok(lb.indexOf('await assertRepInScope(req, tid, salesRepId);') < lb.indexOf('vanLotSnapshot('));
  assert.ok(lb.indexOf("lotErr('LOTS_NOT_ALLOWED')") < lb.indexOf('vanLotSnapshot('));
});

test('المعالج: LotError بحالته ورمزه (lotHttpError) قبل فرع 4xx القائم، والانشغال يُحوَّل في مسار اللوط وحده', () => {
  const h = between(van, 'router.use((err: unknown', 'export default router;');
  const i = h.indexOf('const lh = err instanceof LotError ? lotHttpError(err) : null;');
  assert.ok(i > 0 && i < h.indexOf('status >= 400 && status < 500'));
  // اثنان: مسار اللوط، وغير المتتبَّع والميزة مفعّلة (D25، مشروطاً بـlotsOn) — والمطفأة لا تصل إليه
  const code = stripComments(van);
  assert.equal((code.match(/asLotBusy\(/g) ?? []).length, 2, 'مهلة معاملةٍ خارج اللوط (العهدة، الإزالة القائمة) لا تصير LOT_BUSY');
  assert.ok(code.includes('throw (lotsOn ? asLotBusy(e) : null) ?? e;'), 'تحويل غير المتتبَّع مشروط بعلم الشركة');
});

test('lotsVan: التحميل من المستودع بـallocateOutLines لكل سطر (D22) لا التجميع ثم distributeToLines، والإنقاص من السيارة بـpickOutSources بعد aggregateRequest (D26)', () => {
  const svc = stripComments(read('services/lotsVan.ts'));
  assert.match(svc, /allocateOutLines\(\{/);
  assert.doesNotMatch(svc, /\ballocateOut\(/, 'allocateOut على المجموع يشقّ الكرتون بلا وسم');
  const pick = between(svc, 'function pickPlan(', '\n}\n');
  assert.ok(pick.indexOf('aggregateRequest(') < pick.indexOf('pickOutSources('));
  // distributeToLines للمصدر الوحيد من pickOutSources وحده
  assert.equal((svc.match(/distributeToLines\(/g) ?? []).length, 1);
  assert.ok(pick.includes('distributeToLines(res.rows'));
  // I7 وisLotQty قبل أي قراءة، وI3 قبل الكتابة
  const plan = between(svc, 'export async function planVanMovementInTx(', '\nexport function vanItemLotColumns(');
  assert.ok(plan.indexOf('parseLine(') < plan.indexOf('placeViews('));
  assert.ok(plan.includes('LOT_I3_MISMATCH'));
  assert.ok(read('services/lotsVan.ts').includes("if (q < 0 && type !== 'ADJUST') throw lotErr('LOT_QTY_INVALID'"));
});
