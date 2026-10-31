// الوحدات المتعددة — وحدة البند في الإصدار (routes/invoices.ts resolveLineUnit): لقطة الجهاز في إعادة الرفع (القاعدة ٧) والكاش
// القديم في الحيّ، ثم «الوحدة الرئيسية» D16: إعادة الرفع بعد تحويلٍ مسجَّل في ProductBaseConversion (الحالات A وB وC).
// نُقلت الحالات الأولى من multi-unit-routes.test.ts (§9: الملكية لـB4) لأن النتيجة صارت تحمل `unit.unitId` و`rebase`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

// ═══ حقن البدائل قبل تحميل الموجّه (resolveLineUnit نقيّة، والوحدة تستورد القاعدة) ═══

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
const prismaFake: unknown = new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined : new Proxy({}, { get: () => async () => { throw new Error('لا قاعدة هنا'); } })) });
const pass = (_req: unknown, _res: unknown, next: () => void): void => next();
stub('config/database', { default: prismaFake });
stub('middleware/auth', {
  authenticate: pass, requireAdmin: pass, requireAccounting: pass, requireAdminPermission: () => pass,
  tenantId: () => 'T1', isOwnerSession: () => false,
});
stub('routes/invoicesZatcaDeps', { productionPhase2Deps: () => { throw new Error('لا مرحلة ثانية هنا'); } });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { resolveLineUnit } = require('../routes/invoices') as typeof import('../routes/invoices');
import type { BaseConversionRow } from '../services/baseConversions';

type Res = Awaited<ReturnType<typeof resolveLineUnit>>;
const okUnit = (r: Res) => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return r as Extract<Res, { ok: true }>;
};
const rejected = (r: Res) => [(r as { ok: boolean }).ok, (r as { status?: number }).status, (r as { code?: string }).code];

// ═══ (١) لقطة الجهاز في إعادة الرفع والكاش القديم في الحيّ (منقولة) ═══

const CONVERTED = {
  name: 'ماء', unit: 'حبة',
  units: [
    { id: 'u-ct', name: 'كرتون', factor: 24, price: 10, unitCode: 'CT', isActive: true },
    { id: 'u-sh', name: 'شدة', factor: 6, price: null, unitCode: null, isActive: false },
  ],
};
const never = async () => false;

test('إعادة الرفع: لقطة الجهاز تُكتب بعد التحقّق أنها للصنف — والأساس المحوَّل بعد الإصدار يُقرأ بمعامل وحدته', async () => {
  const replay = { replay: true, seenInHistory: never };
  const u = async (item: Record<string, unknown>, o: Parameters<typeof resolveLineUnit>[2] = replay) => okUnit(await resolveLineUnit(CONVERTED, item, o)).unit;
  // «٢ كرتون» صدرت والكرتون أساس (معامل ١)، ثم حُوّل الصنف إلى حبة: تُكتب كرتوناً بمعامل ٢٤ لا حبّتين
  assert.deepEqual(await u({ unitName: 'كرتون', unitFactor: 1 }), { unitName: 'كرتون', unitFactor: 24, unitCode: 'CT', unitId: 'u-ct', priceUnit: CONVERTED.units[0] });
  // تغيّر معامل الكرتون بعد الإصدار: معامل الجهاز يغلب، ولا يُسعَّر بسعر الوحدة المحدَّد لمعاملٍ آخر — ولا معرّف وحدةٍ لمعاملٍ آخر
  const changed = await u({ unitId: 'u-ct', unitName: 'كرتون', unitFactor: 12 });
  assert.equal(changed.unitFactor, 12);
  assert.equal(changed.priceUnit, null);
  assert.equal(changed.unitId, null);
  // وحدةٌ أُوقفت بعد الإصدار: لا يُرفض بها المستند
  assert.equal((await u({ unitId: 'u-sh', unitName: 'شدة', unitFactor: 6 })).unitFactor, 6);
  assert.equal((await u({ unitId: 'u-sh' })).unitFactor, 6, 'بلا لقطة: معامل الوحدة الموقوفة');
  // وحدةٌ حُذفت: يشهد لها التاريخ وإلّا فلا
  assert.equal((await u({ unitName: 'علبة', unitFactor: 4 }, { replay: true, seenInHistory: async (n, f) => n === 'علبة' && f === 4 })).unitFactor, 4);
  // معاملٌ لا شاهد له لا يُكتب **ولا يُقيَّد بالأساس**: يُرفض ظاهراً في صندوق الإرسال
  assert.deepEqual(rejected(await resolveLineUnit(CONVERTED, { unitName: 'علبة', unitFactor: 4 }, replay)), [false, 400, 'UNIT_INVALID']);
  // لقطة تالفة تُهمل ولا تُرفض؛ ولقطة الأساس أساس
  assert.equal((await u({ unitId: 'u-ct', unitFactor: 0 })).unitFactor, 24);
  assert.equal((await u({ unitName: 'حبة', unitFactor: 1 })).unitFactor, 1);
  assert.equal((await u({})).unitFactor, 1, 'جسم ما قبل الميزة');
});

