import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import dnsPromises from 'dns/promises';
import { parseCoords, resolveLocationUrl } from '../services/geoLink';

/**
 * محلّل روابط موقع العميل (PIN-1/SM-2 وPIN-7 من تدقيق بصمة الحضور، ٧ نوفمبر): دبّوس المكان `!3d!4d` يُقدَّم على مركز
 * الخريطة `@` (رابط المكان على الكمبيوتر فيه `@` مُزاحٌ عنه مئات الأمتار)، ثم معاملات النقطة والمسار، و`@` آخر الملاذ،
 * والإحداثيات في نصّ وجهة التحويلة تُقرأ ولو فشل جلبها. الروابط بأشكالها الحقيقية كما ينسخها الناس.
 */

const PIN = { lat: 24.7136011, lng: 46.6753209 };      // باب المحل (دبّوس المكان)
const CENTER = { lat: 24.7152813, lng: 46.6721377 };   // مركز العرض على 17z — نحو ٣٨٠ م عن الدبّوس

// رابط المكان كما يُنسخ من شريط العنوان على الكمبيوتر: @ مركز العرض، و!3d!4d دبّوس المكان في data=
const DESKTOP_PLACE = 'https://www.google.com/maps/place/%D9%85%D8%AD%D9%84+%D8%A7%D9%84%D8%B1%D9%8A%D8%A7%D8%B6/'
  + `@${CENTER.lat},${CENTER.lng},17z/data=!3m1!4b1!4m6!3m5!1s0x3e2f03890d489399:0xba974d1c98e79fd5!8m2!3d${PIN.lat}!4d${PIN.lng}`
  + '!16s%2Fg%2F11c5ql9z8c?entry=ttu&g_ep=EgoyMDI2MTEwMy4wIKXMDSoASAFQAw%3D%3D';

test('PIN-1: رابط المكان على الكمبيوتر ⇒ دبّوس المكان !3d!4d لا مركز الخريطة @', () => {
  assert.deepEqual(parseCoords(DESKTOP_PLACE), PIN);
  // بالتقريب 15z والترميز %21 في تحويلة مرمَّزة
  const z15 = `https://www.google.com/maps/place/Shop/@24.7201,46.6650,15z/data=%214m6%213m5%211s0x1:0x2%218m2%213d${PIN.lat}%214d${PIN.lng}`;
  assert.deepEqual(parseCoords(z15), PIN);
});

test('أكثر من زوج !3d!4d ⇒ الأخير (المكان المفتوح بعد بحثٍ قرب مكانٍ آخر)، والزوج غير الصالح يُتخطّى', () => {
  const several = 'https://www.google.com/maps/place/Cafe/@24.7101,46.6601,15z/data=!4m14!1m7!3m6!1s0x1:0x2!2sAnchor!8m2!3d24.7000123!4d46.6000456'
    + `!2m1!1scoffee!3m5!1s0x3:0x4!8m2!3d${PIN.lat}!4d${PIN.lng}!16s%2Fg%2F1?entry=ttu`;
  assert.deepEqual(parseCoords(several), PIN);
  const lastInvalid = `https://www.google.com/maps/place/X/@24.7,46.6,17z/data=!8m2!3d${PIN.lat}!4d${PIN.lng}!8m2!3d95.1!4d46.6`;
  assert.deepEqual(parseCoords(lastInvalid), PIN);
});

