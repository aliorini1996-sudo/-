import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { checkText, checkGlossary } from '../../scripts/claims-rules.mjs';
import { availableLangs, routeLangs, pathForLocale, seoUrls } from '../i18n/locale';
import { isAdsTagRoute } from '../lib/adsRoutes';
import {
  AMBASSADORS_TEXT, AMBASSADORS_LANGS, AMBASSADORS_JOIN, AMBASSADORS_LOGIN, AMBASSADORS_PATH, ambassadorsJoinHref, ambassadorsLoginHref,
  ambassadorsJsonLd, ambassadorsStaticHtml, ambassadorsTextFor, type AmbText,
} from './ambassadorsText';
import AmbassadorsPage from './AmbassadorsPage';

/**
 * حرّاس الصفحة العلنية «سفراء فيلد سيلز» (V2_SPEC §9 — قرار المالك ١٨ نوفمبر ٢٠٢٦: صفحة علنية مفهرسة بثلاث لغات
 * ورابط في تذييل الرئيسية، والبوابة نفسها تبقى غير مُدرجة). الملفات تُقرأ نصّاً من web-admin/ (cwd لـnpm test).
 */
const read = (...p: string[]) => fs.readFileSync(path.join(process.cwd(), ...p), 'utf8');
/** مسار البوابة مساراً لا جزءاً من كلمة (/axis) — كما في affiliate/hiding.test.ts */
const AX_PATH = /\/ax(?![A-Za-z0-9_-])/;

/** كل النصوص الظاهرة للغة واحدة سطراً لكل قيمة */
function allStrings(t: AmbText): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(t);
  return out;
}

test('النصوص بثلاث لغات وبالشكل نفسه: ٣ خطوات و٣ أسباب و٦ أدوات و٤ فئات وأسئلة شائعة، بلا حقل فارغ', () => {
  assert.deepEqual([...AMBASSADORS_LANGS], ['ar', 'en', 'fr']);
  for (const L of AMBASSADORS_LANGS) {
    const t = AMBASSADORS_TEXT[L];
    assert.equal(t.steps.length, 3, `${L}: الخطوات`);
    assert.equal(t.why.length, 3, `${L}: لماذا`);
    assert.equal(t.tools.length, 6, `${L}: الأدوات`);
    assert.equal(t.who.length, 4, `${L}: لمن`);
    assert.equal(t.stats.length, 3, `${L}: الأرقام`);
    assert.equal(t.card.steps.length, 3, `${L}: خطوات البطاقة`);
    assert.ok(t.faq.length >= 6, `${L}: الأسئلة`);
    assert.equal(t.faq.length, AMBASSADORS_TEXT.ar.faq.length, `${L}: عدد الأسئلة يخالف العربية`);
    assert.ok(t.h1.includes(t.h1Accent), `${L}: الجزء المرجاني ليس داخل H1`);
    for (const s of allStrings(t)) assert.ok(s.trim(), `${L}: نصّ فارغ`);
    // لا عربية في الإنجليزية والفرنسية
    if (L !== 'ar') for (const s of allStrings(t)) assert.doesNotMatch(s, /[؀-ۿ]/, `${L}: نصّ عربي متسرّب «${s}»`);
  }
  // لغة الواجهة خارج الثلاث (tr/zh) تسقط إلى الإنجليزية
  assert.equal(ambassadorsTextFor('zh').h1, AMBASSADORS_TEXT.en.h1);
  assert.equal(ambassadorsTextFor('ar').h1, AMBASSADORS_TEXT.ar.h1);
});

test('المحتوى كما قرّره المالك: ٣٠٪ من أول دفعة، حجز ١٠ أيام وتسوية كل ١٠ أيام، انضمام فوري، و«انضم الآن»', () => {
  const ar = allStrings(AMBASSADORS_TEXT.ar).join('\n');
  assert.match(AMBASSADORS_TEXT.ar.h1, /٣٠٪ من أول دفعة لكل شركة تحيلها/);
  assert.match(ar, /تُحجز ١٠ أيام ثم تُسوّى في دورة تسوية كل ١٠ أيام/);
  assert.match(ar, /بلا انتظار موافقة/);
  assert.match(ar, /ولو كانت اشتراكاً سنوياً/);
  assert.equal(AMBASSADORS_TEXT.ar.cta, 'انضم الآن');
  for (const w of ['الأفراد', 'الشركات', 'المؤثرون', 'الوكالات']) assert.ok(AMBASSADORS_TEXT.ar.who.some((x) => x.t === w), w);
  for (const tool of ['رابط', 'ترشيح', 'حساب تجريبي', 'مواد تسويقية', 'الجوال', 'خمس لغات']) {
    assert.ok(AMBASSADORS_TEXT.ar.tools.some((x) => x.t.includes(tool)), `أداة غائبة: ${tool}`);
  }
  const en = allStrings(AMBASSADORS_TEXT.en).join('\n');
  assert.match(en, /30% of the first/);
  assert.match(en, /every 10 days/);
  const fr = allStrings(AMBASSADORS_TEXT.fr).join('\n');
  assert.match(fr, /30 % du premier paiement/);
  assert.match(fr, /tous les 10 jours/);
  // المصطلح: «ترشيح» للترشيح المسبق — Nomination بالإنجليزية وRecommandation بالفرنسية كما في قاموس البوابة
  assert.match(en, /nominat/i);
  assert.match(fr, /recommand/i);
});

