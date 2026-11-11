import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { COUNTRIES } from '../i18n/countries';
import { DICT } from '../i18n/strings';
import {
  getFacts, countryRegistry, parseCountryRegistry, coverageFacts, einvoiceStatus, normalizeProfileUrl,
  UI_LANGS, LANG_NAMES, UI_LANGS_SENTENCE, SAME_AS, APPS, IDS, NAME, DESCRIPTION, COVERAGE,
  CONTACT, SUPPORT_SCHEMA_LANG_NAMES,
} from './entity-facts.mjs';

/**
 * حقائق الكيان (entity-facts.mjs) تُحسب من الكود أو تُطابَق به هنا، كي لا تنحرف عنه صامتة:
 * عدد الدول من السجل نفسه، ولغات الواجهة من النوع Lang والقاموس، والمعرّفات وsameAs من index.html.
 */

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');

test('عدد الدول يُحسب من السجل ويطابق COUNTRIES مستورداً', () => {
  const entries = countryRegistry();
  assert.equal(entries.length, Object.keys(COUNTRIES).length);
  for (const e of entries) {
    const c = COUNTRIES[e.code];
    assert.ok(c, `الرمز ${e.code} غير موجود في COUNTRIES`);
    assert.equal(e.nameEn, c.nameEn);
    assert.equal(e.einvoice, c.einvoice);
  }
  const cov = coverageFacts(entries);
  assert.equal(cov.registryEntries, Object.keys(COUNTRIES).length);
  assert.equal(cov.presetCountries, Object.keys(COUNTRIES).filter((k) => k !== COVERAGE.otherCountryCode).length);
  assert.equal(getFacts().coverage.registryEntries, cov.registryEntries);
});

test('محلّل السجل يفشل بصوت عالٍ على ملف لا يفهمه', () => {
  assert.throws(() => parseCountryRegistry('export const OTHER = {};'));
  assert.throws(() => parseCountryRegistry("export const COUNTRIES: X = {\n  SA: {\n    code: 'EG', nameEn: 'x', einvoice: 'none',\n  },\n};"));
});

test('الربط الحكومي حيّ في السعودية وحدها، وهي المحوّل الوحيد المنفَّذ في الخادم', () => {
  assert.equal(einvoiceStatus('SA'), 'live');
  for (const code of Object.keys(COUNTRIES).filter((k) => k !== 'SA')) assert.equal(einvoiceStatus(code), 'on-request');
  const provider = read('..', 'backend', 'src', 'compliance', 'provider.ts');
  // المحوّلات غير المنفَّذة في الخادم تطابق ما تقوله الحقائق
  for (const id of getFacts().eInvoicing.elsewhere.notImplemented) {
    assert.match(provider, new RegExp(`${id}:\\s*notImplemented\\(`), `المحوّل ${id} لم يعد notImplemented — راجع الحقائق`);
  }
  assert.match(provider, /zatca:\s*zatcaProvider/);
});

test('لغات الواجهة تطابق النوع Lang والقاموس', () => {
  const lang = read('src', 'i18n', 'lang.ts');
  const m = lang.match(/export type Lang\s*=\s*([^;]+);/);
  assert.ok(m, 'النوع Lang غير موجود');
  const declared = [...m[1].matchAll(/'([a-z]{2})'/g)].map((x) => x[1]);
  assert.deepEqual([...UI_LANGS].sort(), declared.sort());
  const sample = Object.values(DICT)[0];
  assert.deepEqual([...UI_LANGS].sort(), Object.keys(sample).sort());
  for (const l of UI_LANGS) {
    assert.ok(UI_LANGS_SENTENCE[l], `جملة لغات الواجهة ناقصة بـ${l}`);
    for (const named of UI_LANGS) assert.ok(LANG_NAMES[named][l], `اسم ${named} ناقص بـ${l}`);
  }
});

test('المعرّفات وsameAs والصيغ تطابق index.html', () => {
  const html = read('index.html');
  assert.ok(html.includes(`"@id": "${IDS.organization}"`));
  assert.ok(html.includes(`"@id": "${IDS.repApp}"`), '#software هو معرّف تطبيق المندوب (نقد GEO ٦)');
  const ld = html.match(/"sameAs":\s*\[([^\]]*)\]/);
  assert.ok(ld, 'sameAs غير موجود في index.html');
  const live = [...ld[1].matchAll(/"([^"]+)"/g)].map((x) => normalizeProfileUrl(x[1])).sort();
  assert.deepEqual(SAME_AS.map(normalizeProfileUrl).sort(), live);
  const alt = html.match(/"alternateName":\s*\[([^\]]*)\]/);
  assert.ok(alt);
  const alternates = [...alt[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  for (const a of alternates) assert.ok(NAME.alternates.includes(a), `صيغة اسم في index.html غير مسجّلة في الحقائق: ${a}`);
  for (const a of Object.values(APPS)) if ('url' in a && a.public && a.url) assert.ok(SAME_AS.includes(a.url), `تطبيق منشور غائب عن sameAs: ${a.url}`);
});

/**
 * لغات ContactPoint لغات فريق المبيعات والدعم لا لغات الواجهة (١١ نوفمبر ٢٠٢٦): صارت الخمس فادّعت دعماً بالتركية
 * والصينية لا فريق له. مصدرها CONTACT.supportLanguages، وindex.html مطابق له (prerender يحقنه في كل صفحة).
 */
test('لغات فريق التواصل من CONTACT.supportLanguages، وindex.html يطابقها', () => {
  assert.deepEqual(CONTACT.supportLanguages, ['ar', 'en', 'fr']);
  assert.deepEqual(SUPPORT_SCHEMA_LANG_NAMES, ['Arabic', 'English', 'French']);
  const m = read('index.html').match(/"contactPoint"\s*:\s*\{[^{}]*?"availableLanguage"\s*:\s*(\[[^\]]*\])/);
  assert.ok(m, 'contactPoint.availableLanguage غير موجود في index.html');
  assert.deepEqual(JSON.parse(m[1]), SUPPORT_SCHEMA_LANG_NAMES);
});

test('الوصف القصير بلا «Arab markets» ولا «الأسواق العربية»', () => {
  assert.doesNotMatch(DESCRIPTION.en, /Arab\s+(?:markets?|world|League)|22\s+Arab/i);
  assert.doesNotMatch(DESCRIPTION.ar, /(?:الأسواق|العالم|الدول)\s*العربي/);
  assert.ok(DESCRIPTION.en.startsWith(NAME.official));
});
