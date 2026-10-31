import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PHRASES } from '../i18n/strings';

/**
 * «الوحدة الرئيسية» في شاشات B5b (primary_unit_spec §5.3) — حرّاس ثابتة على المصدر: الصفحات (tsx) لا تُشغَّل بلا متصفح،
 * ومنطقها النقيّ في lib/stockRequest.ts (stockRequest.primary.test.ts). هنا يُثبَت أن الصفحات تستعمله فعلاً:
 * كل بند مخزونٍ يحمل `baseUnitName`، وردّ «الوحدات تغيّرت» يعيد الجلب، والإزالة تحوّل إلى الأساس قبل الإرسال،
 * والمجاميع عبر الأصناف موسومة (R3)، وصنفٌ بلا رئيسية على نصّه القائم (I1).
 */
const src = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const van = src('../pages/VanStockPage.tsx');
const wh = src('../pages/CompanyWarehousePage.tsx');
const log = src('../components/VanLoadsLog.tsx');
const inv = src('../components/forms/InvoiceModal.tsx');
const req = src('../components/StockRequestModal.tsx');

/** جسم الدالة/المكوّن من رأسه حتى رأس التالي في الملف */
const body = (s: string, head: string, next: string) => {
  const a = s.indexOf(head);
  assert.ok(a >= 0, `غائب: ${head}`);
  const b = s.indexOf(next, a + head.length);
  return s.slice(a, b < 0 ? undefined : b);
};

