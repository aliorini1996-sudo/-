// «احجز اجتماع» (طلب المالك ٨ نوفمبر ٢٠٢٦) — الجوال الدولي من أي دولة، وقائمة مفاتيح كل الدول.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_DIAL } from '../i18n/dialCodes';
import { dialCountryOf, filterDialCountries, internationalPhone, phoneDigits } from './meetingPhone';

const here = path.dirname(fileURLToPath(import.meta.url));

test('قائمة المفاتيح تشمل كل دول العالم: ٢٤٠ دولة وإقليماً فأكثر، بلا تكرار، وكل مفتاح بصيغة +أرقام', () => {
  assert.ok(ALL_DIAL.length >= 240, `${ALL_DIAL.length}`);
  const codes = ALL_DIAL.map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length, 'رمز مكرر');
  for (const c of ALL_DIAL) {
    assert.match(c.dial, /^\+[1-9]\d{0,3}$/, c.code);
    assert.ok(c.ar && c.en, c.code);
  }
  for (const must of ['SA', 'US', 'GB', 'IN', 'CN', 'BR', 'NG', 'ID', 'PK', 'FJ', 'IS', 'JM', 'MV', 'BA', 'EE', 'KP', 'CU']) {
    assert.ok(codes.includes(must), must);
  }
});

test('الأرقام: العربية والفارسية لاتينية، وما ليس رقماً يُحذف', () => {
  assert.equal(phoneDigits('٠٥٠ ١٢٣-٤٥٦٧'), '0501234567');
  assert.equal(phoneDigits('۰۵۰۱۲۳'), '050123');
});

test('الجوال الدولي: صفر البداية يُحذف، والمفتاح المكتوب في أوله لا يُكرَّر، والطول بحدود E.164', () => {
  assert.equal(internationalPhone('+966', '0512345678'), '+966512345678');
  assert.equal(internationalPhone('+966', '512345678'), '+966512345678');
  assert.equal(internationalPhone('+966', '966512345678'), '+966512345678');
  assert.equal(internationalPhone('+1', '(415) 555-0100'), '+14155550100');
  assert.equal(internationalPhone('+44', '07700 900123'), '+447700900123');
  assert.equal(internationalPhone('+683', '4002'), '+6834002', 'نيوي: أرقام قصيرة');
  assert.equal(internationalPhone('+966', ''), null);
  assert.equal(internationalPhone('+966', '123'), null, 'قصير');
  assert.equal(internationalPhone('+966', '1234567890123456'), null, 'طويل');
  assert.equal(internationalPhone('x', '0512345678'), null);
});

test('قائمة الاختيار: العربية أولاً، والبحث بالاسم (بلغتيه) أو بالمفتاح، والافتراضي السعودية', () => {
  const all = filterDialCountries('', 'ar');
  assert.equal(all.length, ALL_DIAL.length);
  assert.equal(all[0].code, 'SA');
  assert.deepEqual(filterDialCountries('مصر', 'ar').map((c) => c.code), ['EG']);
  assert.ok(filterDialCountries('germ', 'en').some((c) => c.code === 'DE'));
  assert.ok(filterDialCountries('+44', 'en').some((c) => c.code === 'GB'));
  assert.ok(filterDialCountries('٩٦٦', 'ar').some((c) => c.code === 'SA'));
  assert.deepEqual(filterDialCountries('zzzz', 'en'), []);
  assert.equal(dialCountryOf(null).code, 'SA');
  assert.equal(dialCountryOf('FJ').dial, '+679');
});

test('الصفحة موصولة: المسار بخمس لغات، وزر الرئيسية يفتحها، والوسم الإعلاني مسموح عليها', () => {
  const app = fs.readFileSync(path.join(here, '..', 'App.tsx'), 'utf8');
  for (const p of ['/meeting', '/en/meeting', '/fr/meeting', '/tr/meeting', '/zh/meeting']) {
    assert.ok(app.includes(`<Route path="${p}" element={<MeetingPage />} />`), p);
  }
  const tpl = fs.readFileSync(path.join(here, '..', 'landing', 'landingTemplate.ts'), 'utf8');
  assert.ok(tpl.includes('<a href=\\"/meeting\\" data-hero-meeting=\\"\\"'));
  const page = fs.readFileSync(path.join(here, '..', 'pages', 'MeetingPage.tsx'), 'utf8');
  assert.ok(page.includes('contactApi.meeting({ name: name.trim(), phone: full, country: country.code, lang })'));
});
