/**
 * «خيار البلوتوث للمندوب دائماً» (طلب المالك ٣١ أكتوبر ٢٠٢٦) — شركةٌ بلا «إعدادات طباعة» (أو قالبها الشريط الكلاسيكي) يظهر لمندوبها
 * سطر «تغيير» تحت زرّ الطباعة، ومنه «بلوتوث مباشر» بقالب الجهاز deviceRollProfile: «الشريط المختصر» بعرض رول طابعته 58/80 مم.
 * وما لم يختره فالزرّ والورقة كاليوم حرفاً بحرف (نظام الطباعة والشريط الكلاسيكي).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEVICE_ROLL_IDS, PROFILE_ID_RE, deviceRollProfile, isDeviceRollId, legacyThermalProfile, profileDisplayName, profileIssues } from '../lib/print/printSettings';
import { supportsDirect, transportFor } from './printDirect';
import { fromRollView, parseDeviceChoice, rollViewOf, withConnection } from './printDevice';
import { printThermalInvoice } from './thermal';
import { DocumentResult, type InvoiceDoc } from './RepDocuments';

const same = (s: string) => s;

test('قالب الجهاز: المختصر بعرض الرول، يُرسل بالبلوتوث، ومعرّفه لا يلتبس بقالبٍ للشركة', () => {
  for (const mm of [58, 80] as const) {
    const p = deviceRollProfile(mm);
    assert.equal(p.printer, 'thermal');
    assert.equal(p.template, 'roll_compact');
    assert.equal(p.paper.widthMm, mm);
    assert.equal(p.paper.printableDots, mm === 80 ? 576 : 384);
    assert.equal(supportsDirect(p), true, 'لا يُرسل بالبلوتوث');
    assert.equal(isDeviceRollId(p.id), true);
    assert.equal(PROFILE_ID_RE.test(p.id), false, 'معرّفٌ قد يلتبس بقالبٍ للشركة');
    // قواعد القالب نفسها (عدا المعرّف المقصود خارج نمط الشركة)
    assert.deepEqual(profileIssues(p, 'p').filter((i) => i.path !== 'p.id'), []);
  }
  assert.equal(deviceRollProfile().id, DEVICE_ROLL_IDS[58], 'الافتراضي 58');
  assert.equal(profileDisplayName(deviceRollProfile(80), (s) => `[${s}]`), '[حرارية 80 مم]', 'اسم قالب الجهاز يُترجم');
  assert.equal(supportsDirect(legacyThermalProfile()), false, 'الكلاسيكي يبقى على نظام الطباعة');
});

test('الطريقة: البلوتوث متى اختاره الجهاز ودعمه المتصفح — وإلا نظام الطباعة', () => {
  const p = deviceRollProfile(80);
  assert.equal(transportFor(p, { transport: 'bt-serial' }, true), 'bt-serial');
  assert.equal(transportFor(p, { transport: 'bt-serial' }, false), 'system', 'متصفحٌ بلا Web Serial');
  assert.equal(transportFor(p, null, true), 'system', 'الافتراضي نظام الطباعة');
});

test('عرض الرول يُحفظ على الجهاز: 80 صراحةً و58 الافتراضي بلا مفتاح', () => {
  assert.deepEqual(withConnection(null, { rollMm: 80 }), { rollMm: 80 });
  assert.equal(withConnection({ rollMm: 80 }, { rollMm: 58 }), null);
  assert.deepEqual(withConnection({ transport: 'bt-serial' }, { rollMm: 80 }), { transport: 'bt-serial', rollMm: 80 });
  assert.deepEqual(parseDeviceChoice('{"transport":"bt-serial","rollMm":80}'), { transport: 'bt-serial', rollMm: 80 });
  assert.deepEqual(parseDeviceChoice('{"transport":"bt-serial","rollMm":112}'), { transport: 'bt-serial' }, 'عرضٌ مجهول يُسقط');
});

test('شركةٌ بلا إعدادات طباعة: سطر «تغيير» تحت زرّ الطباعة — والزرّ بنصّ اليوم', () => {
  const doc: InvoiceDoc = {
    kind: 'invoice', number: 'INV-1', date: '2026-10-31T10:00:00', type: 'CASH',
    company: { name: 'شركة', taxNumber: '300000000000003', countryCode: 'SA' }, customer: { name: 'عميل' }, repName: 'أحمد',
    items: [{ name: 'ماء', qty: 1, unitPrice: 11.5, discountPct: 0, taxPct: 15, lineTotal: 11.5 }],
    subtotal: 10, discount: 0, tax: 1.5, total: 11.5, pricesIncludeTax: true,
  };
  const html = renderToStaticMarkup(createElement(DocumentResult, { doc, onClose: () => {} }));
  assert.ok(html.includes('طباعة حرارية 58 مم'), 'نصّ الزرّ تغيّر');
  assert.ok(html.includes('>تغيير</button>'), 'سطر «تغيير» غائب عن شركةٍ بلا إعدادات');
  assert.ok(html.includes('نظام الطباعة في الجهاز'), 'الطريقة الحالية غير مذكورة');
});

test('البلوتوث بقالب الجهاز 80 مم يطبع المختصر بعرض 80 — لا الشريط الكلاسيكي', async () => {
  const doc: InvoiceDoc = {
    kind: 'invoice', number: 'INV-2', date: '2026-10-31T10:00:00', type: 'CASH',
    company: { name: 'شركة', taxNumber: '300000000000003', countryCode: 'SA' }, customer: { name: 'عميل' }, repName: 'أحمد',
    items: [{ name: 'ماء', qty: 1, unitPrice: 11.5, discountPct: 0, taxPct: 15, lineTotal: 11.5 }],
    subtotal: 10, discount: 0, tax: 1.5, total: 11.5, pricesIncludeTax: true,
  };
  let html = '';
  await printThermalInvoice(doc, { profile: deviceRollProfile(80), tr: same, capture: (h) => { html = h; } });
  assert.ok(html.includes('size: 80mm') && !html.includes('58mm auto'), 'ليس المختصر بعرض 80');
});

test('مراجعة: طريقة قالب الجهاز (rollVia) مستقلةٌ عن طريقة قوالب الشركة (transport) — في الاتجاهين', () => {
  // جهازٌ يطبع فاتورته بالبلوتوث على قالبٍ للشركة: أدوات قالب الجهاز تراه «نظام الطباعة» (لا يرث البلوتوث)
  assert.equal(rollViewOf({ transport: 'bt-serial' }), null);
  assert.deepEqual(rollViewOf({ transport: 'bt-serial', rollVia: 'bt-serial', rollMm: 80 }), { transport: 'bt-serial', rollVia: 'bt-serial', rollMm: 80 });
  // اختيار البلوتوث لقالب الجهاز لا يمسّ transport الشركة، واختيار نظام الطباعة له لا يُطفئ بلوتوث قالب الشركة
  assert.deepEqual(fromRollView({ transport: 'system' }, { transport: 'bt-serial' }), { transport: 'system', rollVia: 'bt-serial' });
  assert.deepEqual(fromRollView({ transport: 'bt-serial', rollVia: 'bt-serial' }, { rollMm: 80 }), { transport: 'bt-serial', rollMm: 80 });
  assert.equal(fromRollView(null, null), null);
  // والرابط البطيء يمرّ كما هو
  assert.deepEqual(fromRollView({ rollVia: 'bt-serial' }, withConnection(rollViewOf({ rollVia: 'bt-serial' }), { slow: true })), { rollVia: 'bt-serial', slow: true });
  assert.deepEqual(parseDeviceChoice('{"rollVia":"bt-serial","rollMm":80}'), { rollVia: 'bt-serial', rollMm: 80 });
  assert.equal(parseDeviceChoice('{"rollVia":"wifi"}'), null);
});

test('مراجعة: شاشة المستند تقرأ rollVia لقالب الجهاز لا transport — وأدوات «نظام الطباعة» تعاير بالشريط الكلاسيكي', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const src = (f: string) => fs.readFileSync(path.join(process.cwd(), 'src', ...f.split('/')), 'utf8');
  assert.match(src('rep/RepDocuments.tsx'), /deviceRoll \? transportFor\(deviceRoll, \{ transport: deviceChoice\?\.rollVia \}\)/);
  const sheet = src('rep/PrintDeviceSheet.tsx');
  assert.match(sheet, /choice=\{deviceRoll \? rollViewOf\(choice\) : choice\}/);
  assert.match(sheet, /onChoice=\{deviceRoll \? \(c\) => onChoice\(fromRollView\(choice, c\)\) : onChoice\}/);
  const tools = src('components/print/PrintDeviceTools.tsx');
  assert.match(tools, /buildCalibrationDocument\(sysProfile, tr, \{ mode: 'system', name \}\)/);
  assert.match(tools, /profile: port \? profile : sysProfile/);
});
