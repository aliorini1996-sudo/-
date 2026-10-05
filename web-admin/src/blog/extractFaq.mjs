/**
 * أسئلة شائعة صادقة للبيانات المنظّمة (بند P2 وتصحيح الناقد 7).
 *
 * القاعدة الحاكمة: لا FAQPage إلا لأسئلة **ظاهرة في الصفحة نفسها**. كان قالب الرئيسية يحقن أسئلته
 * العربية في أكثر من مئتي صفحة لا تعرضها (ومنها صفحات إنجليزية)، بينما أسئلة المقالات اليدوية
 * الظاهرة فعلاً لا تدخل أي FAQPage. هذا الملف يستخرج الأسئلة الظاهرة من HTML المقال، ويُسقط منها
 * ما لا يصحّ تضخيمه في البيانات المنظّمة:
 *   - نفي قديم للمرحلة الثانية أو تموضع «المرحلة الأولى» (قاعدة zatca-phase2-stale-denial نفسها
 *     في scripts/claims-rules.mjs — تُقرأ منها، فلا نسخة موازية من الأنماط).
 *   - وعد «دون اتصال» غير مقيَّد: للشركات المفعّل لها ربط المرحلة الثانية تحتاج الفواتير والمرتجعات
 *     اتصالاً لحظة الإصدار، فالجواب الذي يَعِد بالعمل دون اتصال بلا هذا القيد لا يدخل acceptedAnswer.
 * السؤال المُسقَط يبقى في نص المقال كما هو (يحرّره المالك من CMS)؛ نحن فقط لا نضخّمه.
 *
 * الملف نقيّ بلا fs ولا شبكة ولا استيرادات: يستورده prerender وقت البناء وBlogPostPage وPricingPage في
 * المتصفح، فيخرج FAQPage واحد من المصدر نفسه قبل إقلاع React وبعده.
 *
 * ⚠️ لماذا تُمرَّر قواعد الحارس وسيطاً (faqProblemWith) ولا تُستورد هنا: الصفحتان في الحزمة الرئيسية،
 *    وclaims-rules.mjs يبني عند تحميله أنماطاً بنظرة خلفية (lookbehind) يرفضها Safari قبل 16.4 —
 *    استيرادها هنا كان سيُسقط الموقع كله (لا صفحة المقال وحدها) على أجهزة iOS القديمة. prerender يمرّرها
 *    مباشرة، وBlogPostPage يحمّلها كسولاً (import()) فإن تعذّرت سقطت FAQPage وحدها.
 *    والتصفية تفشل مغلقة: بلا مصنِّف لا FAQPage.
 */

const ENTITIES = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&#x27;': "'", '&nbsp;': ' ', '&#160;': ' ', '&lt;': '<', '&gt;': '>' };

/** نص صرف من HTML: الوسوم تُحذف، والكيانات الشائعة تُفكّ، والفراغ يُطبَّع */
export const textOf = (html) => String(html == null ? '' : html)
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&(?:amp|quot|#39|#x27|nbsp|#160|lt|gt);/g, (m) => ENTITIES[m])
  .replace(/\s+/g, ' ')
  .trim();

/** عنوان قسم الأسئلة بلغات المقالات (ع/إ/فر) */
const FAQ_HEAD = /أسئل[ةه]\s*شائع[ةه]|الأسئل[ةه]\s*الشائع[ةه]|أسئل[ةه]\s*متكرر[ةه]|الأسئل[ةه]\s*المتكرر[ةه]|\bFAQs?\b|Frequently\s+asked|Questions\s+fr[ée]quentes/i;
const IS_QUESTION = /[؟?]\s*$/;

/** تسلسل العناوين والفقرات بترتيب ظهورها (h2/h3/p فقط) */
function tokens(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<(h2|h3|p)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const text = textOf(m[2]);
    if (text) out.push({ tag: m[1].toLowerCase(), text });
  }
  return out;
}

/**
 * الأزواج الظاهرة كما هي، قبل أي تصفية.
 * 1) قسم بعنوان H2 «أسئلة شائعة/FAQ»: كل H3 فيه مع الفقرة التي تليه مباشرة، حتى أول H2 تالٍ.
 * 2) وإلا: إن كانت في المقال ثلاثة عناوين H2 أو أكثر تنتهي بـ«؟» أو «?» (مقال أسئلة كامل) فكل
 *    H2 سؤالي مع الفقرة التي تليه مباشرة.
 * عنوان تليه قائمة أو عنوان آخر بلا فقرة لا يُعدّ زوجاً: لا جواب نصّياً نقتبسه.
 * @param {string} contentHtml
 * @returns {{ q: string, a: string }[]}
 */
