import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RULES, GLOSSARY_AVOID, GLOSSARY_PATHS, FIELD_SEP, checkGlossary, checkText, findViolation, pageHead, pageKeywords, ruleHaystack, trFold,
} from '../../scripts/claims-rules.mjs';
import { listArticles } from '../blog/seo/catalog.mjs';

/**
 * قواميس المصطلحات (src/i18n/glossary) وقاعدتها في حارس الادّعاءات — بند ٢٢ في خطة SEO.
 * الكلمة التي تنقلب نيّتها لا تُستهدف منفردة في صفحات لغتها، وتمرّ مركّبة أو في سياقها (unlessWith).
 * حارسٌ لا يعضّ ينجح كاذباً، وحارسٌ يعضّ المصطلح المعتمد يُعطَّل — فيُختبر الطرفان.
 */

const LANGS = ['ar', 'en', 'fr', 'tr', 'zh'] as const;
type Glossary = {
  code: string; categoryTerms: string[]; preferred: Record<string, string>;
  avoid: { term: string; why: string; unlessWith?: string[]; scope?: string }[];
  keep: string[]; notes: string; sources: string[];
};
const load = (c: string): Glossary => JSON.parse(readFileSync(new URL(`./glossary/${c}.json`, import.meta.url), 'utf8'));

test('القواميس الخمسة بالشكل نفسه، وكتلة الحارس في claims-rules.mjs مطابقة لها حرفياً', () => {
  for (const c of LANGS) {
    const g = load(c);
    assert.deepEqual(Object.keys(g), ['code', 'categoryTerms', 'preferred', 'avoid', 'keep', 'notes', 'sources'], c);
    assert.equal(g.code, c);
    assert.ok(g.categoryTerms.length >= 10 && g.avoid.length >= 3 && g.keep.includes('FieldSales') && g.sources.length, c);
    for (const a of g.avoid) {
      assert.ok(a.term.trim() && a.why.trim(), `${c}: بند بلا كلمة أو سبب`);
      assert.ok(Object.keys(a).every((k) => ['term', 'why', 'unlessWith', 'scope'].includes(k)), `${c}: حقل غريب في «${a.term}»`);
      assert.ok(a.scope === undefined || ['head', 'text', 'alone'].includes(a.scope), `${c}: scope «${a.scope}»`);
      assert.ok(!(a.scope === 'alone' && a.unlessWith), `${c}: alone بلا سياق — «${a.term}»`);
      assert.ok(a.unlessWith === undefined || (a.unlessWith.length && a.unlessWith.every((w) => typeof w === 'string' && w.trim())), c);
    }
    assert.deepEqual(GLOSSARY_AVOID[c], g.avoid, `${c}: الكتلة قديمة — شغّل node scripts/gen-glossary-guard.mjs`);
    // المصطلح المعتمد للفئة لا يعضّه حارس لغته
    assert.deepEqual(checkGlossary(g.preferred.category, c), [], `${c}: «${g.preferred.category}»`);
  }
});

test('قاعدة لكل كلمة: حاجبة لنصوص المستودع وتحذير لنصوص CMS، مقصورة على صفحات لغتها، وتفحص الكلمات المفتاحية', () => {
  const rules = RULES.filter((r) => r.glossary);
  assert.equal(rules.length, LANGS.reduce((n, c) => n + load(c).avoid.length, 0));
  assert.equal(new Set(RULES.map((r) => r.id)).size, RULES.length, 'معرّفات مكرّرة');
  for (const r of rules) {
    assert.equal(r.severity, undefined, r.id);
    assert.equal(r.cmsWarn, true, r.id);
    assert.equal(r.keywords, true, r.id);
    assert.equal(r.paths, GLOSSARY_PATHS[r.glossary!], r.id);
  }
  const P = GLOSSARY_PATHS;
  // العربية في الجذر: كل مسار لا يبدأ بمجلد لغة — والمقاطع المحجوزة بشكل رمز (og · rep-app) صفحات عربية
  for (const p of ['index.html', 'llms.txt', 'blog\\cashvan-vs-presales\\index.html', 'rep-app/index.html', '%D9%85%D8%B2/index.html']) assert.ok(P.ar.test(p), p);
  for (const p of ['en/index.html', 'fr\\blog\\x\\index.html', 'zh-hant/index.html', 'es/index.html', 'ckb/index.html']) assert.ok(!P.ar.test(p), p);
  assert.ok(P.en.test('en\\about\\index.html') && !P.en.test('index.html') && !P.en.test('es/index.html'));
  assert.ok(P.zh.test('zh/index.html') && !P.zh.test('zh-hant/index.html'));
});

