import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stockCountLines, stockCountRef, type VanStockSource } from './stockCount';

// «كشف جرد» سيارة المندوب (طلب المالك ٢٣ نوفمبر ٢٠٢٦)

const row = (name: string, remaining: number, extra: Partial<VanStockSource> = {}): VanStockSource =>
  ({ productId: name, name, code: `C-${name}`, unit: 'حبة', remaining, ...extra });

test('الكشف يضمّ ما في السيارة وحده: رصيدٌ موجب أو عجز أو تالفٌ/منتهي — والصفر يُترك، مرتّباً بالاسم', () => {
  const lines = stockCountLines([
    row('مكسرات', 12), row('شاي', 0), row('قهوة', -3), row('زبيب', 0, { damaged: 2 }), row('تمر', 0, { expired: 1, damaged: 1 }),
  ]);
  assert.deepEqual(lines.map((l) => l.name), ['تمر', 'زبيب', 'قهوة', 'مكسرات']);
  assert.equal(lines.find((l) => l.name === 'قهوة')!.onHand, -3, 'العجز يُطبع بإشارته');
  assert.equal(lines.find((l) => l.name === 'تمر')!.unsellable, 2, 'التالف والمنتهي معاً');
});

test('الكود الذي هو نسخةٌ من الاسم لا يتكرّر، والوحدات تمرّ كما هي', () => {
  const [l] = stockCountLines([row('شاي', 5, { code: 'شاي', units: [{ id: 'u1', name: 'كرتون', factor: 24 } as never], primaryUnitId: 'u1' })]);
  assert.equal(l.code, '');
  assert.equal(l.units?.length, 1);
  assert.equal(l.primaryUnitId, 'u1');
});

test('رقم الكشف SC-YYMMDD-HHMM من لحظة الإصدار', () => {
  assert.equal(stockCountRef(new Date(2026, 10, 23, 9, 5)), 'SC-261123-0905');
});

test('الصفحة: أيقونة لكل سيارة بين «المتبقي» و«البيع بدون مخزون» تفتح الكشف برصيدٍ جديد من الخادم، والورقة نوعٌ في نافذة المستندات', () => {
  const page = readFileSync(new URL('../pages/VanStockPage.tsx', import.meta.url), 'utf8');
  const head = page.indexOf("tr('كشف جرد')");
  assert.ok(head > page.indexOf("tr('المتبقي')") && head < page.indexOf("tr('آخر تحميل')"), 'عمود الكشف في موضعه');
  assert.match(page, /onClick=\{\(\) => openStockCount\(r\)\}/);
  assert.match(page, /queryKey: \['van-current', r\.salesRepId\],[\s\S]{0,140}staleTime: 0/, 'الرصيد لحظة الإصدار لا نسخةٌ قديمة');
  assert.match(page, /\{countDoc && <DocumentModal doc=\{countDoc\}/);
  const docs = readFileSync(new URL('../rep/RepDocuments.tsx', import.meta.url), 'utf8');
  assert.match(docs, /\| StockRequestDoc \| StockCountDoc;/);
  assert.match(docs, /if \(doc\.kind === 'stockCount'\) return <PrintableStockCount ref=\{refProp\} doc=\{doc\} \/>;/);
  for (const label of ["tr('رصيد النظام')", "tr('الكمية الفعلية')", "tr('الفرق')", "tr('توقيع المندوب')", "tr('توقيع أمين المستودع')", "tr('توقيع المشرف')"]) {
    assert.ok(docs.includes(label), label);
  }
});
