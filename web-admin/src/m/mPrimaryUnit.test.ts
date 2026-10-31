// «الوحدة الرئيسية» (القاعدة ١٢) في تطبيق الإدارة على الجوال — الحزمة B6a (primary_unit_spec §4.4، §5.3، §6).
// منطق الشاشات الصرف (mPrimaryUnit.ts وmLotsLogic.lotCardQtyText) بالسلوك، وأسلاك الشاشات (MProducts وMRepLoad وMWarehouse
// وMInvoiceCreate وMReports وMLots) بفحصٍ ثابت لمصدرها — كل اختبارٍ هنا يفشل على 079fb38 (الملف أو الدالّة أو السلك غائب).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  anyPrimary, qtyTotalLabel, fill, errorCode, refetchUnitsOn, productUnitsChanged, withBaseUnitName, backWithBaseNames,
  defModeKey, readDefMode, writeDefMode, primaryCandidates, canAddSubUnit, convertRefusalHint,
  emptySubUnitDraft, subUnitDraftProblem, subUnitPrice, subUnitDraftKey, subUnitBody, dryRunOf, dryRunItems, dryRunNeeds,
  canRunSubUnit, defaultAfterLine, tiersFitPrimary,
} from './mPrimaryUnit';
import { lotCardQtyText, lotQtyBare } from './mLotsLogic';
import { tierToPrimary, tierFromPrimary, tierBaseBounds } from './mUnits';
import { splitVanMovement } from '../lib/vanMovement';
import type { UnitDef } from '../lib/units';

const src = (f: string) => fs.readFileSync(path.join(process.cwd(), 'src', 'm', f), 'utf8');
const num = (n: number) => String(n);
const err = (code: string) => ({ response: { status: 409, data: { code, message: 'رسالة الخادم' } } });

const carton: UnitDef = { id: 'u-ct', name: 'كرتون', factor: 24, isActive: true };
const pallet: UnitDef = { id: 'u-pl', name: 'طبلية', factor: 1200, isActive: true };

// ═══════════════ R3: وسم المجاميع عبر الأصناف ═══════════════

test('anyPrimary: القيمة الصادقة لا حضور المفتاح — null الحاضر (D18) لا يقلب الوسم', () => {
  assert.equal(anyPrimary([{ primaryUnitId: null }, { primaryUnitId: undefined }, {}]), false);
  assert.equal(anyPrimary([{ primaryUnitId: null }, { primaryUnitId: 'u-ct' }]), true);
  assert.equal(anyPrimary(null), false);
  assert.equal(anyPrimary(undefined), false);
});

test('qtyTotalLabel: «بالوحدات الصغرى» مع رئيسية، والوسم القائم حرفاً بلاها (I1)', () => {
  const tr = (s: string) => s;
  assert.equal(qtyTotalLabel(tr, 'المتبقي', 'المتبقي بوحدات الأساس', { primary: true, multi: true }), 'المتبقي بالوحدات الصغرى');
  assert.equal(qtyTotalLabel(tr, 'المتبقي', 'المتبقي بوحدات الأساس', { primary: false, multi: true }), 'المتبقي بوحدات الأساس');
  assert.equal(qtyTotalLabel(tr, 'المتبقي', 'المتبقي بوحدات الأساس', { primary: false, multi: false }), 'المتبقي');
  // كل جزءٍ يمرّ بالترجمة
  const up = (s: string) => `[${s}]`;
  assert.equal(qtyTotalLabel(up, 'إجمالي الكمية', 'x', { primary: true, multi: false }), '[إجمالي الكمية] [بالوحدات الصغرى]');
});

test('fill: الحقول تُملأ بعد الترجمة، والمتكرّر كلّه', () => {
  assert.equal(fill('سعر {unit} · {unit}', { unit: 'كرتون' }), 'سعر كرتون · كرتون');
  assert.equal(fill('كم {sub} في {primary}', { sub: 'قارورة', primary: 'كرتون' }), 'كم قارورة في كرتون');
  assert.equal(fill('{n} بندا', { n: 3 }), '3 بندا');
});

// ═══════════════ رموز الرفض: ما يُعاد جلبه ═══════════════

