/**
 * المندوب الذكي — المسح العام لخرائط Google (بلا مفتاح) وتوجيه المندوب بعده.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePublicSearch, publicSearch, publicSearchUrl } from '../ai-rep/publicMaps';
import { aiGuide, daysAgoAr, eligibleShops, followUpShops, ruleGuide, shopScore, visitedRecently, type ScanShop } from '../ai-rep/scanGuide';

/** مدخل نتيجة بشكل ردّ Google: الحقول في مواضعها والباقي فارغ. */
function entry(o: { name: string; placeId: string; lat: number; lng: number; rating?: number; cats?: string[]; address?: string; open?: string }) {
  const x: unknown[] = new Array(210).fill(null);
  x[4] = [null, null, null, null, null, null, null, o.rating ?? null];
  x[9] = [null, null, o.lat, o.lng];
  x[10] = '0x0:0x1';
  x[11] = o.name;
  x[13] = o.cats ?? [];
  x[39] = o.address ?? null;
  x[78] = o.placeId;
  x[203] = o.open ? [[null, [o.open]]] : null;
  return [null, x];
}
const body = (list: unknown[]) => {
  const d: unknown[] = new Array(70).fill(null);
  d[64] = list;
  return `)]}'\n${JSON.stringify({ c: 0, d: `)]}'\n${JSON.stringify(d)}` })}`;
};

test('المسح العام: تحليل ردّ Google — الاسم والتقييم والموقع والنوع وحالة الفتح، وتجاوز الناقص', () => {
  const r = parsePublicSearch(body([
    entry({ name: 'تموينات الريان', placeId: 'ChIJaaa', lat: 24.71, lng: 46.67, rating: 4.2, cats: ['متجر بقالة'], address: 'حي الملز', open: 'مفتوح · يغلق عند الساعة ١١ م' }),
    entry({ name: 'بقالة النور', placeId: 'ChIJbbb', lat: 24.72, lng: 46.68, open: 'مغلق · يفتح عند الساعة ٧ ص' }),
    [null, 'ليس محلاً'],
    entry({ name: '', placeId: 'ChIJccc', lat: 1, lng: 1 }),
  ]));
  assert.ok(r);
  assert.equal(r.length, 2);
  assert.deepEqual(
    { n: r[0].name, id: r[0].placeId, rt: r[0].rating, c: r[0].categories, a: r[0].address, o: r[0].openNow },
    { n: 'تموينات الريان', id: 'ChIJaaa', rt: 4.2, c: ['متجر بقالة'], a: 'حي الملز', o: true },
  );
  assert.equal(r[1].openNow, false);
  assert.equal(r[1].rating, null);
  // صفحة حجب/HTML ⇒ null، وردّ بلا نتائج ⇒ []
  assert.equal(parsePublicSearch('<html>unusual traffic</html>'), null);
  assert.deepEqual(parsePublicSearch(body([]).replace('[]', 'null')), []);
});

