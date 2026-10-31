import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeRepLines, mergeRepUpdate, applyAdminEdit } from '../services/repStockRequest';

/** «طلب بضاعة» المندوب — المنطق النقيّ وحرّاس الموجّه الثابتة (routes/repStockRequests.ts) */
const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8').replace(/\r\n/g, '\n');

test('ما يرسله المندوب: الصفر يُهمل والمكرّر يُجمع بترتيب أول ظهور', () => {
  assert.deepEqual(
    normalizeRepLines([{ productId: 'a', qty: 2 }, { productId: 'b', qty: 0 }, { productId: 'c', qty: 1.5 }, { productId: 'a', qty: 3 }]),
    [{ productId: 'a', qty: 5, unitName: null, unitFactor: 1 }, { productId: 'c', qty: 1.5, unitName: null, unitFactor: 1 }],
  );
  assert.deepEqual(normalizeRepLines([{ productId: 'a', qty: 0 }]), []);
  // فرق التمثيل العشريّ لا يصنع كمية جديدة
  assert.deepEqual(normalizeRepLines([{ productId: 'a', qty: 0.1 }, { productId: 'a', qty: 0.2 }]), [{ productId: 'a', qty: 0.3, unitName: null, unitFactor: 1 }]);
});

test('رفعٌ ثانٍ من المندوب يحفظ تعديل الإدارة لما لم يغيّره، ويعتمد ما غيّره، ويُخرج ما أزاله', () => {
  const prev = [
    { productId: 'a', requestedQty: 10, qty: 6 }, // الإدارة خفّضته
    { productId: 'b', requestedQty: 4, qty: 0 },  // الإدارة حذفته
    { productId: 'c', requestedQty: 2, qty: 2 },
  ];
  const next = mergeRepUpdate(prev, [{ productId: 'a', qty: 10 }, { productId: 'b', qty: 5 }, { productId: 'd', qty: 1 }]);
  assert.deepEqual(next, [
    { productId: 'a', requestedQty: 10, qty: 6, unitName: null, unitFactor: 1 }, // لم يتغيّر طلبه ⇒ يبقى تعديل الإدارة
    { productId: 'b', requestedQty: 5, qty: 5, unitName: null, unitFactor: 1 },  // غيّره ⇒ يعود معتمداً بما كتب
    { productId: 'd', requestedQty: 1, qty: 1, unitName: null, unitFactor: 1 },  // جديد
  ]); // c أزاله المندوب فخرج
});

test('تعديل الإدارة: كميات لأصناف الطلب فقط، والسالب يصير صفراً، وصنفٌ غريب يُرفض', () => {
  const prev = [{ productId: 'a', requestedQty: 10, qty: 10 }, { productId: 'b', requestedQty: 3, qty: 3 }];
  const ok = applyAdminEdit(prev, [{ productId: 'a', qty: 7 }]);
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.lines, [{ productId: 'a', requestedQty: 10, qty: 7, unitName: null, unitFactor: 1 }, { productId: 'b', requestedQty: 3, qty: 3, unitName: null, unitFactor: 1 }]);
  const zero = applyAdminEdit(prev, [{ productId: 'b', qty: 0 }]);
  assert.ok(zero.ok && zero.lines[1].qty === 0 && zero.lines[1].requestedQty === 3, 'الحذف صفرٌ يبقى سطره بما طلبه المندوب');
  assert.deepEqual(applyAdminEdit(prev, [{ productId: 'x', qty: 1 }]), { ok: false, productId: 'x' });
});

const route = () => read('routes', 'repStockRequests.ts');
const handler = (src: string, sig: string) => {
  const start = src.indexOf(sig);
  assert.ok(start >= 0, `المسار غير موجود: ${sig}`);
  const end = src.indexOf('\nrouter.', start + sig.length);
  return src.slice(start, end < 0 ? undefined : end);
};

// ═══ الوحدات المتعددة: سطرٌ واحد لكل صنف (@@unique([requestId, productId])) بوحدةٍ واحدة ═══
const CT = { unitName: 'كرتون', unitFactor: 24 };
const BASE = { unitName: null, unitFactor: 1 };

test('الوحدات: سطران للصنف بوحدةٍ واحدة يُجمعان بها، وبوحدتين يصيران سطراً بالأساس بلا كسر كرتون', () => {
  assert.deepEqual(
    normalizeRepLines([{ productId: 'a', qty: 2, ...CT }, { productId: 'a', qty: 3, ...CT }]),
    [{ productId: 'a', qty: 5, ...CT }],
    'خمسة كراتين تبقى كراتين كما كتبها المندوب',
  );
  assert.deepEqual(
    normalizeRepLines([{ productId: 'a', qty: 5, ...CT }, { productId: 'a', qty: 3 }, { productId: 'b', qty: 2, ...CT }]),
    [{ productId: 'a', qty: 123, ...BASE }, { productId: 'b', qty: 2, ...CT }],
    '٥ كرتون + ٣ حبة = ١٢٣ حبة لا ٥٫١٢٥ كرتون، والصنف الآخر بوحدته',
  );
  // اسم الوحدة جزءٌ من هويتها: «كرتون» و«صندوق» بمعاملٍ واحد وحدتان
  assert.deepEqual(
    normalizeRepLines([{ productId: 'a', qty: 1, ...CT }, { productId: 'a', qty: 1, unitName: 'صندوق', unitFactor: 24 }]),
    [{ productId: 'a', qty: 48, ...BASE }],
  );
});

