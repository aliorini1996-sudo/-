// «الوحدة الرئيسية» (D9/D18 و§2.16): مفتاحا العرض في صفّ الصنف لا يخرجان في حمولة ERP — payloadVersion 3 حرفياً كما هي.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { productPayloadRow, invoicePayloadRow, withoutDisplayOnlyKeys } from '../services/erpPayload';
import { PRODUCT_DISPLAY_ONLY_KEYS } from '../services/baseConversions';

const units = [{ id: 'u1', name: 'كرتون', factor: 24, price: 48, unitCode: 'CT', isActive: true, sortOrder: 0 }];

test('حمولة الصنف تُسقط primaryUnitId وbaseConvertedAt — قيمةً أو null — وبقية الصفّ (ومنها الوحدات) كما هي', () => {
  const converted = { id: 'p', unit: 'قارورة', basePrice: 2, units, primaryUnitId: 'u1', baseConvertedAt: new Date('2026-10-30T00:00:00Z'), image: 'data:...' };
  assert.deepEqual(productPayloadRow(converted), { id: 'p', unit: 'قارورة', basePrice: 2, units });
  // D18: المفتاحان حاضران بـnull في كل صنف لم تُفعَّل له الميزة — والحمولة بشكلها القديم حرفياً
  assert.deepEqual(productPayloadRow({ id: 'p', unit: 'حبة', basePrice: 5, units, primaryUnitId: null, baseConvertedAt: null }), { id: 'p', unit: 'حبة', basePrice: 5, units });
  // ومع أعمدة «تتبّع اللوط» معاً
  assert.deepEqual(productPayloadRow({ id: 'p', lotTracked: true, lotTrackedSince: null, primaryUnitId: 'u1', baseConvertedAt: null }), { id: 'p' });
});

test('القائمة من baseConversions.ts هي المفتاحان حرفياً، والمُسقِط يعيد الكائن نفسه حين لا مفتاح منهما (كـwithoutLotKeys)', () => {
  assert.deepEqual([...PRODUCT_DISPLAY_ONLY_KEYS], ['primaryUnitId', 'baseConvertedAt']);
  const plain = { id: 'p', unit: 'حبة', basePrice: 5, units };
  assert.equal(withoutDisplayOnlyKeys(plain), plain);
  const withKeys = { ...plain, primaryUnitId: null };
  assert.notEqual(withoutDisplayOnlyKeys(withKeys), withKeys);
  assert.ok('primaryUnitId' in withKeys, 'الأصل لا يُعدَّل');
});

test('صنف البند في حمولة الفاتورة بلا المفتاحين — والبند بالأساس كما هو', () => {
  const product = { id: 'p1', unit: 'قارورة', unitCode: 'PCE', primaryUnitId: 'u1', baseConvertedAt: '2026-10-30T00:00:00.000Z' };
  const row = invoicePayloadRow({
    id: 'i1', number: 'INV-1', type: 'SALE', status: 'CONFIRMED', invoiceDate: new Date('2026-10-30T09:00:00Z'), pricesIncludeTax: false,
    subtotal: 96, taxAmt: 14.4, total: 110.4,
    items: [{ qty: 2, unitName: 'كرتون', unitFactor: 24, baseQty: 48, unitCode: 'CT', unitPrice: 48, taxPct: 15, taxAmt: 14.4, lineTotal: 110.4, product }],
  } as never, 'Asia/Riyadh');
  const item = (row.items as Record<string, unknown>[])[0];
  assert.deepEqual(item.product, { id: 'p1', unit: 'قارورة', unitCode: 'PCE' });
  assert.equal(item.qty, 48, 'الكمية بالأساس (القارورة) لا بالرئيسية');
});

test('I2: erpPayload.ts لا يذكر primaryUnitId نصاً — المفاتيح من القائمة المستوردة وحدها', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'erpPayload.ts'), 'utf8');
  assert.ok(!src.includes('primaryUnitId'));
  assert.match(src, /import \{ PRODUCT_DISPLAY_ONLY_KEYS \} from '\.\/baseConversions'/);
});