test('refetchUnitsOn: UNIT_INVALID وPRODUCT_UNITS_CHANGED يُعيدان الجلب، و503 PRODUCT_UNITS_BUSY لا (§6.4)', () => {
  assert.equal(refetchUnitsOn(err('UNIT_INVALID')), true);
  assert.equal(refetchUnitsOn(err('PRODUCT_UNITS_CHANGED')), true);
  assert.equal(refetchUnitsOn(err('PRODUCT_UNITS_BUSY')), false);
  assert.equal(refetchUnitsOn(new Error('network')), false);
  assert.equal(refetchUnitsOn(null), false);
  assert.equal(errorCode(err('X')), 'X');
});

test('productUnitsChanged: BASE_UNIT_CHANGED وPRIMARY_UNIT_CHANGED وحدهما', () => {
  assert.equal(productUnitsChanged(err('BASE_UNIT_CHANGED')), true);
  assert.equal(productUnitsChanged(err('PRIMARY_UNIT_CHANGED')), true);
  assert.equal(productUnitsChanged(err('PRIMARY_UNIT_IN_USE')), false);
  assert.equal(productUnitsChanged(err('UNIT_INVALID')), false);
});

// ═══════════════ baseUnitName في أسطر المخزون ═══════════════

test('withBaseUnitName: الأساس كما يعرفه الكتالوج، والفارغ لا يُرسَل (الغياب = لا مقارنة)', () => {
  assert.deepEqual(withBaseUnitName({ productId: 'p', qty: 2 }, 'قارورة'), { productId: 'p', qty: 2, baseUnitName: 'قارورة' });
  assert.deepEqual(withBaseUnitName({ productId: 'p', qty: 2 }, ''), { productId: 'p', qty: 2 });
  assert.deepEqual(withBaseUnitName({ productId: 'p', qty: 2 }, null), { productId: 'p', qty: 2 });
  assert.deepEqual(withBaseUnitName({ productId: 'p', qty: 2 }, '  '), { productId: 'p', qty: 2 });
});

test('تحميل /m: الشقّان يحملان baseUnitName — والتنزيل الذي يعيد بناءه splitVanMovement يستعيده بترتيب أسطره', () => {
  const rows = [
    withBaseUnitName({ productId: 'a', qty: 5, unitId: 'u-ct' as string | null }, 'قارورة'),
    withBaseUnitName({ productId: 'b', qty: -2, unitId: null as string | null }, 'كرتون'),
    withBaseUnitName({ productId: 'c', qty: 0, unitId: null as string | null }, 'حبة'),
    withBaseUnitName({ productId: 'a', qty: -3, unitId: 'u-ct' as string | null }, 'قارورة'),
  ];
  const s = splitVanMovement(rows);
  const back = backWithBaseNames(rows, s.back);
  assert.deepEqual(s.out.map(i => [i.productId, i.qty, (i as { baseUnitName?: string }).baseUnitName]), [['a', 5, 'قارورة']]);
  assert.deepEqual(back.map(i => [i.productId, i.qty, i.baseUnitName]), [['b', 2, 'كرتون'], ['a', 3, 'قارورة']]);
  // ومن غير الحقل (صنفٌ بلا اسم أساس في الكتالوج) البند كما كان حرفاً
  assert.deepEqual(backWithBaseNames([{ qty: -1 }], [{ productId: 'x', qty: 1 }]), [{ productId: 'x', qty: 1 }]);
});

// ═══════════════ طريقة التعريف: آخر اختيارٍ لكل مستخدم ═══════════════

test('readDefMode/writeDefMode: لكل مستخدم، والافتراض الأوّل، والتخزين الذي يرمي لا يُسقط النموذج', () => {
  const m = new Map<string, string>();
  const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
  assert.equal(readDefMode(st, 'u1'), 'base');
  writeDefMode(st, 'u1', 'primary');
  assert.equal(readDefMode(st, 'u1'), 'primary');
  assert.equal(readDefMode(st, 'u2'), 'base', 'مستخدمٌ آخر لا يرث اختيار غيره');
  assert.equal(defModeKey('u1'), 'fs.m.productDefMode.u1');
  const bad = { getItem: () => { throw new Error('SecurityError'); }, setItem: () => { throw new Error('QuotaExceeded'); } };
  assert.equal(readDefMode(bad, 'u1'), 'base');
  assert.doesNotThrow(() => writeDefMode(bad, 'u1', 'primary'));
  assert.equal(readDefMode(null, 'u1'), 'base');
});

// ═══════════════ الانتقال إلى العكسي لصنفٍ قائم ═══════════════

