// تقرير المرتجع (GET /reports/returns) — حارسٌ نصّي: النطاق والحالة والنوع، ونسبة المرتجع على مبيعات المدى نفسه في النطاق نفسه.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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
