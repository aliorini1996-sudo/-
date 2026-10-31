// «الوحدة الرئيسية» — الحزمة B5c (primary_unit_spec §5.3): التقارير وترتيب المناديب ولوكيشن والتشغيلات وكشف الحساب
// والكتالوج العام. المنطق الصرف يُختبر بالنداء (lib/locations.ts وlib/lotsPage.ts وRepRankingBoard وCatalogPage)، والتوصيل
// في الصفحات التي تستورد api/client (import.meta.env لا يُقرأ في node) بحرّاسٍ نصّية.
// كل حالةٍ بلا وحدة رئيسية (primaryUnitId غائب أو null أو تالف) تطابق 079fb38 حرفاً (I1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  loadProductPrimaryText, loadsQtySuffix, summaryHasPrimary, summarySheets,
  type LocBucket, type LocLoadProduct, type LocationsSummaryData,
} from './locations';
import {
  baseChangedError, lotQtyDir, lotQtyText, lotQtyUnitText, lotRowProduct, lotUnitTag, lotsUnitNote, relabelBody, unloadBody,
  type RelabelLineForm,
} from './lotsPage';
import type { LotUnloadPlanDto } from './lots';
import type { UnitDef } from './units';
import { formatRankingValue, type RankingProduct } from '../components/reports/RepRankingBoard';
import { CatalogPrices, catalogPriceLines } from '../pages/CatalogPage';
import { roundDecimal } from '../rep/invoiceCalc';
import { PHRASES } from '../i18n/strings';

const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const arTr = (s: string) => s;
const plain = (n: number) => String(n);

const CARTON: UnitDef = { id: 'u-ct', name: 'كرتون', factor: 24, isActive: true };
const PALLET: UnitDef = { id: 'u-pl', name: 'طبلية', factor: 1200, isActive: true };

// ═══ لوكيشن (lib/locations.ts) ═══

const bucket = (id: string | null, products: LocLoadProduct[]): LocBucket => ({
  locationId: id, name: id ? `موقع ${id}` : null, isActive: true, lat: null, lng: null,
  sales: { count: 0, amount: 0 }, returns: { count: 0, amount: 0 }, net: 0,
  loads: { count: products.length, qty: products.reduce((s, p) => s + p.qty, 0), products },
});
const summaryOf = (products: LocLoadProduct[]): LocationsSummaryData => ({
  range: { from: '2026-10-31', to: '2026-10-31', timezone: 'Asia/Riyadh' },
  rows: [bucket('a', products)],
  none: bucket(null, []),
  totals: { sales: { count: 0, amount: 0 }, returns: { count: 0, amount: 0 }, net: 0, loads: { count: products.length, qty: products.reduce((s, p) => s + p.qty, 0) } },
});
const water = (over: Partial<LocLoadProduct> = {}): LocLoadProduct =>
  ({ productId: 'p1', name: 'مياه', unit: 'قارورة', qty: 1250, units: [PALLET, CARTON], ...over });

test('لوكيشن: رقاقة الصنف بالوحدة الرئيسية، وبلاها (أو بمعرّفٍ تالف) null فيبقى العرض القائم', () => {
  assert.equal(loadProductPrimaryText(water({ primaryUnitId: 'u-ct' }), plain), '52 كرتون و2 قارورة', 'تقف عند الكرتون ولا تذكر الطبلية (D4)');
  assert.equal(loadProductPrimaryText(water({ primaryUnitId: 'u-ct', qty: 0 }), plain), '0 كرتون');
  assert.equal(loadProductPrimaryText(water({ primaryUnitId: 'u-ct', qty: 1250 }), (n) => `«${n}»`), '«52» كرتون و«2» قارورة', 'الأرقام بمنسّق الشاشة');
  assert.equal(loadProductPrimaryText(water(), plain), null, 'بلا رئيسية ⇒ القائم');
  assert.equal(loadProductPrimaryText(water({ primaryUnitId: null }), plain), null);
  assert.equal(loadProductPrimaryText(water({ primaryUnitId: 'u-gone' }), plain), null, 'معرّف لا يطابق وحدة ⇒ القائم (I5)');
  assert.equal(loadProductPrimaryText(water({ primaryUnitId: 'u-ct', units: [{ ...CARTON, isActive: false }] }), plain), null, 'رئيسية موقوفة ⇒ القائم');
  assert.equal(loadProductPrimaryText({ productId: 'p', name: 'x', unit: 'حبة', qty: 5 }, plain), null, 'خادمٌ أقدم بلا units');
});

