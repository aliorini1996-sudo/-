/**
 * المندوب الذكي — المسح العام لخرائط Google (بلا مفتاح) وتوجيه المندوب بعده.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BREAKER_OPEN_MS, REP_RETRY_MS, breakerLeftMs, notePublicScanShops, noteRepScanFailed, openFlag, parsePublicSearch, publicScan, publicScanHealth,
  publicSearch, publicSearchUrl, repRetryLeftMs, resetPublicSearchState, type PublicPlace, type PublicSearchResult,
} from '../ai-rep/publicMaps';
import {
  CHANCE_AR, RATER_AR, SHOP_AR, aiGuide, countAr, daysAgoAr, distAr, eligibleShops, followUpShops, ruleGuide, shopScore, shrunkRating,
  visitedRecently, type ScanShop,
} from '../ai-rep/scanGuide';
import { publicOutletType, searchTermsFor } from '../ai-rep/taxonomy';
import { mergeNearby } from '../ai-rep/nearby';

// ── مدخلات اصطناعية بشكل ردّ Google الحقيقي (المواضع مأخوذة من ردٍّ حقيقي لُقط مرةً للتطوير، بلا بياناته) ──

/** يوم في جدول الأسبوع: [اسمه، رقمه، التاريخ، [[نصّ الساعات، [[من], [إلى]]]]، 0، 1]. */
const day = (name: string, n: number, hours: string) => [name, n, [2026, 9, 30], [[hours, [[7], []]]], 0, n === 5 && hours === 'مغلق' ? 2 : 1];
const WEEK_DAYS: [string, number][] = [['الأربعاء', 3], ['الخميس', 4], ['الجمعة', 5], ['السبت', 6], ['الأحد', 7], ['الاثنين', 1], ['الثلاثاء', 2]];
/**
 * جزء ساعات العمل x[203]: [0] جدول الأسبوع، و[1] حالة الآن: [اليوم، 0، رمزها (1 مفتوح، 2 يغلق قريباً، 5 مغلق)،
 * null، [سطرها، نمط]، [سطرها، نمط]، null، [ساعة الإغلاق]، [«مفتوح/مغلق»، نمط]]، ثم 3، null، null، null، 6.
 */
function hoursBlock(o: { status: string; short?: string; code?: number; friday?: string; hours?: string }) {
  const week = WEEK_DAYS.map(([d, n]) => day(d, n, d === 'الجمعة' && o.friday ? o.friday : o.hours ?? '٧:٠٠ص–١٢:٠٠ص'));
  const style = [[0, 5, [null, [1, 2]]]];
  return [week, [week[0], 0, o.code ?? 1, null, [o.status, style], [o.status, style], null, [24], o.short ? [o.short, style] : null], 3, null, null, null, 6];
}

/** مدخل نتيجة: x[4] [.., [رابط المراجعات، «عدد التعليقات»], .., التقييم [7]، العدد [8]]، x[9] الموقع، x[11] الاسم، x[13] التصنيف، x[78] المعرّف. */
function entry(o: {
  name: string; placeId: string; lat: number; lng: number; rating?: number; count?: number; cats?: string[]; address?: string;
  hours?: unknown; x34?: unknown;
}) {
  const x: unknown[] = new Array(260).fill(null);
  if (o.rating != null) x[4] = [null, null, null, ['https://search.google.com/local/reviews?placeid=x', `عدد التعليقات: ${o.count ?? 0}`, null, 'tok'], null, null, null, o.rating, o.count ?? null];
  x[9] = [null, null, o.lat, o.lng];
  x[10] = '0x0:0x1';
  x[11] = o.name;
  x[13] = o.cats ?? [];
  x[34] = o.x34 ?? null;
  x[39] = o.address ?? null;
  x[78] = o.placeId;
  x[203] = o.hours ?? null;
  return [null, x];
}
/** الردّ: [0][0] صدى الاستعلام، و[64] القائمة (null في منطقة خالية). */
const body = (list: unknown[] | null, query: string | null = 'بقالة') => {
  const d: unknown[] = new Array(72).fill(null);
  d[0] = query == null ? null : [query, [[null, null, 'tok']], null, 1];
  d[64] = list;
  return `)]}'\n${JSON.stringify(d)}`;
};
const places = (r: ReturnType<typeof parsePublicSearch>): PublicPlace[] => {
  assert.ok(Array.isArray(r), `ليس قائمة: ${String(r)}`);
  return r;
};

