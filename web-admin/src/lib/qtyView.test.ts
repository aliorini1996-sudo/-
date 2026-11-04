import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { baseQtyText } from './adminUnits';
import {
  DEFAULT_QTY_VIEW, QTY_VIEW_KEY, anyBigUnit, fmtTotalQty, isQtyView, loadQtyView, qtyText, qtyViewFor, radioKeyStep, saveQtyView,
  totalsList, unitTotalsItems, unitTotalsParts, unitTotalsText, type QtyView,
} from './qtyView';
import { PHRASES } from '../i18n/strings';

/**
 * «عرض الكميات» (طلب المالك ٤ نوفمبر ٢٠٢٦): «الكبرى» = baseQtyText حرفاً (عرض اليوم)، و«الصغرى» = رقم الأساس واسمه لصنفٍ له
 * وحدةٌ أكبر، والمجاميع عبر الأصناف لكل وحدةٍ كبرى من الخادم. صنف «ماء» أساسه القارورة، والكرتون ٢٤ والطبلية ١٢٠٠.
 */
const units = [
  { id: 'u-ctn', name: 'كرتون', factor: 24, price: null, isActive: true },
  { id: 'u-pal', name: 'طبلية', factor: 1200, price: 2000, isActive: true },
];
const water = { unit: 'قارورة', units };
const waterPrimary = { unit: 'قارورة', units, primaryUnitId: 'u-ctn' };
const waterBadPrimary = { unit: 'قارورة', units, primaryUnitId: 'gone' };
const plainItem = { unit: 'كيس', units: [] };
const inactiveBig = { unit: 'حبة', units: [{ id: 'u-x', name: 'كرتون', factor: 24, isActive: false }] };
const plain = (n: number) => String(n);
const fmtEn = (n: number) => Number(n.toFixed(2)).toLocaleString('en-US');

const products = [water, waterPrimary, waterBadPrimary, plainItem, inactiveBig, { unit: 'حبة' }, null, undefined];
const samples = [0, 1, 23, 24, 51, 1250, 1250.5, 2401, -24, -51, 0.333333, 1e6 + 3];

test('«الكبرى» = baseQtyText حرفاً لكل صنفٍ وكمية ومنسّق — عرض اليوم بلا تغيير', () => {
  for (const p of products) {
    for (const n of samples) {
      for (const f of [plain, fmtEn]) {
        assert.equal(qtyText('major', n, p, f), baseQtyText(n, p, f), `${JSON.stringify(p)} ${n}`);
      }
    }
  }
  // أمثلةٌ صريحة: الرئيسية يقف العرض عندها، وبلاها أكبر وحدةٍ تنقسم
  assert.equal(qtyText('major', 1250, waterPrimary, fmtEn), '52 كرتون و2 قارورة');
  assert.equal(qtyText('major', 2401, water, fmtEn), '2 طبلية و1 قارورة');
  assert.equal(qtyText('major', 5, plainItem, fmtEn), '5');
});

test('«الصغرى»: رقم الأساس بجانب اسمه لصنفٍ له وحدةٌ أكبر — وغيره كما هو', () => {
  assert.equal(qtyText('minor', 1250, waterPrimary, fmtEn), '1,250 قارورة');
  assert.equal(qtyText('minor', 2401, water, fmtEn), '2,401 قارورة');
  // رئيسيةٌ تالفة لا تمنع الصغرى: للصنف وحدةٌ أكبر نشطة
  assert.equal(qtyText('minor', 48, waterBadPrimary, plain), '48 قارورة');
  assert.equal(qtyText('minor', -24, water, fmtEn), '-24 قارورة');
  assert.equal(qtyText('minor', 0, water, fmtEn), '0 قارورة');
  assert.equal(qtyText('minor', 1250.456, water, fmtEn), '1,250.46 قارورة');
  // المنسّق نفسه على الرقم (fmtLotQty أربع منازل مثلاً)
  assert.equal(qtyText('minor', 0.3333, water, n => n.toFixed(4)), '0.3333 قارورة');
  // صنفٌ بلا وحدةٍ أكبر (أو وحدته الكبرى موقوفة): الحالان سواء = baseQtyText
  for (const p of [plainItem, inactiveBig, { unit: 'حبة' }, null, undefined]) {
    for (const n of samples) assert.equal(qtyText('minor', n, p, fmtEn), baseQtyText(n, p, fmtEn));
  }
  assert.equal(qtyText('minor', 48, inactiveBig, plain), '48');
  // كميةٌ ليست رقماً تُقرأ صفراً كما في baseQtyText
  assert.equal(qtyText('minor', Number.NaN, water, plain), '0 قارورة');
});

