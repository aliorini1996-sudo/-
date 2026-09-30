// المندوب الذكي — دراسة المحل من ملفه في خرائط Google: قراءة الملف، والملخّص الحتمي، وحارس أرقام مخرجات العقل
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaceProfile, placeProfile } from '../ai-rep/places';
import { activityOf, aiStudy, reviewThemes, ruleStudy, sanitizeStudy, studyInput } from '../ai-rep/profileStudy';
import type { LlmConfig, LlmResult } from '../ai-rep/llm';

const RAW = {
  id: 'ChIJN1t_tDeuEmsRUsoyG83frY4',
  displayName: { text: 'تموينات النرجس' },
  primaryTypeDisplayName: { text: 'بقالة' },
  primaryType: 'grocery_store',
  types: ['grocery_store', 'store'],
  formattedAddress: 'حي النرجس، الرياض',
  location: { latitude: 24.85, longitude: 46.65 },
  googleMapsUri: 'https://maps.google.com/?cid=1',
  rating: 4.2,
  userRatingCount: 128,
  regularOpeningHours: { openNow: true, weekdayDescriptions: ['السبت: ٦:٠٠ ص – ١٢:٠٠ ص'] },
  reviews: [
    { rating: 5, originalText: { text: 'محل نظيف والتعامل محترم وكل شي متوفر' }, text: { text: 'Clean shop' }, relativePublishTimeDescription: 'قبل شهر', authorAttribution: { displayName: 'أبو محمد', uri: 'https://maps.google.com/u/1' } },
    { rating: 1, originalText: { text: 'الأسعار غالية جداً وناقص أصناف كثيرة' }, relativePublishTimeDescription: 'قبل أسبوعين', authorAttribution: { displayName: 'سارة' } },
    { rating: 4, text: { text: 'good' } },
  ],
};

test('قراءة ملف المحل: النص الأصلي، والتقييم، والساعات، والمغلق', () => {
  const p = parsePlaceProfile(RAW)!;
  assert.equal(p.name, 'تموينات النرجس');
  assert.equal(p.typeLabel, 'بقالة');
  assert.equal(p.rating, 4.2);
  assert.equal(p.ratingCount, 128);
  assert.equal(p.openNow, true);
  assert.equal(p.hours.length, 1);
  assert.equal(p.reviews.length, 3);
  assert.equal(p.reviews[0].text, 'محل نظيف والتعامل محترم وكل شي متوفر', 'النص الأصلي لا الترجمة');
  assert.equal(p.reviews[0].author, 'أبو محمد');
  assert.equal(p.reviews[2].text, 'good', 'بلا نص أصلي ⇒ المترجم');
  assert.equal(p.closed, false);
  assert.equal(parsePlaceProfile({ ...RAW, businessStatus: 'CLOSED_PERMANENTLY' })!.closed, true);
  assert.equal(parsePlaceProfile({ id: 'x' }), null, 'بلا موقع');
});

