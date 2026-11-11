/**
 * صفحات الدول في الطبقة متعددة اللغات (نوع «country») — اشتقاق فهرسها من ملفات المستودع، مشتركٌ بين المستورد
 * (import-country-i18n.mjs يكتبه) والحارس (verify-i18n.mjs G0 يعيد اشتقاقه ويقارن) والاختبارات.
 *
 * المدخلات نسخ حرفية من مصنع المحتوى، لا تُحرَّر في المستودع (فرع آخر ينسخ الملفات نفسها حرفياً):
 *   src/content/country-facts/<CC>.json  — حقائق الدولة المدقّقة (audit = اكتمل التدقيق)
 *   src/content/country-pages/<CC>.json  — محتوى الصفحة المراجَع (review.quality: publish | publish-with-notes)
 * المخرج: src/i18n/registry/country-pages.json — { pages: [مدخل لكل صفحة منشورة], excluded: [ما استُثني وسببه] }،
 *   وsrc/i18n/registry/country-content/<CC>.<code>.json لكل صفحة منشورة (مجرّد: ما يقرؤه القالب وحده) — هو وحده ما
 *   يصل إلى المتصفح ويُصيَّر؛ src/content لا يدخل حزمة المتصفح أبداً (فيه notes وreview والدول المستثناة).
 *
 * الدولة تُستثنى (ولا يُضعف حارس لأجلها) إن: غاب ملفها أو حقائقها، أو لم يكتمل تدقيق الحقائق، أو لم تُجز المراجعة،
 * أو غابت لغة سوقها، أو بُنيت الصفحة على حقائق غير المدقّقة (basedOnFactsVerifiedAt ≠ verifiedAt)، أو نقص شكلها، أو
 * لم يصلح slug أو صادم صفحة أخرى، أو لم تُنشر لغتها بصفحة الدول، أو خالف نصّها قاعدة من قواعد الحارس نفسها
 * (claims-i18n: الاعتماد، والسنة أو التاريخ في جملة عن FieldSales (والسنة كلها في H1)، والسعر الحيّ، ورقم+عملة،
 * وادّعاء الربط الحكومي · claims-rules · لغة النص).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import {
  countrySlug, pagePath, BASE_PAGES, TIER_A_PAGES, DEFAULT_CATEGORY_SLUG,
  ORIGIN, canon, clusterAlternates, countryEntryOf, countryOfPageKey,
} from '../src/i18n/i18nRoutes.mjs';
import { COUNTRY_SECTION_IDS } from '../src/i18n/marketingTemplate.mjs';
import {
  checkCountryContent, countryContentTexts, scriptProblems, findI18nViolations, selfYearViolations, govLinkViolations,
  stampProblem, hasCountryClaimRules,
} from './claims-i18n.mjs';
import { RULES, findViolation } from './claims-rules.mjs';
import {
  headOf, mainOf, canonicalOf, alternatesOf, titleOf, metaContent, removeElements, stripTags, blockTexts, ldBlocks,
  RE_LANGS_NAV, RE_COUNTRIES,
} from './html-scan.mjs';

/** الدول المستهدفة ولغة صفحة كلٍّ منها (بترتيب الفهرس والقوائم) */
export const COUNTRY_TARGETS = Object.freeze({ MX: 'es', CO: 'es', BR: 'pt', ID: 'id' });
export const COUNTRY_PAGES_DIR = 'src/content/country-pages';
export const COUNTRY_FACTS_DIR = 'src/content/country-facts';
export const COUNTRY_INDEX_FILE = 'src/i18n/registry/country-pages.json';
export const COUNTRY_QUALITY_OK = Object.freeze(['publish', 'publish-with-notes']);
/**
 * ملفات المحتوى المشتقة المجرّدة — واحد لكل صفحة منشورة (<CC>.<code>.json): ما يقرؤه القالب وحده (code ·
 * basedOnFactsVerifiedAt · content[code] بحقوله المعروفة). هي وحدها ما يصل إلى حزمة المتصفح (import.meta.glob في
 * I18nMarketingPage.tsx) وما يصيّره prerender وgen-llms-i18n؛ أما src/content (notes وreview وتدقيق الحقائق والدول
 * المستثناة) فلا يدخل المتصفح أبداً. يكتبها المستورد، والحارس يعيد اشتقاقها (G0) ويفحص dist/assets (G-assets).
 */
