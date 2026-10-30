// «تتبّع اللوط» — W1: منطق التفعيل الصرف (lotTrackingUi.ts) وحرّاس الشاشات: نافذة المالك، ونافذة الصنف، وصفحة المنتجات،
// وإعدادات الشركة، وتحذير حذف المندوب. والقاعدة الحاكمة: الميزة المطفأة لا تغيّر شيئاً (§١٠.١)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  LOT_TRACKING_MAX_IDS, REP_DELETE_LOTS, attentionRows, fillVanLots, lotRecordsRetainedOf, productLotNote, productLotPayload,
  tenantLotNote, tenantLotPayload, trackingBalanceOf, trackingRequest, vanLotsLeft,
} from './lotTrackingUi';
import { PHRASES } from '../i18n/strings';

const axiosErr = (status: number, data: unknown) => ({ response: { status, data } });
const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), 'src', ...p), 'utf8');

// ─── نافذة المالك ───

test('نافذة المالك: التنبيه بحسب الانتقال — إطفاء، وإعادة تفعيل بحقبة جديدة، وأول تفعيل', () => {
  assert.equal(tenantLotNote({ lotTrackingEnabled: true }, false), 'OFF');
  assert.equal(tenantLotNote({ lotTrackingEnabled: false, lotTrackingSince: '2026-10-01T00:00:00.000Z' }, true), 'NEW_EPOCH');
  assert.equal(tenantLotNote({ lotTrackingEnabled: false, lotTrackingSince: null }, true), 'FIRST_ON');
  assert.equal(tenantLotNote({}, true), 'FIRST_ON', 'شركة قديمة بلا العمود');
  assert.equal(tenantLotNote({ lotTrackingEnabled: true }, true), null);
  assert.equal(tenantLotNote({}, false), null);
});

test('نافذة المالك: العلم في الحمولة حين يتغيّر وحده — فلا يمرّ حفظٌ آخر بمعاملة الحقبة', () => {
  assert.deepEqual(tenantLotPayload({ lotTrackingEnabled: false }, false), {});
  assert.deepEqual(tenantLotPayload({}, false), {});
  assert.deepEqual(tenantLotPayload({ lotTrackingEnabled: true }, true), {});
  assert.deepEqual(tenantLotPayload({ lotTrackingEnabled: false }, true), { lotTrackingEnabled: true });
  assert.deepEqual(tenantLotPayload({ lotTrackingEnabled: true }, false), { lotTrackingEnabled: false });
});

test('حذف الشركة: LOT_RECORDS_RETAINED وتفاصيله (D31) — وغيره null', () => {
  const e = axiosErr(409, { success: false, code: 'LOT_RECORDS_RETAINED', message: 'x', detail: { lots: 3, expiryFrom: '2026-05-03', retentionDays: 180 } });
  assert.deepEqual(lotRecordsRetainedOf(e), { lots: 3, expiryFrom: '2026-05-03', retentionDays: 180 });
  assert.deepEqual(lotRecordsRetainedOf(axiosErr(409, { code: 'LOT_RECORDS_RETAINED' })), { lots: 0, expiryFrom: null, retentionDays: 180 });
  assert.equal(lotRecordsRetainedOf(axiosErr(409, { code: 'LEDGER_RETENTION_ACTIVE' })), null);
  assert.equal(lotRecordsRetainedOf(new Error('net')), null);
});

// ─── نافذة الصنف ───

test('نافذة الصنف: lotTracked لا يُرسل والميزة مطفأة، ولا إلا حين يتغيّر', () => {
  assert.deepEqual(productLotPayload({ lotTracked: true }, false, false), {}, 'مطفأة ⇒ لا حقل ولو اختلف');
  assert.deepEqual(productLotPayload(null, false, true), {});
  assert.deepEqual(productLotPayload(null, true, false), {}, 'صنفٌ جديد غير متتبَّع ⇒ الحمولة كما كانت');
  assert.deepEqual(productLotPayload(null, true, true), { lotTracked: true });
  assert.deepEqual(productLotPayload({ lotTracked: false }, true, false), {});
  assert.deepEqual(productLotPayload({}, true, false), {}, 'صنفٌ بلا العمود = غير متتبَّع');
  assert.deepEqual(productLotPayload({ lotTracked: false }, true, true), { lotTracked: true });
  assert.deepEqual(productLotPayload({ lotTracked: true }, true, false), { lotTracked: false });
});