test('primaryCandidates: النشطة بمعاملٍ صحيح ٢..١٠٠٠٠٠ تصاعدياً — شروط primaryUnitOf (I5)', () => {
  const units: UnitDef[] = [
    pallet, carton,
    { id: 'off', name: 'موقوفة', factor: 6, isActive: false },
    { id: 'frac', name: 'كسر', factor: 2.5, isActive: true },
    { id: 'big', name: 'ضخمة', factor: 200000, isActive: true },
    { name: 'بلا معرّف', factor: 12, isActive: true },
  ];
  assert.deepEqual(primaryCandidates(units).map(u => u.id), ['u-ct', 'u-pl']);
  assert.deepEqual(primaryCandidates(null), []);
});

test('canAddSubUnit: canConvertBase الصريح أو جلسة المالك — والغائب منع', () => {
  assert.equal(canAddSubUnit({ canConvertBase: true }, false), true);
  assert.equal(canAddSubUnit({ canConvertBase: false }, false), false);
  assert.equal(canAddSubUnit({}, false), false);
  assert.equal(canAddSubUnit(null, true), true, 'جلسة المالك يسمح لها الخادم دائماً');
});

test('convertRefusalHint: تلميحٌ لكل رمز، والغائب «غير مفعّلة لشركتك» (D21: لا «الأساس»)', () => {
  assert.equal(convertRefusalHint('OWNER_ONLY'), 'غير مفعّلة لشركتك — اطلب تفعيلها من الدعم الفني');
  assert.equal(convertRefusalHint('SCOPED_USER'), 'تخصّ الشركة كلها — لمستخدم غير مقيّد بنطاق');
  assert.equal(convertRefusalHint('ROLE_FORBIDDEN'), 'لمستخدم بدور مدير أو مشرف');
  assert.equal(convertRefusalHint('FORBIDDEN'), 'تتطلّب صلاحيات الأصناف والفواتير ومخزون السيارات معاً');
  assert.equal(convertRefusalHint(null), convertRefusalHint('OWNER_ONLY'));
});

// ═══════════════ «إضافة وحدة فرعية أصغر» ═══════════════

const cartonBase = { unit: 'كرتون', basePrice: 48, units: [{ id: 'u-pl', name: 'طبلية', factor: 50, isActive: true }] as UnitDef[] };

test('subUnitDraftProblem: حارس الخادم نفسه بلفظ D21 — لا «الأساس» في أي رسالة', () => {
  const d = { ...emptySubUnitDraft };
  assert.equal(subUnitDraftProblem(d, cartonBase), 'اسم الوحدة الفرعية مطلوب');
  assert.equal(subUnitDraftProblem({ ...d, newBaseName: 'كرتون', factor: '24' }, cartonBase), 'الوحدة الفرعية باسم الوحدة الحالية نفسها');
  assert.equal(subUnitDraftProblem({ ...d, newBaseName: 'طبلية', factor: '24' }, cartonBase), 'اسم الوحدة الفرعية مستخدم لوحدة أخرى لهذا الصنف');
  assert.equal(subUnitDraftProblem({ ...d, newBaseName: 'قارورة', factor: '1' }, cartonBase), 'العدد صحيح أكبر من 1 — كم وحدة فرعية في الوحدة الحالية');
  assert.equal(subUnitDraftProblem({ ...d, newBaseName: 'قارورة', factor: '24', basePrice: '-1' }, cartonBase), 'سعر الوحدة رقم موجب');
  assert.equal(subUnitDraftProblem({ ...d, newBaseName: 'قارورة', factor: '24' }, cartonBase), null);
  for (const f of ['', '1', '2.5']) {
    const why = subUnitDraftProblem({ ...d, newBaseName: f ? 'قارورة' : '', factor: f }, cartonBase) ?? '';
    assert.doesNotMatch(why, /الأساس/, why);
  }
});

test('subUnitPrice: المكتوب، وإلّا سعر الحالية ÷ العدد بأربع منازل كخطوة ٥ (16.33 ÷ 8 = 2.0413)', () => {
  assert.equal(subUnitPrice({ ...emptySubUnitDraft, factor: '24' }, 48), 2);
  assert.equal(subUnitPrice({ ...emptySubUnitDraft, factor: '8' }, 16.33), 2.0413);
  assert.equal(subUnitPrice({ ...emptySubUnitDraft, factor: '24', basePrice: '2.5' }, 48), 2.5);
});

