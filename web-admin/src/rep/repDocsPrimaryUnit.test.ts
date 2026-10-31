// «الوحدة الرئيسية» في أوراق المندوب ووقائعها (B6c): RepDocuments وwarehouseNoticeFacts وaiRepLogic وvanLots.
// صنفٌ يُعرَّف بالكرتون (٢٤ قارورة) ومعه طبلية (١٢٠٠): الكمية بالأساس تُعرض بالكرتون (R1)، وبند المستند بلقطته مع اسم
// الوحدة دائماً (R2، فخّ «×5»)، وكميات LOT تبقى بالأساس. والحارس الأوّل: صنفٌ بلا رئيسية (أو `primaryUnitId: null` كما يصل
// في كل select بحكم D18) يبقى حرفياً كما كان (I1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PrintableLoadNotice, PrintableStatement, PrintableStockRequest, loadNoticeDocFromData, statementDocFromData, statementItemLine,
  stockRequestOnHandText, warehouseNoticeDocFromEntry, type StatementDoc, type StockRequestDoc, type StockRequestDocLine,
} from './RepDocuments';
import { qtyByUnit, unitTotalsText } from './warehouseNoticeFacts';
import { expectedQtyText, expectedRowText, type Expected } from './aiRepLogic';
import { formatQty } from '../lib/units';

const units = [
  { id: 'u-ctn', name: 'كرتون', factor: 24, isActive: true },
  { id: 'u-pal', name: 'طبلية', factor: 1200, isActive: true },
];
const company = { name: 'شركة الاختبار', taxNumber: '300000000000003', address: 'الرياض', phone: '0501234567', countryCode: 'SA' };

// ═══ warehouseNoticeFacts.qtyByUnit ═══

test('إجمالي الإشعار: سطرٌ بالقارورة لصنفٍ رئيسيّه كرتون يُجمع لكل وحدة «10 قارورة» لا «10» — وnull/الغياب كما كان', () => {
  const lines = [{ qty: 10, unit: 'قارورة', unitFactor: 1, primaryUnitId: 'u-ctn' }, { qty: 3, unit: 'كيس' }];
  assert.deepEqual(qtyByUnit(lines), [{ unit: 'قارورة', qty: 10 }, { unit: 'كيس', qty: 3 }]);
  assert.equal(unitTotalsText(qtyByUnit(lines)!, String), '10 قارورة · 3 كيس');
  // التكافؤ: المفتاح null (D18) أو غائب ⇒ الرقم كما كان
  assert.equal(qtyByUnit([{ qty: 10, unit: 'قارورة', unitFactor: 1, primaryUnitId: null }, { qty: 3, unit: 'كيس' }]), null);
  assert.equal(qtyByUnit([{ qty: 10, unit: 'قارورة', unitFactor: 1, primaryUnitId: '' }]), null, 'قيمة صادقة لا حضور مفتاح');
  assert.equal(qtyByUnit([{ qty: 10, unit: 'قارورة' }]), null);
});

// ═══ كشف الحساب (R2) ═══

test('بند كشف الحساب: لصنفٍ له رئيسية تُلحق الوحدة دائماً «ماء ×5 قارورة» — وبلاها أو بـnull «×5» كما كان', () => {
  assert.equal(statementItemLine({ name: 'ماء', qty: 5, unit: 'قارورة', primaryUnitId: 'u-ctn' }), 'ماء ×5 قارورة');
  assert.equal(statementItemLine({ name: 'ماء', qty: 2, unit: 'كرتون', unitFactor: 24, primaryUnitId: 'u-ctn' }), 'ماء ×2 كرتون');
  assert.equal(statementItemLine({ name: 'ماء', qty: 5, unit: 'قارورة' }), 'ماء ×5');
  assert.equal(statementItemLine({ name: 'ماء', qty: 5, unit: 'قارورة', primaryUnitId: null }), 'ماء ×5', 'null حاضرٌ في كل select (D18)');
  assert.equal(statementItemLine({ name: 'ماء', qty: 2, unit: 'كرتون', unitFactor: 24 }), 'ماء ×2 كرتون');
  assert.equal(statementItemLine({ name: 'ماء', qty: 5, primaryUnitId: 'u-ctn' }), 'ماء ×5', 'بلا اسم وحدة لا لاحقة فارغة');
});