test('حرّاس البناء على النصوص: لا مبلغ بعملة، ولا ادّعاء محظور، ولا مصطلح متجنَّب، ولا «الأسواق العربية»، ولا مسار البوابة', () => {
  // verify-pricing: رقمٌ يليه ر.س أو ريال أو ﷼ أو SAR — «حدّ أدنى بسيط» بلا رقم
  const PRICED = /[\d٠-٩][\d٠-٩,.٬]*\s*(?:ر\.?\s?س|﷼|ريال|SAR\b)|\bSAR\s*[\d٠-٩]|\b(?:SR|SAR|USD|\$)\s?\d/i;
  for (const L of AMBASSADORS_LANGS) {
    const strings = allStrings(AMBASSADORS_TEXT[L]);
    const text = strings.join('\n');
    assert.doesNotMatch(text, PRICED, `${L}: مبلغ بعملة`);
    assert.deepEqual(checkText(text), [], `${L}: حارس الادّعاءات`);
    assert.deepEqual(checkGlossary(text, L), [], `${L}: قاموس المصطلحات`);
    assert.doesNotMatch(text, AX_PATH, `${L}: مسار البوابة في نصوص الصفحة`);
    assert.doesNotMatch(text, /ركاز|rekaz/i, `${L}: اسم منافس`);
    assert.doesNotMatch(text, /اشترك\s*الآن|subscribe\s*now|abonnez-vous/i, `${L}: «اشترك الآن»`);
    assert.doesNotMatch(text, /أعلى\s*نسبة|highest\s+(?:rate|commission)|meilleure?\s+(?:commission|taux)/i, `${L}: ادّعاء غير موثّق`);
  }
  for (const L of ['en', 'fr'] as const) {
    const t = AMBASSADORS_TEXT[L];
    assert.doesNotMatch(`${t.seoTitle} ${t.seoDesc} ${t.h1}`, /\bArab\s+(?:markets?|world)\b|march[ée]s\s+arabes?|monde\s+arabe/i, `${L}: حصر عربي في الرأس`);
  }
});

test('الجسم المُصيَّر وFAQPage من المصدر نفسه: كل سؤال ظاهر، والأزرار إلى مساري التحويل وحدهما', () => {
  for (const L of AMBASSADORS_LANGS) {
    const t = AMBASSADORS_TEXT[L];
    const html = ambassadorsStaticHtml(L);
    assert.ok(html.startsWith('<main>') && html.endsWith('</main>'), `${L}: غلاف main`);
    assert.equal((html.match(/<h1>/g) || []).length, 1, `${L}: H1 واحد`);
    assert.ok(html.includes(`<h1>${t.h1}</h1>`), `${L}: H1 لا يطابق نصّ React`);
    assert.ok(html.includes(`href="${ambassadorsJoinHref(L)}"`) && html.includes(`href="${ambassadorsLoginHref(L)}"`), `${L}: الأزرار بلغة الصفحة`);
    assert.doesNotMatch(html, AX_PATH, `${L}: مسار البوابة في الجسم المُصيَّر`);
    const ld = ambassadorsJsonLd(L) as { '@type': string; mainEntity: { name: string; acceptedAnswer: { text: string } }[] };
    assert.equal(ld['@type'], 'FAQPage');
    assert.equal(ld.mainEntity.length, t.faq.length);
    // verify-schema البند ٤: نصّ كل سؤال يظهر في الجسم (بعد فكّ الكيانات)
    const plain = html.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    for (const q of ld.mainEntity) {
      assert.ok(plain.includes(q.name), `${L}: سؤال FAQPage غائب عن الجسم «${q.name}»`);
      assert.ok(plain.includes(q.acceptedAnswer.text), `${L}: جواب غائب عن الجسم`);
    }
    // روابط النسخ الأخرى بشرطة أخيرة (صفحات مُصيَّرة مجلّدات)
    for (const o of AMBASSADORS_LANGS.filter((x) => x !== L)) {
      assert.ok(html.includes(`href="${o === 'ar' ? '' : `/${o}`}${AMBASSADORS_PATH}/"`), `${L}: رابط النسخة ${o}`);
    }
  }
});

