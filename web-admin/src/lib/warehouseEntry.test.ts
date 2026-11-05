import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { entryAttempt, isReplayResponse, productArchivedOf, zeroAdjustStart } from './warehouseEntry';
import { PHRASES } from '../i18n/strings';

/**
 * نافذة «استلام / تسوية» المستودع (مراجعة المخزون، نوفمبر ٢٠٢٦): مرجع المحاولة clientRef (D8)، وردّ PRODUCT_ARCHIVED (D3)،
 * و«اجعل الرصيد صفراً» لتسوية صفّ الجدول (D1).
 */

test('D8: المحتوى نفسه ⇒ المرجع نفسه (إعادة بعد ردٍّ ضائع)، وأي تعديل ⇒ مرجعٌ جديد', () => {
  let n = 0;
  const fresh = () => `ref-${++n}`;
  const body = { type: 'RECEIVE', items: [{ productId: 'a', qty: 5 }] };
  const a1 = entryAttempt(null, body, fresh);
  const a2 = entryAttempt(a1, { type: 'RECEIVE', items: [{ productId: 'a', qty: 5 }] }, fresh);
  assert.equal(a2.ref, a1.ref, 'الإعادة بلا تعديل');
  const a3 = entryAttempt(a2, { type: 'RECEIVE', items: [{ productId: 'a', qty: 6 }] }, fresh);
  assert.notEqual(a3.ref, a1.ref, 'كميةٌ أخرى حركةٌ أخرى');
  const a4 = entryAttempt(null, body, fresh);
  assert.notEqual(a4.ref, a1.ref, 'بعد النجاح يُصفَّر المرجع ⇒ الحركة التالية بمرجعٍ جديد');
});

test('D8: المرجع الافتراضي UUID داخل قيد الخادم (≤ ٦٤، [A-Za-z0-9_-])', () => {
  const { ref } = entryAttempt(null, { x: 1 });
  assert.match(ref, /^[A-Za-z0-9_-]{1,64}$/);
});

test('D8: ردّ الإعادة (200 بالمرجع نفسه) — replay أو idempotent', () => {
  assert.equal(isReplayResponse({ success: true, replay: true, data: {} }), true);
  assert.equal(isReplayResponse({ success: true, idempotent: true, data: {} }), true);
  assert.equal(isReplayResponse({ success: true, data: { replay: true } }), true);
  assert.equal(isReplayResponse({ success: true, data: { id: 'e1' } }), false);
  assert.equal(isReplayResponse(undefined), false);
});

test('D3: 422 PRODUCT_ARCHIVED يُقرأ بصنفه وموضع سطره ورسالته — وغيره null', () => {
  const e = { response: { status: 422, data: { success: false, code: 'PRODUCT_ARCHIVED', message: 'الصنف «M» محذوف', productId: 'p-old', index: 2 } } };
  assert.deepEqual(productArchivedOf(e), { productId: 'p-old', index: 2, message: 'الصنف «M» محذوف' });
  assert.deepEqual(productArchivedOf({ response: { data: { code: 'PRODUCT_ARCHIVED', productId: 'p', index: -1 } } }), { productId: 'p', index: null, message: null });
  assert.equal(productArchivedOf({ response: { data: { code: 'UNIT_INVALID' } } }), null);
  assert.equal(productArchivedOf(new Error('net')), null);
  assert.equal(productArchivedOf(undefined), null);
});

test('D1: «اجعل الرصيد صفراً» — عكس الرصيد، بالرئيسية حين ينقسم عليها وإلّا بالأساس', () => {
  const egg = { unit: 'بيضة', units: [{ id: 'u-c', name: 'كرتون', factor: 360, isActive: true }], primaryUnitId: 'u-c' };
  assert.deepEqual(zeroAdjustStart(egg, 9000), { unitId: 'u-c', qty: -25 });
  assert.deepEqual(zeroAdjustStart(egg, -720), { unitId: 'u-c', qty: 2 });
  assert.deepEqual(zeroAdjustStart(egg, 100), { unitId: null, qty: -100 }, 'لا ينقسم ⇒ بالأساس');
  assert.deepEqual(zeroAdjustStart(egg, 10), { unitId: null, qty: -10 }, 'دون كرتون ⇒ بالأساس');
  // صنفٌ قديم أساسه الكرتون بلا وحدات: −25 ⇒ +25
  assert.deepEqual(zeroAdjustStart({ unit: 'كرتون' }, -25), { unitId: null, qty: 25 });
  // بلا رئيسية: الأساس ولو كانت له وحدةٌ أكبر
  assert.deepEqual(zeroAdjustStart({ unit: 'حبة', units: [{ id: 'u', name: 'كرتون', factor: 24 }] }, 48), { unitId: null, qty: -48 });
  assert.equal(zeroAdjustStart(egg, 0), null);
  assert.equal(zeroAdjustStart(egg, 1e-9), null);
});