test('المسح العام: الرابط يحمل الاستعلام والموقع، والحجب يُبلَّغ لا يُتحايَل عليه', async () => {
  const u = publicSearchUrl('بقالة', 24.7, 46.6, 1000);
  assert.match(u, /^https:\/\/www\.google\.com\/search\?tbm=map/);
  assert.ok(decodeURIComponent(u).includes('!2d46.600000!3d24.700000'));
  const blocked = await publicSearch({ query: 'بقالة', lat: 24.7, lng: 46.6, spanM: 1000, fetchImpl: async () => ({ ok: false, status: 429, text: async () => '' }) });
  assert.equal(blocked.ok, false);
  assert.equal(!blocked.ok && blocked.code, 'BLOCKED');
  const captcha = await publicSearch({ query: 'بقالة', lat: 24.7, lng: 46.6, spanM: 1000, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>captcha</html>' }) });
  assert.equal(!captcha.ok && captcha.code, 'BLOCKED');
  const down = await publicSearch({ query: 'بقالة', lat: 24.7, lng: 46.6, spanM: 1000, fetchImpl: async () => { throw new Error('net'); } });
  assert.equal(!down.ok && down.code, 'UNAVAILABLE');
  const ok = await publicSearch({ query: 'بقالة', lat: 24.7, lng: 46.6, spanM: 1000, fetchImpl: async () => ({ ok: true, status: 200, text: async () => body([entry({ name: 'أ', placeId: 'ChIJx', lat: 24.7, lng: 46.6 })]) }) });
  assert.equal(ok.ok && ok.places.length, 1);
});

const shop = (ref: string, o: Partial<ScanShop> = {}): ScanShop => ({
  ref, name: `محل ${ref}`, category: 'متجر بقالة', rating: 4, openNow: true, distanceM: 300, lat: 24.7, lng: 46.6, relation: 'NEW', rejectedRecently: false, ...o,
});

test('توجيه المسح الحتمي: الفرص الجديدة وحدها، بالتقييم والفتح والقرب، حتى خمس', () => {
  assert.ok(shopScore(shop('P1', { rating: 4.5 })) > shopScore(shop('P2', { rating: 3 })));
  assert.ok(shopScore(shop('P1')) > shopScore(shop('P2', { openNow: false })));
  assert.ok(shopScore(shop('P1', { distanceM: 100 })) > shopScore(shop('P2', { distanceM: 2000 })));
  const shops = [
    shop('P1', { relation: 'CUSTOMER' }),
    shop('P2', { rejectedRecently: true }),
    ...['P3', 'P4', 'P5', 'P6', 'P7', 'P8'].map((r, i) => shop(r, { distanceM: 100 + i * 100, lat: 24.7 + i * 0.001 })),
  ];
  const g = ruleGuide(shops, { lat: 24.7, lng: 46.6 });
  assert.equal(g.source, 'RULES');
  assert.equal(g.stops.length, 5);
  assert.ok(!g.stops.some(s => s.ref === 'P1' || s.ref === 'P2'));
  assert.ok(!g.stops.some(s => s.ref === 'P8'));
  assert.match(g.stops[0].why, /تقييمه 4/);
  assert.match(g.summary, /حولك 8 محلاً/);
  assert.equal(ruleGuide([shop('P1', { relation: 'CUSTOMER' })], { lat: 0, lng: 0 }).stops.length, 0);
});

const NOW = new Date('2026-09-20T09:00:00Z');
const ago = (h: number) => new Date(NOW.getTime() - h * 3600000).toISOString();

test('توجيه المسح وذاكرة الفريق: المزور خلال التهدئة لا يعود فرصة، والمهتم بعدها متابعة بسببه، و«ربما عميل» لا يُعدّ من عملائك', () => {
  const shops = [
    shop('P1', { lastOutcome: 'INTERESTED', lastOutcomeAt: ago(5), distanceM: 20 }), // زاره زميل اليوم وهو الأقرب
    shop('P2', { lastOutcome: 'QUOTE', lastOutcomeAt: ago(4 * 24), distanceM: 400 }),
    shop('P3', { lastOutcome: 'CLOSED', lastOutcomeAt: ago(30), distanceM: 300 }), // وُجد مغلقاً أمس ⇒ فرصة من جديد
    shop('P4', { reportedClosed: true, lastOutcome: 'NOT_FOUND', lastOutcomeAt: ago(10 * 24), distanceM: 50 }),
    shop('P5', { lastOutcome: 'NOT_INTERESTED', lastOutcomeAt: ago(5 * 24), rejectedRecently: true, distanceM: 60 }),
    shop('P6', { relation: 'POSSIBLE_CUSTOMER', distanceM: 70 }),
    shop('P7', { relation: 'CUSTOMER', distanceM: 80 }),
    shop('P8', { distanceM: 500 }),
    shop('P9', { lastOutcome: 'NOT_FOUND', lastOutcomeAt: ago(40 * 24), distanceM: 600 }), // انقضى وسمه ⇒ فرصة بتنبيه
  ];
  assert.deepEqual(eligibleShops(shops, NOW).map(s => s.ref), ['P3', 'P8', 'P9']);
  assert.deepEqual(followUpShops(shops, NOW).map(s => s.ref), ['P2']);
  assert.ok(visitedRecently(shops[0], NOW));
  assert.ok(!visitedRecently(shops[2], NOW), '«مغلق الآن» لا يدخل التهدئة');
  const g = ruleGuide(shops, { lat: 24.7, lng: 46.6 }, NOW);
  assert.deepEqual(new Set(g.stops.map(s => s.ref)), new Set(['P2', 'P3', 'P8', 'P9']));
  const byRef = new Map(g.stops.map(s => [s.ref, s]));
  assert.equal(byRef.get('P2')!.kind, 'FOLLOW_UP');
  assert.match(byRef.get('P2')!.why, /^متابعة: طلب عرض سعر قبل 4 أيام/);
  assert.equal(byRef.get('P3')!.kind, 'NEW');
  assert.match(byRef.get('P3')!.why, /وُجد مغلقاً في زيارة سابقة/);
  assert.match(byRef.get('P9')!.why, /أُبلغ سابقاً أنه لم يُعثر عليه/);
  assert.match(g.summary, /منها 3 فرصة جديدة و1 للمتابعة و1 من عملائك و1 ربما من عملائك/);
  assert.equal(daysAgoAr(0.5), 'اليوم');
  assert.equal(daysAgoAr(12), 'قبل 12 يوماً');
  // لا فرص ولا متابعات ⇒ لا يدّعي «غير مزورة»
  const none = ruleGuide([shops[0], shops[4]], { lat: 0, lng: 0 }, NOW);
  assert.equal(none.stops.length, 0);
  assert.match(none.summary, /ولا فرص جديدة ولا متابعات مستحقّة الآن/);
});

test('توجيه المسح بالعقل: المتابعة تُقبل بنوعها وأيامها، والمزور خلال التهدئة يُرفض', async () => {
  const cfg = { provider: 'groq', apiKey: 'k', model: 'm', baseUrl: 'http://x' } as never;
  const shops = [shop('P1', { lastOutcome: 'CALL_BACK', lastOutcomeAt: ago(6 * 24) }), shop('P2', { lastOutcome: 'INTERESTED', lastOutcomeAt: ago(2) }), shop('P3')];
  let sent = '';
  const r = await aiGuide(shops, {
    cfg, playbook: null, origin: { lat: 24.7, lng: 46.6 }, now: NOW,
    llm: (async (_c: unknown, req: { messages: { content: string }[] }) => {
      sent = req.messages[1].content;
      return { ok: true as const, content: JSON.stringify({ summary: 'ابدأ بالمتابعة', plan: [{ ref: 'P1', why: 'طلب العودة قبل 6 أيام' }, { ref: 'P2', why: 'مهتم' }, { ref: 'P3', why: 'قريب' }] }), usage: { promptTokens: 1, completionTokens: 1 } };
    }) as never,
  });
  assert.ok(r.guide);
  assert.deepEqual(r.guide.stops.map(s => [s.ref, s.kind]), [['P1', 'FOLLOW_UP'], ['P3', 'NEW']]);
  assert.equal(r.guide.stops[0].why, 'طلب العودة قبل 6 أيام', 'أيام المتابعة في القائمة ⇒ رقم مسموح');
  assert.match(sent, /"days_since_visit":6/);
  assert.match(sent, /زاره الفريق مؤخراً/);
});

test('توجيه المسح بالعقل: مراجع الفرص وحدها، والأرقام المخترعة تُسقَط، والتعثّر ⇒ null', async () => {
  const cfg = { provider: 'groq', apiKey: 'k', model: 'm', baseUrl: 'http://x' } as never;
  const shops = [shop('P1'), shop('P2', { relation: 'CUSTOMER' }), shop('P3', { rating: 4.4 })];
  const reply = (content: string) => async () => ({ ok: true as const, content, usage: { promptTokens: 10, completionTokens: 5 } });
  const r = await aiGuide(shops, {
    cfg, playbook: null, origin: { lat: 24.7, lng: 46.6 },
    llm: reply(JSON.stringify({ summary: 'المنطقة فيها فرص جيدة', plan: [{ ref: 'P3', why: 'تقييمه 4.4 وقريب' }, { ref: 'P2', why: 'عميل' }, { ref: 'P1', why: 'يبيع 900 كرتون شهرياً' }, { ref: 'P9', why: 'x' }] })) as never,
  });
  assert.ok(r.guide);
  assert.deepEqual(r.guide.stops.map(s => s.ref), ['P3', 'P1']);
  assert.equal(r.guide.stops[0].why, 'تقييمه 4.4 وقريب');
  assert.equal(r.guide.stops[1].why, '');
  const bad = await aiGuide(shops, { cfg, playbook: null, origin: { lat: 0, lng: 0 }, llm: reply('ليس JSON') as never });
  assert.equal(bad.guide, null);
  const fail = await aiGuide(shops, { cfg, playbook: null, origin: { lat: 0, lng: 0 }, llm: (async () => ({ ok: false, code: 'LLM_RATE_LIMIT' })) as never });
  assert.equal(fail.guide, null);
});