test('statementDocFromData يحمل primaryUnitId الصادق وحده — null كغيابه فالبند حرفياً كما كان، والكشف المطبوع يُلحق الوحدة', () => {
  const entries = (pid: string | null) => [
    { entryDate: '2026-10-29', description: 'بيع', debit: 10, credit: 0, balance: 10, type: 'INVOICE_DEBIT', invoice: { number: 'INV-1', items: [
      { product: { name: 'ماء', unit: 'قارورة', primaryUnitId: pid }, unitName: null, unitFactor: 1, qty: 5 },
      { product: { name: 'عصير', unit: 'كرتون', primaryUnitId: null }, qty: 1 },
    ] } },
  ];
  const on = statementDocFromData({ name: 'بقالة' } as never, entries('u-ctn'), 'أحمد');
  assert.deepEqual(on.entries[0].items, [
    { name: 'ماء', qty: 5, unit: 'قارورة', unitFactor: 1, primaryUnitId: 'u-ctn' }, { name: 'عصير', qty: 1, unit: 'كرتون' },
  ]);
  const off = statementDocFromData({ name: 'بقالة' } as never, entries(null), 'أحمد');
  assert.deepEqual(off.entries[0].items, [{ name: 'ماء', qty: 5, unit: 'قارورة', unitFactor: 1 }, { name: 'عصير', qty: 1, unit: 'كرتون' }]);
  const html = (d: StatementDoc) => renderToStaticMarkup(createElement(PrintableStatement, { doc: { ...d, company } }));
  assert.ok(html(on).includes('ماء ×5 قارورة، عصير ×1'), 'الكشف المطبوع: «×5» وحدها لصنفٍ بالكرتون تُقرأ كراتين');
  assert.ok(html(off).includes('ماء ×5، عصير ×1'), 'بلا رئيسية: كما كان حرفاً');
});

// ═══ إشعار التحميل وإشعار المستودع ═══

test('loadNoticeDocFromData: primaryUnitId المسطّح من /van-stock/movements يُحمل، وnull/الغياب ⇒ البند كما كان، والإجمالي لكل وحدة', () => {
  const mv = (pid: string | null | undefined) => loadNoticeDocFromData('أحمد', { kind: 'LOAD', date: '2026-10-29', items: [
    { name: 'ماء', qty: 10, unit: 'قارورة', baseQty: 10, ...(pid !== undefined && { primaryUnitId: pid }) },
    { name: 'سكر', qty: 2, unit: 'كيس' },
  ] }, company);
  const on = mv('u-ctn');
  assert.deepEqual(on.items[0], { name: 'ماء', qty: 10, unit: 'قارورة', unitFactor: 1, primaryUnitId: 'u-ctn' });
  assert.deepEqual(mv(null).items, [{ name: 'ماء', qty: 10, unit: 'قارورة', unitFactor: 1 }, { name: 'سكر', qty: 2, unit: 'كيس' }]);
  assert.deepEqual(mv(undefined).items, mv(null).items);
  const html = (d: ReturnType<typeof mv>) => renderToStaticMarkup(createElement(PrintableLoadNotice, { doc: d }));
  assert.ok(html(on).includes('10 قارورة · 2 كيس'), 'الإجمالي لكل وحدة حين في الإشعار صنفٌ له رئيسية');
  assert.ok(!html(mv(null)).includes('10 قارورة · 2 كيس'), 'بلا رئيسية: الرقم كما كان');
});

test('warehouseNoticeDocFromEntry: primaryUnitId من صنف السطر يُحمل صادقاً وحده — null ⇒ السطر كما كان', () => {
  const entry = (pid: string | null) => warehouseNoticeDocFromEntry({ id: 'e-1', type: 'RECEIVE', createdAt: '2026-10-29', totalCost: 20, items: [
    { qty: 40, unitName: null, unitFactor: 1, unitCost: 0.5, lineCost: 20, product: { name: 'ماء', unit: 'قارورة', primaryUnitId: pid } },
  ] });
  assert.equal(entry('u-ctn').items[0].primaryUnitId, 'u-ctn');
  assert.ok(!('primaryUnitId' in entry(null).items[0]), 'null كغيابه');
  assert.deepEqual(qtyByUnit(entry('u-ctn').items), [{ unit: 'قارورة', qty: 40 }]);
  assert.equal(qtyByUnit(entry(null).items), null);
});

// ═══ ورقة طلب المخزون: الرصيد (R1) ═══

test('«الرصيد الحالي» في ورقة طلب المخزون بالرئيسية: «52 كرتون و2 قارورة» لا الطبلية، والصفر «0 كرتون»، والعجز بإشارته', () => {
  const line = (onHand: number, pid: string | null): StockRequestDocLine =>
    ({ productId: 'p', name: 'ماء', unit: 'كرتون', onHand, qty: 3, unitFactor: 24, units, baseUnit: 'قارورة', primaryUnitId: pid });
  assert.equal(stockRequestOnHandText(line(1250, 'u-ctn')), '52 كرتون و2 قارورة');
  assert.equal(stockRequestOnHandText(line(0, 'u-ctn')), '0 كرتون');
  assert.equal(stockRequestOnHandText(line(5, 'u-ctn')), '5 قارورة');
  assert.equal(stockRequestOnHandText(line(-26, 'u-ctn')), '−1 كرتون و2 قارورة');
  // التكافؤ: بلا رئيسية (null، أو معرّفٌ لا يطابق وحدة) ⇒ formatQty القائم حرفياً
  for (const pid of [null, 'u-gone']) {
    assert.equal(stockRequestOnHandText(line(1250, pid)), formatQty(1250, units, 'قارورة'));
    assert.equal(stockRequestOnHandText(line(-26, pid)), `−${formatQty(26, units, 'قارورة')}`);
  }
  // صنفٌ بلا وحدات: الرقم كما كان
  assert.equal(stockRequestOnHandText({ productId: 'q', name: 'سكر', unit: 'كيس', onHand: -3.456, qty: 1 }), '−3.46');
  const doc = (pid: string | null): StockRequestDoc => ({
    kind: 'stockRequest', company, ref: 'SR-1', date: '2026-10-29T08:00:00.000Z', to: 'PURCHASING' as StockRequestDoc['to'],
    items: [line(1250, pid)],
  });
  const html = (d: StockRequestDoc) => renderToStaticMarkup(createElement(PrintableStockRequest, { doc: d }));
  assert.ok(html(doc('u-ctn')).includes('52 كرتون و2 قارورة'));
  assert.ok(html(doc(null)).includes(formatQty(1250, units, 'قارورة')));
});