test('نافذة الصنف: تنبيه الإطفاء وإعادة التفعيل بحقبة جديدة (D9، D25)', () => {
  assert.equal(productLotNote({ lotTracked: true }, false), 'OFF');
  assert.equal(productLotNote({ lotTracked: false, lotTrackedSince: '2026-09-01T00:00:00.000Z' }, true), 'NEW_EPOCH');
  assert.equal(productLotNote({ lotTracked: false, lotTrackedSince: null }, true), null, 'أول تفعيل بلا تنبيه');
  assert.equal(productLotNote(null, true), null);
  assert.equal(productLotNote({ lotTracked: true }, true), null);
});

test('LOT_TRACKING_HAS_BALANCE: تفاصيل المسارين (الصنف والجماعي) بشكلٍ واحد، والمشوّه يسقط', () => {
  // مسار الصنف (products.ts: trackingBalanceDetail) يزيد count وlots — تُتجاهل
  const single = axiosErr(409, {
    code: 'LOT_TRACKING_HAS_BALANCE', message: 'm',
    detail: {
      productId: 'p1', updated: 0, count: 2, lots: [{}],
      products: [{ productId: 'p1', name: 'حليب', warehouse: 10.00004, vans: [{ salesRepId: 'r1', qty: 2 }, { salesRepId: 'r2', qty: 0 }], qty: 12 }],
    },
  });
  assert.deepEqual(trackingBalanceOf(single), {
    updated: 0,
    products: [{ productId: 'p1', name: 'حليب', warehouse: 10, vans: [{ salesRepId: 'r1', qty: 2 }], qty: 12 }],
  });
  // الجماعي بعد دفعاتٍ التزمت
  const bulk = axiosErr(409, {
    code: 'LOT_TRACKING_HAS_BALANCE',
    detail: { updated: 100, products: [{ productId: 'p2', name: null, warehouse: 0, vans: [{ salesRepId: 'r9', qty: 5 }] }, { name: 'بلا معرّف' }, null] },
  });
  assert.deepEqual(trackingBalanceOf(bulk), {
    updated: 100,
    products: [{ productId: 'p2', name: null, warehouse: 0, vans: [{ salesRepId: 'r9', qty: 5 }], qty: 5 }],
  });
  assert.equal(trackingBalanceOf(axiosErr(409, { code: 'LOT_BUSY' })), null);
  assert.equal(trackingBalanceOf(undefined), null);
});

// ─── التفعيل الجماعي ───

test('جسم التفعيل الجماعي: نطاقٌ واحد بالضبط، والتأكيد مع الإطفاء وحده، والفارغ لا يُرسل', () => {
  assert.deepEqual(trackingRequest({ kind: 'selected', ids: ['a', 'b', 'a', ''] }, true), { enabled: true, productIds: ['a', 'b'] });
  assert.equal(trackingRequest({ kind: 'selected', ids: [] }, true), null);
  assert.equal(trackingRequest({ kind: 'selected', ids: Array.from({ length: LOT_TRACKING_MAX_IDS + 1 }, (_, i) => `p${i}`) }, true), null);
  assert.deepEqual(trackingRequest({ kind: 'category', categoryId: 'c1' }, false), { enabled: false, categoryId: 'c1' });
  assert.equal(trackingRequest({ kind: 'category', categoryId: '' }, true), null);
  assert.deepEqual(trackingRequest({ kind: 'all' }, true), { enabled: true, all: true });
  assert.deepEqual(trackingRequest({ kind: 'all' }, false, true), { enabled: false, all: true, confirmLotBalances: true });
  assert.deepEqual(trackingRequest({ kind: 'all' }, true, true), { enabled: true, all: true }, 'التأكيد لا معنى له مع التفعيل');
  for (const scope of [{ kind: 'selected' as const, ids: ['x'] }, { kind: 'category' as const, categoryId: 'c' }, { kind: 'all' as const }]) {
    const req = trackingRequest(scope, true)!;
    assert.equal([req.productIds !== undefined, req.categoryId !== undefined, req.all === true].filter(Boolean).length, 1);
  }
});