// ─── حرّاس الشاشتين ───
const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');

test('الويب: «تسوية» على صفّ الجدول بصنفه، والمرجع لكل محاولة، وPRODUCT_ARCHIVED يمنع وارد المحذوف', () => {
  const s = read('pages', 'CompanyWarehousePage.tsx');
  assert.match(s, /onClick=\{\(\) => openEntry\(r\)\}/);
  assert.match(s, /<WarehouseEntryModal lotOn=\{lotOn\} seed=\{entrySeed\} stockRows=\{rows\}/);
  assert.match(s, /useState<'RECEIVE' \| 'ADJUST'>\(seed \? 'ADJUST' : 'RECEIVE'\)/, 'الصفّ يفتح تسوية');
  assert.match(s, /\?\? \(seedFull\?\.id === id \? seedFull : undefined\)/, 'المحذوف من صفّ المستودع لا من قائمة المنتجات');
  // وعلم اللوط للمحذوف من الصنف نفسه (القائمة لا تحمله) — والميزة مفعّلة وحدها
  assert.match(s, /enabled: lotOn && seedMissing,/);
  assert.match(s, /lotTracked: seedProdQ\.data\.lotTracked/);
  assert.match(s, /attempt\.current = entryAttempt\(attempt\.current, body\);\n\s+const payload: EntryPayload = \{ \.\.\.body, clientRef: attempt\.current\.ref \};/);
  assert.match(s, /onSuccess: \(res\) => \{\n\s+attempt\.current = null;/, 'بعد النجاح مرجعٌ جديد');
  assert.match(s, /const arch = productArchivedOf\(e\);/);
  assert.match(s, /&& !archivedReceive\(r\);/, 'وارد المحذوف لا يُحفظ');
  // الموقوف والمحذوف في الذيل وخارج «يحتاج استلام»، والعجز تحت القيمة
  assert.match(s, /const lowCount = lowStockCount\(rows\);/);
  assert.match(s, /\{activeRows\.map\(renderRow\)\}[\s\S]{0,900}\{dormantRows\.map\(renderRow\)\}/);
  assert.match(s, /\{breakdown && !shownLoading && !shownError && \(/);
  assert.match(s, /shownLoading \? '…' : formatCurrency\(totalValue\)/, 'لا «0.00» أثناء التحميل');
});

test('الجوال: «تسوية» من تفصيل الصفّ، والمرجع لكل محاولة، والمحذوف لا يُستلم', () => {
  const s = read('m', 'MWarehouse.tsx');
  assert.match(s, /onAdjust=\{\(\) => \{ setAdjustSeed\(r\); setEntryOpen\(true\); \}\}/);
  assert.match(s, /<MWarehouseEntry lotOn=\{lotOn\} seed=\{adjustSeed\} stockRows=\{all\} onClose=\{closeEntry\} \/>/);
  assert.match(s, /attempt\.current = entryAttempt\(attempt\.current, body\);\n\s+const payload: EntryPayload = \{ \.\.\.body, clientRef: attempt\.current\.ref \};/);
  assert.match(s, /const arch = productArchivedOf\(e\);/);
  assert.match(s, /&& !archivedReceive\(r\)\);/);
  assert.match(s, /const \{ active: activeRows, dormant: dormantRows \} = useMemo\(\(\) => splitDormant\(rows\), \[rows\]\);/);
  // S14: عدد أصناف الحركة بتمييزه العربي («صنفان» لا «2 صنف»)
  assert.match(s, /title=\{countText\(lang, products, 'صنف', tr, formatNumber\)\}/);
});

test('عبارات النافذة والجدول مترجمة إلى اللغات الأربع', () => {
  for (const k of ['محذوف — بقي له رصيد', 'اسم مكرر', 'الوارد والتسويات', 'منها تسويات', 'تكلفة العجز', 'عجز بلا تكلفة', 'بلا تكلفة',
    'منها عجز', 'صنفا برصيد سالب', 'منها {n} محذوفة أو موقوفة', 'والموجب', 'رصيد اليوم', 'أصناف موقوفة أو محذوفة لها رصيد',
    'تسوية رصيد هذا الصنف', 'الرصيد الآن', 'اجعل الرصيد صفرا', 'صنف محذوف لا يستلم في المستودع استعمل التسوية لتصحيح رصيده',
    'هذه الحركة محفوظة من قبل ولم تسجل مرة ثانية']) {
    const e = PHRASES[k];
    assert.ok(e, `«${k}» غائب`);
    for (const l of ['en', 'fr', 'tr', 'zh'] as const) assert.ok(e[l]?.trim(), `«${k}» بلا ${l}`);
  }
  assert.ok(PHRASES['منها {n} محذوفة أو موقوفة'].en.includes('{n}'), 'الموضع محفوظ في الترجمة');
});