test('الوحدات: «لم يغيّر المندوب طلبه» بالأساس — ٢٤ حبة بعد كرتونٍ الطلبُ نفسه، وكرتونان بعد حبّتين تغيير', () => {
  const prev = [
    { productId: 'a', requestedQty: 1, qty: 1, ...CT },   // كرتون — لم تعدّله الإدارة
    { productId: 'b', requestedQty: 2, qty: 1, ...BASE }, // حبّتان — خفّضتهما الإدارة إلى حبّة
    { productId: 'c', requestedQty: 3, qty: 2, ...CT },   // ٣ كراتين — خفّضتها الإدارة إلى كرتونين
  ];
  const next = mergeRepUpdate(prev, [
    { productId: 'a', qty: 24, ...BASE },
    { productId: 'b', qty: 2, ...CT },
    { productId: 'c', qty: 3, ...CT },
  ]);
  assert.deepEqual(next, [
    { productId: 'a', requestedQty: 1, qty: 1, ...CT },   // ٢٤ حبة = كرتون ⇒ السطر كما راجعته الإدارة بوحدته
    { productId: 'b', requestedQty: 2, qty: 2, ...CT },   // ٤٨ حبة ≠ حبّتين ⇒ طلبٌ جديد معتمدٌ بما كتب
    { productId: 'c', requestedQty: 3, qty: 2, ...CT },   // لم يتغيّر ⇒ يبقى تعديل الإدارة
  ]);
  // صفوف القاعدة القديمة بلا وحدة (unitFactor=1) تُقرأ بالأساس — السلوك القائم حرفياً
  assert.deepEqual(mergeRepUpdate([{ productId: 'a', requestedQty: 10, qty: 6 }], [{ productId: 'a', qty: 10 }]), [{ productId: 'a', requestedQty: 10, qty: 6, ...BASE }]);
});

test('الوحدات: تعديل الإدارة بلا وحدة بوحدة السطر، وبوحدته نفسها كذلك، وبوحدةٍ أخرى يعود السطر كلّه إلى الأساس', () => {
  const prev = [{ productId: 'a', requestedQty: 5, qty: 5, ...CT }];
  const same = applyAdminEdit(prev, [{ productId: 'a', qty: 4 }]);
  assert.deepEqual(same.ok && same.lines, [{ productId: 'a', requestedQty: 5, qty: 4, ...CT }], 'الإداري يكتب رقماً بجانب «كرتون» ⇒ كراتين');
  const explicit = applyAdminEdit(prev, [{ productId: 'a', qty: 4, ...CT }]);
  assert.deepEqual(explicit.ok && explicit.lines, [{ productId: 'a', requestedQty: 5, qty: 4, ...CT }]);
  const pieces = applyAdminEdit(prev, [{ productId: 'a', qty: 100, ...BASE }]);
  assert.deepEqual(pieces.ok && pieces.lines, [{ productId: 'a', requestedQty: 120, qty: 100, ...BASE }], 'طلب ٥ كرتون واعتُمد ١٠٠ حبة ⇒ ١٢٠ مقابل ١٠٠ بالأساس');
  // سطرٌ بالأساس يُعتمد بالكرتون: يبقى بالأساس والكمية مضروبة
  const up = applyAdminEdit([{ productId: 'a', requestedQty: 30, qty: 30, ...BASE }], [{ productId: 'a', qty: 1, ...CT }]);
  assert.deepEqual(up.ok && up.lines, [{ productId: 'a', requestedQty: 30, qty: 24, ...BASE }]);
});

test('حارس نصّي: الكتابة بلقطة الوحدة، والسقف بالأساس، والوحدة يحلّها الخادم لا رقمٌ من الجسم', () => {
  const s = route();
  assert.match(s, /unitId: z\.string\(\)\.max\(64\)\.nullish\(\),/);
  assert.doesNotMatch(s, /unitFactor: z\./, 'معاملٌ من الجسم لا يُقبل');
  assert.match(s, /const fieldsOf = \(l: OutLine\) => \(\{ requestedQty: l\.requestedQty, \.\.\.unitFields\(l\.qty, \{ name: l\.unitName, factor: l\.unitFactor \}\) \}\);/);
  const mine = handler(s, "router.put('/mine'");
  assert.ok(mine.indexOf('resolveLineUnits(tid, data.items)') < mine.indexOf('normalizeRepLines('), 'الوحدة تُحلّ قبل الجمع');
  assert.match(mine, /if \(overCap\(lines\)\)/);
  assert.match(mine, /items: \{ create: merged\.map\(rowOf\) \}/);
  const edit = handler(s, "router.put('/:id'");
  assert.match(edit, /\.\.\.\(i\.unitId !== undefined && \{ unitName: units\[idx\]\.name, unitFactor: units\[idx\]\.factor \}\),/, 'الغائبة ⇒ وحدة السطر');
  assert.match(edit, /if \(overCap\(edit\.lines\)\)/);
  assert.match(edit, /data: fieldsOf\(l\)/);
});

