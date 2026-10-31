// تقرير المرتجع (GET /reports/returns) — حارسٌ نصّي: النطاق والحالة والنوع، ونسبة المرتجع على مبيعات المدى نفسه في النطاق نفسه.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { returnLineView, salesByProduct } from '../routes/reports';

test('تقرير المرتجع: المؤكَّدة من نوع المرتجع في نطاق المستخدم، والنسبة على مبيعات النطاق والمدى نفسيهما', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports.ts'), 'utf8').replace(/\r\n/g, '\n');
  const i = src.indexOf("router.get('/returns'");
  assert.ok(i > 0, 'المسار غائب');
  const h = src.slice(i, src.indexOf("router.get('/collections'"));
  // نطاق المستخدم ومعه فلتر الفريق — في النطاق نفسه فيطبَّق على المرتجعات وعلى مبيعات النسبة معاً
  assert.match(h, /const scope = \{ \.\.\.\(await scopedRecordWhere\(req, SHAPE_INVOICE_RECEIPT\)\), \.\.\.teamDocWhere\(reportTeamOf\(req\.query\.teamId\)\) \};/, 'نطاق المستخدم والفريق');
  assert.match(h, /where: \{ tenantId: tid, \.\.\.scope, status: 'CONFIRMED', type: 'RETURN', invoiceDate: dateFilter \}/, 'المرتجعات المؤكَّدة');
  assert.match(h, /where: \{ tenantId: tid, \.\.\.scope, status: 'CONFIRMED', type: \{ not: 'RETURN' \}, invoiceDate: dateFilter \}/, 'مبيعات المدى نفسه');
  assert.match(h, /returnRate: salesTotal > 0 \?/, 'لا قسمة على صفر');
  assert.match(h, /where: \{ id: \{ in: saleItemIds \}, invoice: \{ tenantId: tid \} \}/, 'فاتورة البيع من الشركة نفسها');
  assert.match(h, /: \{ gte: new Date\(Date\.now\(\) - DEFAULT_DAYS/, 'بلا مدى: ٩٠ يوماً لا كل التاريخ');
});

test('الوحدات المتعددة: بند المرتجع بوحدته هو (لقطة البند) لا بوحدة الصنف اليوم، ومعه الكمية بالأساس', () => {
  const base = { lineTotal: 0.42, returnExpired: null, expiresAt: null, itemName: null };
  // حبّةٌ أُرجعت من صنفٍ أساسه «حبة» ووحدته الأكبر «كرتون»: تظهر «١ حبة» لا «١ كرتون»
  const piece = returnLineView({ ...base, qty: 1, unitName: null, unitFactor: 1, baseQty: 1, product: { name: 'ببسي', unit: 'حبة' } });
  assert.deepEqual([piece.qty, piece.unit, piece.baseQty, piece.baseUnit, piece.unitFactor], [1, 'حبة', 1, 'حبة', 1]);
  // كرتونٌ مرتجع: الوحدة من اللقطة، والأساس ٢٤
  const carton = returnLineView({ ...base, lineTotal: 10, qty: 1, unitName: 'كرتون', unitFactor: 24, baseQty: 24, product: { name: 'ببسي', unit: 'حبة' } });
  assert.deepEqual([carton.qty, carton.unit, carton.baseQty, carton.baseUnit, carton.unitFactor], [1, 'كرتون', 24, 'حبة', 24]);
  // بندٌ سبق الميزة: بلا لقطة ⇒ وحدة الصنف كما كان، والأساس من الكمية (baseQty فارغ لم يملأه الترحيل)
  const legacy = returnLineView({ ...base, lineTotal: 5, qty: 3, unitName: null, unitFactor: 1, baseQty: null, product: { name: 'حليب', unit: 'كرتون' }, expiresAt: new Date('2026-10-01T00:00:00Z') });
  assert.deepEqual(legacy, { name: 'حليب', unit: 'كرتون', qty: 3, unitFactor: 1, baseQty: 3, baseUnit: 'كرتون', lineTotal: 5, returnExpired: null, expiresAt: '2026-10-01' });
  // صنفٌ محذوف: الاسم من لقطة البند
  assert.equal(returnLineView({ ...base, qty: 1, itemName: 'قديم', product: null }).name, 'قديم');
});

test('الوحدات المتعددة: المبيعات حسب الصنف تُجمع بالأساس، ووحدة الأساس ووحداته مع كل صفّ، والمبلغ كما هو', () => {
  const cans = { id: 'cans', name: 'ببسي', code: 'P1', unit: 'حبة' };
  const milk = { id: 'milk', name: 'حليب', code: 'P2', unit: 'كرتون' };
  const rows = salesByProduct([
    { items: [
      { qty: 2, unitName: 'كرتون', unitFactor: 24, baseQty: 48, lineTotal: 20, product: cans },
      { qty: 3, unitName: null, unitFactor: 1, baseQty: 3, lineTotal: 1.5, product: cans },
      { qty: 4, unitFactor: 1, baseQty: null, lineTotal: 40, product: milk },
    ] },
    { items: [{ qty: 1, unitFactor: 1, lineTotal: 2, product: null }] },
  ], new Map([['cans', [{ name: 'كرتون', factor: 24 }]]]));
  // كرتونان وثلاث حبّات = ٥١ حبة (لا «٥»)، وقيمته مجموع البنود
  assert.deepEqual(rows[0], { productId: 'milk', name: 'حليب', code: 'P2', qty: 4, baseQty: 4, unit: 'كرتون', units: [], total: 40 });
  assert.deepEqual(rows[1], { productId: 'cans', name: 'ببسي', code: 'P1', qty: 51, baseQty: 51, unit: 'حبة', units: [{ name: 'كرتون', factor: 24 }], total: 21.5 });
  // بندٌ بلا صنف يبقى في دلوه ولا يُسقط التقرير
  assert.deepEqual(rows[2], { productId: null, name: 'صنف محذوف', code: '—', qty: 1, baseQty: 1, unit: '', units: [], total: 2 });
});

test('حارس نصّي: تقرير المرتجع يقرأ لقطة الوحدة، وتقرير المبيعات يُرفق وحدة الصنف ويجمع بالأساس', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'reports.ts'), 'utf8').replace(/\r\n/g, '\n');
  const r = src.slice(src.indexOf("router.get('/returns'"), src.indexOf("router.get('/collections'"));
  assert.match(r, /unitName: true, unitFactor: true, baseQty: true,/);
  assert.match(r, /items: r\.items\.map\(returnLineView\)/);
  const s = src.slice(src.indexOf("router.get('/sales'"), src.indexOf("router.get('/orders'"));
  assert.match(s, /product: \{ select: \{ id: true, name: true, code: true, unit: true, primaryUnitId: true \} \}/);
  assert.match(s, /salesByProduct\(invoices, await activeUnitsByProduct\(tid, ids\), returns\)/);
  assert.doesNotMatch(s, /\+= Number\(item\.qty\)/, 'لا جمع للكمية الخام');
});