test('needsAttention: السالب أولاً ويُوسَم، والمشوّه يسقط', () => {
  const rows = attentionRows({
    updated: 3,
    needsAttention: [
      { productId: 'a', name: 'أ', warehouse: { total: 10, unknown: 10 }, vans: [] },
      { productId: 'b', name: 'ب', warehouse: null, vans: [{ salesRepId: 'r1', total: -2, unknown: -2 }, { total: 1 }] },
      { name: 'بلا معرّف' },
    ],
  });
  assert.deepEqual(rows.map(r => [r.productId, r.negative]), [['b', true], ['a', false]]);
  assert.deepEqual(rows[0].vans, [{ salesRepId: 'r1', total: -2, unknown: -2 }]);
  assert.equal(rows[0].warehouse, null);
  assert.deepEqual(attentionRows(null), []);
  assert.deepEqual(attentionRows({ needsAttention: 'x' }), []);
});

// ─── تحذير حذف المندوب ───

test('تشغيلات السيارة قبل حذف المندوب: الصالح الموجب أيّاً كانت حالته، والمشوّه صفر', () => {
  const snap = {
    serverTime: '', day: '2026-10-30', tracked: ['p1', 'p2', 'p3'], allowUnknown: true,
    products: [
      { productId: 'p1', lots: [{ lotId: 'l1', usable: 5 }, { lotId: 'l2', status: 'BLOCKED', usable: 0.1 }, { lotId: 'l3', usable: 0 }] },
      { productId: 'p2', lots: [{ lotId: 'l4', usable: 0.2 }] },
      { productId: 'p3', lots: [] },
    ],
  };
  assert.deepEqual(vanLotsLeft(snap), { lots: 3, products: 2, qty: 5.3 });
  assert.deepEqual(vanLotsLeft(null), { lots: 0, products: 0, qty: 0 });
  assert.deepEqual(vanLotsLeft({ products: 'x' }), { lots: 0, products: 0, qty: 0 });
  assert.equal(fillVanLots('{lots} / {qty}', { lots: 3, qty: 5.3 }), '3 / 5.3');
});

test('نصّ تحذير حذف المندوب مترجم بالأربع — وكل ترجمة تحمل {lots} و{qty}', () => {
  const row = PHRASES[REP_DELETE_LOTS];
  assert.ok(row, 'لا ترجمة لنصّ التحذير');
  for (const lang of ['en', 'fr', 'tr', 'zh'] as const) {
    assert.ok(row[lang].includes('{lots}') && row[lang].includes('{qty}'), `ترجمة ${lang} تُسقط رقماً`);
  }
});

// ─── حرّاس الشاشات ───

test('نافذة المالك: المربع بعد المستودع، مطفأ افتراضياً، ويُرسل حين يتغيّر — والتنبيهات بالانتقال', () => {
  const s = read('pages', 'PlatformPage.tsx');
  assert.match(s, /useState\(!!tenant\.lotTrackingEnabled\)/);
  assert.match(s, /\n {6}\.\.\.tenantLotPayload\(tenant, lotTrackingEnabled\),\n/, 'العلم في حمولة tenantApi.update حين يتغيّر');
  const wh = s.indexOf("{tr('تفعيل مخزون الشركة المستودع لهذه الشركة')}");
  const lot = s.indexOf("{tr('تفعيل تتبع اللوط التشغيلات لهذه الشركة')}");
  const daily = s.indexOf("{tr('تفعيل التقرير اليومي لهذه الشركة')}");
  assert.ok(wh > 0 && lot > wh && daily > lot, 'بعد المستودع مباشرة');
  assert.ok(s.includes("{lotNote === 'OFF' && ("));
  assert.ok(s.includes("{lotNote === 'NEW_EPOCH' && ("));
  // D8: نافذة الإطفاء تحذّر من المادة ٥٢ من اللائحة التنفيذية لنظام الغذاء (حفظ ١٨٠ يوماً بعد الانتهاء) — بترجمتها الكاملة
  const off = s.slice(s.indexOf("{lotNote === 'OFF' && ("), s.indexOf("{lotNote === 'NEW_EPOCH' && ("));
  const text = off.match(/\{tr\('([^']+)'\)\}/)?.[1] ?? '';
  assert.ok(text.includes('المادة 52 من اللائحة التنفيذية لنظام الغذاء') && text.includes('180 يوما'), 'تحذير الإطفاء بلا المادة ٥٢');
  const row = PHRASES[text];
  assert.ok(row && ['en', 'fr', 'tr', 'zh'].every(l => /52/.test((row as Record<string, string>)[l] ?? '') && /180/.test((row as Record<string, string>)[l] ?? '')), 'ترجمةٌ تُسقط المادة أو المدة');
});

test('حذف الشركة: confirmLotRecords لا يُرسل إلا من مرحلة سجلات التشغيلات، ويحمل تأكيد الدفاتر الذي سبقه', () => {
  const s = read('pages', 'PlatformPage.tsx');
  assert.match(s, /mutationFn: \(\{ ledger, lots \}: \{ ledger: boolean; lots: boolean \}\) => tenantApi\.remove\(tenant\.id, ledger, lots\)/);
  const calls = [...s.matchAll(/deleteMutation\.mutate\(\{ ledger: ([^,]+), lots: (true|false) \}\)/g)].map(m => [m[1], m[2]]);
  assert.deepEqual(calls.sort(), [['false', 'false'], ['ledgerConfirmed', 'true'], ['true', 'false']].sort());
  assert.ok(s.includes('setLedgerConfirmed(sent.ledger);'));
  // الرفض يُقرأ قبل رموز الدفاتر
  const onErr = s.slice(s.indexOf('onError: (err: unknown, sent) => {'));
  assert.ok(onErr.indexOf('lotRecordsRetainedOf(err)') < onErr.indexOf("'LEDGER_RETENTION_ACTIVE'"));
  const client = read('api', 'client.ts');
  assert.ok(client.includes('confirmLotRecords: confirmLotRecords ? 1 : undefined'));
});

test('نافذة الصنف: القسم خلف lotTrackingOn، والعلم يُرسل حين يتغيّر وحده، ولا تُعاد قيمه المحمّلة', () => {
  const s = read('components', 'forms', 'ProductModal.tsx');
  assert.match(s, /zatcaCollect = false, lotTrackingOn = false \}: Props\)/);
  const at = s.indexOf('data-lot-tracking=""');
  assert.ok(at > 0 && s.lastIndexOf('{lotTrackingOn && (', at) > at - 200, 'القسم خارج حارس الميزة');
  assert.ok(s.includes('...productLotPayload(product, lotTrackingOn, lotTracked),'));
  assert.match(s, /lotTracked: _lotTracked, lotTrackedSince: _lotTrackedSince, units: _units, \.\.\.rest \} = data;/);
  assert.equal((s.match(/lotTracked:/g) || []).length, 1, 'لا كتابة أخرى للعلم في الحمولة');
});

