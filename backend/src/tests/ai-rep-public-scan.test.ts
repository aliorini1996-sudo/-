/**
 * المندوب الذكي — المسح العام لخرائط Google (بلا مفتاح) وتوجيه المندوب بعده.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePublicSearch, publicSearch, publicSearchUrl } from '../ai-rep/publicMaps';
import { aiGuide, ruleGuide, shopScore, type ScanShop } from '../ai-rep/scanGuide';

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