test('إعادة الرفع بلا سجلّ: rebase يساوي معامل الوحدة التي صارها أساس الجهاز، و١ لغيره (I9)', async () => {
  const replay = { replay: true, seenInHistory: never };
  assert.equal(okUnit(await resolveLineUnit(CONVERTED, { unitName: 'كرتون', unitFactor: 1 }, replay)).rebase, 24);
  assert.equal(okUnit(await resolveLineUnit(CONVERTED, { unitName: 'كرتون', unitFactor: 1, baseUnitName: 'كرتون' }, replay)).rebase, 24);
  assert.equal(okUnit(await resolveLineUnit(CONVERTED, { unitId: 'u-ct', unitName: 'كرتون', unitFactor: 24 }, replay)).rebase, 1);
  assert.equal(okUnit(await resolveLineUnit(CONVERTED, {}, replay)).rebase, 1);
  assert.equal(okUnit(await resolveLineUnit(CONVERTED, {}, replay)).notice, undefined);
});

test('الإصدار الحيّ: الخادم يحلّ الوحدة، والموقوفة والكاش القديم ومعرّف صنفٍ آخر ٤٠٠ UNIT_INVALID', async () => {
  const live = { replay: false, seenInHistory: async (): Promise<boolean> => { throw new Error('التاريخ لا يُقرأ في الحيّ'); } };
  const ok = await resolveLineUnit(CONVERTED, { unitId: 'u-ct' }, live);
  assert.deepEqual(ok, { ok: true, unit: { unitName: 'كرتون', unitFactor: 24, unitCode: 'CT', unitId: 'u-ct', priceUnit: CONVERTED.units[0] }, rebase: 1 });
  assert.deepEqual(await resolveLineUnit(CONVERTED, { unitId: 'u-ct', unitName: 'كرتون', unitFactor: 24 }, live), ok, 'لقطةٌ مطابقة');
  assert.deepEqual(rejected(await resolveLineUnit(CONVERTED, { unitId: 'u-sh' }, live)), [false, 400, 'UNIT_INVALID'], 'الموقوفة');
  for (const stale of [
    { unitId: 'u-ct', unitName: 'كرتون', unitFactor: 12 }, // المعامل تغيّر
    { unitName: 'كرتون', unitFactor: 1 }, // يرى الكرتون أساساً — حُوّل الصنف بعد كاشه
    { unitId: 'u-gone', unitName: 'علبة', unitFactor: 4 }, // وحدةٌ حُذفت
    { baseUnitName: 'كرتون' }, // أساسٌ قديم
  ]) {
    const r = await resolveLineUnit(CONVERTED, stale, live);
    assert.deepEqual(rejected(r), [false, 400, 'UNIT_INVALID'], JSON.stringify(stale));
    assert.match(String((r as { message?: string }).message), /حدّث قائمة الأصناف/);
  }
  // المرتجع المرتبط بفاتورة بيع يقبل الوحدة الموقوفة
  assert.equal(okUnit(await resolveLineUnit(CONVERTED, { unitId: 'u-sh' }, { ...live, allowInactive: true })).unit.unitFactor, 6);
  assert.deepEqual(rejected(await resolveLineUnit(CONVERTED, { unitId: 'u-of-another-product' }, live)), [false, 400, 'UNIT_INVALID'], 'معرّف صنفٍ آخر لا يُقرأ أساساً');
  assert.deepEqual(await resolveLineUnit({ name: 'x', unit: 'حبة' }, {}, live),
    { ok: true, unit: { unitName: null, unitFactor: 1, unitCode: null, unitId: null, priceUnit: null }, rebase: 1 }, 'صنفٌ بلا وحدات');
});