test('المسح العام: تحليل ردّ Google — الاسم والتقييم وعدد المقيّمين والموقع والتصنيف وساعات الأسبوع، وتجاوز الناقص', () => {
  const r = places(parsePublicSearch(body([
    entry({ name: 'تموينات الريان', placeId: 'ChIJaaa', lat: 24.71, lng: 46.67, rating: 4.2, count: 165, cats: ['متجر بقالة'], address: 'حي الملز',
      hours: hoursBlock({ status: 'مفتوح · يغلق عند الساعة ١٢ ص', short: 'مفتوح', friday: 'مغلق' }) }),
    entry({ name: 'بقالة النور', placeId: 'ChIJbbb', lat: 24.72, lng: 46.68, hours: hoursBlock({ status: 'مغلق · يفتح يوم الخميس عند الساعة ٩:٣٠ ص', short: 'مغلق', code: 5 }) }),
    [null, 'ليس محلاً'],
    entry({ name: '', placeId: 'ChIJccc', lat: 1, lng: 1 }),
  ])));
  assert.equal(r.length, 2);
  assert.deepEqual(
    { n: r[0].name, id: r[0].placeId, rt: r[0].rating, rc: r[0].ratingCount, c: r[0].categories, a: r[0].address, o: r[0].openNow, cl: r[0].closed },
    { n: 'تموينات الريان', id: 'ChIJaaa', rt: 4.2, rc: 165, c: ['متجر بقالة'], a: 'حي الملز', o: true, cl: false },
  );
  // عطلة الجمعة في جدول الأسبوع لا تَسِم المحل «مغلق الآن» — الحالة من خانتها
  assert.equal(r[0].hours.length, 7);
  assert.ok(r[0].hours.includes('الجمعة: مغلق'));
  assert.equal(r[0].openText, 'مفتوح · يغلق عند الساعة ١٢ ص');
  assert.equal(r[1].openNow, false);
  assert.equal(r[1].rating, null);
  assert.equal(r[1].ratingCount, null);
  // بلا ساعات ⇒ حالة مجهولة وساعات فارغة
  const bare = places(parsePublicSearch(body([entry({ name: 'ب', placeId: 'ChIJddd', lat: 1, lng: 1 })])))[0];
  assert.deepEqual([bare.openNow, bare.openText, bare.hours], [null, null, []]);
});

test('المسح العام: «سيغلق قريبًا» مفتوح و«سيفتح قريبًا» مغلق، والمغلق نهائياً/مؤقتاً يُعلَّم', () => {
  assert.equal(openFlag('سيغلق قريبًا: · عند الساعة ٨:٥١ م · يفتح يوم الخميس'), true);
  assert.equal(openFlag('يغلق قريبًا'), true);
  assert.equal(openFlag('سيفتح قريبًا · ٧ ص'), false);
  assert.equal(openFlag('مغلق · يفتح ٧ ص'), false);
  assert.equal(openFlag('مفتوح على مدار الساعة'), true);
  assert.equal(openFlag('نعمل على مدار 24 ساعة'), null);
  const r = places(parsePublicSearch(body([
    entry({ name: 'أ', placeId: 'ChIJa1', lat: 1, lng: 1, hours: hoursBlock({ status: 'سيغلق قريبًا: · عند الساعة ٨:٥١ م', code: 2 }) }),
    entry({ name: 'ب', placeId: 'ChIJb1', lat: 1, lng: 1, hours: hoursBlock({ status: 'سيفتح قريبًا · عند الساعة ٧ ص', code: 3 }) }),
    entry({ name: 'ج', placeId: 'ChIJc1', lat: 1, lng: 1, hours: hoursBlock({ status: 'مغلق نهائيًا', short: 'مغلق', code: 5 }) }),
    entry({ name: 'د', placeId: 'ChIJd1', lat: 1, lng: 1, x34: [null, null, null, null, [null, null, null, null, 'مغلق مؤقتًا']] }),
  ])));
  assert.deepEqual(r.map(p => [p.openNow, p.closed]), [[true, false], [false, false], [false, true], [null, true]]);
});

