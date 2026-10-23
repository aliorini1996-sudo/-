// إعداد الطباعة على الجهاز («إعدادات الطباعة» M2، التصميم §2): الهوية لكل مساحة، والمحفوظ يُنقّى ولا يرمي، والاختيار لكل نوع
// مستند — وبلا إعدادات مخصّصة لا يُقرأ اختيار الجهاز أبداً (زرّ اليوم كما هو).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDeviceChoice, printDeviceKey, printIdentityFrom, withConnection, withKindChoice } from './printDevice';
import {
  defaultPrintOptions, deviceProfilesFor, legacyPrintSettings, presetPaper, printKindOf, profileFor, readPrintSettings,
  type PrintSettingsV1,
} from '../lib/print/printSettings';

const jwt = (payload: object) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;

test('الهوية: المندوب والجوال واللوحة كلٌّ من مساحته — والغائب «local»', () => {
  const store: Record<string, string> = {
    rep_token: jwt({ tenantId: 't-rep' }), rep_user: JSON.stringify({ id: 'r-1' }),
    m_token: 'bad', m_user: JSON.stringify({ id: 'u-m', tenantId: 't-m' }),
    token: jwt({ tenantId: 't-web' }), user: JSON.stringify({ id: 'u-web' }),
  };
  const read = (k: string) => store[k] ?? null;
  assert.deepEqual(printIdentityFrom('/rep', read), { tenantId: 't-rep', userId: 'r-1' });
  assert.deepEqual(printIdentityFrom('/m/invoices', read), { tenantId: 't-m', userId: 'u-m' }, 'توكنٌ تالف ⇒ شركة المستخدم المحفوظ');
  assert.deepEqual(printIdentityFrom('/invoices', read), { tenantId: 't-web', userId: 'u-web' });
  assert.deepEqual(printIdentityFrom('/maghreb', read), { tenantId: 't-web', userId: 'u-web' }, '/m بحدّ نهاية');
  assert.deepEqual(printIdentityFrom('/rep', () => '{bad'), { tenantId: 'local', userId: 'local' });
  assert.equal(printDeviceKey({ tenantId: 't', userId: 'u' }), 'fs_print:t:u');
});

test('المحفوظ يُنقّى: معرّفات غير صالحة وأنواع مجهولة تسقط، والتالف لا شيء', () => {
  assert.equal(parseDeviceChoice(null), null);
  assert.equal(parseDeviceChoice('{bad'), null);
  assert.equal(parseDeviceChoice('[1]'), null);
  assert.equal(parseDeviceChoice('{}'), null);
  assert.deepEqual(
    parseDeviceChoice(JSON.stringify({ byKind: { invoice: 'mip480', receipt: 'X!', delivery: 'van-80', statement: 7 }, transport: 'usb', portHint: { name: 'MIP480' } })),
    { byKind: { invoice: 'mip480' }, portHint: { name: 'MIP480' } },
  );
  assert.deepEqual(parseDeviceChoice(JSON.stringify({ transport: 'system' })), { transport: 'system' });
});

test('الاختيار لكل نوع مستند — وإلغاؤه يعيده لاختيار الشركة', () => {
  const a = withKindChoice(null, 'invoice', 'mip480');
  assert.deepEqual(a, { byKind: { invoice: 'mip480' } });
  const b = withKindChoice(a, 'receipt', 'van-80');
  assert.deepEqual(b, { byKind: { invoice: 'mip480', receipt: 'van-80' } });
  assert.deepEqual(withKindChoice(b, 'invoice', null), { byKind: { receipt: 'van-80' } });
  assert.equal(withKindChoice(a, 'invoice', null), null);
  assert.deepEqual(withKindChoice({ transport: 'system', byKind: { invoice: 'x-1' } }, 'invoice', null), { transport: 'system' });
});