test('subUnitBody: expectedBaseName والإبقاء صريحان، والسعر الفارغ غائب، والإقراران حين يُطلبان وحدهما', () => {
  const d = { newBaseName: ' قارورة ', factor: '24', basePrice: '', keepPrimary: true };
  assert.deepEqual(subUnitBody(d, 'كرتون', { dryRun: true }),
    { newBaseName: 'قارورة', factor: 24, expectedBaseName: 'كرتون', keepOldBaseAsPrimary: true, dryRun: true });
  assert.deepEqual(subUnitBody({ ...d, basePrice: '2', keepPrimary: false }, 'كرتون', { acknowledgeErp: true, acknowledgeApi: false }),
    { newBaseName: 'قارورة', factor: 24, expectedBaseName: 'كرتون', basePrice: 2, keepOldBaseAsPrimary: false, acknowledgeErp: true });
});

test('المعاينة: البصمة تتبع القيم، وزرّ التنفيذ لمعاينةٍ ناجحة بالبصمة نفسها والإقرارين المطلوبين', () => {
  const d = { newBaseName: 'قارورة', factor: '24', basePrice: '', keepPrimary: true };
  const key = subUnitDraftKey(d);
  assert.notEqual(subUnitDraftKey({ ...d, factor: '12' }), key);
  assert.notEqual(subUnitDraftKey({ ...d, keepPrimary: false }), key);
  assert.equal(subUnitDraftKey({ ...d, newBaseName: ' قارورة ' }), key, 'المسافات لا تغيّر المعنى');
  const plain = { converted: { invoiceItems: 3, vanLoadItems: 2, warehouseEntryItems: 1, stockRequestItems: 0, priceTiers: 9 } };
  assert.equal(dryRunItems(plain), 6, 'الشرائح وأسعار العملاء لا تُعدّ بنوداً');
  assert.equal(canRunSubUnit({ previewKey: null, key, preview: null, ackErp: false, ackApi: false }), false, 'لا معاينة ⇒ معطّل');
  assert.equal(canRunSubUnit({ previewKey: key, key, preview: plain, ackErp: false, ackApi: false }), true);
  assert.equal(canRunSubUnit({ previewKey: key, key: subUnitDraftKey({ ...d, factor: '12' }), preview: plain, ackErp: false, ackApi: false }), false,
    'تعديلٌ بعد المعاينة يعيده معطّلاً');
  const linked = { erpLinked: true, apiKeys: { write: 1, readOnly: 1 } };
  assert.deepEqual(dryRunNeeds(linked), { erp: true, apiKeys: 2 });
  assert.equal(canRunSubUnit({ previewKey: key, key, preview: linked, ackErp: true, ackApi: false }), false);
  assert.equal(canRunSubUnit({ previewKey: key, key, preview: linked, ackErp: false, ackApi: true }), false);
  assert.equal(canRunSubUnit({ previewKey: key, key, preview: linked, ackErp: true, ackApi: true }), true);
});

test('dryRunOf وdefaultAfterLine: ردّ المعاينة وحده، وسطر الافتراض حين يختلف عن افتراض اليوم', () => {
  assert.deepEqual(dryRunOf({ success: true, dryRun: true, primaryAfter: 'كرتون' }), { success: true, dryRun: true, primaryAfter: 'كرتون' });
  assert.equal(dryRunOf({ success: true, data: {} }), null, 'تنفيذٌ لا معاينة');
  assert.equal(dryRunOf(null), null);
  assert.equal(defaultAfterLine('كرتون', 'طبلية'), 'كرتون', 'طبلية بلا رئيسية ثم «تبقى الحالية رئيسية»');
  assert.equal(defaultAfterLine('كرتون', 'كرتون'), null);
  assert.equal(defaultAfterLine(null, 'طبلية'), null);
});

// ═══════════════ شرائح الأسعار بالرئيسية ═══════════════

test('tiersFitPrimary: كل حدٍّ قائم مضاعفٌ صحيح للمعامل، وبلا شرائح نعم، والمعامل < ٢ لا', () => {
  assert.equal(tiersFitPrimary([{ minQty: 48, baseMinQty: 48, maxQty: 240, baseMaxQty: 240, price: 1.9 }], 24), true);
  assert.equal(tiersFitPrimary([{ minQty: 30, price: 1.9 }], 24), false, '٣٠ قارورة لا تُكتب كراتين بلا كسر');
  assert.equal(tiersFitPrimary([{ minQty: 48, maxQty: 50, price: 1.9 }], 24), false);
  assert.equal(tiersFitPrimary([], 24), true);
  assert.equal(tiersFitPrimary(null, 24), true);
  assert.equal(tiersFitPrimary([{ minQty: 48, price: 1 }], 1), false);
  // الحدّ بالأساس من عموده بعد التحويل لا من القديم
  assert.equal(tiersFitPrimary([{ minQty: 2, baseMinQty: 48, price: 1 }], 24), true);
});