test('لوكيشن R3: مجموع الكميات موسوم «بالوحدات الصغرى» حين فيه صنفٌ له رئيسية، وإلا الوسم القائم حرفاً', () => {
  assert.equal(summaryHasPrimary(summaryOf([water({ primaryUnitId: 'u-ct' })])), true);
  assert.equal(summaryHasPrimary(summaryOf([water({ primaryUnitId: null })])), false, 'null حاضر في كل select — ليس رئيسية');
  assert.equal(loadsQtySuffix(summaryOf([water({ primaryUnitId: 'u-ct' })]), arTr), ' (بالوحدات الصغرى)');
  assert.equal(loadsQtySuffix(summaryOf([water()]), arTr), '');
  assert.equal(loadsQtySuffix(undefined, arTr), '');
});

test('لوكيشن R9: ورقة الأصناف — الكمية رقماً بالأساس، ونصّها بالرئيسية عمودٌ يظهر مع الرئيسية وحدها', () => {
  const on = summarySheets(summaryOf([water({ primaryUnitId: 'u-ct' }), { productId: 'p2', name: 'عصير', unit: 'علبة', qty: 7, primaryUnitId: null }]), arTr);
  assert.deepEqual(on[1].rows[0], { 'الموقع': 'موقع a', 'الصنف': 'مياه', 'الوحدة': 'قارورة', 'الكمية': 1250, 'الكمية بوحداتها': '52 كرتون و2 قارورة' });
  assert.deepEqual(on[1].rows[1], { 'الموقع': 'موقع a', 'الصنف': 'عصير', 'الوحدة': 'علبة', 'الكمية': 7, 'الكمية بوحداتها': '7 علبة' });
  assert.equal(on[1].colWidths?.length, 5);
  assert.ok(Object.keys(on[0].rows[0]).includes('كمية التحميل (بالوحدات الصغرى)'), 'وسم R3 في ورقة المواقع');

  // I1: بلا رئيسية — الورقتان كما في 079fb38 حرفاً
  const off = summarySheets(summaryOf([water({ primaryUnitId: null })]), arTr);
  assert.deepEqual(off[1].rows[0], { 'الموقع': 'موقع a', 'الصنف': 'مياه', 'الوحدة': 'قارورة', 'الكمية': 1250 });
  assert.deepEqual(off[1].colWidths, [24, 28, 10, 14]);
  assert.ok(Object.keys(off[0].rows[0]).includes('كمية التحميل'));
  assert.ok(!Object.keys(off[0].rows[0]).some((k) => k.includes('بالوحدات الصغرى')));
});

test('LocationsPage: الرقاقة بالرئيسية ووسم R3 على المجاميع، والفرع القائم حرفاً', () => {
  const s = read('pages', 'LocationsPage.tsx');
  assert.match(s, /loadProductPrimaryText\(p, fmtQty\)/);
  assert.ok(s.includes("<b>{fmtQty(p.qty)}</b> {p.unit ?? ''}"), 'الفرع بلا رئيسية كما كان');
  assert.match(s, /\{tr\('كمية التحميل'\)\}\{qtySuffix\}/);
  assert.match(s, /\$\{tr\('الكمية'\)\} \$\{fmtQty\(b\.loads\.qty\)\}\$\{qtySuffix\}/);
  assert.match(s, /\{fmtQty\(data\.totals\.loads\.qty\)\}\{qtySuffix\}/);
});

// ═══ التشغيلات (lib/lotsPage.ts) ═══

const lotProd = { unit: 'قارورة', units: [PALLET, CARTON], primaryUnitId: 'u-ct' };
const fmt2 = (n: number) => `[${n}]`;