test('المكوّن يُرسم بلغة مساره من المصدر نفسه، وأزراره إلى مساري التحويل، وبلا مسار البوابة', () => {
  for (const [p, L] of [['/ambassadors', 'ar'], ['/en/ambassadors', 'en'], ['/fr/ambassadors', 'fr']] as const) {
    const html = renderToStaticMarkup(createElement(StaticRouter, { location: p }, createElement(AmbassadorsPage)));
    const t = AMBASSADORS_TEXT[L];
    assert.match(html, new RegExp(`dir="${L === 'ar' ? 'rtl' : 'ltr'}"`), `${p}: الاتجاه`);
    assert.ok(html.includes(t.h1Accent) && html.includes(t.stepsTitle) && html.includes(t.faq[0].q), `${p}: النصوص`);
    assert.ok(html.includes(`href="${ambassadorsJoinHref(L).replace(/&/g, '&amp;')}"`), `${p}: زرّ الانضمام`);
    assert.ok(html.includes(`href="${ambassadorsLoginHref(L)}"`), `${p}: زرّ الدخول`);
    assert.doesNotMatch(html, AX_PATH, `${p}: مسار البوابة في الصفحة`);
    assert.equal((html.match(/<h1\b/g) || []).length, 1, `${p}: H1 واحد`);
  }
  // المصدر الواحد: العنوان والوصف من ملف النصوص، ولا نصوص مكتوبة في المكوّن
  const src = read('src', 'pages', 'AmbassadorsPage.tsx');
  assert.match(src, /title: t\.seoTitle, description: t\.seoDesc, keywords: t\.keywords/);
  assert.match(src, /jsonLd: ambassadorsJsonLd\(L\)/);
  assert.match(src, /seoUrls\(AMBASSADORS_PATH, L\)/);
  assert.doesNotMatch(src, AX_PATH, 'المكوّن يذكر مسار البوابة');
});

test('prerender يكتب الصفحة من ملف النصوص نفسه (لا نسخة ثانية) وبعنقود ثلاثي', () => {
  const pre = read('scripts', 'prerender.mjs');
  assert.match(pre, /await loadTs\('pages\/ambassadorsText\.ts'\)/);
  assert.match(pre, /title: t\.seoTitle, description: t\.seoDesc, keywords: t\.keywords/);
  assert.match(pre, /jsonLd: amb\.ambassadorsJsonLd\(L\)/);
  assert.match(pre, /bodyHtml: amb\.ambassadorsStaticHtml\(L\)/);
  assert.match(pre, /trilingualHreflang\(amb\.AMBASSADORS_PATH\)/);
  assert.equal(pre.match(AX_PATH), null, 'prerender.mjs يذكر مسار البوابة');
  // ملف النصوص بلا استيراد: loadTs يحوّله ويستورده وحده
  assert.doesNotMatch(read('src', 'pages', 'ambassadorsText.ts'), /^\s*import\s/m, 'ambassadorsText.ts يستورد — يكسر loadTs');
});

test('المسارات: ثلاث صفحات وتحويلان استبدالاً إلى البوابة، وLocaleSync لا يشتقّ لغة من مساري التحويل', () => {
  const app = read('src', 'App.tsx');
  for (const p of ['/ambassadors', '/en/ambassadors', '/fr/ambassadors']) {
    assert.ok(app.includes(`<Route path="${p}" element={<AmbassadorsPage />} />`), p);
  }
  assert.ok(app.includes('<Route path="/ambassadors/join" element={<Navigate to="/ax?view=register" replace />} />'), 'تحويل الانضمام');
  assert.ok(app.includes('<Route path="/ambassadors/login" element={<Navigate to="/ax" replace />} />'), 'تحويل الدخول');
  assert.doesNotMatch(app, /path="\/(?:tr|zh)\/ambassadors"/, 'لا نسخة تركية ولا صينية');
  const sync = app.match(/function LocaleSync\(\)[\s\S]*?\n\}/);
  assert.ok(sync);
  const m = sync![0].match(/if \((\/\^\\\/ambassadors[^\n]*?\/)\.test\(pathname\)\) return;/);
  assert.ok(m, 'LocaleSync لا يتخطّى مساري التحويل');
  const rx = new RegExp(m![1].slice(1, -1));
  for (const p of ['/ambassadors/join', '/ambassadors/login', '/ambassadors/join/']) assert.equal(rx.test(p), true, p);
  for (const p of ['/ambassadors', '/en/ambassadors', '/ambassadors/joinx']) assert.equal(rx.test(p), false, p);
});