test('الحرّاس: مصادقة ثم «النظام المحاسبي» ثم صلاحية المخزون ثم المستودع المفعّل — قبل أي مسار', () => {
  const s = route();
  const order = ['router.use(authenticate);', 'router.use(requireAccounting);', "router.use(requireAdminPermission('canManageVanStock'));", 'warehouseEnabled'];
  const at = order.map((x) => s.indexOf(x));
  at.forEach((p, i) => assert.ok(p > 0, `غائب: ${order[i]}`));
  assert.deepEqual([...at].sort((a, b) => a - b), at, 'ترتيب الحرّاس');
  assert.ok(at[3] < s.indexOf("router.get('/mine'"), 'حارس المستودع بعد أول مسار');
});

test('مسارات المندوب له وحده، ومعرّفه من توكنه لا من الطلب', () => {
  const s = route();
  for (const sig of ["router.get('/mine', repOnly,", "router.put('/mine', repOnly,", "router.delete('/mine', repOnly,"]) {
    const h = handler(s, sig);
    assert.match(h, /const me = req\.user!\.id;/);
    assert.match(h, /salesRepId: me/);
    assert.doesNotMatch(h, /req\.(body|query|params)\.salesRepId/);
  }
  // الأصناف من الشركة نفسها وغير مؤرشفة — ومعها أساسها (§2.9) في الاستعلام نفسه، يُقرأ قبل حلّ الوحدات، والعدد يطابق
  const mine = handler(s, "router.put('/mine'");
  assert.match(mine, /prisma\.product\.findMany\(\{\s*where: \{ id: \{ in: \[\.\.\.new Set\(data\.items\.map\(\(i\) => i\.productId\)\)\] \}, tenantId: tid, deletedAt: null \}, select: \{ id: true, name: true, unit: true, baseConvertedAt: true \},?\s*\}\)/);
  assert.ok(mine.indexOf('prisma.product.findMany(') < mine.indexOf('resolveLineUnits('), 'أساس الصنف قبل حلّ الوحدات');
  assert.match(mine, /const prods = itemProds\.filter\(\(p\) => idSet\.has\(p\.id\)\);/);
  assert.match(mine, /if \(prods\.length !== ids\.length\) \{ res\.status\(400\)/);
});

test('مسارات الإدارة لغير المندوب، ومقيّدة بالشركة ونطاق المستخدم، وتحت قفل الشركة مع فحص النسخة', () => {
  const s = route();
  for (const sig of ["router.get('/', companyOnly,", "router.post('/send', companyOnly,", "router.put('/:id', companyOnly,", "router.post('/:id/reject', companyOnly,"]) {
    const h = handler(s, sig);
    assert.match(h, /tenantId: tid|pendingForEdit\(tx, req, tid/, `${sig} بلا عزل شركة`);
    assert.match(h, /repScopeWhere\(req\)|pendingForEdit\(/, `${sig} بلا نطاق المستخدم`);
    if (!sig.startsWith("router.get")) assert.match(h, /await lockTenant\(tx, tid\);/, `${sig} بلا قفل`);
  }
  assert.match(s, /async function pendingForEdit[\s\S]*?tenantId: tid, status: 'PENDING', \.\.\.\(await repScopeWhere\(req\)\)[\s\S]*?updatedAt\.toISOString\(\) !== seen/);
  // الإرسال يرفض نصف ما رآه الإداري: غيابٌ أو نسخة مختلفة ⇒ 409 والمعاملة كلها تُلغى
  assert.match(handler(s, "router.post('/send'"), /rows\.length !== want\.size \|\| rows\.some\(\(r\) => r\.updatedAt\.toISOString\(\) !== want\.get\(r\.id\)\)/);
  // /send قبل /:id
  assert.ok(s.indexOf("router.post('/send'") < s.indexOf("router.put('/:id'"));
});

test('كتابة المندوب تحت قفل الشركة نفسه: طلبٌ معلّق واحد لا يتكرّر', () => {
  const h = handler(route(), "router.put('/mine'");
  const lock = h.indexOf('await lockTenant(tx, tid);');
  const find = h.indexOf("status: 'PENDING' }");
  assert.ok(lock > 0 && find > lock, 'البحث عن المعلّق قبل القفل');
});

test('مُركَّب على /api/rep-stock-requests ومصنَّف في اختبار الموقع', () => {
  const idx = read('index.ts');
  assert.match(idx, /app\.use\('\/api\/rep-stock-requests', repStockRequestsRouter\);/);
});