test('الشرائح بالرئيسية: tierFromPrimary(tierToPrimary(t)) تعيد الأصل بالأساس — التخزين بالأساس دائماً', () => {
  const t = { minQty: 48, baseMinQty: 48, maxQty: 240, baseMaxQty: 240, price: 1.875 };
  const v = tierToPrimary(t, 24);
  assert.deepEqual(v, { min: 2, max: 10, price: 45 });
  const back = tierFromPrimary(v.min, v.max, v.price, 24);
  assert.deepEqual(tierBaseBounds(back), { min: 48, max: 240 });
  assert.equal(back.price, 1.875);
});

// ═══════════════ بطاقة التشغيلة: R1 بلا كسر I1 ═══════════════

test('lotCardQtyText: بالرئيسية «2 كرتون و4 قارورة»، وبلاها الرقم واسم الأساس حرفاً ولو للصنف وحدات (I1)', () => {
  const withPrim = { unit: 'قارورة', units: [carton], primaryUnitId: 'u-ct' };
  assert.equal(lotCardQtyText(52, withPrim, num), '2 كرتون و4 قارورة');
  assert.equal(lotCardQtyText(0, withPrim, num), '0 كرتون');
  const noPrim = { unit: 'قارورة', units: [carton], primaryUnitId: null };
  assert.equal(lotCardQtyText(52, noPrim, num), '52 قارورة', 'كما كانت `${fmtQ(x)} ${unit}` حرفاً');
  assert.equal(lotCardQtyText(52, { unit: 'قارورة', units: [carton] }, num), '52 قارورة');
  assert.equal(lotCardQtyText(52, { unit: '' }, num), '52 ');
  // رئيسيةٌ تالفة (موقوفة) ⇒ سلوك اليوم
  assert.equal(lotCardQtyText(52, { unit: 'قارورة', units: [{ ...carton, isActive: false }], primaryUnitId: 'u-ct' }, num), '52 قارورة');
});

test('lotQtyBare: الأسطر الثانوية بالرئيسية بجانب عنوانٍ صار بها، وبلاها الرقم المجرّد حرفاً (I1)', () => {
  const withPrim = { unit: 'قارورة', units: [carton], primaryUnitId: 'u-ct' };
  assert.equal(lotQtyBare(24, withPrim, num), '1 كرتون', '«محجوز 24» بجانب «2 كرتون و4 قارورة» تُقرأ كراتين');
  assert.equal(lotQtyBare(5, withPrim, num), '5 قارورة');
  assert.equal(lotQtyBare(24, { unit: 'قارورة', units: [carton], primaryUnitId: null }, num), '24', 'بلا رئيسية: الرقم المجرّد كما كان');
  assert.equal(lotQtyBare(24, null, num), '24');
  assert.equal(lotQtyBare(24, { unit: 'قارورة', units: [{ ...carton, isActive: false }], primaryUnitId: 'u-ct' }, num), '24');
});

test('MLots: صفّ القائمة والأسطر الثانوية في البطاقة بالرئيسية — لا رقمٌ مجرّد بجانب رصيدٍ بالكرتون', () => {
  const lots = src('MLots.tsx');
  assert.match(lots, /lotQtyBare\(r\.summary\.total, lotRowProduct\(r\), fmtQ\)/, 'رصيد صفّ القائمة رقمٌ مجرّد بالأساس لصنفٍ له رئيسية');
  assert.match(lots, /primaryUnitOf\(lotRowProduct\(r\)\) \? '' : \(r\.productUnit \|\| ''\)/);
  assert.match(lots, /const qb = \(n: number\) => lotQtyBare\(n, prod, fmtQ\);/);
  for (const f of ['r.held.SELLABLE', 'r.usable.EXPIRED', 'r.usable.DAMAGED', 'planTotals.held', 'p.usable.SELLABLE', 'p.held.SELLABLE',
    'p.raw.EXPIRED', 'p.raw.DAMAGED', 'p.loaded', 'p.unloaded', 'p.sold', 'p.returned', 'Math.abs(o.qty)']) {
    assert.ok(!lots.includes(`fmtQ(${f})`), `${f} ما زال رقماً مجرّداً بالأساس بجانب رصيدٍ بالرئيسية`);
    assert.ok(lots.includes(`qb(${f})`), `${f} لا يمرّ بـlotQtyBare`);
  }
});