test('التشغيلات R1: الكمية بالرئيسية «2 كرتون و3 قارورة»، وبلاها fmt(n) حرفاً', () => {
  assert.equal(lotQtyText(51, lotProd, plain), '2 كرتون و3 قارورة');
  assert.equal(lotQtyText(51, lotProd, fmt2), '[2] كرتون و[3] قارورة', 'الأرقام بمنسّق الشاشة');
  assert.equal(lotQtyText(0, lotProd, plain), '0 كرتون', 'الصفر بالرئيسية (قرار المالك)');
  assert.equal(lotQtyText(-26, lotProd, plain), '-1 كرتون و2 قارورة', 'العجز السالب');
  assert.equal(lotQtyText(5, lotProd, plain), '5 قارورة');
  // I1
  assert.equal(lotQtyText(51, { ...lotProd, primaryUnitId: null }, fmt2), '[51]', 'بلا رئيسية: الرقم وحده كما كان — لا تفكيك بالكرتون');
  assert.equal(lotQtyText(51, { unit: 'قارورة' }, fmt2), '[51]');
  assert.equal(lotQtyText(51, null, fmt2), '[51]');
  assert.equal(lotQtyText(51, { ...lotProd, primaryUnitId: 'u-gone' }, fmt2), '[51]', 'معرّف تالف ⇒ القائم');
});

test('التشغيلات: الكمية مع وحدتها، والوسم اللاحق، وسطر «الكميات بـ…» بلا كلمة «الأساس» لصنفٍ له رئيسية (D21)', () => {
  assert.equal(lotQtyUnitText(51, lotProd, plain), '2 كرتون و3 قارورة');
  assert.equal(lotQtyUnitText(51, { unit: 'حبة', primaryUnitId: null }, plain), '51 حبة', 'القائم: «الرقم اسم الأساس»');
  assert.equal(lotUnitTag(lotProd), '', 'النص يحمل أسماء الوحدات');
  assert.equal(lotUnitTag({ unit: 'حبة', primaryUnitId: null }), 'حبة');
  assert.equal(lotsUnitNote(lotProd, arTr), 'الكميات بالوحدة الصغرى (قارورة)');
  assert.ok(!lotsUnitNote(lotProd, arTr).includes('الأساس'));
  assert.equal(lotsUnitNote({ unit: 'حبة' }, arTr), 'الكميات بوحدة الأساس (حبة)', 'I1: النص القائم حرفاً');
  assert.equal(lotsUnitNote({ unit: '' }, arTr), 'الكميات بوحدة الأساس ', 'I1: بلا اسم كما كان');
  assert.ok(PHRASES['الكميات بالوحدة الصغرى'], 'العبارة الجديدة مترجمة');
});

test('التشغيلات: صنف صفّ القائمة/العجز من الحقول المسطّحة، وغيابها (خادمٌ أقدم) ⇒ بلا رئيسية', () => {
  assert.deepEqual(lotRowProduct({ productUnit: 'قارورة', productUnits: [CARTON], productPrimaryUnitId: 'u-ct' }), { unit: 'قارورة', units: [CARTON], primaryUnitId: 'u-ct' });
  assert.deepEqual(lotRowProduct({ productUnit: 'حبة' }), { unit: 'حبة', units: null, primaryUnitId: null });
  assert.equal(lotQtyText(-48, lotRowProduct({ productUnit: 'قارورة', productUnits: [CARTON], productPrimaryUnitId: 'u-ct' }), plain), '-2 كرتون');
});