test('نافذة الصنف (§٤.١٨): الصنف المتتبَّع يُخفى أساس صلاحيته ومعاينته بنصّ «من انتهاء التشغيلة» — وتبقى المدة وقيد المرتجع', () => {
  const s = read('components', 'forms', 'ProductModal.tsx');
  // خلف الميزة والعلم معاً، وأساسٌ لا يكتمل (شراءٌ بلا تاريخ) يبقى ظاهراً فلا يرفض الحفظ بحقلٍ مخفي
  assert.ok(s.includes("const lotExpiry = lotTrackingOn && lotTracked && !(lifeBasis === 'PURCHASE' && !watch('shelfLifeFromDate'));"));
  const at = s.indexOf('{lotExpiry ? (');
  const basis = s.indexOf("{...register('shelfLifeBasis')}");
  const preview = s.indexOf('{tr(PREVIEW_LABEL[lifeBasis])}');
  const rule = s.indexOf('data-return-rule=""');
  const duration = s.indexOf("{...register('shelfLifeValue', { valueAsNumber: true })}");
  assert.ok(at > 0 && basis > at && preview > basis && rule > preview, 'الأساس ومعاينته في فرع غير المتتبَّع');
  assert.ok(s.slice(at, basis).includes('data-lot-expiry-basis=""'), 'نصّ «من انتهاء التشغيلة» في فرع المتتبَّع');
  assert.ok(duration > 0 && duration < at, 'المدة خارج الفرع: تبقى لقيد النسبة');
  assert.ok(s.includes("{lotExpiry ? tr('الصلاحية من تاريخ انتهاء التشغيلة') : <>{tr('تحسب من')} {tr(SHELF_LIFE_BASIS_LABELS[lifeBasis])}</>}"));
});