test('وجهات تحويلة الرابط المختصر من الجوال (maps.app.goo.gl) تُقرأ بلا جلب', () => {
  // دبّوس مُسقَط: /maps/search/LAT,+LNG
  assert.deepEqual(parseCoords(`https://www.google.com/maps/search/${PIN.lat},+${PIN.lng}?entry=tts&g_ep=EgoyMDI2MTEwMy4wIPu8ASoASAFQAw%3D%3D&skid=0f0e`), PIN);
  // ?q=LAT,LNG
  assert.deepEqual(parseCoords(`https://maps.google.com/?q=${PIN.lat},${PIN.lng}&entry=gps&g_ep=CAESBzI2LjQ0LjEYACCIJw%3D%3D`), PIN);
  // مكان باسم بصيغة الدرجات: الاسم لا يُقرأ، والدبّوس في data= يُقدَّم على @
  assert.deepEqual(parseCoords(`https://www.google.com/maps/place/24%C2%B042'49.0%22N+46%C2%B040'31.2%22E/@${CENTER.lat},${CENTER.lng},17z/data=!3m1!4b1!4m4!3m3!8m2!3d${PIN.lat}!4d${PIN.lng}?entry=ttu`), PIN);
  // /maps/place/LAT,LNG/@مركز
  assert.deepEqual(parseCoords(`https://www.google.com/maps/place/${PIN.lat},${PIN.lng}/@${CENTER.lat},${CENTER.lng},17z?entry=ttu`), PIN);
});

test('معاملات النقطة: q مقدَّم على ll و@، و«q=اسم&ll=» ⇒ ll، وloc: والوسم بين قوسين والترميز', () => {
  assert.deepEqual(parseCoords(`https://maps.google.com/maps?q=${PIN.lat},${PIN.lng}&ll=${CENTER.lat},${CENTER.lng}&z=17`), PIN);
  assert.deepEqual(parseCoords(`https://maps.google.com/maps?q=Kingdom+Centre&ll=${PIN.lat},${PIN.lng}&z=17`), PIN);
  assert.deepEqual(parseCoords(`https://maps.google.com/maps?q=loc:${PIN.lat}%2C${PIN.lng}`), PIN);
  assert.deepEqual(parseCoords(`https://maps.google.com/?q=${PIN.lat},${PIN.lng}+(%D9%85%D8%AD%D9%84)`), PIN);
  assert.deepEqual(parseCoords(`https://maps.google.com/?q=${PIN.lat}%2C%20${PIN.lng}`), PIN);
  // daddr (الوجهة) لا saddr (البداية)
  assert.deepEqual(parseCoords(`https://maps.google.com/maps?saddr=24.6000,46.6000&daddr=${PIN.lat},${PIN.lng}`), PIN);
  // روابط Maps URLs: destination وquery
  assert.deepEqual(parseCoords(`https://www.google.com/maps/dir/?api=1&origin=24.6000,46.6000&destination=${PIN.lat}%2C${PIN.lng}&travelmode=driving`), PIN);
  assert.deepEqual(parseCoords(`https://www.google.com/maps/search/?api=1&query=${PIN.lat}%2C${PIN.lng}`), PIN);
});

test('مسار الاتجاهات /maps/dir: الوجهة آخر مقطع، ومقطع البداية لا يُؤخذ أبداً', () => {
  assert.deepEqual(parseCoords(`https://www.google.com/maps/dir/24.6000,46.6000/${PIN.lat},${PIN.lng}/@24.6568,46.6376,13z/data=!4m2!4m1!3e0`), PIN);
  assert.deepEqual(parseCoords(`https://www.google.com/maps/dir//${PIN.lat},${PIN.lng}/@24.6568,46.6376,13z`), PIN);
  const toName = parseCoords('https://www.google.com/maps/dir/24.6000,46.6000/Kingdom+Centre/@24.6568,46.6376,13z');
  assert.notDeepEqual(toName, { lat: 24.6, lng: 46.6 }, 'البداية ليست موقع العميل');
  // بدايةٌ بلا وجهة: لا تُؤخذ البداية أبداً — @ آخر الملاذ كما كان، أو لا شيء
  const START = { lat: 24.6, lng: 46.6 };
  assert.deepEqual(parseCoords('https://www.google.com/maps/dir/24.6000,46.6000//@24.65,46.63,13z'), { lat: 24.65, lng: 46.63 });
  assert.equal(parseCoords('https://www.google.com/maps/dir/24.6000,46.6000/'), null);
  assert.deepEqual(parseCoords('https://www.google.com/maps/dir/24.6000,46.6000/@24.65,46.63,13z/data=!4m2!4m1!3e0'), { lat: 24.65, lng: 46.63 });
  assert.equal(parseCoords('https://www.google.com/maps/dir/24.6000,46.6000//'), null);
  for (const u of ['https://www.google.com/maps/dir/24.6000,46.6000//@24.65,46.63,13z', 'https://www.google.com/maps/dir/24.6000,46.6000/']) {
    assert.notDeepEqual(parseCoords(u), START, u);
  }
  // والوجهة تبقى بشرطةٍ أخيرة أو بدايةٍ فارغة
  assert.deepEqual(parseCoords(`https://www.google.com/maps/dir/24.6000,46.6000/${PIN.lat},${PIN.lng}/`), PIN);
  assert.deepEqual(parseCoords(`https://www.google.com/maps/dir//${PIN.lat},${PIN.lng}/`), PIN);
});