test('ملف Google: الحقول المطلوبة بلا صور، وأخطاء المفتاح والحصة', async () => {
  let mask = '', url = '';
  const r = await placeProfile({
    apiKey: 'k', placeId: RAW.id,
    fetchImpl: async (u, init) => { url = u; mask = init.headers['X-Goog-FieldMask']; return { ok: true, status: 200, json: async () => RAW }; },
  });
  assert.ok(r.ok);
  assert.match(mask, /reviews/);
  assert.match(mask, /rating,userRatingCount/);
  assert.ok(!/photos/.test(mask), 'بلا صور');
  assert.match(url, /languageCode=ar&regionCode=SA$/);
  const none = await placeProfile({ apiKey: null, placeId: RAW.id });
  assert.ok(!none.ok && none.code === 'PLACES_NOT_CONFIGURED');
  const q = await placeProfile({ apiKey: 'k', placeId: RAW.id, fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
  assert.ok(!q.ok && q.code === 'PLACES_QUOTA');
});

test('الملخّص الحتمي: النشاط من عدد المقيّمين، ومحاور المديح والشكوى', () => {
  assert.equal(activityOf(500), 'HIGH');
  assert.equal(activityOf(100), 'MEDIUM');
  assert.equal(activityOf(5), 'LOW');
  assert.equal(activityOf(0), 'UNKNOWN');
  const p = parsePlaceProfile(RAW)!;
  const t = reviewThemes(p);
  assert.ok(t.praise.includes('النظافة') && t.praise.includes('التعامل والخدمة') && t.praise.includes('توفّر الأصناف'));
  assert.ok(t.complaints.includes('الأسعار') && t.complaints.includes('توفّر الأصناف'));
  const s = ruleStudy(p);
  assert.equal(s.source, 'RULES');
  assert.match(s.summary, /4\.2/);
  assert.ok(s.opportunity.some(o => o.includes('نقص الأصناف')));
  const empty = ruleStudy(parsePlaceProfile({ ...RAW, rating: undefined, userRatingCount: 0, reviews: [] })!);
  assert.equal(empty.activity, 'UNKNOWN');
  assert.match(empty.summary, /لا تقييمات/);
});

test('مدخل العقل بلا أسماء المراجعين وروابطهم', () => {
  const p = parsePlaceProfile(RAW)!;
  const s = studyInput(p, ['مياه ٣٣٠ مل'], null);
  assert.ok(!s.includes('أبو محمد') && !s.includes('maps.google.com/u/1'));
  assert.ok(s.includes('الأسعار غالية'));
});

test('حارس مخرجات العقل: الأرقام بلا مصدر تُسقط، والمنتجات من الكتالوج وحده', () => {
  const p = parsePlaceProfile(RAW)!;
  const products = ['مياه ٣٣٠ مل', 'عصير برتقال'];
  const out = JSON.stringify({
    summary: 'بقالة تقييمها 4.2 من 128 مقيّماً.',
    activity: 'MEDIUM', activity_why: 'عدد المقيّمين متوسط.',
    praise: ['النظافة', 'يبيع 500 كرتون يومياً'],
    complaints: ['الأسعار'],
    opportunity: ['اعرض توريداً منتظماً'],
    offer: ['مياه ٣٣٠ مل', 'منتج غير موجود'],
    opening_line: 'السلام عليكم، عندنا توريد منتظم.',
    objection: 'السعر', objection_reply: 'نعطيك خصم 20٪',
  });
  const s = sanitizeStudy(out, p, products, null)!;
  assert.equal(s.source, 'AI');
  assert.deepEqual(s.praise, ['النظافة'], 'رقم مخترع ⇒ العنصر يُسقط');
  assert.deepEqual(s.offer, ['مياه ٣٣٠ مل'], 'المنتجات من الكتالوج فقط');
  assert.equal(s.objectionReply, null, 'خصم مخترع ⇒ يُسقط');
  assert.match(s.summary, /4\.2/);
  // وعدٌ بلا رقم لا يفوّضه الدليل ⇒ يُسقط؛ ويمرّ حين يفوّضه
  const promise = JSON.stringify({ summary: 'بقالة', objection: 'السعر', objection_reply: 'نعطيك خصم على أول طلب' });
  assert.equal(sanitizeStudy(promise, p, products, null)!.objectionReply, null);
  assert.equal(sanitizeStudy(promise, p, products, 'نقدّم خصم على أول طلب للعملاء الجدد')!.objectionReply, 'نعطيك خصم على أول طلب');
  assert.equal(sanitizeStudy('ليس JSON', p, products, null), null);
  assert.equal(sanitizeStudy('```json\n{"summary":"محل جيد"}\n```', p, products, null)?.summary, 'محل جيد');
});

test('الدراسة بالعقل: نجاح، وإعادة عند مخرج معطوب، وفشل ⇒ null', async () => {
  const p = parsePlaceProfile(RAW)!;
  const cfg: LlmConfig = { baseUrl: 'https://x', apiKey: 'k', model: 'm', extraBody: {}, timeoutMs: 1000, maxTokens: 100 };
  const usage = { promptTokens: 10, completionTokens: 5, cachedTokens: 0 };
  const ok = (content: string): LlmResult => ({ ok: true, content, toolCalls: [], usage, finishReason: 'stop' });
  let calls = 0;
  const r1 = await aiStudy(p, { cfg, products: [], playbook: null, llm: async () => { calls++; return calls === 1 ? ok('xx') : ok('{"summary":"بقالة مرتبة"}'); } });
  assert.equal(calls, 2);
  assert.equal(r1.study?.summary, 'بقالة مرتبة');
  assert.equal(r1.tokensIn, 20);
  const r2 = await aiStudy(p, { cfg, products: [], playbook: null, llm: async () => ({ ok: false, code: 'LLM_RATE_LIMIT' }) });
  assert.equal(r2.study, null);
  assert.equal(r2.code, 'LLM_RATE_LIMIT');
  // المضيف يرفض response_format ⇒ إعادة بدونه
  let formats: unknown[] = [];
  await aiStudy(p, { cfg, products: [], playbook: null, llm: async (_c, req) => { formats.push(req.responseFormat); return formats.length === 1 ? { ok: false, code: 'LLM_BAD_REQUEST' } : ok('{"summary":"تمام"}'); } });
  assert.deepEqual(formats, ['json_object', undefined]);
  formats = [];
});

test('مراجعات ملصقة من تطبيق خرائط Google: التقييم والعدد من النص، والتقطيع، والقطبية بلا نجوم', async () => {
  const { profileFromPaste } = await import('../ai-rep/profileStudy');
  const text = 'تموينات الريان\n٤٫٣ ★★★★☆ (١٢٨)\n\nمحل نظيف والتعامل ممتاز وكل شي متوفر\n\nالأسعار غالية وناقص أصناف كثيرة، ما أنصح\n\nok';
  const p = profileFromPaste({ name: 'تموينات الريان', text, lat: 24.8, lng: 46.6 });
  assert.equal(p.rating, 4.3);
  assert.equal(p.ratingCount, 128);
  assert.ok(p.reviews.length >= 2);
  const t = reviewThemes(p);
  assert.ok(t.praise.includes('النظافة') && t.praise.includes('توفّر الأصناف'));
  assert.ok(t.complaints.includes('الأسعار'));
  const s = ruleStudy(p);
  assert.match(s.summary, /4\.3/);
  // إدخال صريح يغلب النص، ونص بلا مراجعات
  assert.equal(profileFromPaste({ text: 'مراجعة: خدمة ممتازة جداً وسريعة', rating: 3.9, lat: 1, lng: 1 }).rating, 3.9);
  assert.equal(profileFromPaste({ text: '12345', lat: 1, lng: 1 }).reviews.length, 0);
});