test('الكلمة المنفردة تُكشف، والمركّبة أو التي في سياقها تمرّ', () => {
  const hits: [string, string][] = [
    ['ar', 'كاش فان, أفضل الممارسات, مخزون سيارة'],
    ['en', 'Van Sales Best Practices | FieldSales'],
    ['en', 'Van Sales Reps | Jobs in Accra'],
    ['en', 'order booker, delivery app, salesman GPS tracking'],
    ['fr', 'Prévendeurs : offres d’emploi à Alger'],
    ['tr', 'Plasiyer | İş ilanları'],
    ['ar', 'مندوب مبيعات, تحصيل'],
    ['en', 'distributor management system Kenya, DMS, distribution network'],
    ['fr', 'Bonnes pratiques de la vente en camion | FieldSales'],
    ['fr', 'Billets : vente en tournée des concerts'],
    // الفاصلة تقطع السياق: «application» في بند سابق لا تُعفي البند التالي
    ['fr', 'application de vente terrain Maroc, vente en camion Maroc, stock véhicule'],
    ['fr', 'Une application van sales hors ligne'],
    ['tr', 'İkinci el araç satışı'],
    ['tr', 'Sıcak satış teknikleri'],
    ['zh', '车销 二手车'],
    ['zh', '我们的预售活动'],
    ['zh', 'ZATCA 电子发票 增值税发票 收款管理'],
  ];
  for (const [c, t] of hits) assert.ok(checkGlossary(t, c).length, `${c}: مرّت «${t}»`);
  const passes: [string, string][] = [
    ['ar', 'تطبيق مندوب مبيعات للشركات'],
    // نيّة الوظائف تنقلب حين تكون الكلمة هي المقطع كله، لا داخل عبارة إدارة
    ['ar', 'صلاحيات مندوب المبيعات, سقف الخصم'],
    ['en', 'ZATCA E-Invoicing for Van Sales Reps: QR Invoices'],
    ['tr', 'Saha satış ekibiniz için teklif alın. Plasiyerlerinizi ve ihtiyaçlarınızı anlatın'],
    ['fr', 'Facturation hors ligne et impression thermique pour les commerciaux terrain'],
    ['ar', 'أفضل ممارسات الكاش فان لمناديب التوزيع'],
    ['ar', 'إدارة أسطول سيارات التوزيع'],
    ['en', 'Van Sales Software for Distributors | FieldSales'],
    ['en', 'A comparison of the cash van (van sales) model and pre-sales in distribution'],
    ['en', 'Distributor Management System (DMS) Software'],
    ['fr', 'Application de vente en camion (Van Sales)'],
    ['fr', "Qu'est-ce que la vente en camion (van sales) ?"],
    ['fr', 'Logiciel de vente en tournée pour distributeurs | FieldSales'],
    ['fr', 'Bonnes pratiques de la vente en tournée pour la distribution'],
    ['tr', 'Plasiyer Programı: Araçtan Sıcak Satış | FieldSales'],
    ['tr', 'Plasiyerler için internetsiz faturalama ve termal yazdırma'],
    ['tr', 'araçtan satış ve ön sipariş (soğuk satış)'],
    ['zh', '经销商车销管理软件 | FieldSales'],
    ['zh', '车销访销全链路'],
  ];
  for (const [c, t] of passes) assert.deepEqual(checkGlossary(t, c), [], `${c}: إنذار كاذب على «${t}»`);
  // قاموس لغة لا يعضّ لغة أخرى
  assert.deepEqual(checkGlossary('Van Sales Best Practices', 'fr'), []);
});

test('checkText لا يطبّق قواعد القاموس: «van sales» و«مندوب مبيعات» شرحاً في المتن صحيحتان', () => {
  assert.deepEqual(checkText('Van sales means the rep sells from stock carried in the van. يعمل مندوب مبيعات التوزيع بالسيارة.'), []);
});

test('التركية: İ/i وI/ı — العناوين بالأحرف الكبيرة لا تفلت (طيّ trFold قبل المطابقة، وأنماط iu)', () => {
  // toLocaleLowerCase('tr') بطول ثابت: الموضع لا ينزاح، والمطابقة المُعادة بنصّها الأصلي (إسناد CMS يبحث عنه كما كُتب)
  assert.equal(trFold('PLASİYER SICAK SATIŞ'), 'plasiyer sıcak satış');
  const plasiyer = RULES.find((r) => r.glossary === 'tr' && r.term === 'plasiyer')!;
  assert.deepEqual(findViolation(plasiyer, 'Xx | PLASİYER'), { index: 5, match: 'PLASİYER' });
  for (const r of RULES.filter((x) => x.glossary)) assert.equal(r.re.flags, 'iu', r.id);
  const hits = [
    'PLASİYER | İş ilanları',
    'PLASIYER | Is ilanlari', // I لاتينية بلا نقطة من لوحة غير تركية
    'SICAK SATIŞ TEKNİKLERİ',
    'Sicak satış teknikleri',
    'İKİNCİ EL ARAÇ SATIŞI',
    'ARAÇ TAKİP SİSTEMİ',
    'SATIŞ ÖNCESİ DESTEK',
  ];
  for (const t of hits) assert.ok(checkGlossary(t, 'tr').length, `tr: مرّت «${t}»`);
  for (const t of ['PLASİYER PROGRAMI: ARAÇTAN SICAK SATIŞ | FieldSales', 'PLASİYERLERİNİZİ VE İHTİYAÇLARINIZI ANLATIN', 'ARAÇTAN SATIŞ VE ÖN SİPARİŞ (SOĞUK SATIŞ)']) {
    assert.deepEqual(checkGlossary(t, 'tr'), [], `tr: إنذار كاذب على «${t}»`);
  }
});