export const COUNTRY_CONTENT_DIR = 'src/i18n/registry/country-content';
export const countryContentRel = (cc, code) => `${COUNTRY_CONTENT_DIR}/${cc}.${code}.json`;

const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o ?? null)).digest('hex');
const str = (v) => typeof v === 'string' && v.trim().length > 0;

/** هل ملف الحقائق مدقّق (حقل audit كائن غير فارغ) */
export const factsAudited = (facts) => !!(facts && facts.audit && typeof facts.audit === 'object' && Object.keys(facts.audit).length);
/** جودة مراجعة الصفحة */
export const reviewQuality = (page) => (page && page.review && typeof page.review === 'object' ? page.review.quality ?? null : null);

/** مشكلات شكل محتوى لغة واحدة (فارغة = سليم) — ما يحتاجه القالب ليصيّر بلا رمي */
export function countryShapeProblems(c) {
  const p = [];
  if (!c || typeof c !== 'object') return ['المحتوى غائب'];
  for (const k of ['title', 'description', 'h1', 'intro', 'lastVerifiedLabel']) if (!str(c[k])) p.push(`${k} فارغ`);
  const ids = (Array.isArray(c.sections) ? c.sections : []).map((s) => s && s.id).join(',');
  if (ids !== COUNTRY_SECTION_IDS.join(',')) p.push(`الأقسام «${ids}» لا «${COUNTRY_SECTION_IDS.join(',')}»`);
  for (const s of Array.isArray(c.sections) ? c.sections : []) if (!str(s && s.title) || !str(s && s.body)) p.push(`القسم ${s && s.id} بلا عنوان أو نصّ`);
  const faq = Array.isArray(c.faq) ? c.faq : [];
  if (faq.length < 1) p.push('لا أسئلة');
  faq.forEach((f, i) => { if (!str(f && f.q) || !str(f && f.a)) p.push(`السؤال ${i} ناقص`); });
  const si = c.sampleInvoice || {};
  if (!str(si.title)) p.push('sampleInvoice.title فارغ');
  const fields = Array.isArray(si.fields) ? si.fields : [];
  if (!fields.length) p.push('sampleInvoice.fields فارغة');
  fields.forEach((f, i) => { if (!str(f && f.label) || !str(f && f.example)) p.push(`حقل الفاتورة ${i} ناقص`); });
  const src = Array.isArray(c.sources) ? c.sources : [];
  if (!src.some((s) => s && /^https:\/\//.test(String(s.url || '')))) p.push('لا مصدر https');
  for (const s of src) if (s && s.url && !/^https?:\/\//.test(String(s.url))) p.push(`رابط مصدر غير صالح «${String(s.url).slice(0, 40)}»`);
  for (const t of countryContentTexts(c)) if (/[<>]/.test(t.text)) p.push(`وسم HTML في ${t.path}`);
  return p;
}

/**
 * مخالفات نصّ صفحة الدولة لقواعد الحارس قبل التصيير — الحارس يعيدها على dist (G4/G5).
 * opts: { code, livePrices, verifiedAt, script }.
 */
export function countryContentViolations(c, opts = {}) {
  const out = [];
  for (const v of checkCountryContent(c, { code: opts.code, livePrices: opts.livePrices, verifiedAt: opts.verifiedAt })) {
    out.push(`${v.id} (${v.path}): «${v.match}»`);
  }
  const texts = countryContentTexts(c);
  const all = texts.map((t) => t.text).join(' . ');
  const head = [c.title, c.description, c.h1].filter(str).join(' ');
  const raw = `${all} ${(Array.isArray(c.sources) ? c.sources : []).map((s) => (s && s.url) || '').join(' ')}`;
  for (const rule of RULES) {
    if (rule.paths && !rule.paths.test(`${opts.code}/x`)) continue;
    if (rule.severity === 'warn' && rule.id !== 'zatca-phase2-stale-denial') continue;
    const hay = rule.scope === 'head' ? head : rule.scope === 'raw' ? raw : all;
    const v = findViolation(rule, hay);
    if (v) out.push(`claims ${rule.id}: «${v.match.slice(0, 60)}»`);
  }
  // لغة النص كما يفحصها G4: النصّ الظاهر بلا روابط (عناوين المصادر روابط) — والعنوان والوصف
  const visible = texts.filter((t) => !t.path.startsWith('sources.')).map((t) => t.text).join(' \n ');
  for (const p of scriptProblems(visible, { script: opts.script || 'Latn', code: opts.code })) out.push(`script: ${p}`);
  return out;
}

/** مقاطع صفحات اللغة الأخرى (أول مقطع بعد الرمز) — slug صفحة الدولة لا يساويها */
function takenSegments(loc) {
  const segs = new Set(['countries', 'about', 'contact', 'features', 'apps', 'quote', DEFAULT_CATEGORY_SLUG]);
  for (const pk of [...BASE_PAGES, ...TIER_A_PAGES]) {
    if (!(loc.pages || []).includes(pk)) continue;
    const seg = pagePath(loc.code, pk, loc.slug).split('/')[2];
    if (seg) segs.add(seg);
  }
  return segs;
}

/**
 * يشتقّ الفهرس من ملفات المستودع.
 * args: { root, published, registry?, livePrices, targets? } — registry = locales.json (لنظام كتابة اللغة).
 * يعيد { pages, excluded } بترتيب COUNTRY_TARGETS.
 */
export function deriveCountryIndex({ root, published, registry, livePrices = [], targets = COUNTRY_TARGETS }) {
  const read = (rel) => {
    const f = path.join(root, rel);
    if (!fs.existsSync(f)) return { missing: true };
    try { return { json: JSON.parse(fs.readFileSync(f, 'utf8')) }; } catch (e) { return { error: e.message }; }
  };
  const locByCode = new Map(((published && published.locales) || []).map((l) => [l.code, l]));
  const scriptOf = (code) => (((registry && registry.locales) || []).find((l) => l.code === code) || {}).script || 'Latn';
  const pages = [];
  const excluded = [];
  const usedPaths = new Set();
  for (const [cc, code] of Object.entries(targets)) {
    const reasons = [];
    const pf = read(`${COUNTRY_PAGES_DIR}/${cc}.json`);
    const ff = read(`${COUNTRY_FACTS_DIR}/${cc}.json`);
    if (pf.missing) reasons.push(`${COUNTRY_PAGES_DIR}/${cc}.json غائب (المحتوى المراجَع لم يصل)`);
    else if (pf.error) reasons.push(`${COUNTRY_PAGES_DIR}/${cc}.json ليس JSON صالحاً: ${pf.error}`);
    if (ff.missing) reasons.push(`${COUNTRY_FACTS_DIR}/${cc}.json غائب (الحقائق المدقّقة لم تصل)`);
    else if (ff.error) reasons.push(`${COUNTRY_FACTS_DIR}/${cc}.json ليس JSON صالحاً: ${ff.error}`);
    const page = pf.json;
    const facts = ff.json;
    if (facts && !factsAudited(facts)) reasons.push('حقائق الدولة لم يكتمل تدقيقها (audit غائب)');
    if (facts && facts.code && facts.code !== cc) reasons.push(`رمز ملف الحقائق «${facts.code}» لا ${cc}`);
    let c = null;
    if (page) {
      if (page.code !== cc) reasons.push(`رمز ملف الصفحة «${page.code}» لا ${cc}`);
      const q = reviewQuality(page);
      if (!COUNTRY_QUALITY_OK.includes(q)) reasons.push(`المراجعة ${q == null ? 'غائبة' : `«${q}»`} (المنشور publish وpublish-with-notes وحدهما)`);
      // المجرَّد: ما يُصيَّر ويُنشر فعلاً (الفحوص كلها عليه)
      c = page.content && page.content[code] ? strippedCountryContent(page.content[code]) : null;
      if (!c) reasons.push(`لا محتوى بلغة «${code}» في ملف الصفحة`);
      if (facts && page.basedOnFactsVerifiedAt !== facts.verifiedAt) {
        reasons.push(`الصفحة مبنية على حقائق ${page.basedOnFactsVerifiedAt} والمدقّقة ${facts.verifiedAt}`);
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(page.basedOnFactsVerifiedAt || ''))) reasons.push(`basedOnFactsVerifiedAt «${page.basedOnFactsVerifiedAt}» ليس YYYY-MM-DD`);
    }
    const loc = locByCode.get(code);
    if (!loc) reasons.push(`اللغة ${code} غير منشورة في الطبقة`);
    else if (!(loc.pages || []).includes('countries')) reasons.push(`اللغة ${code} بلا صفحة دول (/${code}/countries/) تربط الصفحة`);
    let slug = null;
    if (c) {
      reasons.push(...countryShapeProblems(c).map((x) => `شكل: ${x}`));
      slug = countrySlug(c.slugHint);
      if (!slug) reasons.push(`slugHint «${c.slugHint}» لا يصلح مساراً (قصير أو محجوز أو بلا حرف لاتيني)`);
      else if (loc && takenSegments(loc).has(slug)) reasons.push(`slug «${slug}» يصادم صفحة أخرى للغة ${code}`);
      else if (usedPaths.has(`/${code}/${slug}/`)) reasons.push(`slug «${slug}» مكرّر لصفحة دولة أخرى بلغة ${code}`);
      if (!reasons.length) {
        reasons.push(...countryContentViolations(c, { code, livePrices, verifiedAt: page.basedOnFactsVerifiedAt, script: scriptOf(code) }));
      }
    }
    const uniq = [...new Set(reasons)];
    if (uniq.length) { excluded.push({ cc, code, reasons: uniq }); continue; }
    usedPaths.add(`/${code}/${slug}/`);
    pages.push({ cc, code, slug, h1: c.h1, contentDate: page.basedOnFactsVerifiedAt, contentHash: sha(c) });
  }
  return { pages, excluded };
}

// ─── الملفات المشتقة المجرّدة (ما يصل إلى المتصفح وحده) ──────────────────────────────────────────

const pick = (o, keys) => {
  const out = {};
  if (o && typeof o === 'object') for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
};
const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * محتوى لغة واحدة بحقوله التي يقرؤها القالب وحدها (marketingTemplate.mjs: countryBody) — أي حقل آخر يضيفه المصنع
 * (ملاحظة داخل مصدر، تعليق محرّر…) لا يُنشر. null إن لم يكن كائناً.
 */
export function strippedCountryContent(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const si = c.sampleInvoice && typeof c.sampleInvoice === 'object' ? c.sampleInvoice : null;
  return {
    ...pick(c, ['slugHint', 'title', 'description', 'h1', 'intro']),
    sections: arr(c.sections).map((s) => pick(s, ['id', 'title', 'body'])),
    faq: arr(c.faq).map((f) => pick(f, ['q', 'a'])),
    ...(si ? { sampleInvoice: { ...pick(si, ['title', 'note']), fields: arr(si.fields).map((f) => pick(f, ['label', 'example'])) } } : {}),
    sources: arr(c.sources).map((s) => pick(s, ['url', 'title', 'label', 'name'])),
    ...pick(c, ['sourcesTitle', 'lastVerifiedLabel']),
  };
}

/** الملف المشتق لصفحة منشورة: code (رمز الدولة) وbasedOnFactsVerifiedAt وcontent[code] المجرَّد — لا notes ولا review ولا لغة أخرى */
export function strippedCountryFile(page, code) {
  return {
    code: page.code,
    basedOnFactsVerifiedAt: page.basedOnFactsVerifiedAt,
    content: { [code]: strippedCountryContent(page.content && page.content[code]) },
  };
}

/** نصّ الملف المشتق كما يُكتب (المستورد) ويُقارن (الحارس) */
export const countryContentText = (file) => `${JSON.stringify(file, null, 1)}\n`;

/** الملفات المشتقة المتوقعة لصفحات فهرسٍ منشورة: Map<مسار نسبي، نصّ> */
export function deriveCountryContentFiles({ root, index }) {
  const out = new Map();
  for (const e of (index && index.pages) || []) {
    const src = path.join(root, COUNTRY_PAGES_DIR, `${e.cc}.json`);
    if (!fs.existsSync(src)) continue; // يلتقطه G0 (صفحة في الفهرس بلا ملف)
    const page = JSON.parse(fs.readFileSync(src, 'utf8'));
    out.set(countryContentRel(e.cc, e.code), countryContentText(strippedCountryFile(page, e.code)));
  }
  return out;
}

/** ملفات المجلد المشتق الموجودة فعلاً (نسبية) */
export function listCountryContentFiles(root) {
  const dir = path.join(root, COUNTRY_CONTENT_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => `${COUNTRY_CONTENT_DIR}/${n}`);
}

/** فروق المجلد المشتق عمّا يُشتق من src/content (غائب · مختلف · زائد) — فارغة = مطابق */
export function countryContentFilesProblems({ root, index }) {
  const want = deriveCountryContentFiles({ root, index });
  const out = [];
  for (const [rel, text] of want) {
    const f = path.join(root, rel);
    if (!fs.existsSync(f)) out.push(`${rel} غائب`);
    else if (fs.readFileSync(f, 'utf8') !== text) out.push(`${rel} لا يطابق ما يُشتق من ${COUNTRY_PAGES_DIR}`);
  }
  for (const rel of listCountryContentFiles(root)) if (!want.has(rel)) out.push(`${rel} زائد (ليس صفحة منشورة في الفهرس)`);
  return out;
}

// ─── ما لا يجوز أن يصل إلى حزم المتصفح (G-assets) ─────────────────────────────────────────────

const FP_MIN = 24;
const FP_LEN = 48;
const stringsIn = (v, out = []) => {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringsIn(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => stringsIn(x, out));
  return out;
};

/**
 * بصمة نصّ: 48 حرفاً من أطول مقطع فيه بلا علامة تنصيص أو شرطة مائلة أو $ أو سطر جديد — يبقى حرفياً في JS المصغّر
 * (بعد فكّ \uXXXX). الروابط تُحذف أولاً: رابط مصدر عامّ تذكره صفحات أخرى ليس تسريباً.
 * المرشّحات: وسط المقطع ثم أوله ثم آخره، ويُختار أول مرشّح لا يحمله النصّ العامّ (isPublic) — مطلع المقدمة كثيراً
 * ما يكرّر جملة تسويقية منشورة («FieldSales es una plataforma en la nube…» في es.json)، فلا يُعدّ وجودها تسريباً.
 * null إن قصر المقطع عن 24 حرفاً أو كانت كل مرشّحاته عامة.
 */
export function fingerprintOf(s, isPublic = () => false) {
  const best = [...(String(s ?? '').replace(/https?:\/\/\S+/g, '\n').split(/["'`\\$\r\n\t]/)
    .map((x) => x.replace(/\s+/g, ' ').trim()).sort((a, b) => b.length - a.length)[0] || '')];
  if (best.length < FP_MIN) return null;
  const n = Math.min(FP_LEN, best.length);
  const starts = [...new Set([Math.floor((best.length - n) / 2), 0, best.length - n])];
  for (const i of starts) {
    const fp = best.slice(i, i + n).join('').trim();
    if ([...fp].length >= FP_MIN && !isPublic(fp)) return fp;
  }
  return null;
}

/** نصّ حزمة بعد فكّ الهروب (\uXXXX · \u{…} · \xXX) وتوحيد الفراغات — لتُطابَق البصمات حرفياً */
export function normalizeAssetText(t) {
  return String(t)
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\s+/g, ' ');
}

/**
 * بصمات ما لا يُنشر: ملاحظات التحرير والمراجعة (notes · review) في ملف كل صفحة، وتدقيق الحقائق وحدودها
 * (audit · honesty · uncertain) في ملف كل دولة، ومحتوى كل دولة غير منشورة (ولغات المنشورة الأخرى).
 * النصّ العامّ لا يُتّخذ بصمة: محتوى الصفحات المنشورة (اقتباس محرّر لجملة نُشرت ليس تسريباً)، وملفات الطبقة التسويقية
 * للغات الصفحات المستهدفة والإنجليزية (src/i18n/marketing/<code>.json — منشورة علناً).
 * يعيد [{ cc, kind, fp }].
 */
export function countryLeakFingerprints({ root, index, targets = COUNTRY_TARGETS }) {
  const published = new Map(((index && index.pages) || []).map((e) => [e.cc, e.code]));
  const read = (rel) => {
    const f = path.join(root, rel);
    try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; } catch { return null; }
  };
  const marketing = [...new Set(['en', ...Object.values(targets)])].map((code) => read(`src/i18n/marketing/${code}.json`)).filter(Boolean);
  const publicText = normalizeAssetText([
    ...[...deriveCountryContentFiles({ root, index }).values()].map((t) => stringsIn(JSON.parse(t)).join('\n')),
    ...marketing.map((m) => stringsIn(m).join('\n')),
  ].join('\n'));
  const isPublic = (fp) => publicText.includes(normalizeAssetText(fp));
  const out = [];
  const seen = new Set();
  const add = (cc, kind, values) => {
    for (const s of stringsIn(values)) {
      const fp = fingerprintOf(s, isPublic);
      if (!fp || seen.has(fp)) continue;
      seen.add(fp);
      out.push({ cc, kind, fp });
    }
  };
  for (const cc of Object.keys(targets)) {
    const page = read(`${COUNTRY_PAGES_DIR}/${cc}.json`);
    const facts = read(`${COUNTRY_FACTS_DIR}/${cc}.json`);
    if (page) {
      add(cc, 'notes', page.notes);
      add(cc, 'review', page.review);
      for (const [code, c] of Object.entries(page.content || {})) {
        if (published.get(cc) === code) continue;
        const kind = published.has(cc) ? `content.${code} (لغة غير منشورة)` : `content.${code} (دولة غير منشورة)`;
        add(cc, kind, [c && c.h1, c && c.intro, ...arr(c && c.sections).map((s) => s && s.body)]);
      }
    }
    if (facts) {
      add(cc, 'facts.audit', facts.audit);
      add(cc, 'facts.honesty', facts.honesty);
      add(cc, 'facts.uncertain', facts.uncertain);
    }
  }
  return out;
}

/** البصمات التي تحملها الحزم: assets = [{ name, text }] ⇒ [{ name, cc, kind, fp }] */
export function assetLeaks(assets, fingerprints) {
  const out = [];
  const fps = fingerprints.map((f) => ({ ...f, n: normalizeAssetText(f.fp) }));
  for (const a of assets) {
    const t = normalizeAssetText(a.text);
    for (const f of fps) if (t.includes(f.n)) out.push({ name: a.name, cc: f.cc, kind: f.kind, fp: f.fp });
  }
  return out;
}

// ─── فحوص dist لصفحة دولة (G2 · G3 · G5 · G6) ───────────────────────────────────────────────
// verify-i18n يطبّقها على كل صفحة دولة في dist، واختبار countryPages.test.ts يطبّقها على HTML مصيَّر من المثبّت
// ثم مكسور عمداً — فيُثبت أنها تلتقط الكسر قبل أول نشر فعلي.

const RE_STAMP = () => /<p\b[^>]*data-country-verified[^>]*>[\s\S]*?<\/p>/gi;

/**
 * مشكلات صفحة دولة مُصيَّرة. args: { html, page, reg, country (الملف المشتق), livePrices }.
 * يعيد [{ g, msg }] (الرسالة بلا مسار الصفحة — الحارس يضيفه).
 */
export function countryPageDistProblems({ html, page, reg, country, livePrices = [] }) {
  const out = [];
  const add = (g, msg) => { if (!out.some((x) => x.g === g && x.msg === msg)) out.push({ g, msg }); };
  const head = headOf(html);
  const main = mainOf(html);
  const want = canon(ORIGIN + page.path);
  const cc = countryOfPageKey(page.pageKey);
  const entry = countryEntryOf(reg, page.code, page.pageKey);
  if (!entry) add('G5', `${page.pageKey} (${page.code}) ليست في فهرس صفحات الدول`);

  // G3: canonical ذاتي، وعنقود ذاتي في السجل وفي الرأس (hreflang لغتها + x-default إليها نفسها)
  const got = canonicalOf(head);
  if (got !== want) add('G3', `canonical «${got}» ≠ ${want}`);
  const cluster = page.clusterKey ? clusterAlternates(page.clusterKey, reg) : [];
  const selfOk = cluster.length === 2 && cluster.every((a) => canon(a.href) === want)
    && cluster[0].hreflang === page.hreflang && cluster[1].hreflang === 'x-default';
  if (!selfOk) add('G3', `عنقود صفحة الدولة في السجل ليس ذاتياً (hreflang ${page.hreflang} + x-default = canonical): ${cluster.map((a) => `${a.hreflang}|${a.href}`).join(' · ') || '—'}`);
  const alts = alternatesOf(head).map((a) => `${a.hreflang}|${canon(a.href)}`).sort().join(' · ');
  const wantAlts = [`${page.hreflang}|${want}`, `x-default|${want}`].sort().join(' · ');
  if (alts !== wantAlts) add('G3', `بدائل الرأس «${alts || '—'}» لا الذاتية «${wantAlts}»`);

  // G5: قاعدة السنة على مستوى الجملة في الصفحة كلها — السنة أو التاريخ محجوب في كل جملة عن FieldSales نفسها (الاسم
  // أو المتكلم أو صيغه)، ومسموح في جمل حقائق الدولة وعناوين المصادر أيّ قسم كانت فيه؛ وH1 بلا سنة (يُعاد نشره في
  // قائمة صفحات اللغة وllms.txt حيث السنة محجوبة كلها)؛ وختم «آخر تحقق» بسنة التحقق وحدها. وبقية القواعد
  // (رقم+عملة · الاعتماد · السعر الحيّ · ادّعاء الربط الحكومي) في كل الصفحة بلا استثناء.
  const title = titleOf(head);
  const metas = [metaContent(head, 'name', 'description'), metaContent(head, 'property', 'og:title'), metaContent(head, 'property', 'og:description')].map((x) => x || '');
  const stamps = [...main.matchAll(RE_STAMP())].map((m) => m[0]);
  for (const v of findI18nViolations([stripTags(removeElements(main, RE_COUNTRIES)), title, ...metas].join(' \n '), { code: page.code, livePrices, allowYear: true })) {
    add('G5', `[${v.id}] «${v.match}» — ${v.why}`);
  }
  const h1Text = [...main.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => stripTags(m[1])).join(' \n ');
  for (const v of findI18nViolations(h1Text, { code: page.code })) if (v.id === 'i18n-year') add('G5', `[${v.id}] H1 «${v.match}» — ${v.why}`);
  if (!hasCountryClaimRules(page.code)) add('G5', `لا قاعدة جملة (السنة قرب FieldSales وادّعاء الربط) للغة ${page.code}`);
  const noNav = removeElements(main, RE_LANGS_NAV);
  for (const b of [...blockTexts(removeElements(noNav, RE_STAMP())), title, ...metas]) {
    for (const v of selfYearViolations(b, page.code)) add('G5', `[${v.id}] «${v.match}» — ${v.why}`);
  }
  for (const b of [...blockTexts(noNav), title, ...metas]) {
    for (const v of govLinkViolations(b, page.code)) add('G5', `[${v.id}] «${v.match}» — ${v.why}`);
  }
  if (!stamps.length) add('G5', 'ختم «آخر تحقق» (data-country-verified) غائب');
  else {
    const sp = stampProblem(stripTags(stamps[0]), entry ? entry.contentDate : '');
    if (sp) add('G5', `[i18n-year] ${sp}`);
  }
  // ومصدر الحقيقة نفسه: الملف المشتق الذي صُيِّرت منه (القاعدة نفسها في المستورد)
  const c = country && country.content ? country.content[page.code] : null;
  if (!c) add('G5', `لا محتوى ${page.code} في ${countryContentRel(cc, page.code)}`);
  else {
    for (const v of checkCountryContent(c, { code: page.code, livePrices, verifiedAt: country.basedOnFactsVerifiedAt })) {
      add('G5', `${countryContentRel(cc, page.code)} ${v.path}: [${v.id}] «${v.match}» — ${v.why}`);
    }
  }

  // G6: الأزرار، وFAQPage = الأسئلة الظاهرة، وختم التحقق = تاريخ الحقائق، والمصادر، ومثال الفاتورة
  if (!html.includes('/subscribe-request/?type=quote')) add('G6', 'رابط «طلب عرض سعر» غائب');
  if (!html.includes('go/wa')) add('G6', 'رابط واتساب (go/wa) غائب');
  if (!/href="\/(?:en|fr|tr|zh)\/meeting\/"/.test(html)) add('G6', 'رابط «احجز اجتماعاً» غائب');
  const graph = ldBlocks(html).flatMap((b) => { try { const j = JSON.parse(b); return Array.isArray(j['@graph']) ? j['@graph'] : [j]; } catch { return []; } });
  const faqLd = graph.find((n) => n && n['@type'] === 'FAQPage');
  const shown = [...main.matchAll(/<section\b[^>]*data-country-faq[^>]*>([\s\S]*?)<\/section>/gi)]
    .flatMap((m) => [...m[1].matchAll(/<h3>([\s\S]*?)<\/h3>/gi)].map((q) => stripTags(q[1])));
  if (!faqLd) add('G6', 'لا FAQPage في JSON-LD');
  else {
    const names = (faqLd.mainEntity || []).map((q) => String(q.name).replace(/\s+/g, ' ').trim());
    if (!shown.length || names.length !== shown.length || names.some((n, i) => n !== shown[i])) add('G6', `أسئلة FAQPage (${names.length}) لا تطابق الظاهرة (${shown.length})`);
  }
  const dt = ((main.match(/<p\b[^>]*data-country-verified[^>]*>[\s\S]*?<time\b[^>]*datetime="([^"]+)"/i) || [])[1]) || '';
  if (!entry || dt !== entry.contentDate) add('G6', `ختم آخر تحقق «${dt}» ≠ تاريخ الحقائق ${entry ? entry.contentDate : '—'}`);
  // داخل قسم المصادر نفسه (نمط ممتدّ كان يلتقط رابط https بعده — زرّ واتساب — فيمرّ قسمٌ بلا مصدر https)
  const sourcesSec = (main.match(/<section\b[^>]*data-country-sources[^>]*>[\s\S]*?<\/section>/i) || [''])[0];
  if (!/<a\b[^>]*href="https:\/\//i.test(sourcesSec)) add('G6', 'قائمة المصادر بلا رابط https');
  if (!/<table\b[^>]*data-country-sample-fields/i.test(main)) add('G6', 'مثال بنية الفاتورة غائب');
  // الأقسام الخمسة بترتيبها (كان «قسم einvoicing موجود» شرطاً لاستثناء السنة فيه — صار فحص بنية)
  const secIds = [...main.matchAll(/<section\b[^>]*data-country-section="([^"]*)"/gi)].map((m) => m[1]).join(',');
  if (secIds !== COUNTRY_SECTION_IDS.join(',')) add('G6', `أقسام الصفحة «${secIds || '—'}» لا «${COUNTRY_SECTION_IDS.join(',')}»`);
  return out;
}

/**
 * G2: صفحة الدولة مربوطة من قائمة صفحات كل صفحة أخرى للغتها (data-i18n-pages) ومن صفّها في جدول /<lang>/countries/.
 * args: { cp (صفحة الدولة), others: [{ path, pageKey, html }] } ⇒ [{ g, msg }]
 */
export function countryLinkProblems({ cp, others }) {
  const out = [];
  const cc = countryOfPageKey(cp.pageKey);
  for (const o of others) {
    if (!o.html) continue;
    const nav = (o.html.match(/<nav\b[^>]*data-i18n-pages[^>]*>[\s\S]*?<\/nav>/i) || [''])[0];
    if (!nav.includes(`href="${cp.path}"`)) out.push({ g: 'G2', msg: `${o.path}: قائمة صفحات اللغة (data-i18n-pages) بلا رابط ${cp.path}` });
    if (o.pageKey === 'countries') {
      const row = [...o.html.matchAll(/<tr>\s*<th\b[^>]*scope="row"[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => m[1]).find((x) => x.includes(`data-country-link="${cc}"`));
      if (!row || !row.includes(`href="${cp.path}"`)) out.push({ g: 'G2', msg: `${o.path}: صفّ ${cc} في جدول الدول لا يربط ${cp.path}` });
    }
  }
  return out;
}