export function rawFaq(contentHtml) {
  const t = tokens(contentHtml);
  const pairAt = (i) => (t[i + 1] && t[i + 1].tag === 'p' ? { q: t[i].text, a: t[i + 1].text } : null);
  const seen = new Set();
  const uniq = (list) => list.filter((x) => x && !seen.has(x.q) && seen.add(x.q));

  const head = t.findIndex((x) => x.tag === 'h2' && FAQ_HEAD.test(x.text));
  if (head >= 0) {
    const out = [];
    for (let i = head + 1; i < t.length && t[i].tag !== 'h2'; i++) if (t[i].tag === 'h3') out.push(pairAt(i));
    const pairs = uniq(out);
    if (pairs.length >= 2) return pairs;
    seen.clear();
  }

  const qHeads = t.map((x, i) => (x.tag === 'h2' && IS_QUESTION.test(x.text) ? i : -1)).filter((i) => i >= 0);
  if (qHeads.length >= 3) return uniq(qHeads.map(pairAt));
  return [];
}

/** «دون اتصال» بصيغها — بلا حدّ كلمة لاتيني (\b لا يعمل مع العربية) */
const OFFLINE = /(?:بلا|بدون|دون|من\s*غير)\s*(?:ال)?(?:اتصال|إنترنت|انترنت|إنترنيت|انترنيت|شبك[ةه])|[أا]وف[\s-]?لاين|\boff-?line\b|hors[\s-]+ligne|çevrimdışı|离线/i;
/**
 * مصنِّف الأزواج من قواعد حارس الادّعاءات: يعيد (زوج) ⇒ سبب الإسقاط أو null.
 * rules = وحدة scripts/claims-rules.mjs نفسها (RULES وfindViolation وnorm وPHASE2).
 * @param {{ RULES: Array<{ id: string }>, findViolation: Function, norm: (s: string) => string, PHASE2: string }} rules
 * @returns {(pair: { q: string, a: string }) => null | 'zatca-phase2-stale-denial' | 'offline-unqualified'}
 */
export function faqProblemWith(rules) {
  const { RULES, findViolation, norm, PHASE2 } = rules;
  const stale = RULES.find((r) => r.id === 'zatca-phase2-stale-denial');
  // القيد الذي يجعل وعد «دون اتصال» صادقاً: ذكر المرحلة الثانية/ربطها أو اشتراط الاتصال لحظة الإصدار
  const qualified = new RegExp(`${PHASE2}|لحظ[ةه]\\s*(?:ال)?[إا]صدار|at\\s+the\\s+moment\\s+of\\s+issu|au\\s+moment\\s+de\\s+l.[ée]mission`, 'i');
  return ({ q, a }) => {
    const text = norm(`${q} ${a}`);
    if (stale && findViolation(stale, text)) return 'zatca-phase2-stale-denial';
    if (OFFLINE.test(text) && !qualified.test(text)) return 'offline-unqualified';
    return null;
  };
}

/**
 * يصفّي قائمة أسئلة جاهزة (أسئلة CMS للرئيسية) بالقواعد نفسها.
 * problem: مصنِّف faqProblemWith — بلا مصنِّف تُعاد قائمة فارغة (تفشل مغلقة، لا FAQPage غير مصفّاة).
 * min: أقل عدد يبرّر FAQPage — دونه تُعاد قائمة فارغة.
 * @param {{ q: string, a: string }[]} items
 * @param {{ problem?: (pair: { q: string, a: string }) => string | null, min?: number }} [opts]
 * @returns {{ kept: { q: string, a: string }[], dropped: { q: string, a: string, why: string }[] }}
 */
export function publishableFaq(items, { problem, min = 2 } = {}) {
  if (typeof problem !== 'function') return { kept: [], dropped: [] };
  const kept = [];
  const dropped = [];
  for (const it of items || []) {
    const q = textOf(it && it.q);
    const a = textOf(it && it.a);
    if (!q || !a) continue;
    const why = problem({ q, a });
    if (why) dropped.push({ q, a, why });
    else kept.push({ q, a });
  }
  return { kept: kept.length >= min ? kept : [], dropped };
}

/**
 * أسئلة المقال الظاهرة الصالحة لـFAQPage: [{q,a}] أو [] إن قلّت عن زوجين بعد التصفية.
 * @param {string} contentHtml
 * @param {{ problem?: (pair: { q: string, a: string }) => string | null }} [opts]
 * @returns {{ q: string, a: string }[]}
 */
export function extractFaq(contentHtml, { problem } = {}) {
  return publishableFaq(rawFaq(contentHtml), { problem }).kept;
}

/** التفصيل للسجل وللاختبار: الخام والمقبول والمُسقَط وسببه */
export function extractFaqDetailed(contentHtml, { problem } = {}) {
  const raw = rawFaq(contentHtml);
  const { kept, dropped } = publishableFaq(raw, { problem });
  return { raw, kept, dropped };
}

/** عقدة FAQPage من أزواج مقبولة */
export const faqPageNode = (items) => ({
  '@type': 'FAQPage',
  mainEntity: items.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
});

/* ─── صفحة الأسعار: مصدر واحد للتصيير المسبق وPricingPage ─────────────────────
 *
 * كانت أسئلة /pricing مكتوبة في prerender.mjs وحده: الزاحف بلا JS يقرؤها، وبعد إقلاع React تختفي
 * من الصفحة وتبقى في FAQPage — أي أسئلة في البيانات المنظّمة لا يراها من يفتح الصفحة. الآن الأسئلة
 * والسكيما تُبنى هنا من باقات CMS نفسها، ويعرضها الطرفان. لا رقم مكتوب يدوياً: كل سعر من plans.
 */

