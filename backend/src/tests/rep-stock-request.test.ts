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
    [{ productId: 'a', qty: 5 }, { productId: 'c', qty: 1.5 }],
  );
  assert.deepEqual(normalizeRepLines([{ productId: 'a', qty: 0 }]), []);
  // فرق التمثيل العشريّ لا يصنع كمية جديدة
  assert.deepEqual(normalizeRepLines([{ productId: 'a', qty: 0.1 }, { productId: 'a', qty: 0.2 }]), [{ productId: 'a', qty: 0.3 }]);
});

test('رفعٌ ثانٍ من المندوب يحفظ تعديل الإدارة لما لم يغيّره، ويعتمد ما غيّره، ويُخرج ما أزاله', () => {
  const prev = [
    { productId: 'a', requestedQty: 10, qty: 6 }, // الإدارة خفّضته
    { productId: 'b', requestedQty: 4, qty: 0 },  // الإدارة حذفته
    { productId: 'c', requestedQty: 2, qty: 2 },
  ];
  const next = mergeRepUpdate(prev, [{ productId: 'a', qty: 10 }, { productId: 'b', qty: 5 }, { productId: 'd', qty: 1 }]);
  assert.deepEqual(next, [
    { productId: 'a', requestedQty: 10, qty: 6 }, // لم يتغيّر طلبه ⇒ يبقى تعديل الإدارة
    { productId: 'b', requestedQty: 5, qty: 5 },  // غيّره ⇒ يعود معتمداً بما كتب
    { productId: 'd', requestedQty: 1, qty: 1 },  // جديد
  ]); // c أزاله المندوب فخرج
});

test('تعديل الإدارة: كميات لأصناف الطلب فقط، والسالب يصير صفراً، وصنفٌ غريب يُرفض', () => {
  const prev = [{ productId: 'a', requestedQty: 10, qty: 10 }, { productId: 'b', requestedQty: 3, qty: 3 }];
  const ok = applyAdminEdit(prev, [{ productId: 'a', qty: 7 }]);
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.lines, [{ productId: 'a', requestedQty: 10, qty: 7 }, { productId: 'b', requestedQty: 3, qty: 3 }]);
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
  // الأصناف من الشركة نفسها وغير مؤرشفة
  assert.match(handler(s, "router.put('/mine'"), /prisma\.product\.count\(\{ where: \{ id: \{ in: ids \}, tenantId: tid, deletedAt: null \} \}\)/);
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