test('القراءة في شاشة المستند: null والتالف غير مخصّصين (اختيار الجهاز لا يُقرأ)، والصالح مخصّص', () => {
  assert.deepEqual(readPrintSettings(null), { settings: legacyPrintSettings(), customized: false });
  assert.deepEqual(readPrintSettings({ version: 2 }), { settings: legacyPrintSettings(), customized: false });
  const custom: PrintSettingsV1 = {
    ...legacyPrintSettings(),
    profiles: [...legacyPrintSettings().profiles, { id: 'mip480', name: 'MIP480', printer: 'impact', template: 'impact_plain', paper: presetPaper('ff_a4')!, options: defaultPrintOptions('impact') }],
    routing: { invoice: 'mip480', receipt: 'legacy-58', statement: 'mip480', notices: null },
  };
  const r = readPrintSettings(JSON.parse(JSON.stringify(custom)));
  assert.equal(r.customized, true);
  assert.equal(profileFor(r.settings, 'invoice')?.id, 'mip480');
  // كل أنواع شاشة المستند تجد نوعها في التوجيه
  assert.deepEqual(['invoice', 'receipt', 'statement', 'settlement', 'loadNotice', 'warehouseNotice', 'stockRequest'].map(printKindOf),
    ['invoice', 'receipt', 'statement', 'notices', 'notices', 'notices', 'notices']);
  // لا رول لكشف الحساب بين خيارات الجهاز
  assert.deepEqual(deviceProfilesFor(r.settings, 'statement').map((p) => p.id), ['legacy-a4', 'mip480']);
  assert.deepEqual(deviceProfilesFor(r.settings, 'invoice').map((p) => p.id), ['legacy-58', 'legacy-a4', 'mip480']);
});

test('شبكة أمان «استعادة الافتراضي»: كائنٌ يساوي الافتراضي حرفياً غير مخصّص — فلا اختيار جهاز ولا سطر «تغيير» ولا تحويل إلى A4', () => {
  const saved = JSON.parse(JSON.stringify(legacyPrintSettings()));
  assert.deepEqual(readPrintSettings(saved), { settings: legacyPrintSettings(), customized: false });
  // ولو بقيمٍ عبثية في الملفّين المجمَّدين (يُعادان كما هما)
  saved.profiles[0].options.copies = 3;
  saved.profiles[1].options.showLogo = false;
  assert.equal(readPrintSettings(saved).customized, false);
  // وأيّ فرقٍ حقيقيّ مخصّص: إذن الاختيار أو توجيهٌ أو قالبٌ زائد
  assert.equal(readPrintSettings({ ...legacyPrintSettings(), repMayChoose: false }).customized, true);
  assert.equal(readPrintSettings({ ...legacyPrintSettings(), routing: { ...legacyPrintSettings().routing, receipt: null } }).customized, true);
  // غير المخصّص لا يقرأ اختيار الجهاز (شاشة المستند تمرّر null) — فيبقى زرّ اليوم 58 مم
  const r = readPrintSettings(JSON.parse(JSON.stringify(legacyPrintSettings())));
  assert.equal(profileFor(r.settings, 'invoice', r.customized ? { byKind: { invoice: 'legacy-a4' } } : null)?.id, 'legacy-58');
});

test('M3: طريقة الاتصال والرابط البطيء — نظام الطباعة افتراضٌ لا يُحفظ، والقيم المجهولة تسقط', () => {
  assert.deepEqual(withConnection(null, { transport: 'bt-serial' }), { transport: 'bt-serial' });
  assert.equal(withConnection({ transport: 'bt-serial' }, { transport: 'system' }), null, 'العودة للافتراضي تمحو المفتاح');
  assert.deepEqual(withConnection({ byKind: { invoice: 'mip480' } }, { slow: true }), { byKind: { invoice: 'mip480' }, slow: true });
  assert.deepEqual(withConnection({ transport: 'bt-serial', slow: true }, { slow: false }), { transport: 'bt-serial' });
  assert.deepEqual(parseDeviceChoice(JSON.stringify({ transport: 'bt-serial', slow: true })), { transport: 'bt-serial', slow: true });
  assert.equal(parseDeviceChoice(JSON.stringify({ transport: 'usb', slow: 'yes' })), null);
});