const isNumericPrice = (p) => /^\d+$/.test(String(p && p.price != null ? p.price : '').trim());

/**
 * ملخّصات الأسعار من باقات CMS — الصيغة نفسها في scripts/pricing-source.mjs (arSummary/enSummary).
 * @param {Array<{ price?: string|number, limit?: string }>} plans
 */
export function pricingSummaries(plans) {
  const numeric = (plans || []).filter(isNumericPrice);
  const has = numeric.length > 0;
  return {
    ar: numeric.map((p) => `${p.price} ر.س ${p.limit || ''}`.trim()).join('، ') + (has ? ' (شامل ضريبة القيمة المضافة)' : ''),
    en: numeric.map((p) => `${p.price} SAR`).join(' / ') + (has ? ' (VAT included)' : ''),
    fr: numeric.map((p) => `${p.price} SAR`).join(' / ') + (has ? ' (TVA incluse)' : ''),
    has,
  };
}

/**
 * أسئلة التسعير بلغة الصفحة (ar/en/fr؛ غيرها بلا أسئلة).
 * @param {string} lang
 * @param {Array<{ price?: string|number, limit?: string }>} plans
 * @returns {{ q: string, a: string }[]}
 */
export function pricingFaq(lang, plans) {
  const s = pricingSummaries(plans);
  const list = {
    ar: [
      s.has && ['كم سعر برنامج مندوبين المبيعات؟', `${s.ar}. السعر لكل شركة لا لكل مستخدم، وما فوق ذلك يُحدَّد بالمحادثة.`],
      ['هل السعر لكل مندوب أم لكل شركة؟', 'لكل شركة. إضافة مندوب جديد ضمن حدّ الباقة لا تزيد فاتورتك الشهرية.'],
      ['هل هناك رسوم تأسيس أو إعداد؟', 'لا رسوم تأسيس ولا رسوم إعداد.'],
      ['هل التجربة تحتاج بطاقة ائتمان؟', 'لا. التجربة عشرة أيام بلا بطاقة ائتمان.'],
      ['هل يدعم النظام الفاتورة الإلكترونية؟', 'نعم. يُصدر فاتورة ضريبية برمز QR، وندعم ربط المرحلة الثانية مع منصة فاتورة التابعة لهيئة الزكاة والضريبة والجمارك. والهيئة لا تعتمد مزوّدي البرمجيات.'],
    ],
    en: [
      s.has && ['How much does field sales software cost?', `${s.en} per month, priced per company rather than per user.`],
      ['Is it priced per rep or per company?', 'Per company. Adding a rep within your plan limit does not increase your monthly bill.'],
      ['Are there setup fees?', 'No setup or onboarding fees.'],
      ['Does the trial need a credit card?', 'No. The 10-day trial needs no credit card.'],
    ],
    fr: [
      s.has && ['Combien coûte un logiciel de vente terrain ?', `${s.fr} par mois, par entreprise et non par utilisateur.`],
      ['Le prix est-il par commercial ou par entreprise ?', 'Par entreprise. Ajouter un commercial dans la limite de votre offre n’augmente pas votre facture mensuelle.'],
      ['Y a-t-il des frais de mise en service ?', 'Aucuns frais de mise en service ni d’intégration.'],
      ['L’essai demande-t-il une carte bancaire ?', 'Non. L’essai de 10 jours se fait sans carte bancaire.'],
    ],
  }[lang];
  if (!list) return [];
  // نصّ مستودع لا CMS: يحرسه verify-claims على الصفحة المُصيَّرة، فلا يمرّ بالمصنِّف
  return list.filter(Boolean).map(([q, a]) => ({ q, a }));
}

/**
 * سكيما صفحة الأسعار: Product بمعرّف ثابت واحد للغات الثلاث (url لغة الصفحة نفسها) + FAQPage
 * للأسئلة المعروضة. AggregateOffer من الباقات الرقمية وحدها، ويُحذف إن لم توجد أسعار.
 * @param {string} lang
 * @param {Array<{ price?: string|number }>} plans
 * @param {string} canonical رابط الصفحة بلغتها (بشرطة)
 */
export function pricingJsonLd(lang, plans, canonical) {
  const prices = (plans || []).filter(isNumericPrice).map((p) => Number(p.price)).sort((x, y) => x - y);
  const faq = pricingFaq(lang, plans);
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Product',
        '@id': 'https://fieldsa.net/#product',
        name: 'Field Sales',
        alternateName: 'فيلد سيلز',
        url: canonical,
        ...(prices.length ? {
          offers: {
            '@type': 'AggregateOffer',
            lowPrice: String(prices[0]),
            highPrice: String(prices[prices.length - 1]),
            priceCurrency: 'SAR',
            offerCount: (plans || []).length,
            availability: 'https://schema.org/InStock',
          },
        } : {}),
      },
      ...(faq.length ? [faqPageNode(faq)] : []),
    ],
  };
}