test('D20-أ: الأساس يُقارَن بـbaseNameKey — اسمٌ أطول من ٦٤ حرفاً قصّه المخطّط لا يُرى كاشاً قديماً', async () => {
  const long = 'ق'.repeat(80);
  const p = { name: 'ماء', unit: long, units: [] };
  const live = { replay: false, seenInHistory: never };
  assert.equal((await resolveLineUnit(p, { baseUnitName: long.slice(0, 64) }, live)).ok, true);
  assert.equal((await resolveLineUnit({ ...p, unit: ` ${long} ` }, { baseUnitName: long.slice(0, 64) }, live)).ok, true, 'والأطراف تُقصّ');
});

// ═══ (٢) «الوحدة الرئيسية» D16: إعادة الرفع بعد تحويلٍ مسجَّل ═══

const T_CONV = new Date('2026-10-10T08:00:00Z');
const BEFORE = new Date('2026-10-09T08:00:00Z');
const AFTER = new Date('2026-10-12T08:00:00Z');
// كرتونٌ (٤٨ ريالاً) حُوّل إلى قارورة (٢ ريال): الكرتون صار وحدةً بمعامل ٢٤ بسعره، وطبليةٌ من ٥٠ كرتوناً صارت ١٢٠٠
const CT = { id: 'u-ct', name: 'كرتون', factor: 24, price: 48, unitCode: 'CT', isActive: true };
const PAL = { id: 'u-pal', name: 'طبلية', factor: 1200, price: null, unitCode: 'PF', isActive: true };
const PRODUCT = { name: 'مياه', unit: 'قارورة', basePrice: 2, units: [CT, PAL] };
const CONVS: BaseConversionRow[] = [{ fromUnit: 'كرتون', toUnit: 'قارورة', factor: 24, fromUnitId: 'u-ct', convertedAt: T_CONV }];
const replayWith = (o: Partial<Parameters<typeof resolveLineUnit>[2]> = {}): Parameters<typeof resolveLineUnit>[2] =>
  ({ replay: true, seenInHistory: never, conversions: CONVS, docAt: AFTER, ...o });

test('D16 (A): لقطةٌ بأساسٍ قديم ⇒ معامل السلسلة من السجلّ — والبند الأكبر يُضرب بها، وبلا سجلّ ⇒ الاستدلال بالاسم كما كان', async () => {
  const r = okUnit(await resolveLineUnit(PRODUCT, { unitFactor: 1, baseUnitName: 'كرتون' }, replayWith()));
  assert.deepEqual(r.unit, { unitName: 'كرتون', unitFactor: 24, unitCode: 'CT', unitId: 'u-ct', priceUnit: CT });
  assert.equal(r.rebase, 24);
  assert.equal(r.notice, undefined, 'السجلّ شاهدٌ حتمي: لا إشعار');
  // بلا لقطة معامل (أساس الجهاز وحده) — الأساس نفسه
  assert.equal(okUnit(await resolveLineUnit(PRODUCT, { baseUnitName: 'كرتون' }, replayWith())).unit.unitFactor, 24);
  // «١ طبلية = ٥٠» على أساس الجهاز (كرتون) ⇒ ١٢٠٠ قارورة بوحدة الطبلية
  const pal = okUnit(await resolveLineUnit(PRODUCT, { unitName: 'طبلية', unitFactor: 50, baseUnitName: 'كرتون' }, replayWith()));
  assert.deepEqual([pal.unit.unitName, pal.unit.unitFactor, pal.unit.unitId, pal.rebase], ['طبلية', 1200, 'u-pal', 24]);
  // لقطة الأساس الحالي: لا شيء يتغيّر
  const now = okUnit(await resolveLineUnit(PRODUCT, { unitFactor: 1, baseUnitName: 'قارورة' }, replayWith()));
  assert.deepEqual([now.unit.unitFactor, now.rebase], [1, 1]);
});

