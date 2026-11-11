/**
 * صفحات الدول في الطبقة متعددة اللغات (نوع «country») — اشتقاق فهرسها من ملفات المستودع، مشتركٌ بين المستورد
 * (import-country-i18n.mjs يكتبه) والحارس (verify-i18n.mjs G0 يعيد اشتقاقه ويقارن) والاختبارات.
 *
 * المدخلات نسخ حرفية من مصنع المحتوى، لا تُحرَّر في المستودع (فرع آخر ينسخ الملفات نفسها حرفياً):
 *   src/content/country-facts/<CC>.json  — حقائق الدولة المدقّقة (audit = اكتمل التدقيق)
 *   src/content/country-pages/<CC>.json  — محتوى الصفحة المراجَع (review.quality: publish | publish-with-notes)
 * المخرج: src/i18n/registry/country-pages.json — { pages: [مدخل لكل صفحة منشورة], excluded: [ما استُثني وسببه] }.
 *
 * الدولة تُستثنى (ولا يُضعف حارس لأجلها) إن: غاب ملفها أو حقائقها، أو لم يكتمل تدقيق الحقائق، أو لم تُجز المراجعة،
 * أو غابت لغة سوقها، أو بُنيت الصفحة على حقائق غير المدقّقة (basedOnFactsVerifiedAt ≠ verifiedAt)، أو نقص شكلها، أو
 * لم يصلح slug أو صادم صفحة أخرى، أو لم تُنشر لغتها بصفحة الدول، أو خالف نصّها قاعدة من قواعد الحارس نفسها
 * (claims-i18n: الاعتماد والسنة خارج einvoicing والسعر الحيّ ورقم+عملة · claims-rules · لغة النص).
 */
import fs from 'fs';
import path from 'path';
import crypto from 'node:crypto';
import { countrySlug, pagePath, BASE_PAGES, TIER_A_PAGES, DEFAULT_CATEGORY_SLUG } from '../src/i18n/i18nRoutes.mjs';
import { COUNTRY_SECTION_IDS } from '../src/i18n/marketingTemplate.mjs';
import { checkCountryContent, countryContentTexts, scriptProblems } from './claims-i18n.mjs';
import { RULES, findViolation } from './claims-rules.mjs';

/** الدول المستهدفة ولغة صفحة كلٍّ منها (بترتيب الفهرس والقوائم) */
export const COUNTRY_TARGETS = Object.freeze({ MX: 'es', CO: 'es', BR: 'pt', ID: 'id' });
export const COUNTRY_PAGES_DIR = 'src/content/country-pages';
export const COUNTRY_FACTS_DIR = 'src/content/country-facts';
export const COUNTRY_INDEX_FILE = 'src/i18n/registry/country-pages.json';
export const COUNTRY_QUALITY_OK = Object.freeze(['publish', 'publish-with-notes']);

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
      c = page.content && page.content[code];
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