test('قيمة عرضٍ تالفة تُقرأ «الكبرى»', () => {
  assert.equal(qtyText('weird' as QtyView, 1250, waterPrimary, fmtEn), baseQtyText(1250, waterPrimary, fmtEn));
  assert.equal(qtyViewFor('weird' as QtyView, true), 'major');
});

test('المجاميع لكل وحدةٍ كبرى: «22.75 كرتون · 40 حبة» بترتيب الخادم، والفارغ صفر', () => {
  assert.equal(unitTotalsText([{ unit: 'كرتون', qty: 22.75 }, { unit: 'حبة', qty: 40 }], fmtEn), '22.75 كرتون · 40 حبة');
  assert.equal(unitTotalsText([{ unit: 'حبة', qty: 40 }, { unit: 'كرتون', qty: 22.75 }], fmtEn), '40 حبة · 22.75 كرتون');
  assert.equal(unitTotalsText([{ unit: 'كرتون', qty: 1234.5 }], fmtEn), '1,234.5 كرتون');
  assert.equal(unitTotalsText([{ unit: 'كرتون', qty: -3 }], fmtEn), '-3 كرتون');
  assert.equal(unitTotalsText([], fmtEn), '0');
  assert.equal(unitTotalsText(null, fmtEn), '0');
  assert.equal(unitTotalsText(undefined, plain), '0');
  // مدخلٌ تالف يُتخطّى ولا يُسقط الشاشة، والاسم يُقصّ
  assert.equal(unitTotalsText([null, { unit: ' شدة ', qty: 2 }, { unit: 'x', qty: Number.NaN }], plain), '2 شدة');
  assert.equal(unitTotalsText([{ unit: '', qty: 7 }], plain), '7');
  assert.deepEqual(unitTotalsParts([{ unit: 'كرتون', qty: 2 }, { unit: 'حبة', qty: 5 }], plain), ['2 كرتون', '5 حبة']);
  assert.deepEqual(unitTotalsParts('x' as never, plain), []);
});

test('منسّق المجاميع بأربع منازل كالخادم: كميةٌ غير صفرٍ لا تُطبع «0» ولا «-0»', () => {
  // بيضةٌ من كرتون ٣٦٠، و٣ قوارير من طبلية ١٢٠٠، و٥ قوارير بيعت بلا رصيد — بمنسّق الصفحة (منزلتان) كانت «0» و«-0»
  assert.equal(fmtTotalQty(0.0028), '0.0028');
  assert.equal(fmtTotalQty(0.0025), '0.0025');
  assert.equal(fmtTotalQty(-0.0042), '-0.0042');
  assert.equal(fmtTotalQty(0.0001), '0.0001');
  assert.equal(fmtTotalQty(22.7917), '22.7917');
  assert.equal(fmtTotalQty(22.75), '22.75');
  assert.equal(fmtTotalQty(1234.5), '1,234.5');
  assert.equal(fmtTotalQty(-3), '-3');
  // دون أربع منازل (لا يرسله الخادم): رقمٌ غير صفر بخانتين معنويّتين
  assert.equal(fmtTotalQty(0.000012), '0.000012');
  assert.equal(fmtTotalQty(-0.00001), '-0.00001');
  assert.equal(fmtTotalQty(0), '0');
  assert.equal(fmtTotalQty(-0), '0');
  assert.equal(fmtTotalQty(Number.NaN), '0');
  for (const q of [0.0028, -0.0028, 0.0042, -0.0042, 0.0001, 0.00001, -0.000049]) {
    const t = unitTotalsText([{ unit: 'كرتون', qty: q }], fmtTotalQty);
    assert.notEqual(t, '0 كرتون'); assert.notEqual(t, '-0 كرتون');
    assert.ok(!/^-?0 /.test(t), t);
  }
  assert.equal(unitTotalsText([{ unit: 'طبلية', qty: 0.0025 }, { unit: 'كيس', qty: 6 }], fmtTotalQty), '0.0025 طبلية · 6 كيس');
  // اللغة النشطة تمرّ إلى toLocaleString
  assert.equal(fmtTotalQty(1234.5, 'fr-FR').replace(/\s/g, ' '), '1 234,5');
});