test('D16 (A) #14: وحدة التحويل حُذفت أو أعيدت تسميتها ⇒ تُقبل اللقطة بمعامل السجلّ (لا سقوط صامت إلى الأساس)', async () => {
  const gone = okUnit(await resolveLineUnit({ ...PRODUCT, units: [PAL] }, { unitFactor: 1, baseUnitName: 'كرتون' }, replayWith()));
  assert.deepEqual(gone.unit, { unitName: 'كرتون', unitFactor: 24, unitCode: null, unitId: null, priceUnit: null });
  assert.equal(gone.rebase, 24);
  const renamed = { ...CT, name: 'صندوق' };
  const ren = okUnit(await resolveLineUnit({ ...PRODUCT, units: [renamed, PAL] }, { unitFactor: 1, baseUnitName: 'كرتون' }, replayWith()));
  assert.deepEqual([ren.unit.unitName, ren.unit.unitFactor, ren.unit.unitId, ren.unit.unitCode], ['كرتون', 24, 'u-ct', 'CT'], 'بمعرّف وحدة التحويل');
  // وحدة التحويل تغيّر معاملها بعده: تُكتب بمعامل السجلّ ولا تُسعَّر بسعر الوحدة لمعاملٍ آخر
  const resized = okUnit(await resolveLineUnit({ ...PRODUCT, units: [{ ...CT, factor: 12 }, PAL] }, { unitFactor: 1, baseUnitName: 'كرتون' }, replayWith()));
  assert.deepEqual([resized.unit.unitFactor, resized.unit.priceUnit, resized.unit.unitId], [24, null, null]);
  // سلسلة تحويلين (طبلية ⇒ كرتون ⇒ قارورة) بأساس جهازٍ أقدم
  const two: BaseConversionRow[] = [{ fromUnit: 'طبلية', toUnit: 'كرتون', factor: 50, fromUnitId: 'u-pal', convertedAt: new Date('2026-10-01T08:00:00Z') }, ...CONVS];
  const old = okUnit(await resolveLineUnit(PRODUCT, { unitFactor: 1, baseUnitName: 'طبلية' }, replayWith({ conversions: two })));
  assert.deepEqual([old.unit.unitName, old.unit.unitFactor, old.unit.unitId, old.rebase], ['طبلية', 1200, 'u-pal', 1200]);
  // تحويلٌ ثم إعادة تسمية الأساس (قارورة ⇒ عبوة)
  const renamedBase: BaseConversionRow[] = [...CONVS, { fromUnit: 'قارورة', toUnit: 'عبوة', factor: 1, fromUnitId: null, convertedAt: new Date('2026-10-11T08:00:00Z') }];
  const rb = okUnit(await resolveLineUnit({ ...PRODUCT, unit: 'عبوة' }, { unitFactor: 1, baseUnitName: 'كرتون' }, replayWith({ conversions: renamedBase })));
  assert.deepEqual([rb.unit.unitFactor, rb.rebase], [24, 24]);
  // معاملٌ يتجاوز الحدّ بعد الضرب ⇒ ٤٠٠ كما كان
  assert.deepEqual(rejected(await resolveLineUnit(PRODUCT, { unitName: 'طبلية', unitFactor: 50000, baseUnitName: 'كرتون' }, replayWith())), [false, 400, 'UNIT_INVALID']);
});

test('D16 (B): جسمٌ بلا لقطة ⇒ إشارة السعر حتمية، وخلافها مع الساعة يُبلَّغ، والسعر الصفري ⇒ الساعة مع إشعار', async () => {
  // بكتالوج قديم وساعة بعد التحويل بأيام: سعر الكرتون القديم (٤٨) يحسم ×٢٤ — والساعة تخالفه فيُبلَّغ
  const late = okUnit(await resolveLineUnit(PRODUCT, {}, replayWith({ netUnitPrice: 48, docAt: AFTER })));
  assert.deepEqual([late.unit.unitName, late.unit.unitFactor, late.unit.unitId, late.rebase, late.notice], ['كرتون', 24, 'u-ct', 24, 'CLOCK_DISAGREES']);
  // السعر والساعة متّفقان ⇒ بلا إشعار
  const early = okUnit(await resolveLineUnit(PRODUCT, {}, replayWith({ netUnitPrice: 48, docAt: BEFORE })));
  assert.deepEqual([early.unit.unitFactor, early.notice], [24, undefined]);
  // سعر القارورة ⇒ الأساس
  const bottle = okUnit(await resolveLineUnit(PRODUCT, {}, replayWith({ netUnitPrice: 2.1, docAt: AFTER })));
  assert.deepEqual([bottle.unit, bottle.rebase, bottle.notice], [{ unitName: null, unitFactor: 1, unitCode: null, unitId: null, priceUnit: null }, 1, undefined]);
  // سعرٌ صفري (هدية) ⇒ الساعة مع AMBIGUOUS: قبل التحويل ×٢٤، وبعده الأساس
  const zeroBefore = okUnit(await resolveLineUnit(PRODUCT, {}, replayWith({ netUnitPrice: 0, docAt: BEFORE })));
  assert.deepEqual([zeroBefore.unit.unitFactor, zeroBefore.notice], [24, 'AMBIGUOUS']);
  const zeroAfter = okUnit(await resolveLineUnit(PRODUCT, {}, replayWith({ netUnitPrice: 0, docAt: AFTER })));
  assert.deepEqual([zeroAfter.unit.unitFactor, zeroAfter.notice], [1, 'AMBIGUOUS']);
  // بلا ساعة جهاز ولا إشارة ⇒ الأساس مع NO_DEVICE_TIME
  const noTime = okUnit(await resolveLineUnit(PRODUCT, {}, replayWith({ netUnitPrice: 0, docAt: null })));
  assert.deepEqual([noTime.unit.unitFactor, noTime.notice], [1, 'NO_DEVICE_TIME']);
  // سعر العميل يغلب: ١٫٥ للقارورة ⇒ كرتونه ٣٦
  const cust = okUnit(await resolveLineUnit(PRODUCT, {}, replayWith({ netUnitPrice: 36, custPrice: 1.5, docAt: BEFORE })));
  assert.equal(cust.unit.unitFactor, 24);
  // ومعامل ١ بلا اسمٍ ولا أساس لا يميّز أساساً قديماً من جديد: كالجسم بلا لقطة
  const one = okUnit(await resolveLineUnit(PRODUCT, { unitFactor: 1 }, replayWith({ netUnitPrice: 48, docAt: BEFORE })));
  assert.equal(one.unit.unitFactor, 24);
});