// ═══ المندوب الذكي: الطلب المتوقع (aiRepLogic، R1) ═══

test('الطلب المتوقع لصنفٍ له رئيسية: التفكيك يقف عند الكرتون — وبلا رئيسية أو بمعرّفٍ تالف كما كان', () => {
  const tr = (s: string) => s;
  const p = { qty: 1250, unit: 'حبة', units: units.map(u => ({ id: u.id, name: u.name, factor: u.factor })) };
  assert.equal(expectedQtyText({ ...p, primaryUnitId: 'u-ctn' }, 'ar', tr), '52 كرتون و2 حبة');
  assert.equal(expectedQtyText({ ...p, primaryUnitId: 'u-ctn' }, 'en', tr), '52 كرتون + 2 حبة');
  assert.equal(expectedQtyText({ ...p, qty: 0, primaryUnitId: 'u-ctn' }, 'ar', tr), '0 كرتون');
  assert.equal(expectedQtyText({ ...p, qty: 5, primaryUnitId: 'u-ctn' }, 'ar', tr), '5 حبة');
  const before = formatQty(1250, units, 'حبة');
  assert.equal(expectedQtyText(p, 'ar', tr), before, 'بلا رئيسية: كما كان');
  assert.equal(expectedQtyText({ ...p, primaryUnitId: null }, 'ar', tr), before);
  assert.equal(expectedQtyText({ ...p, primaryUnitId: 'u-gone' }, 'ar', tr), before, 'معرّفٌ لا يطابق وحدة ⇒ null (I5)');
  // خادمٌ قديم لا يرسل معرّفات الوحدات: لا رئيسية تُطابَق ⇒ كما كان
  assert.equal(expectedQtyText({ ...p, units: units.map(u => ({ name: u.name, factor: u.factor })), primaryUnitId: 'u-ctn' }, 'ar', tr), before);
  const e: Expected = {
    confidence: 'HIGH',
    basis: { rating: 4.2, ratingCount: 10, trafficPct: null, typeMedianCount: 0, typeMedianKnown: false, reviewsRead: false, reviews: 0, mentions: [], talk: [], source: 'VAN', text: '' },
    products: [{ productId: 'p', name: 'ماء', unit: 'حبة', units: p.units, primaryUnitId: 'u-ctn', qty: 48, low: 40, high: 60, mentioned: false }],
  };
  assert.equal(expectedRowText(e, 'ar', tr)?.text, 'متوقع: 2 كرتون ماء');
});

// ═══ LOT: الكميات بالأساس، والرئيسية لا تدخل (I2، D8) ═══

test('vanLots: منطق التشغيلات لا يقرأ الوحدة الرئيسية — كمياته كلها بالأساس ومعامل السطر وحده', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'rep', 'vanLots.ts'), 'utf8');
  assert.ok(!/primaryUnit|primaryChoice|defaultChoice|productQtyText/.test(src), 'الرئيسية عرضٌ وافتراضٌ فقط، لا LOT');
  const docs = fs.readFileSync(path.join(process.cwd(), 'src', 'rep', 'RepDocuments.tsx'), 'utf8');
  // خانات التشغيلة في الإشعارات تبقى بمعامل السطر (لقطته)، لا بالرئيسية — والرئيسية لا تمرّ إلا وسماً (D21: «×30 قارورة» لا
  // «بوحدة الأساس»، rep-offline-7) فلا تمسّ الكمية: lotQtyInLine لا يقرؤها
  for (const m of docs.match(/lot(?:Cell|Line)Text\([^)]*\)/g) ?? []) assert.ok(!/primary/i.test(m.replace(/, primaryUnitId: it\.primaryUnitId/, '')), m);
  const lots = fs.readFileSync(path.join(process.cwd(), 'src', 'rep', 'docLots.ts'), 'utf8');
  const qtyFn = lots.slice(lots.indexOf('export function lotQtyInLine('), lots.indexOf('export function lotDayText('));
  assert.ok(qtyFn.length > 0 && !/primary/i.test(qtyFn), 'كمية التشغيلة بمعامل السطر وحده');
});