test('MRepLoad: توزيع التنزيل على التشغيلات لصنفٍ له رئيسية يسمّي الأساس باسمه لا «وحدة الأساس» (D21)، وبلاها كما كان', () => {
  const s = src('MRepLoad.tsx');
  assert.match(s, /primaryUnitOf\(prod\) \? fill\(tr\('من أي تشغيلة ينزل بـ\{unit\}'\), \{ unit: String\(prod\.unit \?\? ''\) \}\) : tr\('من أي تشغيلة ينزل بوحدة الأساس'\)/,
    'عنوان التوزيع يقول «وحدة الأساس» لصنفٍ له رئيسية');
  assert.equal(fill('من أي تشغيلة ينزل بـ{unit}', { unit: 'قارورة' }), 'من أي تشغيلة ينزل بـقارورة');
});

// ═══════════════ أسلاك الشاشات (فحصٌ ثابت للمصدر) ═══════════════

test('MProducts: الإنشاء العكسي في طلب POST واحد بـreverseCreatePayload، والتعديل برقعةٍ ذرّية وexpectedBaseName', () => {
  const s = src('MProducts.tsx');
  assert.match(s, /reverseCreatePayload\(rf\)/, 'الإنشاء العكسي لا يمرّ بحمولة المواصفة');
  assert.match(s, /reverseEditPatch\(rf, String\(seedPrim\.id\)\)/, 'تعديل صنفٍ له رئيسية لا يرسل رقعة الرئيسية');
  assert.match(s, /if \(product\) payload\.expectedBaseName = savedBase;/, 'حفظ الصنف القائم بلا expectedBaseName');
  assert.match(s, /readDefMode\(safeStorage\(\), user\?\.id\)/, 'طريقة التعريف لا تتذكّر آخر اختيار للمستخدم');
  // صنفٌ بلا رئيسية: سطر القائمة كما كان حرفاً (I1)
  assert.match(s, /: \[p\.code, p\.unit, unitsBrief\(p\.units, formatNumber\), p\.category\?\.name\]\)/);
});

test('MProducts: تعديل صنفٍ قائم لا يرسل حمولة الإنشاء (units/primaryUnitName) — مراجعة B1 ٥', () => {
  const s = src('MProducts.tsx');
  assert.match(s, /if \(rev\) Object\.assign\(payload, product \? \(seedPrim\?\.id \? reverseEditPatch\(rf, String\(seedPrim\.id\)\) : \{\}\) : reverseCreatePayload\(rf\)\);/);
  assert.doesNotMatch(s, /product && seedPrim\?\.id \? reverseEditPatch\(rf, String\(seedPrim\.id\)\) : reverseCreatePayload\(rf\)/);
});

test('MProducts: الوحدات — رئيسية بتأكيد clearPrimary، و«اجعلها الرئيسية»، وexpectedBaseName في كل كتابة', () => {
  const s = src('MProducts.tsx');
  assert.match(s, /setPrimaryUnit\(product\.id, \{ unitId: u\.id, expectedPrimaryUnitId: p\.primaryUnitId \?\? null \}\)/);
  assert.match(s, /setPrimaryUnit\(product!\.id, \{ unitId, expectedPrimaryUnitId: livePrimaryId \}\)/);
  assert.match(s, /removeUnit\(product\.id, u\.id, \{ \.\.\.\(u\.id === p\.primaryUnitId && \{ clearPrimary: true \}\), expectedBaseName: p\.unit \}\)/);
  assert.match(s, /clearPrimary: true \}\)/);
  assert.match(s, /addUnit\(product\.id, \{ \.\.\.body, expectedBaseName: product\.unit, \.\.\.\(asPrimary && \{ makePrimary: true \}\) \}\)/);
  assert.match(s, /updateUnit\(product\.id, unit\.id, \{ \.\.\.body, expectedBaseName: product\.unit \}\)/);
  assert.match(s, /updatePriceTiers\(product\.id, tiers, seed\?\.base \|\| undefined, pr \? \{ id: pr\.id, factor: pr\.factor \} : undefined\)/);
});