test('D16 (C): لقطةٌ بمعامل بلا أساس ⇒ إشارة المعامل (لا ضرب ثانٍ)، وإلا الساعة مع إشعار', async () => {
  // يساوي معامل الكرتون الآن ⇒ من بعد التحويل: لا يُضرب ثانيةً (كرتون ٢٤ لا يصير ٥٧٦)
  const same = okUnit(await resolveLineUnit(PRODUCT, { unitName: 'كرتون', unitFactor: 24 }, replayWith({ docAt: BEFORE })));
  assert.deepEqual([same.unit.unitFactor, same.rebase, same.notice], [24, 1, undefined]);
  // الكرتون بمعامل ١ (كان أساساً) ⇒ ×٢٤ مرةً واحدة
  const was = okUnit(await resolveLineUnit(PRODUCT, { unitName: 'كرتون', unitFactor: 1 }, replayWith({ docAt: AFTER })));
  assert.deepEqual([was.unit.unitFactor, was.unit.unitId, was.rebase, was.notice], [24, 'u-ct', 24, undefined]);
  // الطبلية بمعامل ٥٠ (على أساس الكرتون) ⇒ ١٢٠٠
  const pal = okUnit(await resolveLineUnit(PRODUCT, { unitName: 'طبلية', unitFactor: 50 }, replayWith({ docAt: AFTER })));
  assert.deepEqual([pal.unit.unitFactor, pal.rebase], [1200, 24]);
  // وحدةٌ لا اسم مطابقاً لها اليوم (حُذفت): الساعة تحكم ويشهد التاريخ بالمعامل المضروب، مع إشعار
  const seen = async (n: string, f: number) => n === 'شدة' && f === 144;
  const gone = okUnit(await resolveLineUnit(PRODUCT, { unitName: 'شدة', unitFactor: 6 }, replayWith({ docAt: BEFORE, seenInHistory: seen })));
  assert.deepEqual([gone.unit.unitFactor, gone.rebase, gone.notice], [144, 24, 'AMBIGUOUS']);
  // ساعة بعد التحويل ⇒ المعامل كما هو (لا شاهد له) ⇒ ٤٠٠ ظاهر كما كان
  assert.deepEqual(rejected(await resolveLineUnit(PRODUCT, { unitName: 'شدة', unitFactor: 6 }, replayWith({ docAt: AFTER, seenInHistory: seen }))), [false, 400, 'UNIT_INVALID']);
});

test('D16: السجلّ لا يُقرأ في الحيّ ولا يغيّر شيئاً — الحيّ كما كان حرفياً', async () => {
  const live = { replay: false, seenInHistory: never, conversions: CONVS, docAt: AFTER, netUnitPrice: 48 };
  const r = okUnit(await resolveLineUnit(PRODUCT, {}, live));
  assert.deepEqual([r.unit.unitFactor, r.rebase, r.notice], [1, 1, undefined], 'الحيّ: غياب unitId = الأساس دائماً (D3)');
  assert.deepEqual(rejected(await resolveLineUnit(PRODUCT, { unitFactor: 1, baseUnitName: 'كرتون' }, live)), [false, 400, 'UNIT_INVALID'], 'وكاشٌ بأساسٍ قديم يُرفض');
});