test('المسح العام: المنطقة الخالية [] والصيغة المجهولة CHANGED والحجب null', () => {
  // منطقة خالية فعلاً: صدى الاستعلام بلا قائمة
  assert.deepEqual(parsePublicSearch(body(null)), []);
  assert.deepEqual(parsePublicSearch(body([])), []);
  // لا صدى ولا قائمة، أو قائمة لا يُقرأ منها محل ⇒ غيّرت Google صيغتها
  assert.equal(parsePublicSearch(body(null, null)), 'CHANGED');
  assert.equal(parsePublicSearch(body([[null, 'ليس محلاً'], [null, [1, 2, 3]]])), 'CHANGED');
  // الردّ الخالي الحقيقي يحمل مكان المنطقة نفسها في [0] — يبقى منطقة خالية
  const emptyWithArea = JSON.parse(body(null).slice(5)) as unknown[];
  (emptyWithArea[0] as unknown[])[1] = [entry({ name: 'الملز', placeId: 'ChIJj9AA0tirLz4R6f5u831V3GI', lat: 24.7, lng: 46.7 })];
  assert.deepEqual(parsePublicSearch(`)]}'\n${JSON.stringify(emptyWithArea)}`), []);
  // القائمة انتقلت من [64] والصدى باقٍ ⇒ CHANGED لا «لا محلات حولك» بصمت
  const moved = JSON.parse(body(null).slice(5)) as unknown[];
  moved[65] = [entry({ name: 'أ', placeId: 'ChIJmovedPlace01', lat: 1, lng: 1 })];
  assert.equal(parsePublicSearch(`)]}'\n${JSON.stringify(moved)}`), 'CHANGED');
  assert.equal(parsePublicSearch('<html>unusual traffic</html>'), null);
  // الغلاف القديم {c, d} ما زال يُقرأ
  const wrapped = `)]}'\n${JSON.stringify({ c: 0, d: body([entry({ name: 'أ', placeId: 'ChIJw', lat: 1, lng: 1 })]) })}`;
  assert.equal(places(parsePublicSearch(wrapped)).length, 1);
});

const okText = (list: unknown[] | null) => async () => ({ ok: true, status: 200, text: async () => body(list) });