test('العربية: التعريف والتنكير والإفراد والجمع لكلمات avoid', () => {
  for (const t of ['البيع من السيارات', 'بيع من سيارة', 'للبيع من السيارات المستعملة', 'تتبع المركبة', 'تتبع مركبات الشركة']) {
    assert.ok(checkGlossary(t, 'ar').length, `ar: مرّت «${t}»`);
  }
  for (const t of ['برنامج البيع من السيارات لمناديب التوزيع', 'تتبع مركبات التوزيع ومناديبها']) {
    assert.deepEqual(checkGlossary(t, 'ar'), [], `ar: إنذار كاذب على «${t}»`);
  }
});

test('رأس الصفحة في verify-claims: كل حقل وحده — لا يعبر السياق حقلاً، وآخر العنوان حدٌّ لنطاق alone', () => {
  const html = (title: string, desc: string, h1: string, kw?: string) => `<html><head><title>${title}</title>`
    + `<meta name="description" content="${desc}" />${kw == null ? '' : `<meta name="keywords" content="${kw}" />`}</head>`
    + `<body><main><h1>${h1}</h1><p>Corps de la page.</p></main></body></html>`;
  const hits = (code: string, raw: string) => {
    const page = { raw, text: 'Corps de la page.', head: pageHead(raw), kw: pageKeywords(raw) };
    return RULES.filter((r) => r.glossary === code && findViolation(r, ruleHaystack(r, page))).map((r) => r.term);
  };
  // الحقول في أسطر مستقلّة، بكياناتها مفكوكة ومسافاتها مطويّة
  assert.equal(pageHead(html('A &amp; B', 'Qu&#39;est-ce', '<span>X</span>\n  Y')), ['A & B', "Qu'est-ce", 'X Y'].join(FIELD_SEP));
  // alone: الكلمة آخر العنوان يليها الوصف — كانت تمرّ حين جُمع الرأس بمسافة
  assert.deepEqual(hits('tr', html('FieldSales | Plasiyer', 'Saha satış ekibiniz için program', 'Saha satış programı')), ['plasiyer']);
  assert.ok(hits('en', html('FieldSales | Van Sales Reps', 'Jobs in Accra and Tema', 'Careers')).includes('van sales rep'));
  // unlessWith: «application» آخر العنوان لا تُعفي «vente en camion» أول الوصف
  assert.deepEqual(hits('fr', html('Guide FieldSales — application', 'Vente en camion : les bonnes pratiques', 'Guide')), ['vente en camion']);
  // وداخل الحقل الواحد يبقى السياق: والكيان لا يقطعه («d&#39;» كانت فاصلتها المنقوطة حدّاً)
  assert.deepEqual(hits('fr', html('Logiciel d&#39;aide à la vente en camion | FieldSales', 'Factures et stock du véhicule', 'Logiciel')), []);
  // الكلمات المفتاحية تُفحص لقواعد الرأس وقواعد الصفحة كلها معاً، وبندها حقل مستقلّ
  assert.deepEqual(hits('fr', html('FieldSales', 'Logiciel de vente terrain', 'FieldSales', 'DSD Maroc, logiciel van sales Maroc')), ['logiciel van sales']);
  assert.deepEqual(hits('fr', html('FieldSales — application', 'Logiciel de vente terrain', 'FieldSales', 'vente en camion Maroc')), ['vente en camion']);
});

test('مقالات الكتالوج بلغاتها الثلاث: العنوان والوصف والكلمات المفتاحية (ومنها الذيل المشترك EXTRA_KW) تمرّ بقاموس لغتها', () => {
  for (const L of ['ar', 'en', 'fr'] as const) {
    const bad = listArticles(L)
      .map((a) => [a.slug, checkGlossary([a.title, a.description, a.keywords].join(FIELD_SEP), L)] as const)
      .filter(([, ids]) => ids.length)
      .map(([slug, ids]) => `${slug}: ${ids.join('، ')}`);
    assert.deepEqual(bad, [], L);
  }
  const en = listArticles('en').find((a) => a.slug === 'van-sales-best-practices')!;
  assert.equal(en.title, 'Van Sales Best Practices for Distributors');
});