test('خرائط Apple: ll دبّوس المكان، وq بالإحداثيات، وsll، وdaddr، وcoordinate', () => {
  assert.deepEqual(parseCoords(`https://maps.apple.com/?address=King%20Fahd%20Rd,%20Riyadh,%20Saudi%20Arabia&auid=1234567890&ll=${PIN.lat},${PIN.lng}&lsp=9902&q=Kingdom%20Centre`), PIN);
  assert.deepEqual(parseCoords(`https://maps.apple.com/?ll=${PIN.lat},${PIN.lng}&q=Dropped%20Pin&t=m`), PIN);
  assert.deepEqual(parseCoords(`https://maps.apple.com/?q=${PIN.lat},${PIN.lng}&sll=24.70,46.60&z=10`), PIN);
  assert.deepEqual(parseCoords(`https://maps.apple.com/?q=Kingdom%20Centre&sll=${PIN.lat},${PIN.lng}&z=10`), PIN);
  assert.deepEqual(parseCoords(`https://maps.apple.com/?daddr=${PIN.lat},${PIN.lng}&dirflg=d`), PIN);
  assert.deepEqual(parseCoords(`https://maps.apple.com/place?coordinate=${PIN.lat},${PIN.lng}&name=Marked%20Location`), PIN);
});

test('مركز الخريطة @ وcenter= آخر الملاذ: يُؤخذان حين لا يوجد غيرهما', () => {
  assert.deepEqual(parseCoords(`https://www.google.com/maps/@${CENTER.lat},${CENTER.lng},17z?entry=ttu`), CENTER);
  assert.deepEqual(parseCoords(`https://www.google.com/maps/@?api=1&map_action=map&center=${CENTER.lat}%2C${CENTER.lng}&zoom=17`), CENTER);
  // اسمٌ مرمَّز فيه «&q=» لا يصنع معاملاً مزيّفاً
  assert.deepEqual(parseCoords(`https://www.google.com/maps/place/A%26q%3D1.5,2.5/@${CENTER.lat},${CENTER.lng},17z`), CENTER);
  // اسم مكان بلا أي إحداثيات ⇒ null (يُجلب ثم يُرمَّز جغرافياً)
  assert.equal(parseCoords('https://maps.google.com/?q=Kingdom+Centre,+Riyadh&ftid=0x3e2f03890d489399:0xba974d1c98e79fd5'), null);
});

test('الإحداثيات بمنازلها العشرية كلها بلا تقريب', () => {
  const lat = '24.71360123456789', lng = '46.67532098765432';
  const want = { lat: Number(lat), lng: Number(lng) };
  assert.deepEqual(parseCoords(`https://maps.google.com/?q=${lat},${lng}`), want);
  assert.deepEqual(parseCoords(`https://www.google.com/maps/place/X/@24.7,46.6,17z/data=!8m2!3d${lat}!4d${lng}`), want);
  assert.deepEqual(parseCoords(`${lat}, ${lng}`), want);
  assert.deepEqual(parseCoords('-33.8567844,151.2152967'), { lat: -33.8567844, lng: 151.2152967 });
});

// ───────────── حلّ الروابط المختصرة (جلبٌ مُحاكى بلا شبكة: fetch وDNS بديلان) ─────────────

