// «تتبّع اللوط» — حرّاس نصّية للحزمة B2 (المواصفة §٨.٣): موجّه /api/lots وتسميته. نصّي على المصدر: لا قاعدة ولا شبكة.
// السلوك نفسه مختبرٌ في lots-api.test.ts؛ هنا ما يمنع انحرافاً صامتاً لاحقاً: القفل قبل أي قراءة رصيد أو كتابة في كل معاملة
// لوط، والطابور قبل المعاملة، والمسارات بعلامتي اقتباس مفردتين والثابتة قبل /:id، والتركيب في index.ts.
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

const ROUTER = stripComments(read('routes/lots.ts'));
/** ما يُعدّ قراءة رصيد لوط أو كتابة — يجب أن يسبقه lockLotProducts( في المعاملة نفسها */
const AFTER_LOCK = [/placeViews\(/, /namedLotBalances\(/, /lotHasReferences\(/, /loadLotMetas\(/, /resolveOrCreateLot\(/, /recordLotEvent\(/,
  /\btx\.\w+\.(create|createMany|update|updateMany|delete|deleteMany)\(/];

/** مقاطع المسارات: من router.<method>('…' حتى المسار التالي */
function routeSegments(src: string): { method: string; path: string; body: string }[] {
  const re = /router\.(get|post|put|patch|delete)\(\s*'([^']*)'/g;
  const hits = [...src.matchAll(re)];
  return hits.map((m, i) => ({ method: m[1], path: m[2], body: src.slice(m.index!, i + 1 < hits.length ? hits[i + 1].index : src.length) }));
}

test('B2: المسارات بعلامتي اقتباس مفردتين، والثابتة قبل /:id، والتركيب app.use(\'/api/lots\', lotsRouter) في index.ts', () => {
  assert.doesNotMatch(ROUTER, /router\.(get|post|put|patch|delete)\(\s*["`]/, 'مسارٌ بعلامة اقتباس غير مفردة');
  const segs = routeSegments(ROUTER);
  const paths = segs.map((s) => `${s.method.toUpperCase()} ${s.path}`);
  assert.deepEqual(paths, [
    'GET /', 'GET /balances', 'GET /fefo', 'GET /health', 'POST /', 'POST /relabel', 'POST /products/tracking', 'PUT /settings',
    'GET /:id', 'PATCH /:id', 'PATCH /:id/status', 'DELETE /:id', 'GET /:id/trace', 'GET /:id/unload-plan', 'GET /:id/events',
  ]);
  const firstParam = paths.findIndex((p) => p.includes(':'));
  assert.ok(paths.slice(0, firstParam).every((p) => !p.includes(':')) && paths.slice(firstParam).every((p) => p.includes('/:id')));
  // الحرّاس على الموجّه بالترتيب قبل أي مسار
  const order = ['router.use(authenticate);', "req.user?.role === 'SALES_REP'", 'router.use(requireLots);', "router.use(requireAdminPermission('canManageVanStock'));"];
  let at = -1;
  for (const frag of order) { const i = ROUTER.indexOf(frag); assert.ok(i > at, `الترتيب: ${frag}`); at = i; }
  assert.ok(at < ROUTER.indexOf("router.get('/'"), 'الحرّاس قبل أول مسار');
  const index = stripComments(read('index.ts'));
  assert.match(index, /^import lotsRouter from '\.\/routes\/lots';$/m);
  assert.match(index, /^app\.use\('\/api\/lots', lotsRouter\);/m);
});

test('B2: في كل معاملة لوط بالموجّه: lockLotProducts( يسبق أول قراءة رصيد وأول كتابة، والطابور قبل المعاملة بمهلة D13', () => {
  // inLotTx: الطابور أولاً ثم المعاملة بمهلة اللوط والتحرير في finally — وهي وحدها تفتح المعاملات
  const def = ROUTER.slice(ROUTER.indexOf('async function inLotTx<T>('), ROUTER.indexOf('const LOT_ROW_SELECT'));
  assert.ok(def.indexOf('acquireLotQueue(') >= 0 && def.indexOf('acquireLotQueue(') < def.indexOf('prisma.$transaction('));
  assert.match(def, /finally \{\s*release\(\);\s*\}/);
  assert.match(ROUTER, /const LOT_TX = \{ maxWait: 10_000, timeout: 20_000 \} as const;/);
  assert.equal(ROUTER.split('prisma.$transaction(').length - 1, 1, 'معاملة واحدة: داخل inLotTx');
  assert.doesNotMatch(ROUTER, /SET\s+LOCAL\s+lock_timeout/i);
  let txs = 0;
  for (const seg of routeSegments(ROUTER)) {
    const start = seg.body.indexOf('inLotTx(');
    if (start < 0) continue;
    const tx = seg.body.slice(start);
    txs++;
    if (tx.includes('relabelInTx(')) continue; // القفل داخل relabelInTx (الحارس التالي)
    const lock = tx.indexOf('lockLotProducts(');
    assert.ok(lock > 0, `${seg.method} ${seg.path}: بلا lockLotProducts(`);
    for (const re of AFTER_LOCK) {
      const m = re.exec(tx);
      if (m) assert.ok(m.index > lock, `${seg.method} ${seg.path}: ${re} قبل lockLotProducts(`);
    }
  }
  assert.equal(txs, 6, 'POST /، POST /relabel، POST /products/tracking، PATCH /:id، PATCH /:id/status، DELETE /:id');
  // تبديل التتبّع: صفوف الأصناف FOR UPDATE بمهلةٍ محلية تُستعاد، ثم قفل اللوط، ثم الكتابة (D25)
  const tracking = routeSegments(ROUTER).find((s) => s.path === '/products/tracking')!.body;
  const seq = ["SELECT current_setting('lock_timeout')", "set_config('lock_timeout', ${LOT_LOCK_TIMEOUT}, true)", 'FOR UPDATE', 'lockLotProducts(', "set_config('lock_timeout', ${prevRows", 'tx.product.updateMany('];
  let at = -1;
  for (const frag of seq) { const i = tracking.indexOf(frag); assert.ok(i > at, `التبديل: ${frag}`); at = i; }
  assert.match(tracking, /requireAdminPermission\('canManageProducts'\)/);
});

test('B2: relabelInTx — lockLotProducts( أولاً، ثم البطاقة والعرض وقيود المصدر (removalKeepsLots)، ثم الوجهة والكتابة', () => {
  const src = stripComments(read('services/lotsRelabel.ts'));
  const fn = src.slice(src.indexOf('export async function relabelInTx('));
  const lock = fn.indexOf('lockLotProducts(');
  assert.ok(lock > 0);
  for (const frag of ['loadLotMetas(', 'placeViews(', 'relabelSourceProblem(', 'resolveOrCreateLot(', 'tx.lotRelabel.create(', 'recordLotEvent(']) {
    const i = fn.indexOf(frag);
    assert.ok(i > lock, `${frag} قبل القفل`);
  }
  assert.ok(fn.indexOf('relabelSourceProblem(') < fn.indexOf('resolveOrCreateLot('), 'قيود المصدر قبل إنشاء أي لوط');
  // منع السالب بحارس الإزالة نفسه (لا دلالةٌ ثانية للسالب)، ولا تسوية مستودع (addAtAvg يغيّر التقييم)
  assert.match(src, /removalKeepsLots\(view, \[\{ productId: view\.productId, lotId: src\.fromLotId, bucket: src\.bucket, qty: src\.qty \}\]\)/);
  assert.doesNotMatch(src, /warehouseEntry|addAtAvg|vanLoad\./);
  // D27: لا مصدر موقوفاً ولا منتهياً
  assert.match(src, /fromMeta\.status !== 'ACTIVE'\) return lotErr\('LOT_BLOCKED'/);
  assert.match(src, /isLotExpiredOn\(fromMeta, src\.day\)\) return lotErr\('LOT_EXPIRED'/);
});

test('B2: اقتراح التحميل لكل سطرٍ بمعامله (allocateOutLines، D22) — لا توزيع المجموع ثم distributeToLines ولا allocateOut على المجموع', () => {
  const fefo = routeSegments(ROUTER).find((s) => s.path === '/fefo')!.body;
  assert.match(fefo, /allocateOutLines\(/);
  assert.doesNotMatch(ROUTER, /\ballocateOut\(|distributeToLines\(|aggregateRequest\(/);
});

test('B2: الأخطاء — معالج الموجّه يحوّل LotError والانشغال (lotHttpError) قبل 4xx، والرموز حرفياً بين علامتي اقتباس مفردتين', () => {
  const handler = ROUTER.slice(ROUTER.lastIndexOf('router.use((err: unknown'));
  // خطأ التحقق يمرّ إلى المعالج العام (400) قبل فحص الانشغال: رسالته تحمل قيم الطلب
  assert.ok(handler.indexOf('instanceof ZodError') >= 0 && handler.indexOf('instanceof ZodError') < handler.indexOf('lotHttpError(err)'));
  assert.ok(handler.indexOf('lotHttpError(err)') >= 0 && handler.indexOf('lotHttpError(err)') < handler.indexOf('status >= 400'));
  const all = ROUTER + stripComments(read('services/lotsRelabel.ts')) + stripComments(read('services/lotsTrace.ts'));
  for (const code of ['LOT_SCOPED_USER', 'LOT_REASON_REQUIRED', 'LOT_CHANGED', 'LOT_IN_USE', 'LOT_NUMBER_TAKEN', 'LOT_RELABEL_INVALID',
    'LOT_TRACKING_HAS_BALANCE', 'LOT_NOT_FOUND', 'LOT_BLOCKED', 'LOT_EXPIRED', 'LOT_QTY_INVALID']) {
    assert.ok(all.includes(`'${code}'`), code);
  }
});