test('صفحة المنتجات: العمود والفلتر والتفعيل الجماعي وطلباتها خلف علم الشركة — والمطفأة كما كانت', () => {
  const s = read('pages', 'ProductsPage.tsx');
  assert.match(s, /const lotOn = lotFlagsOf\(company\)\.on;/);
  assert.match(s, /const canBulk = lotOn && user\?\.canManageVanStock !== false;/);
  assert.match(s, /const catFilter = lotOn \? categoryId : '';/, 'فلترٌ خفيّ لا يبقى بعد الإطفاء');
  assert.match(s, /queryKey: \['product-categories'\],[\s\S]{0,200}?enabled: lotOn,/);
  assert.ok(s.includes("queryKey: ['products', search, page, ...(catFilter ? [catFilter] : [])],"), 'مفتاح الجدول كما كان والميزة مطفأة');
  assert.ok(s.includes("productApi.list({ search, page, limit: 15, ...(catFilter ? { categoryId: catFilter } : {}) })"));
  const bulk = s.indexOf('data-lot-bulk=""');
  assert.ok(bulk > 0 && s.lastIndexOf('{canBulk && (', bulk) > bulk - 200);
  assert.ok(s.includes("{lotOn && <th>{tr('التشغيلة')}</th>}"));
  assert.ok(s.includes('lotTrackingOn={lotOn}'));
  assert.ok(s.includes('lotsApi.setTracking(req)'));
  // D9: التأكيد يعيد الطلب نفسه بـconfirmLotBalances
  assert.ok(s.includes('saveMutation.mutate({ ...balanceConfirm.values, confirmLotBalances: true })'));
  assert.ok(s.includes('bulkMutation.mutate({ ...balanceConfirm.req, confirmLotBalances: true })'));
  // المستودع ومخزون السيارات يقرآن «الصنف متتبَّع» من products-min: كل تغييرٍ للعلم يبطلها (الحفظ والميزة مفعّلة، والجماعي، وما التزم قبل 409)
  const invMin = "qc.invalidateQueries({ queryKey: ['products-min'] })";
  const save = s.slice(s.indexOf('const saveMutation = useMutation({'), s.indexOf('const deleteMutation = useMutation({'));
  assert.ok(save.includes(`onSuccess: () => { qc.invalidateQueries({ queryKey: ['products'] }); if (lotOn) ${invMin};`));
  const bulkM = s.slice(s.indexOf('const bulkMutation = useMutation({'));
  const bulkOk = bulkM.slice(bulkM.indexOf('onSuccess: (res, req) => {'), bulkM.indexOf('onError: (err: unknown, req) => {'));
  assert.ok(bulkOk.includes(`${invMin};`), 'نجاح الجماعي');
  const bulkErr = bulkM.slice(bulkM.indexOf('onError: (err: unknown, req) => {'));
  assert.ok(bulkErr.includes(`if (bal.updated > 0) { qc.invalidateQueries({ queryKey: ['products'] }); ${invMin}; }`), 'دفعات التزمت قبل 409');
});

test('إعدادات الشركة: «طباعة التشغيلة» خلف الميزة والمحاسبة والصلاحية، وبمسارها المستقل وحده', () => {
  const s = read('pages', 'CompanySettingsPage.tsx');
  assert.match(s, /const lotCardOn = accountingOn && lotFlags\.on && canManageVanStock;/);
  assert.ok(s.includes('{lotCardOn && <LotOnInvoiceCard value={lotFlags.onInvoice} />}'));
  assert.equal((s.match(/<LotOnInvoiceCard\b/g) || []).length, 1);
  assert.ok(s.includes('mutationFn: (lotOnInvoice: boolean) => lotsApi.setSettings({ lotOnInvoice }),'));
  // حفظ النموذج العام لا يحمل الحقل (D15: printSettingsCore والنموذج لا يمسّانه)
  const form = s.slice(s.indexOf('const mutation = useMutation({'), s.indexOf('const onLogoChange'));
  assert.ok(!form.includes('lotOnInvoice'));
});

test('حذف المندوب: تحذير التشغيلات في حواري اللوحة، وطلبه خلف الميزة والمحاسبة والصلاحية', () => {
  const page = read('pages', 'SalesRepsPage.tsx');
  assert.equal((page.match(/<RepVanLotsNote repId=/g) || []).length, 2);
  assert.equal((page.match(/<RepVanStockNote repId=/g) || []).length, 2, 'تحذير مخزون السيارة باقٍ');
  const note = read('components', 'RepVanLotsNote.tsx');
  assert.match(note, /const allowed = ready && on && lotFlagsOf\(companyQ\.data\)\.on && user\?\.canManageVanStock !== false;/);
  assert.match(note, /queryFn: async \(\) => vanLotsLeft\(\(await lotsApi\.vanLotBalances\(repId\)\)\.data\?\.data\),\n\s*enabled: allowed,/);
  assert.match(note, /if \(!left \|\| left\.lots === 0\) return null;/);
});