test('التوطين والوسم الإعلاني: الصفحة ثلاثية، x-default إنجليزية، ومن tr/zh إلى الإنجليزية؛ والوسم عليها لا على التحويلين', () => {
  assert.deepEqual([...availableLangs('/ambassadors/')], ['ar', 'en', 'fr']);
  assert.deepEqual([...routeLangs('/ambassadors')], ['ar', 'en', 'fr']);
  assert.equal(pathForLocale('/ambassadors', 'tr'), '/en/ambassadors');
  assert.equal(pathForLocale('/en/ambassadors', 'fr'), '/fr/ambassadors');
  const s = seoUrls('/ambassadors', 'fr');
  assert.equal(s.canonical, 'https://fieldsa.net/fr/ambassadors');
  assert.deepEqual(s.alternates.map((a) => a.hreflang), ['ar', 'en', 'fr', 'x-default']);
  assert.equal(s.alternates[s.alternates.length - 1].href, 'https://fieldsa.net/en/ambassadors');
  for (const p of ['/ambassadors', '/en/ambassadors/', '/fr/ambassadors']) assert.equal(isAdsTagRoute(p), true, p);
  for (const p of ['/ambassadors/join', '/ambassadors/login']) assert.equal(isAdsTagRoute(p), false, p);
});

test('رابط التذييل: «سفراء فيلد سيلز» في عمود «الشركة» بقالب الهبوط، مترجماً للغات الأربع وموطَّن المسار', async () => {
  const { LANDING_TEMPLATE } = await import('../landing/landingTemplate');
  const col = LANDING_TEMPLATE.match(/>الشركة<\/div>\s*<div[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(col, 'عمود «الشركة» غير موجود');
  assert.ok(col![1].includes('<a href="/ambassadors">سفراء فيلد سيلز</a>'), 'الرابط ليس في عمود «الشركة»');
  const land = read('src', 'pages', 'LandingPage.tsx');
  for (const name of ['CHROME_EN', 'CHROME_FR', 'CHROME_TR', 'CHROME_ZH']) {
    const block = land.slice(land.indexOf(`const ${name}`), land.indexOf('];', land.indexOf(`const ${name}`)));
    assert.match(block, /\['>سفراء فيلد سيلز<', '>[^'<]+<'\]/, `${name} بلا ترجمة الرابط`);
  }
  const lp = land.match(/const LOCALIZED_PATHS = \[([^\]]*)\]/);
  assert.ok(lp && lp[1].includes("'/ambassadors'"), 'LOCALIZED_PATHS بلا /ambassadors');
});

test('الخريطة وllms والحرّاس: الصفحة بلغاتها الثلاث في الخريطة الملتزمة وllms، ومسارا التحويل مساران تطبيقيان', () => {
  const gen = read('scripts', 'gen-sitemap.mjs');
  assert.match(gen, /\{ p: '\/ambassadors', priority: '[\d.]+', freq: '\w+', lastmod: '2026-11-18' \}/);
  assert.doesNotMatch(gen.match(/const FIVE_LANG = new Set\(\[[^\]]*\]\)/)![0], /ambassadors/, 'الصفحة ليست خماسية');
  const sm = read('public', 'sitemap-legacy.xml');
  for (const u of ['https://fieldsa.net/ambassadors/', 'https://fieldsa.net/en/ambassadors/', 'https://fieldsa.net/fr/ambassadors/']) {
    assert.ok(sm.includes(`<loc>${u}</loc>`), `الخريطة بلا ${u}`);
    assert.ok(sm.includes(`href="${u}"`), `بدائل الخريطة بلا ${u}`);
  }
  assert.ok(!/fieldsa\.net\/(?:tr|zh)\/ambassadors/.test(sm), 'لا نسخة تركية ولا صينية في الخريطة');
  const llms = read('public', 'llms.txt');
  assert.ok(llms.includes('https://fieldsa.net/ambassadors/') && llms.includes('https://fieldsa.net/en/ambassadors/'), 'llms.txt بلا الصفحة');
  assert.ok(read('public', 'llms-full.txt').includes('https://fieldsa.net/ambassadors/'), 'llms-full.txt بلا الصفحة');
  // verify-sitemap: الرابط إلى مساري التحويل من صفحة مُصيَّرة مشروع (لا صفحة لهما عمداً)
  const vs = read('scripts', 'verify-sitemap.mjs');
  const rx = vs.match(/(\/\^\\\/ambassadors[^\n]*\/),/);
  assert.ok(rx, 'APP_ROUTES بلا مساري التحويل');
  const re = new RegExp(rx![1].slice(1, -1));
  for (const p of ['/ambassadors/join', '/ambassadors/login/']) assert.equal(re.test(p), true, p);
  assert.equal(re.test('/ambassadors/'), false, 'الصفحة نفسها ليست مسار تطبيق — غيابها عطل يُكشف');
});
