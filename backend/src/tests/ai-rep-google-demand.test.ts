// المندوب الذكي — «الطلب المتوقع من ملف المحل في Google» (googleDemand.ts): كل عامل (الحركة T، والجودة Q، وحديث المراجعات R،
// وذكر الصنف M، والمعامل المتعلَّم C)، ومطابقة الأصناف بتطبيع العربية ونفيها، وبلا مرساة، والعدد المجهول، والترتيب، والثقة،
// وسطر الأساس — ثم بياناته (googleDemandData.ts): شكل استعلام المرساة وعزله وذاكرته، وأصناف المندوب من سيارته أولاً.
// فوق Prisma مزيّف — بلا قاعدة ولا Google.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { Prisma } from '@prisma/client';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};

// ───────────── Prisma مزيّف (للبيانات) ─────────────
let rawCalls: Prisma.Sql[] = [];
let rawRows: unknown[] = [];
let rawFail = false;
let productRows: { id: string; name: string; unit: string }[] = [];
let productWhere: Record<string, unknown>[] = [];
stub('config/database', {
  default: {
    $queryRaw: async (q: Prisma.Sql) => { rawCalls.push(q); if (rawFail) throw new Error('db down'); return rawRows; },
    product: {
      findMany: async (a: { where: Record<string, unknown> }) => {
        productWhere.push(a.where);
        const ids = (a.where.id as { in: string[] }).in;
        return productRows.filter(p => ids.includes(p.id));
      },
    },
  },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const G = require('../ai-rep/googleDemand') as typeof import('../ai-rep/googleDemand');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const D = require('../ai-rep/googleDemandData') as typeof import('../ai-rep/googleDemandData');
type Anchor = import('../ai-rep/googleDemand').Anchor;
type ExpectInput = import('../ai-rep/googleDemand').ExpectInput;

const P = (productId: string, name: string, unit = 'كرتون') => ({ productId, name, unit });
const eggs = P('eggs', 'بيض المراعي 30 حبة');
const milk = P('milk', 'حليب نادك كامل الدسم 1 لتر');
const bread = P('bread', 'صامولي لوزين');
const pepsi = P('pepsi', 'ببسي 330 مل', 'علبة');
const oil = P('oil', 'زيت عافية 1.5 لتر');
const anchors = (o: Record<string, number | [number, number]>): Map<string, Anchor> =>
  new Map(Object.entries(o).map(([id, v]) => [id, { qty: Array.isArray(v) ? v[0] : v, price: Array.isArray(v) ? v[1] : null, invoices: 10 }]));
const base = (counts: number[]) => G.typeBaselines(counts.map(n => ({ outletType: 'GROCERY', ratingCount: n }))).get('GROCERY');
const input = (o: Partial<ExpectInput> = {}): ExpectInput => ({
  outletType: 'GROCERY', rating: null, ratingCount: null, products: [eggs], anchors: anchors({ eggs: 10 }), source: 'VAN', showMoney: false, ...o,
});
const R = (text: string, rating: number | null = null) => ({ rating, text });

// ───────────── التطبيع والمطابقة ─────────────

test('التطبيع: الهمزات والتاء المربوطة والألف المقصورة والتشكيل والتطويل والأرقام وعلامات الترقيم', () => {
  assert.equal(G.normalizeAr('أإآٱ'), 'اااا');
  assert.equal(G.normalizeAr('عصائر مؤكدة'), 'عصاير موكده');
  assert.equal(G.normalizeAr('مُسْتَشْفَى'), 'مستشفي');
  assert.equal(G.normalizeAr('بيـــض!! ٣٠ حبّة'), 'بيض 30 حبه');
  assert.equal(G.normalizeAr('Pepsi-330ML'), 'pepsi 330ml');
  assert.deepEqual(G.tokensAr('والبيض بالحليب للخبز'), ['بيض', 'حليب', 'خبز']);
});

test('مطابقة الكلمة: اللواحق والعطف مقبولة، والكلمات المشابهة لا', () => {
  assert.ok(G.tokenMatches('بيضه', 'بيض'));
  assert.ok(G.tokenMatches('بيضات', 'بيض'));
  assert.ok(G.tokenMatches('وبيض', 'بيض'));
  assert.ok(G.tokenMatches('حليبها', 'حليب'));
  assert.ok(!G.tokenMatches('ابيض', 'بيض'), 'أبيض لونٌ لا بيض');
  assert.ok(!G.tokenMatches('بيضاء', 'بيض'));
  assert.ok(!G.tokenMatches('زيتون', 'زيت'));
  assert.ok(!G.tokenMatches('رزق', 'رز'));
  assert.ok(!G.tokenMatches('لبنان', 'لبن'));
  assert.ok(!G.tokenMatches('مخبز', 'خبز'));
});

test('كلمات الصنف المميِّزة: الصنف العام بمرادفاته (لا علامته)، وإلا كلماته بلا وحدات ولا أحجام ولا أرقام', () => {
  assert.deepEqual(G.productKeywords('بيض المراعي 30 حبة'), ['بيض']);
  assert.deepEqual(G.productKeywords('حليب نادك كامل الدسم 1 لتر'), ['حليب', 'لبن']);
  assert.deepEqual(G.productKeywords('صامولي لوزين'), ['خبز', 'صامولي', 'توست', 'صمون']);
  assert.deepEqual(G.productKeywords('مياه نوفا 330 مل × 40').sort(), ['ماء', 'مويه', 'مياه'].sort());
  assert.deepEqual(G.productKeywords('رز بسمتي الشعلان 5 كجم'), ['ارز', 'رز']);
  assert.deepEqual(G.productKeywords('ببسي 330 مل'), ['ببسي']);
  assert.deepEqual(G.productKeywords('Pepsi 330ml'), ['pepsi']);
  assert.deepEqual(G.productKeywords('كرتون 12 حبة'), [], 'وحدات وأرقام وحدها ⇒ لا كلمات');
});

test('ذكر الصنف: عدد المراجعات، والشكوى في الجملة نفسها وحدها، والاقتباس بلا هاتف ولا رابط', () => {
  const m = G.findMentions([eggs, milk, bread, oil], [
    R('البيض دايم طازج عندهم والحليب متوفر', 5),
    R('الخبز ممتاز بس البيض غير طازج', 3),
    R('ما فيه حليب اليوم، اتصلت 0551234567 https://x.co/a', 2),
    R('محل أبيض نظيف وفيه زيتون', 5),
  ]);
  const e = m.get('eggs')!, k = m.get('milk')!, b = m.get('bread')!;
  assert.equal(e.reviews, 2);
  assert.equal(e.plain, true, 'مذكورٌ بلا شكوى في المراجعة الأولى');
  assert.equal(e.complaint, 'QUALITY');
  assert.equal(e.quote, 'البيض دايم طازج عندهم والحليب متوفر');
  assert.equal(b.reviews, 1);
  assert.equal(b.complaint, null, 'شكوى البيض في جملة أخرى لا تُنسب للخبز');
  assert.equal(k.reviews, 2);
  assert.equal(k.complaint, 'SHORTAGE');
  assert.ok(!m.has('oil'), 'زيتون ليس زيتاً');
  for (const x of m.values()) assert.doesNotMatch(x.quote ?? '', /055|https?:|x\.co/);
  const only = G.findMentions([eggs], [R('البيض غير طازج أبداً')]).get('eggs')!;
  assert.deepEqual([only.plain, only.complaint], [false, 'QUALITY']);
  assert.equal(G.mentionFactor(only), 1.2, 'مذكورٌ بشكوى وحدها ⇒ ١٫٢');
  assert.equal(G.mentionFactor(e), 1.3);
  assert.equal(G.mentionFactor(undefined), 1);
  assert.equal(G.findMentions([eggs], [R('محل أبيض والبيضاء قريبة')]).size, 0, 'لا ذكر زائف');
});

test('ذكرٌ زائف يُرفض: «رز» داخل برز/فرز/كرز، و«روب» في كروب، و«سكر» فعل إغلاق، والبطاطس خضار لا شيبس، و«محل قديم» ليس شكوى', () => {
  const rice = P('rice', 'رز الشعلان 5 كجم'), sugar = P('sugar', 'سكر الأسرة 2 كجم'), yog = P('yog', 'روب المراعي'), chips = P('chips', 'شيبس ليز');
  const ids = (text: string) => [...G.findMentions([rice, sugar, yog, chips, eggs], [R(text, 4)]).keys()].sort();
  for (const t of ['برز المحل بتنظيمه', 'فرز البضاعة ممتاز', 'عصير كرز لذيذ', 'كروب واتساب للطلبات', 'لقيته سكر بدري', 'المحل سكر قبل الوقت', 'البطاطس عندهم طازجة']) {
    assert.deepEqual(ids(t), [], t);
  }
  assert.deepEqual(ids('الرز والسكر متوفرين'), ['rice', 'sugar'], 'الذكر الحقيقي يبقى');
  assert.deepEqual(ids('السكر قليل عندهم عشان كذا'), ['sugar'], 'كلمات الدوام بالكلمة كاملةً: قليل ليست ليل وعشان ليست عشا');
  assert.deepEqual(ids('بالرز البسمتي'), ['rice']);
  assert.deepEqual(ids('وشيبس كثير'), ['chips']);
  const m = G.findMentions([eggs], [R('المحل قديم والبيض طازج', 5)]).get('eggs')!;
  assert.deepEqual([m.plain, m.complaint], [true, null], 'وصف المحل بالقِدم ليس شكوى من البيض');
  assert.equal(G.findMentions([eggs], [R('البيض قديم', 2)]).get('eggs')!.complaint, 'QUALITY');
  assert.deepEqual(G.productKeywords('عرض خاص ببسي'), ['ببسي']);
});

test('الاقتباس الآمن: بلا روابط ولا هواتف ولا محارف خفية، ومقصوص', () => {
  const q = G.safeQuote('‫راجعوا www.spam.com أو 0551234567 ' + 'البيض '.repeat(40));
  assert.doesNotMatch(q, /www|055|‫/);
  assert.ok(q.length <= 90 && q.endsWith('…'));
});

// ───────────── العوامل ─────────────

test('R حديث المراجعات: زحمة وتنوّع حتى ١٫١، نقص الأصناف ١٫١ وفرصة، سلبية غالبة أو إغلاق ٠٫٨، بلا نص ١', () => {
  assert.deepEqual(G.reviewTalk([]), { codes: [], R: 1 });
  assert.deepEqual(G.reviewTalk([R('عليه زحمة دايم', 5)]), { codes: ['BUSY'], R: 1.05 });
  assert.deepEqual(G.reviewTalk([R('زحمة وكل شي متوفر', 5)]), { codes: ['BUSY', 'VARIETY'], R: 1.1 });
  assert.deepEqual(G.reviewTalk([R('ناقص أشياء كثيرة', 2)]), { codes: ['SHORTAGE'], R: 1.1 });
  assert.equal(G.reviewTalk([R('المحل مغلق نهائياً', 1)]).R, 0.8);
  assert.ok(G.reviewTalk([R('المحل مغلق نهائياً', 1)]).codes.includes('CLOSING'));
  assert.equal(G.reviewTalk([R('يقفل الساعة 12', 4)]).R, 1, 'ساعات الإغلاق ليست إغلاقاً');
  const neg = G.reviewTalk([R('سيء', 1), R('وسخ', 1), R('تعامل سيئ', 2)]);
  assert.equal(neg.R, 0.8);
  assert.ok(neg.codes.includes('NEGATIVE'));
  // «ما فيه مواقف» شكوى لا نقص أصناف؛ «ما فيه أغراض» و«البضاعة قليلة» نقص
  assert.deepEqual(G.reviewTalk([R('ما فيه مواقف', 2)]), { codes: [], R: 1 });
  assert.deepEqual(G.reviewTalk([R('ما فيه أغراض كثير', 2)]).codes, ['SHORTAGE']);
  assert.deepEqual(G.reviewTalk([R('البضاعة قليلة', 2)]).codes, ['SHORTAGE']);
  assert.deepEqual(G.reviewTalk([R('ما ناقصه شي كل شي متوفر', 5)]).codes, ['VARIETY'], 'المديح لا يُقرأ نقصاً');
});

test('T الحركة: √((n+5)/(m+5)) في [٠٫٥، ٢]، والمجهول ١', () => {
  assert.equal(G.trafficFactor(40, 40), 1);
  assert.ok(Math.abs(G.trafficFactor(165, 40) - Math.sqrt(170 / 45)) < 1e-9);
  assert.equal(G.trafficFactor(5000, 40), 2);
  assert.equal(G.trafficFactor(1, 40), 0.5);
  assert.equal(G.trafficFactor(null, 40), 1);
  assert.equal(G.trafficFactor(0, 40), 1, 'صفر = غير معروف');
});

test('وسيط النوع من المسح: ٣ معروفة فأكثر وإلا المسبق ٤٠، والمجهول لا يدخل، وحصة المحلات الأقل', () => {
  const b = base([10, 20, 30, 165, 50])!;
  assert.equal(b.median, 30);
  assert.equal(b.known, 5);
  const few = G.typeBaselines([{ outletType: 'GROCERY', ratingCount: 300 }, { outletType: 'GROCERY', ratingCount: null }, { outletType: 'GROCERY', ratingCount: 9 }]).get('GROCERY')!;
  assert.deepEqual([few.median, few.known], [G.TYPE_PRIOR_COUNT, 2]);
  assert.equal(G.trafficPct(165, b), 80);
  assert.equal(G.trafficPct(10, b), 0);
  assert.equal(G.trafficPct(165, few), null, 'أقل من ٣ معروفة ⇒ لا حصة');
  assert.equal(G.trafficPct(null, b), null);
});

test('Q الجودة: التقييم مشدوداً بعدد مقيّميه', () => {
  assert.equal(G.qualityFactor(4.8, 500), 1.15);
  assert.equal(G.qualityFactor(5, 1), 1, '٥٫٠ من مقيّم واحد ليست ممتازة');
  assert.equal(G.qualityFactor(4.2, 100), 1.05);
  assert.equal(G.qualityFactor(3.6, 300), 1);
  assert.equal(G.qualityFactor(3.1, 300), 0.9);
  assert.equal(G.qualityFactor(2.5, 200), 0.8);
  assert.equal(G.qualityFactor(null, 200), 1);
});

test('الثقة: عالية بـ١٠٠ مقيّم ومراجعات مقروءة، متوسطة بـ٢٠، وإلا منخفضة', () => {
  assert.equal(G.expectedConfidence(150, true), 'HIGH');
  assert.equal(G.expectedConfidence(150, false), 'MEDIUM');
  assert.equal(G.expectedConfidence(20, true), 'MEDIUM');
  assert.equal(G.expectedConfidence(19, true), 'LOW');
  assert.equal(G.expectedConfidence(null, true), 'LOW');
});

test('التقريب: الصنف بالوحدة الكاملة عددٌ صحيح ≥١، والكسري بمنزلة ≥٠٫١', () => {
  assert.equal(G.qtyRound(20.4, 10), 20);
  assert.equal(G.qtyRound(0.3, 2), 1);
  assert.equal(G.qtyRound(0.37, 0.5), 0.4);
  assert.equal(G.qtyRound(0.01, 0.5), 0.1);
});

// ───────────── الصيغة كاملة ─────────────

test('الكمية = المرساة × T × Q × R × M، والمدى ×٠٫٧–×١٫٣، وسطر الأساس بالعربية', () => {
  const b = base([10, 20, 30, 165, 50, 40, 60])!;
  const e = G.expectedFor(input({ rating: 4.2, ratingCount: 165, base: b }));
  const T = Math.sqrt(170 / (b.median + 5)), Q = 1.05;
  const v = 10 * T * Q;
  const p = e.products[0];
  assert.equal(p.qty, Math.round(v));
  assert.equal(p.low, Math.round(v * 0.7));
  assert.equal(p.high, Math.round(v * 1.3));
  assert.equal(p.raw, Math.round(v * 1000) / 1000);
  assert.equal(p.mentioned, false);
  assert.equal(e.basis.Q, 1.05);
  assert.equal(e.basis.R, 1);
  assert.equal(e.basis.typeMedianCount, 40);
  assert.equal(e.basis.typeMedianKnown, true);
  assert.equal(e.basis.reviewsRead, false);
  assert.equal(e.confidence, 'MEDIUM', 'بلا مراجعات مقروءة لا ثقة عالية');
  assert.equal(e.basis.text, `${165} مقيّماً (أكثر من 80٪ من محلات المنطقة) · تقييم 4.2`);
});

test('بالمراجعات: ذكر الصنف ×١٫٣ والمذكور أولاً وسطر الأساس يذكره، والثقة العالية', () => {
  const e = G.expectedFor(input({
    rating: 4.6, ratingCount: 400, products: [pepsi, eggs, bread], anchors: anchors({ eggs: 10, pepsi: 24, bread: 30 }),
    reviews: [R('البيض طازج دايم', 5), R('آخذ منهم البيض كل يوم', 5), R('المحل مرتب', 4)],
  }));
  assert.equal(e.products[0].productId, 'eggs', 'المذكور أولاً ولو كانت كميته أقل');
  assert.equal(e.products[0].mentioned, true);
  assert.equal(e.products[0].mentions, 2);
  assert.equal(e.products[0].quote, 'البيض طازج دايم');
  const T = G.trafficFactor(400, G.TYPE_PRIOR_COUNT), Q = G.qualityFactor(4.6, 400);
  assert.equal(e.products[0].qty, Math.round(10 * T * Q * 1.3));
  assert.deepEqual(e.products.slice(1).map(p => p.productId), ['bread', 'pepsi'], 'ثم بالكمية');
  assert.equal(e.confidence, 'HIGH');
  assert.equal(e.basis.reviews, 3);
  assert.deepEqual(e.basis.mentions, [{ name: 'بيض المراعي 30 حبة', reviews: 2 }]);
  assert.match(e.basis.text, /يُذكر «بيض المراعي 30 حبة» في مراجعتين/);
  assert.equal(e.basis.typeMedianKnown, false, 'بلا مسح: المسبق ٤٠');
});

test('الشكوى من الصنف طلبٌ قائم ×١٫٢ وتلميح؛ والمحل المغلق ×٠٫٨', () => {
  const e = G.expectedFor(input({ ratingCount: 50, reviews: [R('البيض غير طازج', 2)] }));
  assert.equal(e.products[0].complaint, 'QUALITY');
  assert.equal(e.products[0].qty, Math.round(10 * G.trafficFactor(50, 40) * 1.2));
  const closing = G.expectedFor(input({ ratingCount: 50, reviews: [R('المحل مسكر نهائي', 1)] }));
  assert.equal(closing.basis.R, 0.8);
  assert.match(closing.basis.text, /حديث عن إغلاق المحل/);
});

test('بلا مرساة (لم يُبع) ⇒ لا رقم وسببه، آخر القائمة؛ والعدد المجهول ⇒ T=1 وثقة منخفضة', () => {
  const e = G.expectedFor(input({ products: [pepsi, eggs], anchors: anchors({ eggs: 6 }) }));
  assert.deepEqual(e.products.map(p => p.productId), ['eggs', 'pepsi']);
  assert.deepEqual({ qty: e.products[1].qty, reason: e.products[1].reason, low: e.products[1].low }, { qty: null, reason: 'NO_ANCHOR', low: null });
  assert.equal(e.products[0].qty, 6, 'بلا إشارات = المرساة');
  assert.equal(e.basis.T, 1);
  assert.equal(e.basis.ratingCount, null);
  assert.equal(e.confidence, 'LOW');
  assert.equal(e.basis.text, 'عدد المقيّمين غير معروف');
  assert.equal(G.topExpected(G.expectedFor(input({ anchors: new Map() }))), null, 'لا رقم ⇒ لا سطر');
  // بلا إشارة تخصّ المحل الرقمُ حجمُ الطلب المعتاد نفسه لكل المحلات: يبقى في البطاقة ولا يصل العقل كرقم هذا المحل
  assert.equal(G.hasShopSignal(e.basis), false);
  assert.equal(G.topExpected(e), null);
  assert.ok(G.topExpected(G.expectedFor(input({ rating: 4.1 }))), 'التقييم وحده إشارة');
  assert.ok(G.topExpected(G.expectedFor(input({ reviews: [] }))), 'المراجعات المقروءة (ولو بلا نص) إشارة');
});

test('الثقة العالية بنصوص مراجعات مقروءة فعلاً: محلٌّ قُرئ ملفه بلا مراجعات نصية ثقته متوسطة', () => {
  assert.equal(G.expectedFor(input({ ratingCount: 300, reviews: [] })).confidence, 'MEDIUM');
  assert.equal(G.expectedFor(input({ ratingCount: 300, reviews: [R('', 5)] })).confidence, 'MEDIUM', 'نجوم بلا نص');
  assert.equal(G.expectedFor(input({ ratingCount: 300, reviews: [R('محل مرتب', 5)] })).confidence, 'HIGH');
});

test('الترتيب بالقيمة حين تُعرض المبالغ، وحتى ٦ أصناف', () => {
  const many = Array.from({ length: 9 }, (_, i) => P(`p${i}`, `صنف ${i}`));
  const anc = anchors(Object.fromEntries(many.map((p, i) => [p.productId, [i + 1, 100 - i * 10] as [number, number]])));
  const byQty = G.expectedFor(input({ products: many, anchors: anc }));
  assert.equal(byQty.products.length, G.MAX_EXPECTED_PRODUCTS);
  assert.equal(byQty.products[0].productId, 'p8', 'بلا مبالغ: الأكثر كمية');
  const byValue = G.expectedFor(input({ products: many, anchors: anc, showMoney: true }));
  // القيمة (i+1)·(100−10i): الأعلى عند i=4 (5×60=300) ثم i=5 (6×50) وi=3 (4×70)…
  assert.deepEqual(byValue.products.slice(0, 3).map(p => p.productId), ['p4', 'p5', 'p3']);
});

test('المعامل المتعلَّم C: يضرب المعروض لا الخام، ومحصور في [٠٫٥، ٢]، ونسخته للّقطة وحدها', () => {
  const e = G.expectedFor(input({ ratingCount: 40, cal: { factor: 1.5, version: 7 } }));
  assert.equal(e.products[0].raw, 10);
  assert.equal(e.products[0].qty, 15);
  assert.equal(e.calVersion, 7);
  assert.equal(e.basis.cal, 1.5);
  assert.equal(G.expectedFor(input({ ratingCount: 40, cal: { factor: 9, version: 2 } })).products[0].qty, 20, 'محصور عند ٢');
  assert.equal(G.expectedFor(input({ ratingCount: 40, cal: { factor: 1, version: null } })).calVersion, null);
  const view = G.expectedView(e);
  assert.equal('calVersion' in view, false);
  assert.equal('raw' in view.products[0], false, 'الخام لا يُرسل للجهاز');
  const sh = G.shownOf(e, 'GROCERY', 1000)!;
  assert.deepEqual(sh, { at: 1000, outletType: 'GROCERY', confidence: 'MEDIUM', calVersion: 7, factor: 1.5, products: [{ productId: 'eggs', qty: 15, raw: 10 }] });
});

test('مدخل العقل: أبرز صنف للتوجيه وحتى ثلاثة للدراسة بأرقامها ومداها', () => {
  const e = G.expectedFor(input({ ratingCount: 40, products: [eggs, milk, bread, pepsi], anchors: anchors({ eggs: 10, milk: 5, bread: 3, pepsi: 1 }), reviews: [R('الحليب ممتاز', 5)] }));
  assert.deepEqual(G.topExpected(e), { product: 'حليب نادك كامل الدسم 1 لتر', unit: 'كرتون', qty: e.products[0].qty, mentioned: true });
  const s = G.studyExpected(e);
  assert.equal(s.length, 3);
  assert.deepEqual(Object.keys(s[0]).sort(), ['high', 'low', 'mentioned', 'product', 'qty', 'unit']);
});

// ───────────── البيانات: المرساة وأصناف المندوب ─────────────

test('المرساة: استعلام مجمَّع واحد معزول بالشركة على الفواتير، وبنود البيع المؤكَّد وحدها، وذاكرة ١٠ دقائق', async () => {
  D.clearAnchorCache();
  rawCalls = []; rawFail = false;
  rawRows = [
    { productId: 'eggs', qty: 4, price: 12.5, invoices: 30 },
    { productId: 'rare', qty: 2, price: 5, invoices: 2 },
    { productId: 'zero', qty: 0, price: 5, invoices: 9 },
    { productId: 'free', qty: 3, price: 0, invoices: 9 },
  ];
  const now = new Date('2026-09-30T10:00:00Z');
  const a = await D.loadAnchors('T1', now);
  assert.deepEqual([...a.keys()], ['eggs', 'free'], 'أقل من ٣ فواتير أو كمية غير موجبة ⇒ بلا مرساة');
  assert.deepEqual(a.get('eggs'), { qty: 4, price: 12.5, invoices: 30 });
  assert.equal(a.get('free')!.price, null);
  assert.equal(rawCalls.length, 1);
  const q = rawCalls[0];
  const sql = q.strings.join('?');
  assert.match(sql, /FROM invoice_items ii\s+JOIN invoices i ON i\.id = ii\."invoiceId" AND i\."tenantId" = \?/);
  assert.match(sql, /i\.status = 'CONFIRMED' AND i\.type IN \('CASH', 'CREDIT'\)/);
  assert.match(sql, /percentile_cont\(0\.5\) WITHIN GROUP \(ORDER BY ii\.qty\)/);
  assert.match(sql, /ii\.qty > 0/);
  assert.match(sql, /GROUP BY 1/);
  assert.equal(q.values.length, 2);
  assert.equal(q.values[0], 'T1');
  assert.equal((q.values[1] as Date).toISOString(), '2026-03-30T10:00:00.000Z', 'ستة أشهر');
  await D.loadAnchors('T1', now);
  assert.equal(rawCalls.length, 1, 'من الذاكرة');
  await D.loadAnchors('T2', now);
  assert.equal(rawCalls.length, 2, 'لكل شركة ذاكرتها');
});

test('المرساة: الفشل لا يُحفظ في الذاكرة', async () => {
  D.clearAnchorCache();
  rawCalls = []; rawFail = true;
  await assert.rejects(D.loadAnchors('T9'));
  rawFail = false; rawRows = [];
  assert.equal((await D.loadAnchors('T9')).size, 0);
  assert.equal(rawCalls.length, 2);
});

test('أصناف المندوب: سيارته (المتبقّي > ٠ بترتيبه، فعّالة غير مؤرشفة)، وإلا ذات الأولوية، وإلا الأكثر فواتيراً', async () => {
  productRows = [{ id: 'eggs', name: 'بيض', unit: 'كرتون' }, { id: 'milk', name: 'حليب', unit: 'كرتون' }, { id: 'water', name: 'مياه', unit: 'كرتون' }];
  productWhere = [];
  const anc = new Map<string, Anchor>([['water', { qty: 5, price: null, invoices: 40 }], ['milk', { qty: 2, price: null, invoices: 90 }]]);
  const van = await D.loadDemandProducts('T1', 'r1', ['water'], anc, async () => [
    { productId: 'milk', remaining: 3 }, { productId: 'eggs', remaining: 12 }, { productId: 'gone', remaining: 0 }, { productId: 'deleted', remaining: 5 },
  ]);
  assert.equal(van.source, 'VAN');
  assert.deepEqual(van.products.map(p => p.productId), ['eggs', 'milk'], 'بترتيب الكمية، والمحذوف وغير الفعّال يسقطان');
  assert.deepEqual(productWhere[0], { tenantId: 'T1', id: { in: ['eggs', 'deleted', 'milk'] }, status: 'ACTIVE', deletedAt: null });
  const pri = await D.loadDemandProducts('T1', 'r1', ['water'], anc, async () => []);
  assert.deepEqual([pri.source, pri.products.map(p => p.productId)], ['PRIORITY', ['water']]);
  const cat = await D.loadDemandProducts('T1', 'r1', [], anc, async () => [{ productId: 'eggs', remaining: 0 }]);
  assert.deepEqual([cat.source, cat.products.map(p => p.productId)], ['CATALOG', ['milk', 'water']]);
});