type Route = (url: string) => Response | Promise<Response>;
async function withMockNet<T>(route: Route, fn: (fetched: string[]) => Promise<T>): Promise<T> {
  // الخدمة تقرأ lookup من الكائن نفسه وقت النداء — نتأكد قبل أي نداء كي لا يخرج استعلام DNS حقيقي
  assert.equal(dnsPromises, require('dns/promises'));
  const dns = mock.method(dnsPromises, 'lookup', (async () => [{ address: '142.250.74.46', family: 4 }]) as unknown as typeof dnsPromises.lookup);
  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (u: string | URL) => { fetched.push(String(u)); return route(String(u)); }) as typeof fetch;
  try {
    const out = await fn(fetched);
    assert.ok(fetched.length === 0 || dns.mock.callCount() > 0, 'DNS البديل هو الذي استُعمل');
    return out;
  } finally { globalThis.fetch = realFetch; dns.mock.restore(); }
}
const redirect = (location: string) => new Response(null, { status: 302, headers: { location } });
const SHORT = 'https://maps.app.goo.gl/Xq3bT7uVw9KpLm2A8';

test('رابط مختصر يحوّل إلى رابط المكان ⇒ دبّوس المكان، ولا تُجلب الوجهة', async () => {
  await withMockNet(u => (u === SHORT ? redirect(DESKTOP_PLACE) : new Response('', { status: 500 })), async fetched => {
    assert.deepEqual(await resolveLocationUrl(SHORT, { googleOnly: true }), PIN);
    assert.deepEqual(fetched, [SHORT]);
  });
});

test('PIN-7: الإحداثيات في وجهة التحويلة تُستعمل ولو فشل جلبها (مهلة)', async () => {
  const target = `https://www.google.com/maps/search/${PIN.lat},+${PIN.lng}?entry=tts&g_ep=EgoyMDI2MTEwMy4wIPu8ASoASAFQAw%3D%3D`;
  await withMockNet(u => { if (u === SHORT) return redirect(target); throw new Error('The operation was aborted due to timeout'); }, async () => {
    assert.deepEqual(await resolveLocationUrl(SHORT, { googleOnly: true }), PIN);
  });
  // وجهة خارج Google فيها إحداثيات: تُقرأ نصّاً ولا تُجلب أبداً (googleOnly)
  await withMockNet(u => (u === SHORT ? redirect(`https://evil.example/?q=${PIN.lat},${PIN.lng}`) : new Response('', { status: 200 })), async fetched => {
    assert.deepEqual(await resolveLocationUrl(SHORT, { googleOnly: true }), PIN);
    assert.deepEqual(fetched, [SHORT]);
  });
});

test('وجهة بلا إحداثيات ⇒ من جسم الصفحة: دبّوس المكان !3d!4d قبل مركز العرض /@', async () => {
  const named = 'https://maps.google.com/?q=Kingdom+Centre&ftid=0x3e2f03890d489399:0xba974d1c98e79fd5&entry=gps';
  const body = `<html><head><link href="https://www.google.com/maps/place/Kingdom+Centre/@${CENTER.lat},${CENTER.lng},17z/data=!4m6!3m5!1s0x3e2f03890d489399:0xba974d1c98e79fd5!8m2!3d${PIN.lat}!4d${PIN.lng}" rel="canonical"></head></html>`;
  await withMockNet(u => (u === SHORT ? redirect(named) : new Response(body, { status: 200 })), async fetched => {
    assert.deepEqual(await resolveLocationUrl(SHORT, { googleOnly: true }), PIN);
    assert.deepEqual(fetched, [SHORT, named]);
  });
});

test('وجهة آخر تحويلة بعد نفاد المحاولات تُقرأ نصّاً', async () => {
  const hops = [SHORT, ...[1, 2, 3, 4, 5].map(i => `https://maps.app.goo.gl/hop${i}`)];
  const last = `https://maps.google.com/?q=${PIN.lat},${PIN.lng}`;
  await withMockNet(u => { const i = hops.indexOf(u); return redirect(i >= 0 && i < hops.length - 1 ? hops[i + 1] : last); }, async fetched => {
    assert.deepEqual(await resolveLocationUrl(SHORT, { googleOnly: true }), PIN);
    assert.deepEqual(fetched, hops);
  });
});
