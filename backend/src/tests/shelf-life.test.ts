// صلاحية الصنف (services/shelfLife.ts، services/invoiceExpiry.ts) — تاريخ الانتهاء من تاريخ البيع بالأيام أو الأشهر
// أو السنوات، وحالة المرتجع (منتهٍ أم لا). صرفٌ بلا قاعدة، ومعه حارسٌ نصّي على المسارات.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addShelfLife, expiryDateFor, localDateIn, shelfLifeOf, shelfLifeProblem } from '../services/shelfLife';
import { isExpiredOn } from '../services/invoiceExpiry';

test('الأيام: تعبر الشهر والسنة', () => {
  assert.equal(addShelfLife('2026-10-11', 30, 'DAY'), '2026-11-10');
  assert.equal(addShelfLife('2026-12-25', 10, 'DAY'), '2027-01-04');
  assert.equal(addShelfLife('2028-02-28', 1, 'DAY'), '2028-02-29', 'سنة كبيسة');
});

test('الأشهر بالتقويم وتُقصّ إلى آخر الشهر', () => {
  assert.equal(addShelfLife('2026-10-11', 6, 'MONTH'), '2027-04-11');
  assert.equal(addShelfLife('2026-01-31', 1, 'MONTH'), '2026-02-28', '٣١ يناير + شهر = آخر فبراير لا ٣ مارس');
  assert.equal(addShelfLife('2027-12-31', 2, 'MONTH'), '2028-02-29');
  assert.equal(addShelfLife('2026-10-11', 18, 'MONTH'), '2028-04-11');
});

test('السنوات، و٢٩ فبراير + سنة = ٢٨ فبراير', () => {
  assert.equal(addShelfLife('2026-10-11', 2, 'YEAR'), '2028-10-11');
  assert.equal(addShelfLife('2028-02-29', 1, 'YEAR'), '2029-02-28');
  assert.equal(addShelfLife('2028-02-29', 4, 'YEAR'), '2032-02-29');
});

test('تاريخ البيع بتوقيت الشركة لا UTC', () => {
  // ١:٣٠ فجر ١٢ أكتوبر بالرياض = ٢٢:٣٠ يوم ١١ بتوقيت UTC
  const at = new Date('2026-10-11T22:30:00Z');
  assert.equal(localDateIn(at, 'Asia/Riyadh'), '2026-10-12');
  const p = { shelfLifeEnabled: true, shelfLifeValue: 10, shelfLifeUnit: 'DAY' };
  assert.equal(expiryDateFor(p, at, 'Asia/Riyadh')?.toISOString(), '2026-10-22T00:00:00.000Z');
  assert.equal(expiryDateFor(p, at, 'Africa/Casablanca')?.toISOString(), '2026-10-21T00:00:00.000Z');
});

test('صنفٌ بلا صلاحية مفعّلة أو بإعداد ناقص: لا تاريخ', () => {
  const at = new Date('2026-10-11T08:00:00Z');
  assert.equal(expiryDateFor({ shelfLifeEnabled: false, shelfLifeValue: 6, shelfLifeUnit: 'MONTH' }, at, 'Asia/Riyadh'), null);
  assert.equal(expiryDateFor({ shelfLifeEnabled: true, shelfLifeValue: null, shelfLifeUnit: 'MONTH' }, at, 'Asia/Riyadh'), null);
  assert.equal(shelfLifeOf({ shelfLifeEnabled: true, shelfLifeValue: 3, shelfLifeUnit: 'WEEK' }), null);
  assert.deepEqual(shelfLifeOf({ shelfLifeEnabled: true, shelfLifeValue: 3, shelfLifeUnit: 'YEAR' }), { value: 3, unit: 'YEAR' });
});

