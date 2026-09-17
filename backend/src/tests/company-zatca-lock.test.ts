// فوترة ZATCA (Z5.0، D9/F13) — قفل الدولة والعملة وتجاوزها ومزوّد الفوترة بعد التفعيل الحيّ في PUT /api/company.
// الحارس النقيّ (القيم المشتقّة النهائية مقابل المحفوظة — حفظ بلا تغيير يمرّ، نقد الخطة 32) + فحص نصّي لموضعه: القراءة نفسها
// التي تسبقه (لا استعلام إضافي)، بعد اشتقاق العملة وقبل الكتابة، ويردّ 409 ويخرج.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { getCountryTax } from '../config/countries';
import { PHASE2_LOCKED_SETTINGS, phase2LockedSettingChanges, phase2SettingsLockedBody } from '../compliance/zatca/settingsGuards';

const LIVE = new Date('2026-11-20T06:00:00.000Z');
const liveRow = (over: Record<string, unknown> = {}) => ({ countryCode: 'SA', currency: 'SAR', currencyOverride: null, einvoiceProvider: 'zatca', zatcaPhase2StartedAt: LIVE, ...over });

/** جسم الكتابة كما يبنيه PUT /api/company بعد الاشتقاق (الدولة مُرسلة، التجاوز من الطلب أو المحفوظ). */
function derived(countryCode: string | undefined, override: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const clean: Record<string, unknown> = { name: 'شركة', ...extra };
  if (countryCode) {
    const c = getCountryTax(countryCode);
    Object.assign(clean, { countryCode: c.code, currency: c.currency, defaultVatPct: c.defaultVatPct, einvoiceProvider: c.provider });
  }
  clean.currencyOverride = override;
  if (override === 'USD') clean.currency = 'USD';
  return clean;
}

test('غير مفعّلة: لا قيد إطلاقاً (كما اليوم) — مهما تغيّرت الدولة أو العملة', () => {
  for (const current of [null, undefined, liveRow({ zatcaPhase2StartedAt: null })]) {
    assert.deepEqual(phase2LockedSettingChanges(current, derived('EG', 'USD')), []);
    assert.deepEqual(phase2LockedSettingChanges(current, derived(undefined, 'EUR')), []);
  }
});

test('مفعّلة: حفظ بلا تغيير فعلي يمرّ (الدولة تُرسل مع كل حفظ فتُشتقّ العملة والمزوّد من جديد)', () => {
  assert.equal(getCountryTax('SA').provider, 'zatca');
  assert.deepEqual(phase2LockedSettingChanges(liveRow(), derived('SA', null)), []);
  assert.deepEqual(phase2LockedSettingChanges(liveRow(), derived('sa', null)), [], 'حالة الأحرف');
  assert.deepEqual(phase2LockedSettingChanges(liveRow(), derived(undefined, null)), [], 'الدولة غير مُرسلة');
  assert.deepEqual(phase2LockedSettingChanges(liveRow(), { name: 'x', currencyOverride: '' }), [], "'' = null");
  assert.deepEqual(phase2LockedSettingChanges(liveRow(), { name: 'x' }), [], 'بلا الحقول');
  assert.deepEqual(phase2LockedSettingChanges(liveRow(), { countryCode: undefined, currency: undefined }), [], 'undefined = لا كتابة');
});

test('مفعّلة: تغيير الدولة أو تجاوز العملة أو المزوّد ⇒ الحقول المتغيّرة وحدها', () => {
  assert.deepEqual(phase2LockedSettingChanges(liveRow(), derived('SA', 'USD')), ['currency', 'currencyOverride']);
  assert.deepEqual(phase2LockedSettingChanges(liveRow(), derived('AE', null)).sort(), ['countryCode', 'currency', 'einvoiceProvider'].sort());
  assert.deepEqual(phase2LockedSettingChanges(liveRow({ currencyOverride: 'USD', currency: 'USD' }), derived('SA', null)), ['currency', 'currencyOverride'], 'إزالة تجاوز قائم تغيير أيضاً');
  assert.deepEqual(phase2LockedSettingChanges(liveRow(), { einvoiceProvider: 'none' }), ['einvoiceProvider']);
  assert.deepEqual([...PHASE2_LOCKED_SETTINGS], ['countryCode', 'currency', 'currencyOverride', 'einvoiceProvider']);
});

test('جسم الردّ 409 برسالة الكتالوج وأسماء الحقول', () => {
  assert.deepEqual(phase2SettingsLockedBody(['currencyOverride']), {
    success: false, code: 'ZATCA_SETTINGS_LOCKED', message: 'لا يمكن تغيير الدولة أو العملة أو مزوّد الفوترة بعد التفعيل', fields: ['currencyOverride'],
  });
});

test('الموضع في PUT /api/company: القراءة نفسها تحمل zatcaPhase2StartedAt، والحارس بعد اشتقاق العملة وقبل upsert، ويردّ 409 ويخرج', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'company.ts'), 'utf8').replace(/\r\n/g, '\n');
  const put = src.slice(src.indexOf("router.put('/'"), src.indexOf('export default router'));
  const read = "const existing = await prisma.companySettings.findUnique({ where: { tenantId: tid }, select: { currencyOverride: true, countryCode: true, currency: true, einvoiceProvider: true, zatcaPhase2StartedAt: true } });";
  assert.ok(put.includes(read), 'قراءة الإعدادات في كتلة العملة');
  assert.equal(put.split('prisma.companySettings.findUnique(').length - 1, 2, 'لا قراءة إضافية (حقول البائع + كتلة العملة فقط)');
  const derive = put.indexOf('clean.currency = getCountryTax(existing?.countryCode).currency;');
  const guard = put.indexOf('const zatcaLocked = phase2LockedSettingChanges(existing, clean);');
  const refuse = put.indexOf('res.status(409).json(phase2SettingsLockedBody(zatcaLocked));');
  const upsert = put.indexOf('prisma.companySettings.upsert(');
  assert.ok(put.indexOf(read) < derive && derive < guard && guard < refuse && refuse < upsert, 'ترتيب القراءة ⇒ الاشتقاق ⇒ الحارس ⇒ الكتابة');
  assert.match(put.slice(refuse, upsert), /^res\.status\(409\)\.json\(phase2SettingsLockedBody\(zatcaLocked\)\);\s*return;/);
  // التغيير الوحيد في المسار: لا شرط على العلم (التفعيل وحده يقفل)
  assert.doesNotMatch(put.slice(guard - 400, refuse), /zatcaPhase2Enabled/);
});
