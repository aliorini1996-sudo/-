import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createLangDetector, docLocale, splitUiLanguages, localeLangNames } from '../../scripts/facts-langs.mjs';

/**
 * كاشف أسماء اللغات في حارس الحقائق (scripts/facts-langs.mjs ← verify-facts.mjs، القاعدة ui-languages).
 *
 * العطل الذي يمنعه: كان الحارس لا يعرف «Ingles» الفلبينية فعدّ جملة الواجهة الصحيحة في tl/ أربع لغات (٧ مواضع زائفة)،
 * فلم يكن ربطه بالبناء ممكناً. والشرط المقابل: لا يُضعف التعرّفُ الأوسع كشفَ التناقض الحقيقي.
 * الاختبار يقرأ السجل المنشور وملفات المحتوى الملتزمة نفسها التي يقرؤها الحارس والتصيير.
 */

const root = process.cwd();
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), 'utf8');
type Published = { locales: { code: string; intlLocale?: string; hreflang?: string }[] };
const published = JSON.parse(read('src/i18n/registry/published.json')) as Published;
const marketing = (code: string) => JSON.parse(read('src/i18n/marketing', `${code}.json`)) as {
  _derived?: { uiLanguages?: string };
  strings: Record<string, string>;
};
const locales = published.locales.map((l) => ({
  code: l.code,
  intl: l.intlLocale || l.hreflang || l.code,
  uiLanguages: marketing(l.code)._derived?.uiLanguages || '',
}));
const det = createLangDetector(locales);
const FIVE = 'ar,en,fr,tr,zh';
const langs = (s: string, loc: string | null = null) => [...det.mentionedLangs(s, loc)].sort().join(',');

test('قائمة لغات الواجهة بكل لغة منشورة تُقرأ الخمس بالضبط (Intl وقائمة المحتوى نفسها)', () => {
  assert.ok(locales.length > 100, `السجل المنشور أقل من المتوقع: ${locales.length}`);
  const bad = locales.filter((l) => l.uiLanguages && langs(l.uiLanguages, l.code) !== FIVE)
    .map((l) => `${l.code}: «${l.uiLanguages}» ⇒ {${langs(l.uiLanguages, l.code)}}`);
  assert.deepEqual(bad, []);
});

test('لا موضع زائف في محتوى أي لغة منشورة (كل نصوص marketing/<code>.json بلغة صفحتها)', () => {
  const hits: string[] = [];
  for (const l of locales) {
    for (const [k, v] of Object.entries(marketing(l.code).strings)) {
      for (const h of det.languageClaims(v, l.code)) hits.push(`${l.code} ${k}: ${h.note} — «${h.match.slice(0, 120)}»`);
    }
  }
  assert.deepEqual(hits, []);
});

test('جملة tl الصحيحة لا تُدان، والناقصة بالفلبينية تُدان', () => {
  const ok = 'Available ang interface ng FieldSales app sa Arabic, Ingles, French, Turkish, at Chinese, at sa mga wikang ito lamang.';
  assert.equal(langs(ok, 'tl'), FIVE);
  assert.deepEqual(det.languageClaims(ok, 'tl'), []);
  // بلا أسماء tl كان «Ingles» غير معروف — العطل الأصلي
  assert.equal(langs(ok, null), 'ar,fr,tr,zh');
  assert.equal(det.languageClaims('Available ang interface ng FieldSales app sa Arabic, Ingles at French.', 'tl').length, 1);
});

test('التناقض الحقيقي يبقى مكشوفاً بكل لغة: ناقصة وزائدة و«فقط»', () => {
  // ناقصة — الإنجليزية العامة، والجملة العربية التي كانت في «عن المنصّة»
  assert.equal(det.languageClaims('The app is available in Arabic, English and French.', null).length, 1);
  assert.equal(det.languageClaims('الواجهة عربية أصلاً ومعها الإنجليزية والفرنسية، وللموقع صفحات تعريفية بالتركية والصينية.', null).length, 1);
  // ناقصة بالإسبانية: «árabe/inglés/francés» تُعرف في صفحات es/ وحدها
  if (det.has('es')) {
    assert.equal(det.languageClaims('La interfaz de la aplicación está disponible en árabe, inglés y francés.', 'es').length, 1);
    assert.deepEqual(det.languageClaims('La interfaz de la aplicación está disponible en árabe, inglés, francés, turco y chino.', 'es'), []);
  }
  // زائدة بالألمانية: «Spanisch» لغة سادسة تُكشف ولو ذُكرت الخمس
  if (det.has('de')) {
    assert.equal(det.languageClaims('Die App ist auf Arabisch, Englisch, Französisch, Türkisch, Chinesisch und Spanisch verfügbar.', 'de').length, 1);
  }
  // بعد جملة الخمس: البعض تفصيل يُعذر، و«فقط» واللغة الزائدة لا تُعذران
  const five = 'The app interface is available in Arabic, English, French, Turkish and Chinese.';
  assert.deepEqual(det.languageClaims(`${five} There is no Pulaar interface, but French and English are among them.`, null), []);
  assert.equal(det.languageClaims(`${five} The rep app runs only in Arabic and English.`, null).length, 1);
  assert.equal(det.languageClaims(`${five} The app also runs in Spanish and English.`, null).length, 1);
});

/**
 * بعضُ الخمس بعد جملتها يُعذر تفصيلاً بشرط نفي أو استدراك أو تضمين صريح في عبارته (١١ نوفمبر ٢٠٢٦): كان يُعذر بلا شرط،
 * فمرّت «ولوحة الإدارة متاحة بالعربية والإنجليزية» بعد جملة الخمس وهي قائمة ناقصة.
 */