test('unitTotalsItems: النصّ والكمية بإشارتها لتلوين كل مجموعةٍ وحدها', () => {
  assert.deepEqual(unitTotalsItems([{ unit: 'كرتون', qty: 2 }, { unit: 'كيس', qty: -5 }, null, { unit: 'x', qty: Number.NaN }], plain),
    [{ text: '2 كرتون', qty: 2 }, { text: '-5 كيس', qty: -5 }]);
  assert.deepEqual(unitTotalsItems(null, plain), []);
  assert.deepEqual(unitTotalsParts([{ unit: 'كرتون', qty: 2 }, { unit: 'كيس', qty: -5 }], plain), ['2 كرتون', '-5 كيس']);
});

test('totalsList: القائمة كما وصلت أو null لخادمٍ أقدم', () => {
  const l = [{ unit: 'كرتون', qty: 1 }];
  assert.equal(totalsList(l), l);
  assert.equal(totalsList(undefined), null);
  assert.equal(totalsList(null), null);
  assert.equal(totalsList({ qty: 1 }), null);
});

test('ظهور المبدّل: صنفٌ له وحدةٌ أكبر نشطة — وإلّا «الكبرى» أيّاً كان المحفوظ', () => {
  assert.equal(anyBigUnit([plainItem, inactiveBig, null]), false);
  assert.equal(anyBigUnit([]), false);
  assert.equal(anyBigUnit([plainItem, water]), true);
  assert.equal(qtyViewFor('minor', false), 'major');
  assert.equal(qtyViewFor('minor', true), 'minor');
  assert.equal(qtyViewFor('major', true), 'major');
});

/** تخزينٌ وهمي لكل اختبار */
function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => { m.set(k, String(v)); }, m };
}

test('التفضيل المحفوظ: المفتاح fs_qty_view والغائب أو التالف أو الرامي «الكبرى»', () => {
  assert.equal(QTY_VIEW_KEY, 'fs_qty_view');
  assert.equal(DEFAULT_QTY_VIEW, 'major');
  assert.equal(loadQtyView(memStorage()), 'major');
  assert.equal(loadQtyView(memStorage({ fs_qty_view: 'minor' })), 'minor');
  assert.equal(loadQtyView(memStorage({ fs_qty_view: 'major' })), 'major');
  assert.equal(loadQtyView(memStorage({ fs_qty_view: 'MINOR' })), 'major');
  assert.equal(loadQtyView(memStorage({ fs_qty_view: '' })), 'major');
  assert.equal(loadQtyView(null), 'major');
  assert.equal(loadQtyView({ getItem: () => { throw new Error('SecurityError'); }, setItem: () => {} }), 'major');
  // بلا تخزين في البيئة (اختبارات node): لا رمي
  assert.equal(loadQtyView(), 'major');

  const s = memStorage();
  saveQtyView('minor', s);
  assert.equal(s.m.get('fs_qty_view'), 'minor');
  assert.equal(loadQtyView(s), 'minor');
  saveQtyView('major', s);
  assert.equal(loadQtyView(s), 'major');
  // قيمةٌ تالفة لا تُكتب، وتخزينٌ محجوب لا يرمي
  saveQtyView('x' as QtyView, s);
  assert.equal(s.m.get('fs_qty_view'), 'major');
  assert.doesNotThrow(() => saveQtyView('minor', { getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); } }));
  assert.doesNotThrow(() => saveQtyView('minor', null));
  assert.doesNotThrow(() => saveQtyView('minor'));
  assert.equal(isQtyView('major'), true);
  assert.equal(isQtyView('minor'), true);
  assert.equal(isQtyView(null), false);
  assert.equal(isQtyView('base'), false);
});