test('التحقّق: المفعّلة تلزمها مدةٌ صحيحة ووحدة، والمطفأة تُقبل', () => {
  assert.equal(shelfLifeProblem({ shelfLifeEnabled: false, shelfLifeValue: null, shelfLifeUnit: null }), null);
  assert.equal(shelfLifeProblem({ shelfLifeEnabled: true, shelfLifeValue: 12, shelfLifeUnit: 'MONTH' }), null);
  assert.match(String(shelfLifeProblem({ shelfLifeEnabled: true, shelfLifeValue: null, shelfLifeUnit: 'MONTH' })), /عدداً صحيحاً/);
  assert.match(String(shelfLifeProblem({ shelfLifeEnabled: true, shelfLifeValue: 0, shelfLifeUnit: 'DAY' })), /عدداً صحيحاً/);
  assert.match(String(shelfLifeProblem({ shelfLifeEnabled: true, shelfLifeValue: 2.5, shelfLifeUnit: 'DAY' })), /عدداً صحيحاً/);
  assert.match(String(shelfLifeProblem({ shelfLifeEnabled: true, shelfLifeValue: 5, shelfLifeUnit: null })), /وحدة/);
  assert.match(String(shelfLifeProblem({ shelfLifeEnabled: true, shelfLifeValue: 101, shelfLifeUnit: 'YEAR' })), /أطول من المعقول/);
});

test('المرتجع: منتهٍ إن جاء بعد يوم الانتهاء، ويوم الانتهاء نفسه آخر يومٍ صالح', () => {
  const exp = new Date('2026-10-20T00:00:00.000Z');
  assert.equal(isExpiredOn('2026-10-19', exp), false);
  assert.equal(isExpiredOn('2026-10-20', exp), false);
  assert.equal(isExpiredOn('2026-10-21', exp), true);
  assert.equal(isExpiredOn('2027-01-01', exp), true);
});

test('حارس نصّي: الصلاحية من تاريخ البيع — الصنف يتحقّق مدمجاً بالمحفوظ، والإصدار يسجّلها، والوارد لا يحسبها', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n');
  const products = read('routes/products.ts');
  assert.equal(products.split('shelfLifeProblem(').length - 1, 2, 'الإنشاء والتعديل كلاهما يتحقّقان');
  assert.ok(products.includes('data.shelfLifeEnabled ?? exists.shelfLifeEnabled'), 'التعديل يدمج مع المحفوظ');

  // كل مخارج الإصدار تسجّل الصلاحية: المرتجع المرتبط، والمرحلة الثانية، والمرحلة الأولى، والإشعارات
  const inv = read('routes/invoices.ts');
  for (const frag of [
    'if (note && tracksExpiry) await stampExpiryAfterIssue(tid, note.status, note.body);',
    'if (phase2 && tracksExpiry) await stampExpiryAfterIssue(tid, phase2.status, phase2.body);',
    'if (tracksExpiry) await stampExpiryAfterIssue(tid, 201, { data: invoice });',
    'await stampExpiryAfterIssue(tid, r.status, r.body);',
  ]) assert.ok(inv.includes(frag), `مخرج إصدار بلا تسجيل الصلاحية: ${frag}`);
  // لا استعلام إضافي لشركةٍ لا تستعمل الصلاحية: الشرط من استعلام الأصناف القائم نفسه
  assert.ok(inv.includes('const tracksExpiry = products.some((p) => shelfLifeOf(p));'));

  const svc = read('services/invoiceExpiry.ts');
  const after = svc.slice(svc.indexOf('export async function stampExpiryAfterIssue'));
  assert.match(after, /try \{\s*await stampInvoiceExpiry\(tenantId, id\);\s*\} catch/, 'التسجيل لا يُفشل الإصدار أبداً');
  // المرتجع الحرّ يُقاس على آخر بيعٍ لهذا الصنف لهذا العميل قبله، غير ملغى ولا إشعار؛ والمرتبط على بند أصله
  for (const frag of ['customerId: inv.customerId', 'type: { in: SALE_TYPES }', "status: { not: 'CANCELLED' }",
    'invoiceDate: { lte: inv.invoiceDate }', "orderBy: [{ invoice: { invoiceDate: 'desc' } }", 'it.creditedItemId']) {
    assert.ok(svc.includes(frag), `قياس المرتجع: ${frag}`);
  }

  const wh = read('routes/warehouse.ts');
  assert.ok(!/expiresAt|shelfLife/.test(wh), 'الوارد لا يحسب الصلاحية بعد أن صارت من تاريخ البيع');
});