test('التفصيل بعد جملة الخمس يُعذر بنفي أو استدراك أو تضمين وحده، والقائمة الناقصة بعدها تُدان', () => {
  const ar5 = 'تطبيقات FieldSales بالعربية والإنجليزية والفرنسية والتركية والصينية.';
  // تُدان: لا نفي ولا استدراك ولا تضمين
  assert.equal(det.languageClaims(`${ar5} ولوحة الإدارة متاحة بالعربية والإنجليزية.`, null).length, 1);
  assert.equal(det.languageClaims('The app interface is available in Arabic, English, French, Turkish and Chinese. The admin panel is available in Arabic and English.', null).length, 1);
  // الحصر («لا … إلا») لا يعذره نفيه
  assert.equal(det.languageClaims(`${ar5} ولا تعمل لوحة الإدارة إلا بالعربية والإنجليزية.`, null).length, 1);
  // تمرّ: نفي وتضمين صريح
  assert.deepEqual(det.languageClaims(`${ar5} ولا واجهة بالفولانية، والفرنسية والإنجليزية منها.`, null), []);
  // صيغة المحتوى المنشور نفسها (ff: tierB.home.faq.4.a): «alaa» نفي و«kono» استدراك و«e majje» تضمين
  if (det.has('ff')) {
    const ff = marketing('ff').strings['tierB.home.faq.4.a'];
    assert.match(ff, /kono Farayseere e Engeleere ina e majje/);
    assert.deepEqual(det.languageClaims(ff, 'ff'), []);
    assert.equal(det.languageClaims('Interface application FieldSales ina heɓoo e Aarabeere, Engeleere, Farayseere, Turkeere e Siineere. Interface hooreeɓe ina heɓoo e Farayseere e Engeleere.', 'ff').length, 1);
  }
});

/**
 * قيد الصفة على الأسماء المحلية (١١ نوفمبر ٢٠٢٦): «arabe» في fr/ اسم محلي من Intl، وكان يُعدّ لغةً في «monde arabe»
 * فيكمّل جملةً أسقطت العربية خمساً فتمرّ. القيد نفسه للعامة والمحلية: بعد موصوف (الرومانسية والإندونيسية) أو قبله.
 */
test('قيد الصفة على الأسماء المحلية: «monde arabe» و«mundo árabe» و«dunia Arab» صفةٌ لا لغة', () => {
  const fr = 'L’application pour le monde arabe est disponible en anglais, français, turc et chinois.';
  assert.equal(langs(fr, 'fr'), 'en,fr,tr,zh');
  assert.equal(det.languageClaims(fr, 'fr').length, 1);
  assert.equal(det.languageClaims(fr, null).length, 1);
  assert.deepEqual(det.languageClaims('L’application est disponible en arabe, anglais, français, turc et chinois.', 'fr'), []);
  if (det.has('es')) {
    assert.equal(det.languageClaims('La aplicación para el mundo árabe está disponible en inglés, francés, turco y chino.', 'es').length, 1);
    assert.equal(langs('La Liga Árabe y el idioma árabe', 'es'), 'ar');
  }
  if (det.has('pt')) assert.equal(det.languageClaims('O app para a região árabe está disponível em inglês, francês, turco e chinês.', 'pt').length, 1);
  if (det.has('it')) assert.equal(det.languageClaims('L’app per il mondo arabo è disponibile in inglese, francese, turco e cinese.', 'it').length, 1);
  if (det.has('id')) {
    assert.equal(langs('Aplikasi untuk dunia Arab dan kantor di Riyadh, Arab Saudi', 'id'), '');
    assert.equal(det.languageClaims('App FieldSales untuk dunia Arab tersedia dalam bahasa Inggris, Prancis, Turki, dan Mandarin.', 'id').length, 1);
  }
});

test('الأسماء المحلية محصورة بصفحات لغتها: «angle» و«Arab» كلمتان عاديتان في نصّ إنجليزي', () => {
  const s = 'The app works from every angle in the United Arab Emirates and in English.';
  assert.equal(langs(s, null), 'en');
  assert.equal(langs(s, 'en'), 'en');
  assert.deepEqual(det.languageClaims(s, null), []);
});

test('تقسيم القوائم بصيغها المنشورة، ورمز لغة الصفحة من مسارها', () => {
  assert.deepEqual(splitUiLanguages('arab, angle, franse, tirk ek sinwa', 'mfe'), ['arab', 'angle', 'franse', 'tirk', 'sinwa']);
  assert.deepEqual(splitUiLanguages('阿拉伯语、英语、法语、土耳其语和中文', 'zh'), ['阿拉伯语', '英语', '法语', '土耳其语', '中文']);
  assert.deepEqual(splitUiLanguages("Icyarabu, Icyongereza, Igifaransa, Igiturukiya n'Igishinwa", 'rw'), ['Icyarabu', 'Icyongereza', 'Igifaransa', 'Igiturukiya', 'Igishinwa']);
  assert.deepEqual(splitUiLanguages('ภาษาอาหรับ อังกฤษ ฝรั่งเศส ตุรกี และจีน', 'th'), ['ภาษาอาหรับ', 'อังกฤษ', 'ฝรั่งเศส', 'ตุรกี', 'จีน']);
  assert.equal(splitUiLanguages('Arabic and English', 'en'), null);
  // ICU يعيد الرمز لاسم لا يعرفه: لا يصير «tr» اسماً يطابق كل «tr»
  const names = localeLangNames('gaa', '');
  assert.ok(!names.tr.includes('tr') && !names.zh.includes('zh'));
  assert.equal(docLocale('tl/about/index.html', det), 'tl');
  assert.equal(docLocale('es/llms.txt', det), det.has('es') ? 'es' : null);
  assert.equal(docLocale('rep-app/index.html', det), null);
  assert.equal(docLocale('index.html', det), null);
});