test('لوحة المفاتيح في المبدّل: الأسهم تدور وتتبع اتجاه الصفحة', () => {
  // من اليمين لليسار: السهم الأيسر «التالي»
  assert.equal(radioKeyStep('ArrowLeft', 0, 2, true), 1);
  assert.equal(radioKeyStep('ArrowLeft', 1, 2, true), 0);
  assert.equal(radioKeyStep('ArrowRight', 0, 2, true), 1);
  assert.equal(radioKeyStep('ArrowRight', 0, 3, true), 2);
  assert.equal(radioKeyStep('ArrowRight', 0, 3, false), 1);
  assert.equal(radioKeyStep('ArrowLeft', 0, 3, false), 2);
  assert.equal(radioKeyStep('ArrowDown', 2, 3, true), 0);
  assert.equal(radioKeyStep('ArrowUp', 0, 3, false), 2);
  assert.equal(radioKeyStep('Home', 1, 2, true), 0);
  assert.equal(radioKeyStep('End', 0, 2, true), 1);
  assert.equal(radioKeyStep('Tab', 0, 2, true), null);
  assert.equal(radioKeyStep('Enter', 0, 2, true), null);
  assert.equal(radioKeyStep('ArrowLeft', 0, 0, true), null);
});

test('نصوص المبدّل مترجمة إلى اللغات الأربع', () => {
  for (const k of ['عرض الكميات', 'الوحدة الكبرى', 'الوحدة الصغرى']) {
    const e = PHRASES[k];
    assert.ok(e, `«${k}» غائبٌ عن PHRASES`);
    for (const l of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(e[l]?.trim(), `«${k}» بلا ${l}`);
  }
});

test('الصفحتان: المبدّل بشرط الوحدة الأكبر، والنماذج والنوافذ كما هي', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8');
  const wh = read('pages', 'CompanyWarehousePage.tsx');
  const van = read('pages', 'VanStockPage.tsx');
  assert.match(wh, /\{anyBig && <QtyViewToggle \/>\}/);
  assert.match(van, /\{anyBig && <QtyViewToggle variant="field" \/>\}/);
  // كل كميةٍ معروضة في «مخزون الشركة» من qtyText — لا baseQtyText باقٍ
  assert.doesNotMatch(wh, /baseQtyText\(/);
  // مجاميع «ما في السيارات» بالكبرى بشرط المبدّل الظاهر — مخفيٌّ ⇒ اليوم حرفاً
  assert.match(wh, /anyBig && qv === 'major' \? vans\?\.major : undefined/);
  assert.match(van, /const majorSums = anyBig && qv === 'major'/);
  // المجاميع لكل وحدةٍ بمنسّق الأربع منازل لا fmtQty (منزلتان ⇒ «0 كرتون» لبضاعةٍ قائمة)
  assert.match(wh, /unitTotalsParts\(list, fmtTotalQty\)/);
  assert.match(van, /unitTotalsItems\(totalsList\(list\), fmtTotal\)/);
  assert.doesNotMatch(wh + van, /unitTotals(Text|Parts|Items)\([^)]*fmtQty\)/);
  // بطاقة السيارات: المجموعات بـ« + » لا بفاصل البنود « · »، والمتعدّد بين قوسين قبل وسمه
  assert.match(wh, /\{i > 0 && ' \+ '\}<span className="whitespace-nowrap">/);
  assert.match(wh, /<UnitTotalsInline list=\{vansUncostedTotals\} base=\{vans\.uncostedQty\} paren \/>/);
  assert.match(wh, /<UnitTotalsInline list=\{vansUnsellableTotals\} base=\{vans\.unsellableQty\} paren \/>/);
  // سطر التشغيلات المعزولة بالأساس: تحت مجاميع «الكبرى» موسومٌ «بالوحدات الصغرى» (لا يُقرأ كراتين)
  assert.match(wh, /\{fmtQty\(vansLotUnsellable\)\}\{vansQtyTotals && <> \{tr\('بالوحدات الصغرى'\)\}<\/>\}/);
  // المتبقّي في ملخّص المناديب: كل مجموعةٍ بلون إشارتها
  assert.match(van, /<UnitTotalsCell list=\{r\.major\?\.remaining\} base=\{r\.totalRemaining\} tone \/>/);
  // سطر الاقتراح ورصيد نافذة الإزالة باقيان بالعرض القائم (نماذج لا عرض)
  assert.match(van, /baseQtyText\(r\.suggested, suggestProduct\(r\), fmtQty\)/);
  assert.match(van, /baseQtyText\(have, row, fmtQty\)/);
});