test('نافذة التحميل: كل بندٍ (تحميلاً وتنزيلاً) يحمل baseUnitName بعد التقسيم، و400/409 يعيد الأسطر بوحداتها الآن', () => {
  const m = body(van, 'function LoadModal(', '\nfunction LoadRowLots(');
  assert.match(m, /const \{ out, back \} = splitVanMovement\(\n\s+withBaseUnitNames\(rows\.map\(/, 'بند التحميل يحمله كما هو');
  assert.match(m, /const backItems = withBaseUnitNames\(back, baseOf\)/, 'splitVanMovement يُسقط ما لا يعرفه من بند التنزيل');
  assert.match(m, /type: 'LOAD', note: trimmed, items: out \}/);
  assert.match(m, /type: 'UNLOAD', note: trimmed, items: backItems \}/);
  assert.match(m, /baseUnit: String\(p\.unit \?\? ''\)/, 'الأساس كما رآه النموذج لحظة إضافة الصنف');
  assert.match(m, /if \(isStaleUnitsError\(e\)\) void rebaseRows\(\)/);
  assert.match(m, /rebaseRow\(/);
  // R5 في التلميح وR6 الافتراضي وR7 الاقتراح
  assert.match(m, /hint: `\$\{p\.code\} · \$\{productUnitLabel\(p\)\}`/);
  assert.match(m, /const c = defaultChoice\(p\)/);
  assert.match(m, /p \? suggestionChoice\(p, r\.suggested\) : suggestionChoice\(\{ unit: r\.unit, units: r\.units \?\? \[\] \}, r\.suggested\)/, 'بلا رئيسية كما كان');
  // الرئيسية من صفّ الاقتراح نفسه أولاً (لا تنتظر قائمة الأصناف)، والكتالوج احتياطٌ لخادمٍ لا يرسلها
  assert.match(m, /const suggestPrimary = \(r: SuggestRow\) => suggestPrimarySource\(r, productOf\(r\.id\)\)/);
  // D21: رسالة الكسور لصنفٍ له رئيسية بلا «الأساس»، والقائمة لغيره حرفاً
  assert.match(m, /primaryUnitOf\(productOf\(r\.productId\)\)\n\s+\? tr\('كمية الصنف المتتبع بأربع خانات عشرية على الأكثر بالوحدة الصغرى'\)\n\s+: tr\('كمية الصنف المتتبع بأربع خانات عشرية على الأكثر بوحدة الأساس'\)/);
});

test('إزالة المنتهي/التالف (D8): منتقي وحدة لصنفٍ له رئيسية وحده، والكمية بالأساس قبل التحقق والإرسال، وbaseUnitName، و400/409 ⇒ إعادة الجلب', () => {
  const m = body(van, 'function RemoveOutModal(', '\nfunction ');
  assert.match(m, /removalStart\(row, have\)/);
  assert.match(m, /const choices = prim \? unitChoices\(row\) : \[\]/, 'بلا رئيسية لا منتقٍ (I1)');
  assert.match(m, /const n = removalBaseQty\(qty, factor\)/);
  assert.match(m, /const qtyOk = n > 0 && n <= have \+ 1e-9 && \(!tracked \|\| isFourDecimals\(n\)\)/, 'المقارنة بالرصيد بالأساس');
  assert.match(m, /draftProblem\(draft \?\? \[\], n, sources\)/, 'مجموع التشغيلات يُقارن بـn بالأساس');
  assert.match(m, /withBaseUnitNames\(\[\{ productId: row\.productId, qty: n,/);
  assert.doesNotMatch(m, /unitId: unitId/, 'عقد الخادم لا يتغيّر: البند بلا unitId');
  assert.match(m, /if \(isStaleUnitsError\(e\)\) \{ onDone\(\); onClose\(\); \}/);
  // الفرع القائم لصنفٍ بلا رئيسية كما كان
  assert.match(m, /\{hasBigUnit\(row\.units\) && <p className="text-\[10px\] text-\[#9A8F7E\] mt-1">\{tr\('بوحدة الأساس'\)\} \{row\.unit\}<\/p>\}/);
});

test('إجراءات التشغيلة في السيارة (إتلاف/تنزيل) تحمل baseUnitName من صفّ السيارة', () => {
  assert.match(van, /vanStockApi\.createLoad\(withItemsBase\(a\.kind === 'DESTROY'/);
  assert.match(van, /\}, a\.baseUnit\)\),/);
  assert.equal((van.match(/qty: roundLot\(l\.usable\), baseUnit: row\.unit \}/g) ?? []).length, 2);
});

test('مخزون السيارات: العنوان الفرعي بالرئيسية بلا «الأساس»، والملخّص موسوم (R3)، ودقّة الاقتراح بالرئيسية وحدها', () => {
  assert.match(van, /primaryUnitOf\(row\) \? `\$\{tr\('الوحدة الرئيسية'\)\} \$\{productUnitLabel\(row\)\}` : hasBigUnit\(row\.units\) \? `\$\{tr\('وحدة الأساس'\)\} \$\{row\.unit\}` : row\.unit/);
  assert.match(van, /const sumTitle = tr\(crossSumLabel\(hasPrimary\)\)/);
  assert.equal((van.match(/title=\{sumTitle\}/g) ?? []).length, 4);
  assert.doesNotMatch(van, /title=\{tr\('مجموع بوحدات الأساس'\)\}/, 'الوسم من crossSumLabel وحده');
  const acc = body(van, 'function AccuracyModal(', '\n/** سطر نافذة التحميل');
  assert.match(acc, /const q = \(n: number\) => \(prim \? baseQtyText\(n, r, fmtQty\) : fmtQty\(n\)\)/, 'بلا رئيسية الرقم كما كان');
});

test('المستودع: سطر الوارد بالرئيسية افتراضاً ويحمل baseUnitName، و400/409 يعيد الأسطر، والتكلفة للرئيسية أولاً', () => {
  const m = body(wh, 'function WarehouseEntryModal(', '\nfunction ');
  assert.match(m, /const c = defaultChoice\(p\)/);
  assert.match(m, /\.\.\.\(r\.baseUnit && \{ baseUnitName: r\.baseUnit \}\)/);
  assert.match(m, /if \(isStaleUnitsError\(e\)\) void rebaseRows\(\)/);
  assert.match(m, /hint: `\$\{p\.code\} · \$\{productUnitLabel\(p\)\}`/);
  assert.match(wh, /\{prim\.name\}: \{formatCurrency\(r\.avgCost \* Number\(prim\.factor\), undefined, 4\)\}/);
  // تلميح المتوسّط الخام (تكلفة القارورة) على سطر القارورة لا على سطر الكرتون
  assert.match(wh, /title=\{String\(r\.avgCost\)\}>\{r\.unit\}: \{formatCurrency\(r\.avgCost, undefined, 4\)\}/);
  assert.doesNotMatch(wh, /title=\{String\(r\.avgCost\)\}>\{prim\.name\}/);
  assert.match(wh, /title=\{tr\(crossSumLabel\(hasPrimary\)\)\}/);
  assert.match(wh, /\{hasPrimary \? tr\('متوسط التكلفة'\) : tr\('متوسط التكلفة لوحدة الأساس'\)\}/);
});

test('سجلّ التحميلات: وسم المجموع من loadSumLabel (R3)', () => {
  assert.match(log, /const sumLabel = loadSumLabel\(items\)/);
  assert.match(log, /title=\{sumLabel \? tr\(sumLabel\) : undefined\}/);
});

test('الفاتورة: الافتراض defaultChoice (الرئيسية)، ورقاقتها مبرزة، و409 PRODUCT_UNITS_CHANGED يحدّث القائمة كـ400', () => {
  assert.match(inv, /const addProduct = \(p: Product\) => \{\n\s+const c = defaultChoice\(p\);/);
  assert.match(inv, /const primId = p \? primaryChoice\(p\)\?\.id \?\? null : null;/);
  assert.match(inv, /\{primId && c\.id === primId \? ` · \$\{tr\('رئيسية'\)\}` : ''\}/);
  assert.match(inv, /if \(data\?\.code === 'UNIT_INVALID' \|\| data\?\.code === 'PRODUCT_UNITS_CHANGED'\) qc\.invalidateQueries\(\{ queryKey: \['products-all'\] \}\)/);
});

test('طلب المخزون: الحفظ يُسقط تعديلات طلبٍ تغيّرت وحداته، والصفّ موسوم بالرئيسية', () => {
  assert.match(req, /if \(isStaleUnitsError\(e\)\) dropEdits\(r\.id\)/);
  assert.match(req, /prim \? `\$\{tr\('الوحدة الرئيسية'\)\} \$\{productUnitLabel\(r\)\}` : multi \? `\$\{tr\('وحدة الأساس'\)\} \$\{r\.unit\}` : r\.unit/);
});

test('نصوص B5b الجديدة بلغاتها الأربع وبلا كلمة «الأساس» (D21)', () => {
  for (const k of ['متوسط التكلفة', 'كمية الصنف المتتبع بأربع خانات عشرية على الأكثر بالوحدة الصغرى']) {
    const p = (PHRASES as Record<string, Record<string, string>>)[k];
    assert.ok(p, k);
    for (const l of ['en', 'fr', 'tr', 'zh']) assert.ok(p[l]?.trim(), `${k} ${l}`);
    assert.doesNotMatch(k, /الأساس/);
  }
});