test('المسح العام: الرابط يحمل الاستعلام والموقع، والحجب والصيغة المجهولة يُبلَّغان لا يُتحايَل عليهما', async () => {
  resetPublicSearchState();
  const u = publicSearchUrl('بقالة', 24.7, 46.6, 1000);
  assert.match(u, /^https:\/\/www\.google\.com\/search\?tbm=map/);
  assert.ok(decodeURIComponent(u).includes('!2d46.600000!3d24.700000'));
  const blocked = await publicSearch({ query: 'بقالة', lat: 24.7, lng: 46.6, spanM: 1000, fetchImpl: async () => ({ ok: false, status: 429, text: async () => '' }) });
  assert.equal(blocked.ok, false);
  assert.equal(!blocked.ok && blocked.code, 'BLOCKED');
  const captcha = await publicSearch({ query: 'بقالة', lat: 24.7, lng: 46.6, spanM: 1000, fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html>captcha</html>' }) });
  assert.equal(!captcha.ok && captcha.code, 'BLOCKED');
  resetPublicSearchState();
  const empty = await publicSearch({ query: 'مخبز', lat: 24.7, lng: 46.6, spanM: 1000, fetchImpl: okText(null) });
  assert.ok(empty.ok && empty.places.length === 0, 'منطقة خالية ⇒ نجاح بلا محلات');
  const down = await publicSearch({ query: 'بقالة', lat: 24.7, lng: 46.6, spanM: 1000, fetchImpl: async () => { throw new Error('net'); } });
  assert.equal(!down.ok && down.code, 'UNAVAILABLE');
  const ok = await publicSearch({ query: 'بقالة', lat: 24.7, lng: 46.6, spanM: 1000, fetchImpl: okText([entry({ name: 'أ', placeId: 'ChIJx', lat: 24.7, lng: 46.6 })]) });
  assert.equal(ok.ok && ok.places.length, 1);
  const bad = await publicSearch({ query: 'تموينات', lat: 24.7, lng: 46.6, spanM: 1000, fetchImpl: async () => ({ ok: true, status: 200, text: async () => body(null, null) }) });
  assert.equal(!bad.ok && bad.code, 'SOURCE_CHANGED');
});

test('حماية المصدر: ذاكرة مؤقتة مشتركة بالموقع المقرَّب والنافذة، تنتهي بعد مدّتها', async () => {
  resetPublicSearchState();
  let calls = 0, t = 1_000_000;
  const f = async () => { calls++; return { ok: true, status: 200, text: async () => body([entry({ name: 'أ', placeId: 'ChIJc', lat: 24.7, lng: 46.6 })]) }; };
  const q = (lat: number, spanM = 5000) => publicSearch({ query: 'بقالة', lat, lng: 46.6, spanM, fetchImpl: f, now: () => t });
  const a = await q(24.7001);
  const b = await q(24.7004); // ~٤٠ م: المربّع نفسه (مندوب آخر أو شركة أخرى)
  assert.equal(calls, 1);
  assert.ok(a.ok && !a.cached && b.ok && b.cached && b.places.length === 1);
  await q(24.7001, 1000); // نافذة أخرى ⇒ طلب
  assert.equal(calls, 2);
  await q(24.71); // ~١ كم ⇒ طلب
  assert.equal(calls, 3);
  t += 16 * 60_000; // انقضت المدّة
  await q(24.7001);
  assert.equal(calls, 4);
});

test('حماية المصدر: ثلاث رفضات خلال ٥ دقائق تفتح القاطع — لا طلبات حتى يُغلق، والذاكرة تبقى تخدم', async () => {
  resetPublicSearchState();
  let calls = 0;
  const t = 5_000_000;
  const blocked = async () => { calls++; return { ok: false, status: 429, text: async () => '' }; };
  const at = (query: string, now: number, fetchImpl: Parameters<typeof publicSearch>[0]['fetchImpl'] = blocked) =>
    publicSearch({ query, lat: 24.7, lng: 46.6, spanM: 5000, fetchImpl, now: () => now });
  await at('تموينات', t, okText([entry({ name: 'أ', placeId: 'ChIJk', lat: 24.7, lng: 46.6 })]));
  for (let i = 0; i < 3; i++) await at(`بقالة ${i}`, t + i);
  assert.equal(calls, 3);
  assert.ok(breakerLeftMs(t + 10) > 0);
  const cool = await at('بقالة 9', t + 10);
  assert.equal(calls, 3, 'القاطع مفتوح ⇒ لا طلب إلى Google');
  assert.ok(!cool.ok && cool.code === 'COOLDOWN' && (cool.retryAfterS ?? 0) > 60);
  const cached = await at('تموينات', t + 10);
  assert.ok(cached.ok && cached.cached, 'الذاكرة المؤقتة تخدم والقاطع مفتوح');
  const later = await at('بقالة 9', t + BREAKER_OPEN_MS + 20, okText([]));
  assert.ok(later.ok, 'بعد مدّة القاطع تعود الطلبات');
  // رفضات متباعدة لا تفتحه
  resetPublicSearchState();
  for (const dt of [0, 6 * 60_000, 12 * 60_000]) await at('مخبز', t + dt);
  assert.equal(breakerLeftMs(t + 12 * 60_000), 0);
});

test('حماية المصدر: أربعة طلبات متزامنة على الأكثر', async () => {
  resetPublicSearchState();
  let live = 0, peak = 0;
  const slow = async () => {
    live++; peak = Math.max(peak, live);
    await new Promise(r => setTimeout(r, 15));
    live--;
    return { ok: true, status: 200, text: async () => body([]) };
  };
  const rs = await Promise.all(Array.from({ length: 9 }, (_, i) => publicSearch({ query: `q${i}`, lat: 24.7, lng: 46.6, spanM: 5000, fetchImpl: slow })));
  assert.equal(peak, 4);
  assert.ok(rs.every(r => r.ok));
});

test('مهلة المندوب بعد مسحٍ فاشل: له وحده وتنقضي', () => {
  resetPublicSearchState();
  assert.equal(repRetryLeftMs('t|r', 1000), 0);
  noteRepScanFailed('t|r', 1000);
  assert.ok(repRetryLeftMs('t|r', 11_000) > 0);
  assert.equal(repRetryLeftMs('t|r2', 11_000), 0);
  assert.equal(repRetryLeftMs('t|r', 1000 + REP_RETRY_MS), 0);
});

test('صحّة المصدر لنبضة المالك: الصيغة المجهولة نصف ساعة، وصفرُ محلات لثلاثة مناديب تباعاً، والحجب للعرض', async () => {
  resetPublicSearchState();
  assert.equal(publicScanHealth(), 'ok');
  // مندوبٌ واحد يحدّث في منطقة خالية لا يكفي، وثلاثة مختلفون بلا مسحٍ مثمر بينهم يكفون
  notePublicScanShops('t1|r1', 0); notePublicScanShops('t1|r1', 0); notePublicScanShops('t2|r9', 0);
  assert.equal(publicScanHealth(), 'ok');
  notePublicScanShops('t3|r4', 0);
  assert.equal(publicScanHealth(), 'empty');
  notePublicScanShops('t1|r1', 12);
  assert.equal(publicScanHealth(), 'ok', 'مسحٌ مثمر يمحو السلسلة');
  // صيغة مجهولة من Google ⇒ source_changed حتى نصف ساعة
  const t = 9_000_000;
  const changed = async () => ({ ok: true, status: 200, text: async () => body(null, null) });
  await publicSearch({ query: 'بقالة', lat: 24.7, lng: 46.6, spanM: 5000, fetchImpl: changed, now: () => t });
  assert.equal(publicScanHealth(t + 60_000), 'source_changed');
  assert.equal(publicScanHealth(t + 31 * 60_000), 'ok');
  // القاطع مفتوح ⇒ blocked (النبضة لا تُنذر به)
  for (let i = 0; i < 3; i++) await publicSearch({ query: `ق${i}`, lat: 24.7, lng: 46.6, spanM: 5000, fetchImpl: async () => ({ ok: false, status: 429, text: async () => '' }), now: () => t + 40 * 60_000 });
  assert.equal(publicScanHealth(t + 41 * 60_000), 'blocked');
  resetPublicSearchState();
});

const found = (...ps: Partial<PublicPlace>[]): PublicSearchResult => ({
  ok: true,
  places: ps.map((p, i) => ({
    placeId: `ChIJ${i}`, featureId: null, name: 'محل', rating: null, ratingCount: null, lat: 24.7, lng: 46.6, categories: [], address: null,
    openText: null, openNow: null, hours: [], closed: false, ...p,
  })),
});
const fail = (code: 'BLOCKED' | 'UNAVAILABLE' | 'SOURCE_CHANGED' | 'COOLDOWN', retryAfterS?: number): PublicSearchResult => ({ ok: false, code, message: `m-${code}`, retryAfterS });

test('المسح العام حول المندوب: نافذتان لكل نوع بصياغتين، بلا تكرار، والنوع من تصنيف Google، والمغلق نهائياً يُسقط', async () => {
  const calls: { query: string; spanM: number }[] = [];
  const r = await publicScan({
    types: ['GROCERY', 'SUPERMARKET'], targets: ['GROCERY', 'MINIMARKET', 'SUPERMARKET'], lat: 24.7, lng: 46.6, radiusM: 2000,
    search: async o => {
      calls.push({ query: o.query, spanM: o.spanM });
      if (o.query === 'بقالة') return found({ placeId: 'A', categories: ['سوبرماركت'] }, { placeId: 'B', categories: ['متجر بقالة'] }, { placeId: 'H', categories: ['هايبر ماركت'] }, { placeId: 'X', closed: true });
      if (o.query === 'تموينات') return found({ placeId: 'B', categories: ['متجر بقالة'] }, { placeId: 'N', name: 'أسواق النخيل', categories: ['متجر'] });
      return found();
    },
  });
  assert.deepEqual(calls.map(c => c.query), ['بقالة', 'تموينات', 'سوبرماركت', 'أسواق']);
  assert.deepEqual(calls.map(c => c.spanM), [5000, 1000, 5000, 1000]);
  assert.ok(r.ok);
  assert.equal(r.partial, false);
  // السوبرماركت الذي وجده بحث «بقالة» سوبرماركت، والهايبر (لا تستهدفه الشركة) والمغلق نهائياً خارج القائمة
  assert.deepEqual(r.places.map(p => [p.placeId, p.type]), [['A', 'SUPERMARKET'], ['B', 'GROCERY'], ['N', 'SUPERMARKET']]);
});

test('المسح العام حول المندوب: فشل بعضه ⇒ ناقص؛ فشله كله ⇒ خطأ بسببه (صيغة مجهولة، قاطع، حجب)', async () => {
  const base = { types: ['GROCERY'], targets: ['GROCERY'], lat: 24.7, lng: 46.6, radiusM: 2000 };
  const part = await publicScan({ ...base, search: async o => (o.query === 'بقالة' ? found({ placeId: 'A' }) : fail('BLOCKED')) });
  assert.ok(part.ok && part.partial && part.places.length === 1);
  const changed = await publicScan({ ...base, search: async () => fail('SOURCE_CHANGED') });
  assert.ok(!changed.ok && changed.code === 'SOURCE_CHANGED');
  const cool = await publicScan({ ...base, search: async () => fail('COOLDOWN', 600) });
  assert.ok(!cool.ok && cool.code === 'SCAN_COOLDOWN' && cool.retryAfterS === 600);
  assert.match(!cool.ok ? cool.message : '', /بعد 10 دقائق$/);
  const mixed = await publicScan({ ...base, search: async o => fail(o.query === 'بقالة' ? 'BLOCKED' : 'SOURCE_CHANGED') });
  assert.ok(!mixed.ok && mixed.code === 'SCAN_FAILED' && mixed.message === 'm-BLOCKED');
});

test('نوع محل البحث العام: تصنيف Google أولاً ثم الاسم ثم البحث، وتصنيفٌ لا تستهدفه الشركة يُسقط', () => {
  const T = ['GROCERY', 'MINIMARKET', 'SUPERMARKET'];
  assert.equal(publicOutletType({ categories: ['سوبرماركت'], name: 'تموينات الخير' }, 'GROCERY', T), 'SUPERMARKET');
  assert.equal(publicOutletType({ categories: ['متجر بقالة'], name: 'أسواق الرهش' }, 'SUPERMARKET', T), 'GROCERY');
  assert.equal(publicOutletType({ categories: ['هايبر ماركت'], name: 'كارفور' }, 'GROCERY', T), null);
  assert.equal(publicOutletType({ categories: ['سوبرماركت'], name: 'س' }, 'GROCERY', ['GROCERY']), null);
  // الاسم وحده لا يُسقط: «أسواق…» لشركة بقالات تبقى بنوع البحث
  assert.equal(publicOutletType({ categories: ['متجر'], name: 'أسواق المريشد' }, 'GROCERY', ['GROCERY']), 'GROCERY');
  // ويُبقي ما أسقطه التصنيف: Google تصنّف بقالات كثيرة «سوبرماركت» (من ردٍّ حقيقي) — لا تغيب عن شركة بقالات
  assert.equal(publicOutletType({ categories: ['سوپر مارکت', 'سوبرماركت'], name: 'بقالة ميد meed' }, 'GROCERY', ['GROCERY']), 'GROCERY');
  assert.equal(publicOutletType({ categories: ['سوبرماركت'], name: 'تموينات أسطورة الخليج' }, 'GROCERY', ['GROCERY']), 'GROCERY');
  // والسلسلة يُسقطها تصنيفها واسمها معاً
  assert.equal(publicOutletType({ categories: ['سوبرماركت'], name: 'أسواق العثيم' }, 'GROCERY', ['GROCERY']), null);
  assert.equal(publicOutletType({ categories: [], name: 'محل' }, 'MINIMARKET', T), 'MINIMARKET');
  assert.deepEqual(searchTermsFor('WHOLESALE'), ['محل مواد غذائية بالجملة', 'جملة مواد غذائية']);
  assert.equal(searchTermsFor('CAFE')[0], 'كوفي');
});

test('مطابقة العميل: عميل سوبرماركت على بعد ١٥ م من محلٍّ صنّفه البحث بقالة ⇒ «ربما عميل حالي» لا فرصة جديدة', () => {
  const place = { placeId: 'P', name: 'تموينات', address: null, lat: 24.7, lng: 46.6, primaryType: null, types: ['grocery_store'] };
  const run = (outletType: string | null, targetTypes = ['GROCERY', 'SUPERMARKET']) => mergeNearby([place], {
    origin: { lat: 24.7, lng: 46.6 }, targetTypes, outlets: [], isolation: false, now: new Date(),
    customers: [{ id: 'c1', lat: 24.7, lng: 46.6 + 15 / 101000, outletType, aiPlaceId: null, visible: true }],
  })[0];
  assert.equal(run('SUPERMARKET').relation, 'POSSIBLE_CUSTOMER');
  assert.equal(run('SUPERMARKET').customerId, 'c1');
  assert.equal(run(null).relation, 'POSSIBLE_CUSTOMER');
  assert.equal(run('PHARMACY').relation, 'NEW', 'نوع لا تستهدفه الشركة لا يُطابَق');
  assert.equal(run('SUPERMARKET', ['GROCERY']).relation, 'NEW');
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
  assert.match(g.summary, /^حولك 8 محلات، منها 6 فرص جديدة وواحد من عملائك\. ابدأ بهذا الترتيب:$/);
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
  assert.match(g.summary, /^حولك 9 محلات، منها 3 فرص جديدة وواحد للمتابعة وواحد من عملائك وواحد ربما من عملائك\./);
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

test('توجيه المسح: المغلق الآن لا يزاحم المفتوح ولا يتقدّمه، ويُذكر «زره لاحقاً»', () => {
  const O = { lat: 24.7, lng: 46.6 };
  const near = shop('P1', { openNow: false, rating: 4.5, distanceM: 100, lat: 24.7009, lng: 46.6 });
  const far = shop('P2', { openNow: true, rating: 4.5, distanceM: 1000, lat: 24.709, lng: 46.6 });
  assert.ok(shopScore(near) > shopScore(far), 'نقاط المغلق القريب أعلى — والخطة مع ذلك تبدأ بالمفتوح');
  const g = ruleGuide([near, far], O);
  assert.deepEqual(g.stops.map(s => s.ref), ['P2', 'P1']);
  assert.match(g.stops[1].why, /مغلق الآن — زره لاحقاً/);
  // خمسة مفتوحة تملأ الخطة ⇒ المغلق خارجها
  const five = ['A', 'B', 'C', 'D', 'E'].map((r, i) => shop(r, { distanceM: 1500 + i * 10, lat: 24.7135 + i * 0.0001 }));
  assert.ok(!ruleGuide([near, ...five], O).stops.some(s => s.ref === 'P1'));
  // كلها مغلقة ⇒ الخطة تبقى بتنبيه (بصيغة المفرد للمحطة الواحدة)
  const allClosed = ruleGuide([near], O);
  assert.deepEqual(allClosed.stops.map(s => s.ref), ['P1']);
  assert.match(allClosed.summary, /\. مغلق الآن — زره حين يفتح:$/);
  const twoClosed = ruleGuide([near, shop('P3', { openNow: false, distanceM: 200, lat: 24.7018, lng: 46.6 })], O);
  assert.equal(twoClosed.stops.length, 2);
  assert.match(twoClosed.summary, /^حولك محلّان، منهما فرصتان جديدتان\. كلها مغلقة الآن — زرها بهذا الترتيب حين تفتح:$/);
});

test('توجيه المسح بالعقل: المغلق الآن يُؤخَّر بعد المفتوح مهما رتّبه العقل', async () => {
  const cfg = { provider: 'groq', apiKey: 'k', model: 'm', baseUrl: 'http://x' } as never;
  const shops = [shop('P1', { openNow: false }), shop('P2'), shop('P3')];
  const plan = { summary: 'ابدأ بالأقرب', plan: [{ ref: 'P1', why: 'قريب' }, { ref: 'P2', why: 'مفتوح' }, { ref: 'P3', why: 'مفتوح' }] };
  const r = await aiGuide(shops, {
    cfg, playbook: null, origin: { lat: 24.7, lng: 46.6 },
    llm: (async () => ({ ok: true as const, content: JSON.stringify(plan), usage: { promptTokens: 1, completionTokens: 1 } })) as never,
  });
  assert.ok(r.guide);
  assert.deepEqual(r.guide.stops.map(s => s.ref), ['P2', 'P3', 'P1']);
});

test('التقييم يُشدّ بعدد مقيّميه، والعدد والمعدود والمسافة بالعربية', () => {
  assert.ok(shopScore(shop('P1', { rating: 5, ratingCount: 1 })) < shopScore(shop('P2', { rating: 4.6, ratingCount: 500 })));
  assert.equal(shrunkRating(4.5, null), 4.5);
  assert.equal(shopScore(shop('P1', { rating: 4.5 })), shopScore(shop('P1', { rating: 4.5, ratingCount: null })), 'بلا عدد ⇒ كما كان');
  assert.deepEqual([1, 2, 3, 10, 11, 99, 100, 102, 103, 111].map(n => countAr(n, SHOP_AR)),
    ['محل واحد', 'محلّان', '3 محلات', '10 محلات', '11 محلاً', '99 محلاً', '100 محل', '102 محل', '103 محلات', '111 محلاً']);
  assert.deepEqual([1, 2, 5, 12].map(n => countAr(n, CHANCE_AR)), ['فرصة جديدة واحدة', 'فرصتان جديدتان', '5 فرص جديدة', '12 فرصة جديدة']);
  assert.equal(countAr(1, RATER_AR), 'مقيّم واحد');
  assert.deepEqual([40, 994, 1234, 12345].map(distAr), ['40 م', '990 م', '1.2 كم', '12 كم']);
  const g = ruleGuide([shop('P1', { distanceM: 40, rating: 4.2, ratingCount: 3 })], { lat: 24.7, lng: 46.6 });
  assert.match(g.stops[0].why, /تقييمه 4\.2 من 3 مقيّمين في خرائط Google/);
  assert.match(g.stops[0].why, /على بعد 40 م$/, 'لا «على بعد 0 كم»');
  // الضمير يطابق العدد (لا «محل واحد، منها» ولا «محلّان، منها»)، و«ابدأ به» للمحطة الواحدة
  assert.equal(g.summary, 'حولك محل واحد: فرصة جديدة واحدة. ابدأ به:');
  assert.equal(ruleGuide([shop('P1'), shop('P2', { relation: 'CUSTOMER' })], { lat: 24.7, lng: 46.6 }).summary, 'حولك محلّان، منهما فرصة جديدة واحدة وواحد من عملائك. ابدأ به:');
  assert.equal(ruleGuide([], { lat: 0, lng: 0 }).summary, 'لا محلات مستهدفة حولك الآن — جرّب منطقة أخرى.');
});
