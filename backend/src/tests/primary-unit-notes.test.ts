// «الوحدة الرئيسية» §2.13 — compliance/zatca/notes.ts نقيّ:
//   • creditUnitOf بلقطةٍ صريحة يملؤها الخادم (#8): بندٌ بلا unitId ومعامله > ١ يُقيَّد بمعامله لا بالأساس، ورمزه رمز وحدة البند
//     إن كانت هي؛ وبلا لقطة (أو بمعامل ١) ⇒ القائم حرفياً.
//   • رسالة تجاوز المتاح بالوحدة الرئيسية حين يحملها البند، وبلاها النصّ القائم.
//   • routes/invoicesNotes.ts: returnItemsToLines تحمل اللقطة والأساس المتوقَّع، وassertNoteBasesUnchanged يقارن تحت القفل.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creditableLines, resolveCreditLines, type NoteOriginalInvoice, type NoteOriginalItem } from '../compliance/zatca/notes';
import { ZatcaHttpError } from '../compliance/zatca/errors';
import { assertNoteBasesUnchanged, returnItemsToLines, type LoadedOriginal } from '../routes/invoicesNotes';
import { PRODUCT_LOCK_TIMEOUT, Phase2ProductUnitsChanged } from '../routes/invoicesZatca';
import { LOT_LOCK_TIMEOUT } from '../services/lotsDb';

const CT = { id: 'u-ct', name: 'كرتون', factor: 24, unitCode: 'CT', isActive: true };

function original(item: Partial<NoteOriginalItem> = {}): NoteOriginalInvoice {
  const it: NoteOriginalItem = {
    id: 'it-1', productId: 'p1', seq: 1, itemName: 'مياه', unitCode: 'CT', qty: 2, unitPrice: 48, discountPct: 0, taxPct: 15,
    vatCategory: 'S', vatExemptionCode: null, vatExemptionReason: null, damagedReturnToStock: true,
    unitName: 'كرتون', unitFactor: 24, baseQty: 48, units: [CT], baseUnitName: 'قارورة', lineTotal: 110.4, ...item,
  };
  return {
    id: 'inv-1', tenantId: 'T1', customerId: 'c1', salesRepId: 'r1', teamId: null, locationId: null, number: 'INV-1',
    status: 'CONFIRMED', type: 'CREDIT', paymentPlan: null, zatcaPhase: 2, documentKind: 'INVOICE', invoiceSubtype: '01',
    einvoiceStatus: 'cleared', pricesIncludeTax: false, discountPct: 0, total: 110.4, paidAmt: 0, remainingAmt: 110.4, invoiceDate: null,
    items: [it],
  } as NoteOriginalInvoice;
}

test('#8: لقطةٌ صريحة بلا unitId ومعامل ٢٤ ⇒ بند الإشعار بالكرتون (وحدة البند نفسها بسعره)، لا حبّة', () => {
  const lines = creditableLines(original({ units: [] }));
  const [l] = resolveCreditLines(lines, [{ invoiceItemId: 'it-1', qty: 1, unitFactor: 24, unitName: 'كرتون' }]);
  assert.deepEqual([l.creditUnitName, l.creditUnitFactor, l.creditUnitCode, l.creditBase, l.creditUnitPrice, l.creditFitted], ['كرتون', 24, 'CT', 24, 48, false]);
  // بلا اللقطة: القائم حرفياً — الأساس بمعامل ١
  const [plain] = resolveCreditLines(lines, [{ invoiceItemId: 'it-1', qty: 1 }]);
  assert.deepEqual([plain.creditUnitName, plain.creditUnitFactor, plain.creditBase], [null, 1, 1]);
  // لقطة بمعامل ١ ⇒ القائم حرفياً
  const [one] = resolveCreditLines(lines, [{ invoiceItemId: 'it-1', qty: 1, unitFactor: 1, unitName: null }]);
  assert.deepEqual([one.creditUnitFactor, one.creditBase], [1, 1]);
  // معاملٌ غير معامل البند (وحدةٌ حُذفت بعد تغيّر معاملها): بمعامله وسعرٍ مشتقّ ورمزٍ عامّ لاسمٍ آخر
  const [half] = resolveCreditLines(lines, [{ invoiceItemId: 'it-1', qty: 1, unitFactor: 12, unitName: 'شدة' }]);
  assert.deepEqual([half.creditUnitName, half.creditUnitFactor, half.creditBase, half.creditFitted, half.creditUnitCode], ['شدة', 12, 12, true, 'PCE']);
  // unitId حاضر ⇒ يغلب اللقطة (القائم حرفياً)
  const withUnits = creditableLines(original());
  const [byId] = resolveCreditLines(withUnits, [{ invoiceItemId: 'it-1', qty: 1, unitId: 'u-ct', unitFactor: 6, unitName: 'x' }]);
  assert.deepEqual([byId.creditUnitFactor, byId.creditUnitName], [24, 'كرتون']);
});