test('التشغيلات: خانة الكمية بإشارة (العجز والأثر) ltr للرقم وحده كما كان، وتنتقل إلى اتجاه الصفحة لنصّ الرئيسية العربي', () => {
  assert.equal(lotQtyDir(lotProd), undefined, '«-1 كرتون و2 قارورة» في خانة ltr تُقرأ مقلوبة');
  assert.equal(lotQtyDir({ ...lotProd, primaryUnitId: null }), 'ltr', 'I1');
  assert.equal(lotQtyDir(null), 'ltr');
  assert.equal(lotQtyDir(lotRowProduct({ productUnit: 'حبة' })), 'ltr', 'صفّ عجزٍ من خادمٍ أقدم');
  const s = read('pages', 'LotsPage.tsx');
  assert.match(s, /dir=\{lotQtyDir\(lotRowProduct\(r\)\)\}>\{lotQtyText\(r\.qty, lotRowProduct\(r\), fmtQ\)\}/, 'العجز في سلامة الأرصدة');
  assert.match(s, /dir=\{lotQtyDir\(prod\)\}>\{o\.qty < 0 \? '−' : '\+'\}\{lotQtyText\(/, 'أثر المصدر');
});

const lines = (qty: string): RelabelLineForm[] => [{ mode: 'UNKNOWN', toLotId: null, lotNumber: '', productionDate: '', expiryDate: '', qty } as RelabelLineForm];
const relabelInput = (baseUnitName: string | null | undefined) => ({
  productId: 'p1', place: 'WAREHOUSE' as const, vanKey: null, bucket: 'SELLABLE' as const, fromLotId: 'l1', reason: 'CORRECTION' as never,
  note: '  ملاحظة ', lines: lines('10'), baseUnitName,
});

test('التشغيلات R8 و§2.11ب: جسم إعادة الوسم بالأساس كما كُتب ويحمل baseUnitName، وبلا اسمٍ بلا المفتاح', () => {
  const b = relabelBody(relabelInput('  قارورة '));
  assert.equal(b.baseUnitName, 'قارورة', 'baseNameKey: قصّ الأطراف');
  assert.equal(b.lines[0].qty, 10, 'الكمية بالأساس كما كُتبت — لا ضرب بالمعامل');
  assert.equal(b.note, 'ملاحظة');
  assert.ok(!('baseUnitName' in relabelBody(relabelInput(null))));
  assert.ok(!('baseUnitName' in relabelBody(relabelInput('   '))));
  assert.equal(relabelBody(relabelInput('x'.repeat(80))).baseUnitName, 'x'.repeat(64), 'حدّ ٦٤ حرفاً كالخادم');
});

test('التشغيلات: جسم التنزيل يحمل baseUnitName أساس الصنف، وبلا اسمٍ الجسم القائم حرفاً', () => {
  const row = { salesRepId: 'r1', deleted: false, usable: { SELLABLE: 12, EXPIRED: 0, DAMAGED: 0 }, held: { SELLABLE: 0, EXPIRED: 0, DAMAGED: 0 } } as unknown as LotUnloadPlanDto;
  const on = unloadBody({ id: 'l1', productId: 'p1', product: { lotTracked: true, unit: 'قارورة' } }, row, 'n');
  assert.deepEqual(on?.items, [{ productId: 'p1', qty: 12, lots: [{ lotId: 'l1', qty: 12 }], baseUnitName: 'قارورة' }]);
  const off = unloadBody({ id: 'l1', productId: 'p1', product: { lotTracked: true } }, row, 'n');
  assert.deepEqual(off?.items, [{ productId: 'p1', qty: 12, lots: [{ lotId: 'l1', qty: 12 }] }], 'I1: بلا المفتاح');
});

test('التشغيلات: رفض «أساسٌ تغيّر» يُعرف (400 UNIT_INVALID و409 PRODUCT_UNITS_CHANGED) لإعادة القراءة، وغيره لا', () => {
  const err = (status: number, code: string) => ({ response: { status, data: { code } } });
  assert.equal(baseChangedError(err(400, 'UNIT_INVALID')), true);
  assert.equal(baseChangedError(err(409, 'PRODUCT_UNITS_CHANGED')), true);
  assert.equal(baseChangedError(err(409, 'LOT_BUSY')), false);
  assert.equal(baseChangedError(err(503, 'PRODUCT_UNITS_BUSY')), false);
  assert.equal(baseChangedError(new Error('x')), false);
  assert.equal(baseChangedError(null), false);
});

test('LotsPage: كل كمية تمرّ بـlotQtyText، ونموذج الوسم لصنفٍ له رئيسية: اسم الأساس لاصقٌ ومعادلٌ حيّ والجسم بـrelabelBody', () => {
  const s = read('pages', 'LotsPage.tsx');
  assert.ok(!/\{fmtQ\(/.test(s) && !/\$\{fmtQ\(/.test(s), 'لا كمية تُعرض بـfmtQ مباشرةً — كلها عبر lotQtyText');
  assert.match(s, /lotQtyText\(r\.qty, lotRowProduct\(r\), fmtQ\)/, 'العجز في سلامة الأرصدة');
  assert.match(s, /const body = relabelBody\(\{[\s\S]*?baseUnitName: lot\.product\.unit/);
  assert.match(s, /hasPrimary \?[\s\S]*?\{lot\.product\.unit\}<\/span>[\s\S]*?= \{lotQtyText\(Number\(l\.qty\), prod, fmtQ\)\}/);
  assert.match(s, /\{lotsUnitNote\(prod, tr\)\}/);
  assert.match(s, /if \(baseChangedError\(e\)\) refresh\(\)/);
});

// ═══ ترتيب المناديب (RepRankingBoard) ═══

test('ترتيب المناديب R1: كمية الصنف بالرئيسية، وبلاها «الرقم اسم الأساس» حرفاً', () => {
  const p: RankingProduct = { id: 'p1', name: 'مياه', unit: 'قارورة', units: [PALLET, CARTON], primaryUnitId: 'u-ct' };
  assert.equal(formatRankingValue('product', 1250, arTr, 'قارورة', p), '52 كرتون و2 قارورة');
  assert.equal(formatRankingValue('product', 0, arTr, 'قارورة', p), '0 كرتون');
  // I1
  assert.equal(formatRankingValue('product', 1250, arTr, 'قارورة', { ...p, primaryUnitId: null }), '1250 قارورة');
  assert.equal(formatRankingValue('product', 12.34567, arTr, 'حبة'), '12.346 حبة');
  assert.equal(formatRankingValue('product', 5, arTr), '5');
  assert.equal(formatRankingValue('visits', 3, arTr, 'قارورة', p), '3 زيارة', 'غير معيار الصنف لا يتأثّر');
});

test('ReportsPage: المرتجعات R2 والمبيعات حسب الصنف/التشغيلة R1 وورقة الترتيب R9', () => {
  const s = read('pages', 'ReportsPage.tsx');
  assert.match(s, /docQtyText\(\{ qty: it\.qty, unitName: it\.unit, unitFactor: it\.unitFactor, primaryUnitId: it\.primaryUnitId \}, plainQty\)/);
  assert.match(s, /factorOf\(i\) !== 1 \|\| !!i\.primaryUnitId/, 'عمود «الوحدة» في Excel حين لصنفٍ رئيسية — بقيمة صادقة لا بحضور المفتاح');
  assert.match(s, /type SalesRow = \{[^}]*primaryUnitId\?: string \| null \}/);
  assert.match(s, /const lotQty = \(r: Pick<LotSalesRowDto, 'unit' \| 'units'> & \{ primaryUnitId\?: string \| null \}/);
  assert.match(s, /primaryUnitOf\(rankingQ\.data\?\.product\)/);
  assert.match(s, /\[tr\('الكمية بوحداتها'\)\]: productQtyText\(r\.value, rankProduct\)/);
  assert.match(s, /colWidths: rankProduct \? \[10, 26, 30, 24\] : \[10, 26, 30\]/, 'بلا رئيسية الورقة كما كانت');
});

test('كشف حساب العميل وكشف المندوب R2: البند يمرّر رئيسيّ صنفه إلى docQtyText', () => {
  const c = read('components', 'forms', 'CustomerStatementModal.tsx');
  assert.match(c, /product: \{ name: string; unit\?: string; primaryUnitId\?: string \| null \}/);
  assert.match(c, /unit: it\.product\.unit, product: \{ primaryUnitId: it\.product\.primaryUnitId \} \}/);
  const r = read('pages', 'SalesRepsPage.tsx');
  assert.match(r, /unit: it\.product\.unit, product: \{ primaryUnitId: \(it\.product as \{ primaryUnitId\?: string \| null \}\)\.primaryUnitId \} \}/);
  assert.ok(!/primaryUnitId !== undefined|'primaryUnitId' in/.test(c + r), 'الشرط قيمةٌ صادقة لا حضور المفتاح (I1)');
});

// ═══ الكتالوج العام (CatalogPage) ═══

const juice = { name: 'عصير', unit: 'حبة', basePrice: 2, taxPct: 15, units: [{ name: 'كرتون', factor: 24, price: 45 }, { name: 'طبلية', factor: 1200, price: 2000 }] };

test('الكتالوج: بلا isPrimary الأساس بارزاً ثم الوحدات كما كان، وبها الرئيسية بارزةً ثم سعر الصغرى ثم البقية', () => {
  assert.deepEqual(catalogPriceLines(juice), {
    main: { key: 'حبة', price: 2, label: 'حبة' },
    rest: [{ key: 'كرتون', price: 45, label: 'كرتون (24 حبة)' }, { key: 'طبلية', price: 2000, label: 'طبلية (1200 حبة)' }],
  });
  const withPrimary = { ...juice, units: [{ ...juice.units[0], isPrimary: true }, juice.units[1]] };
  assert.deepEqual(catalogPriceLines(withPrimary), {
    main: { key: 'كرتون', price: 45, label: 'كرتون (24 حبة)' },
    rest: [{ key: 'حبة', price: 2, label: 'حبة' }, { key: 'طبلية', price: 2000, label: 'طبلية (1200 حبة)' }],
  });
  assert.deepEqual(catalogPriceLines({ ...juice, units: undefined }), { main: { key: 'حبة', price: 2, label: 'حبة' }, rest: [] }, 'خادمٌ أقدم بلا units');
});

test('الكتالوج I1: بطاقة صنفٍ بلا رئيسية تُصيَّر بالـHTML نفسه حرفاً الذي صيّرته البطاقة في 079fb38', () => {
  const brand = '#E15A30', dec = 2, sym = 'ر.س';
  // نسخة حرفية من JSX البطاقة قبل الميزة (CatalogPage.tsx في 079fb38)
  const gross = (p: { basePrice: number; taxPct: number }) => roundDecimal(Number(p.basePrice) * (1 + Number(p.taxPct) / 100), dec);
  const h = createElement;
  const old = (p: typeof juice) => h(Fragment, null,
    h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 6 } },
      h('span', { style: { color: brand, fontWeight: 800, fontSize: 15 } }, gross(p).toLocaleString('ar-SA', { minimumFractionDigits: dec, maximumFractionDigits: dec }), ' ', h('span', { style: { fontSize: 11 } }, sym)),
      h('span', { style: { fontSize: 10.5, color: '#8A8178' } }, p.unit)),
    ...(p.units ?? []).map((u) => h('div', { key: u.name, style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 3 } },
      h('span', { style: { color: '#4A4239', fontWeight: 700, fontSize: 12.5 } }, gross({ basePrice: u.price, taxPct: p.taxPct }).toLocaleString('ar-SA', { minimumFractionDigits: dec, maximumFractionDigits: dec }), ' ', h('span', { style: { fontSize: 10 } }, sym)),
      h('span', { style: { fontSize: 10.5, color: '#8A8178' } }, u.name, ' (', u.factor, ' ', p.unit, ')'))));
  const now = (p: typeof juice) => renderToStaticMarkup(h(CatalogPrices, { p, brand, dec, sym }));
  // الوسم «كرتون (24 حبة)» صار نصّاً واحداً — تعليقات React بين أجزاء النص في القديم تُزال قبل المقارنة (لا أثر لها في العرض)
  const strip = (html: string) => html.replace(/<!-- -->/g, '');
  for (const p of [juice, { ...juice, units: [] }, { ...juice, units: undefined } as unknown as typeof juice]) {
    assert.equal(strip(now(p)), strip(renderToStaticMarkup(old(p))));
  }
  // بالرئيسية: سعر الكرتون شاملاً الضريبة بارزاً بلون الهوية أولاً
  const html = now({ ...juice, units: [{ ...juice.units[0], isPrimary: true } as typeof juice.units[number], juice.units[1]] });
  const first = html.indexOf('color:#E15A30');
  assert.ok(first >= 0 && html.indexOf('كرتون (24 حبة)') < html.indexOf('>حبة<'), 'الكرتون قبل الحبة');
  assert.ok(html.slice(first, html.indexOf('كرتون (24 حبة)')).includes(gross({ basePrice: 45, taxPct: 15 }).toLocaleString('ar-SA', { minimumFractionDigits: dec, maximumFractionDigits: dec })));
});