test('MProducts: «إضافة وحدة فرعية أصغر» خلف canConvertBase (لا جلسة المالك وحدها) وبمعاينة dryRun قبل التنفيذ', () => {
  const s = src('MProducts.tsx');
  assert.match(s, /const canSub = canAddSubUnit\(user, ownerSession\);/);
  assert.match(s, /\{canSub && \(/);
  assert.doesNotMatch(s, /\{ownerSession && \(/, 'البطاقة ما زالت لجلسة المالك وحدها');
  assert.match(s, /subUnitBody\(d, cur, \{ dryRun: true \}\)/, 'لا معاينة قبل التنفيذ');
  assert.match(s, /disabled=\{!runnable \|\| run\.isPending\}/, 'زرّ التنفيذ لا ينتظر المعاينة');
  assert.match(s, /setTimeout\(async \(\) => \{[\s\S]{0,900}\}, 400\)/, 'المعاينة بلا تأخير ٤٠٠ms');
  // D21: لا «الأساس» في نصوص النافذة الجديدة
  const sheet = s.slice(s.indexOf('function SubUnitSheet('), s.indexOf('/** خانة رقمية للوحدات والتحويل'));
  assert.ok(sheet.length > 1000);
  assert.doesNotMatch(sheet.replace(/^\s*(\/\/|\*|\/\*).*$/gm, ''), /tr\('[^']*الأساس[^']*'\)/);
});

test('MRepLoad: baseUnitName في الشقّين، وإعادة الجلب على UNIT_INVALID/PRODUCT_UNITS_CHANGED، ووسم المتبقي R3', () => {
  const s = src('MRepLoad.tsx');
  assert.match(s, /withBaseUnitName\(\{[\s\S]{0,300}\}, r\.baseUnit\)\)/);
  assert.match(s, /back: backWithBaseNames\(items, s\.back\)/);
  assert.match(s, /if \(refetchUnitsOn\(e\)\) \{/);
  assert.match(s, /qtyTotalLabel\(tr, 'المتبقي', 'المتبقي بوحدات الأساس', \{ primary: anyPrimary\(stockQ\.data\), multi: anyMulti \}\)/);
  assert.match(s, /const prod = \{ unit: r\.baseUnit, units: r\.units, primaryUnitId: r\.primaryUnitId \};/);
});

test('MWarehouse: baseUnitName في كل سطر وارد/تسوية، وتكلفة الرئيسية أولاً، ووسم R3', () => {
  const s = src('MWarehouse.tsx');
  assert.match(s, /withBaseUnitName\(\{\s*productId: r\.productId[\s\S]{0,200}\}, r\.baseUnit\)/);
  assert.match(s, /formatCurrency\(r\.avgCost \* Number\(prim\.factor\)\)/);
  assert.match(s, /qtyTotalLabel\(tr, 'الكمية المقيمة', 'الكمية المقيمة بوحدات الأساس'/);
  assert.match(s, /qtyTotalLabel\(tr, 'كمية خارج التقييم', 'كمية خارج التقييم بوحدات الأساس'/);
  assert.match(s, /if \(refetchUnitsOn\(e\)\) \{/);
});

test('MInvoiceCreate وMReports وMLots: إعادة الجلب على سباق التحويل، ووسم الإجمالي R3، وأرصدة البطاقة R1', () => {
  assert.match(src('MInvoiceCreate.tsx'), /if \(refetchUnitsOn\(e\)\) qc\.invalidateQueries\(\{ queryKey: \['m-inv-products'\] \}\);/);
  assert.match(src('MInvoiceCreate.tsx'), /const prim = primaryChoice\(p\);/);
  assert.match(src('MReports.tsx'), /qtyTotalLabel\(tr, 'إجمالي الكمية', 'إجمالي الكمية بوحدات الأساس', \{ primary: anyPrimary\(rows\), multi: anyMulti \}\)/);
  const lots = src('MLots.tsx');
  assert.match(lots, /const q = \(n: number\) => lotCardQtyText\(n, prod, fmtQ\);/);
  assert.doesNotMatch(lots, /\$\{fmtQ\([^)]*\)\} \$\{unit\}/, 'رصيدٌ في البطاقة ما زال رقماً واسم الأساس لصنفٍ له رئيسية');
});