test('رسالة تجاوز المتاح: بالوحدة الرئيسية حين يحملها البند («2 كرتون»)، وبلاها النصّ القائم حرفياً (I1)', () => {
  const over = (item: Partial<NoteOriginalItem>) => {
    try {
      resolveCreditLines(creditableLines(original(item)), [{ invoiceItemId: 'it-1', qty: 49 }]);
    } catch (e) {
      assert.ok(e instanceof ZatcaHttpError);
      return JSON.stringify((e as ZatcaHttpError).body());
    }
    assert.fail('لم يُرفض التجاوز');
  };
  const pal = { id: 'u-pal', name: 'طبلية', factor: 48, unitCode: 'PF', isActive: true };
  const withPrimary = over({ primaryUnitId: 'u-ct', units: [CT, pal] });
  assert.match(withPrimary, /2 كرتون و1 قارورة/, 'المطلوب بالرئيسية لا بالطبلية');
  assert.match(withPrimary, /2 كرتون/);
  const without = over({ units: [CT, pal] });
  assert.match(without, /1 طبلية و1 قارورة/, 'بلا رئيسية: formatQty القائم بأكبر وحدة');
  assert.equal(over({ primaryUnitId: null, units: [CT, pal] }), without, 'null ⇒ القائم حرفياً');
  assert.equal(over({ primaryUnitId: 'u-gone', units: [CT, pal] }), without, 'معرّفٌ تالف ⇒ القائم');
});

test('returnItemsToLines تحمل لقطة الخادم والأساس المتوقَّع، وبلاهما البند كما كان حرفياً', () => {
  const lines = creditableLines(original());
  assert.deepEqual(returnItemsToLines([{ invoiceItemId: 'it-1', qty: 1 }], lines), [{ invoiceItemId: 'it-1', qty: 1, unitId: null }]);
  assert.deepEqual(returnItemsToLines([{ productId: 'p1', qty: 1, unitFactor: 24, unitName: 'كرتون', expectedBase: 'قارورة' }], lines),
    [{ invoiceItemId: 'it-1', qty: 1, unitId: null, unitFactor: 24, unitName: 'كرتون', expectedBase: 'قارورة' }]);
});

test('assertNoteBasesUnchanged: الأساس المتوقَّع (من اللقطة، وإلا من المعاينة) مقابل الأساس تحت القفل — FULL والقفل الغائب بلا مقارنة', () => {
  const loaded = (lockedBases?: Map<string, string>): LoadedOriginal =>
    ({ original: original(), originalBuyer: null, lotTrackedProducts: new Set(), ...(lockedBases && { lockedBases }) });
  const preview = loaded();
  const same = loaded(new Map([['p1', 'قارورة']]));
  const moved = loaded(new Map([['p1', 'علبة']]));
  assert.doesNotThrow(() => assertNoteBasesUnchanged([{ invoiceItemId: 'it-1', qty: 1 }], preview, same));
  assert.throws(() => assertNoteBasesUnchanged([{ invoiceItemId: 'it-1', qty: 1 }], preview, moved),
    (e: unknown) => e instanceof Phase2ProductUnitsChanged && e.names[0] === 'مياه');
  assert.throws(() => assertNoteBasesUnchanged({ fromReturnItems: [{ productId: 'p1', qty: 1, expectedBase: 'قارورة' }] }, preview, moved),
    (e: unknown) => e instanceof Phase2ProductUnitsChanged);
  // اللقطة رأت أساساً غير ما رأته المعاينة: تحكم اللقطة
  assert.throws(() => assertNoteBasesUnchanged([{ invoiceItemId: 'it-1', qty: 1, expectedBase: 'كرتون' }], preview, same),
    (e: unknown) => e instanceof Phase2ProductUnitsChanged);
  assert.doesNotThrow(() => assertNoteBasesUnchanged('FULL', preview, moved));
  assert.doesNotThrow(() => assertNoteBasesUnchanged([{ invoiceItemId: 'it-1', qty: 1 }], preview, loaded()), 'معاملةٌ مزيّفة بلا قفل');
  // اسمٌ أطول من ٦٤ حرفاً يُقارَن بمفتاحه (D20-أ)
  const long = 'ق'.repeat(80);
  assert.doesNotThrow(() => assertNoteBasesUnchanged([{ invoiceItemId: 'it-1', qty: 1, expectedBase: long.slice(0, 64) }], preview, loaded(new Map([['p1', long]]))));
});

test('I10: مهلة قفل الأصناف في فرع المرحلة الثانية نسخةٌ حرفية من LOT_LOCK_TIMEOUT (الفرع لا يستورد lotsDb — عزل D29)', () => {
  assert.equal(PRODUCT_LOCK_TIMEOUT, LOT_LOCK_TIMEOUT);
});
