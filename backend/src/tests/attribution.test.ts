import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  resolveAttribution, contentTypeOf, refFromPath, makeWaCode, paidChannelOf, requestOptedOut,
  aiEngineOfSource, AI_ENGINE_IDS, ipSalt, ipFingerprint, geoLookupUrl,
} from '../services/attribution';

test('محرك ذكاء توليدي يصنف ai_generative ويعرف اسمه', () => {
  const r = resolveAttribution({ referrerHost: 'chatgpt.com', path: '/' });
  assert.equal(r.channel, 'ai_generative');
  assert.equal(r.aiEngine, 'chatgpt');
});

test('نطاق فرعي لمحرك الذكاء يلتقط أيضا', () => {
  const r = resolveAttribution({ referrerHost: 'www.perplexity.ai', path: '/' });
  assert.equal(r.aiEngine, 'perplexity');
  assert.equal(r.channel, 'ai_generative');
});

test('بحث جوجل ⇒ organic، وبلا محيل ⇒ direct', () => {
  assert.equal(resolveAttribution({ referrerHost: 'www.google.com' }).channel, 'organic');
  assert.equal(resolveAttribution({ referrerHost: null }).channel, 'direct');
});

test('قيمة UTM خارج القاموس تطبع إلى other لا ترفض الزيارة', () => {
  const r = resolveAttribution({ utm: { source: 'مصدر-غريب', medium: 'شيء' } });
  assert.equal(r.utmSource, 'other');
  assert.equal(r.utmMedium, 'other');
});

test('قيمة UTM معروفة تحفظ كما هي بحروف صغيرة', () => {
  const r = resolveAttribution({ utm: { source: 'SourceForge', medium: 'Directory' } });
  assert.equal(r.utmSource, 'sourceforge');
  assert.equal(r.utmMedium, 'directory');
});

test('ai_answer كوسم صريح يصنف ai_generative', () => {
  assert.equal(resolveAttribution({ utm: { medium: 'ai_answer' } }).channel, 'ai_generative');
});

test('غياب الوسوم لا يخترع قيما', () => {
  const r = resolveAttribution({});
  assert.equal(r.utmSource, null);
  assert.equal(r.utmCampaign, null);
});

test('نوع المحتوى يشتق من المسار', () => {
  assert.equal(contentTypeOf('/'), 'landing');
  assert.equal(contentTypeOf('/en/'), 'landing');
  assert.equal(contentTypeOf('/blog/x/'), 'blog');
  assert.equal(contentTypeOf('/en/blog/x/'), 'blog');
  assert.equal(contentTypeOf('/invoice-generator/'), 'tool');
  assert.equal(contentTypeOf('/pricing/'), 'pricing');
  assert.equal(contentTypeOf(null), null);
});

test('ref يشتق من المسار آليا ولا يتضارب بين الصفحات', () => {
  assert.equal(refFromPath('/'), 'home');
  assert.equal(refFromPath('/pricing/'), 'pricing');
  assert.equal(refFromPath('/blog/van-sales/'), 'blog-van-sales');
  assert.notEqual(refFromPath('/pricing/'), refFromPath('/blog/x/'));
});

test('رمز واتساب ٨ محارف بلا أحرف ملتبسة', () => {
  const c = makeWaCode('seed');
  assert.equal(c.length, 8);
  assert.match(c, /^[2-9A-HJ-NP-Z]+$/); // لا 0/O/1/I
});

test('رموز واتساب متنوعة فعلا — الخلل السابق أنتج D2222222', () => {
  const codes = new Set<string>();
  for (let i = 0; i < 500; i++) codes.add(makeWaCode('seed' + i));
  // تكرار الرمز يعني محادثات لا تنسب لزياراتها ⇒ انهيار الإسناد بصمت
  assert.ok(codes.size >= 495, `تنوع ضعيف: ${codes.size}/500 فريد`);
  // ولا رمز من محرف واحد مكرر
  for (const c of [...codes].slice(0, 50)) {
    assert.ok(new Set(c.split('')).size >= 3, `رمز ضعيف: ${c}`);
  }
});

// --- القنوات المدفوعة: نقرة الإعلان تصل بمُحيل google.com كالبحث العضوي تماماً ---

test('وسيط cpc/ppc/paid/paidsearch/paid_search من جوجل ⇒ paid_search لا organic', () => {
  for (const medium of ['cpc', 'ppc', 'paid', 'paidsearch', 'paid_search', 'CPC', 'Paid-Search']) {
    const r = resolveAttribution({ utm: { source: 'google', medium }, referrerHost: 'www.google.com' });
    assert.equal(r.channel, 'paid_search', `medium=${medium}`);
  }
});

test('معرّف نقر جوجل بلا أي وسوم ومُحيل google.com ⇒ paid_search', () => {
  for (const clickId of ['gclid', 'gbraid', 'wbraid']) {
    const r = resolveAttribution({ utm: { clickId }, referrerHost: 'www.google.com', path: '/pricing/' });
    assert.equal(r.channel, 'paid_search', `clickId=${clickId}`);
    assert.equal(r.utmSource, null); // لا نخترع وسوماً لم تُرسل
  }
  // المعرّف بمفتاحه (لا بنوعه) يكفي أيضاً — وقيمته لا تظهر في أي حقل ناتج
  const r = resolveAttribution({ utm: { gclid: 'EAIaIQobChMI-secret' }, referrerHost: 'www.google.com' });
  assert.equal(r.channel, 'paid_search');
  assert.equal(JSON.stringify(r).includes('EAIaIQobChMI'), false);
});

test('معرّف نقر بلا مُحيل (تطبيق أو خصوصية المتصفّح) ⇒ paid_search لا direct', () => {
  assert.equal(resolveAttribution({ utm: { clickId: 'gclid' }, referrerHost: null }).channel, 'paid_search');
});

test('نوع معرّف غير معروف أو فارغ لا يجعل الزيارة مدفوعة', () => {
  assert.equal(resolveAttribution({ utm: { clickId: 'fbclid' }, referrerHost: 'www.google.com' }).channel, 'organic');
  assert.equal(resolveAttribution({ utm: { gclid: '   ' }, referrerHost: 'www.google.com' }).channel, 'organic');
});

test('إعلانات التواصل ⇒ paid_social', () => {
  assert.equal(resolveAttribution({ utm: { source: 'facebook', medium: 'paid_social' } }).channel, 'paid_social');
  assert.equal(resolveAttribution({ utm: { source: 'linkedin', medium: 'paidsocial' } }).channel, 'paid_social');
  assert.equal(resolveAttribution({ utm: { source: 'facebook', medium: 'cpm' }, referrerHost: 'm.facebook.com' }).channel, 'paid_social');
  assert.equal(resolveAttribution({ utm: { source: 'linkedin', medium: 'cpm' } }).channel, 'paid_social');
  // cpc من فيسبوك إعلان اجتماعي لا بحثي
  assert.equal(resolveAttribution({ utm: { source: 'fb', medium: 'cpc' } }).channel, 'paid_social');
  assert.equal(resolveAttribution({ utm: { source: 'instagram', medium: 'paid' } }).channel, 'paid_social');
});

test('التواصل غير الممول يبقى social والبحث غير الممول يبقى organic', () => {
  assert.equal(resolveAttribution({ referrerHost: 'm.facebook.com' }).channel, 'social');
  assert.equal(resolveAttribution({ utm: { source: 'facebook', medium: 'social' } }).channel, 'social');
  assert.equal(resolveAttribution({ referrerHost: 'www.bing.com' }).channel, 'organic');
});

test('الوسيط المدفوع يُحفظ بقيمته لا other، والقناة لا تتجاوز حدّ العمود', () => {
  const r = resolveAttribution({ utm: { source: 'google', medium: 'cpc', campaign: 'riyadh-jeddah' } });
  assert.equal(r.utmMedium, 'cpc');
  assert.equal(r.utmSource, 'google');
  assert.equal(r.utmCampaign, 'riyadh-jeddah');
  assert.equal(resolveAttribution({ utm: { source: 'meta', medium: 'Paid Social' } }).utmMedium, 'paid_social');
  assert.equal(resolveAttribution({ utm: { source: 'instagram', medium: 'cpm' } }).utmSource, 'instagram');
  for (const c of ['paid_search', 'paid_social']) assert.ok(c.length <= 24); // channel VarChar(24)
});

test('الدفع الصريح يسبق محرّك الذكاء المُحيل، ومحرّك الذكاء يبقى معروفاً', () => {
  const r = resolveAttribution({ utm: { source: 'google', medium: 'cpc' }, referrerHost: 'chatgpt.com' });
  assert.equal(r.channel, 'paid_search');
  assert.equal(r.aiEngine, 'chatgpt');
});

test('paidChannelOf يعيد null لزيارة بلا أي إشارة دفع', () => {
  assert.equal(paidChannelOf({}), null);
  assert.equal(paidChannelOf({ source: 'google', medium: 'organic' }), null);
  assert.equal(paidChannelOf({ source: 'sourceforge', medium: 'directory' }), null);
});

test('requestOptedOut: إشارة المتصفّح في الترويسات أو علَم الواجهة يوقفان بصمة IP والمعرّفات', () => {
  assert.equal(requestOptedOut({ 'sec-gpc': '1' }), true);
  assert.equal(requestOptedOut({ dnt: '1' }), true);
  assert.equal(requestOptedOut({}, true), true);        // زرّ «إيقاف القياس» أو تخزين محجوب (جسم /track)
  assert.equal(requestOptedOut({}, '1'), true);         // المحوّل /go/wa?o=1
  assert.equal(requestOptedOut({ dnt: '0', 'sec-gpc': '' }), false);
  assert.equal(requestOptedOut({}, 'true'), false);     // قيمة غير معرّفة لا تُفسَّر رفضاً ولا قبولاً خاطئاً
  assert.equal(requestOptedOut(undefined), false);
});

test('المسار /track و/go/wa لا يشتقّان بصمة IP ولا يستدعيان تحديد الموقع عند الرفض', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../routes/analytics.ts', import.meta.url), 'utf8');
  const track = src.slice(src.indexOf("router.post('/track'"), src.indexOf("router.get('/go/wa'"));
  const goWa = src.slice(src.indexOf("router.get('/go/wa'"), src.indexOf('interface V'));
  assert.match(track, /requestOptedOut\(req\.headers,\s*body\.optOut\)/);
  assert.match(track, /const ip = optedOut \? '' : clientIp\(req\)/);
  assert.match(track, /isBot \|\| !ip \? \{\} : await geoLookup\(ip\)/);
  assert.match(goWa, /requestOptedOut\(req\.headers,\s*req\.query\.o\)/);
  assert.match(goWa, /const ip = optedOut \? '' : clientIp\(req\)/);
  assert.match(goWa, /const anonId = optedOut \? null :/);
});

// --- #24: معاملا Google Ads gad_source وgad_campaignid دليل دفع كـgclid ---

test('gad_source وgad_campaignid بلا gclid ومُحيل google.com ⇒ paid_search لا organic', () => {
  for (const clickId of ['gad_source', 'gad_campaignid']) {
    const r = resolveAttribution({ utm: { clickId }, referrerHost: 'www.google.com', path: '/pricing/' });
    assert.equal(r.channel, 'paid_search', `clickId=${clickId}`);
    assert.equal(r.utmSource, null);
    assert.equal(paidChannelOf({ clickId }), 'paid_search');
    // بلا مُحيل (تصفّح خاص أو تطبيق) ⇒ مدفوع لا مباشر
    assert.equal(resolveAttribution({ utm: { clickId }, referrerHost: null }).channel, 'paid_search');
  }
});

test('gad_source بمفتاحه يكفي، وقيمته لا تظهر في أي حقل ناتج', () => {
  const r = resolveAttribution({ utm: { gad_source: '1', gad_campaignid: '987654321' }, referrerHost: 'www.google.com' });
  assert.equal(r.channel, 'paid_search');
  assert.equal(JSON.stringify(r).includes('987654321'), false);
  assert.equal(resolveAttribution({ utm: { gad_source: '  ' }, referrerHost: 'www.google.com' }).channel, 'organic');
});

// --- #25: utm_source لمساعد ذكاء بلا مُحيل ⇒ ai_generative لا direct ---

test('utm_source لمساعد ذكاء معروف بلا مُحيل ⇒ ai_generative ويُعرف المحرّك', () => {
  const cases: [string, string][] = [
    ['chatgpt.com', 'chatgpt'], ['ChatGPT.com', 'chatgpt'], ['chat.openai.com', 'chatgpt'],
    ['perplexity', 'perplexity'], ['perplexity.ai', 'perplexity'], ['www.perplexity.ai', 'perplexity'],
    ['gemini', 'gemini'], ['gemini.google.com', 'gemini'],
    ['copilot', 'copilot'], ['copilot.microsoft.com', 'copilot'],
    ['claude.ai', 'claude'], ['claude', 'claude'],
  ];
  for (const [source, engine] of cases) {
    const r = resolveAttribution({ utm: { source }, referrerHost: null, path: '/' });
    assert.equal(r.channel, 'ai_generative', `source=${source}`);
    assert.equal(r.aiEngine, engine, `source=${source}`);
    // المصدر يُحفظ باسم المحرّك (في القاموس) لا other فلا يضيع
    assert.equal(r.utmSource, engine, `source=${source}`);
  }
});

test('مصدر الذكاء في utm_source يسبق المُحيل غير الذكي، ولا يسبق الدفع ولا الوسيط الصريح', () => {
  assert.equal(resolveAttribution({ utm: { source: 'chatgpt.com' }, referrerHost: 'www.google.com' }).channel, 'ai_generative');
  const paid = resolveAttribution({ utm: { source: 'chatgpt.com', clickId: 'gad_source' }, referrerHost: null });
  assert.equal(paid.channel, 'paid_search');
  const mail = resolveAttribution({ utm: { source: 'claude', medium: 'email' } });
  assert.equal(mail.channel, 'email');
  // مُحيل الذكاء يبقى حاسماً كما كان
  assert.equal(resolveAttribution({ utm: { source: 'google' }, referrerHost: 'chatgpt.com' }).aiEngine, 'chatgpt');
});

test('مصادر ليست مساعد ذكاء لا تُصنَّف ai_generative', () => {
  for (const source of ['notchatgpt.com', 'chatgpt.com.evil.io', 'openai-news', 'google', 'مصدر']) {
    assert.equal(aiEngineOfSource(source), null, `source=${source}`);
    assert.equal(resolveAttribution({ utm: { source }, referrerHost: null }).channel, 'direct', `source=${source}`);
  }
  assert.equal(aiEngineOfSource(undefined), null);
  assert.equal(resolveAttribution({ utm: { source: 'notchatgpt.com' } }).utmSource, 'other');
});

test('لوحة المالك تعدّ زيارة الذكاء بلا مُحيل: لكل محرّك في AI_ENGINE_IDS تسمية في analytics.ts', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../routes/analytics.ts', import.meta.url), 'utf8');
  assert.deepEqual([...AI_ENGINE_IDS].sort(), ['chatgpt', 'claude', 'copilot', 'gemini', 'perplexity']);
  for (const id of AI_ENGINE_IDS) assert.match(src, new RegExp(`engine: '${id}'`), `engine=${id}`);
  assert.match(src, /const aiRows = rows\.filter\(\(r\) => aiLabelOf\(r\)\)/);
  assert.match(src, /r\.channel === 'ai_generative' && r\.aiEngine/);
});

// --- #10/#23: بصمة IP بملح سرّي دائماً ---

const oldHash = (ip: string, salt: string) => createHash('sha256').update(ip + salt).digest('hex').slice(0, 16);

test('IP_SALT مضبوط ⇒ البصمة بالصيغة نفسها السابقة (استمرارية)', () => {
  const env = { IP_SALT: 'قيمة-سرية-للاختبار', JWT_SECRET: 'jwt-test' };
  assert.equal(ipSalt(env), env.IP_SALT);
  assert.equal(ipFingerprint('203.0.113.7', env), oldHash('203.0.113.7', env.IP_SALT));
});

test('غياب IP_SALT ⇒ ملح مشتقّ من JWT_SECRET بـHMAC لا الملح المكشوف fieldsa-visits', () => {
  const env = { JWT_SECRET: 'jwt-secret-for-test' };
  const salt = ipSalt(env);
  assert.ok(salt && /^[0-9a-f]{64}$/.test(salt));
  assert.equal(salt!.includes(env.JWT_SECRET), false);   // السرّ نفسه لا يظهر
  const h = ipFingerprint('203.0.113.7', env);
  assert.match(h!, /^[0-9a-f]{16}$/);
  assert.notEqual(h, oldHash('203.0.113.7', 'fieldsa-visits'));
  assert.equal(ipFingerprint('203.0.113.7', env), h);                                 // ثابتة لنفس الزائر
  assert.notEqual(ipFingerprint('203.0.113.8', env), h);                               // تميّز الزوّار
  assert.notEqual(ipFingerprint('203.0.113.7', { JWT_SECRET: 'another-secret' }), h); // الملح سرّي فعلاً
  assert.equal(ipSalt({ IP_SALT: '   ', JWT_SECRET: env.JWT_SECRET }), salt);         // IP_SALT فارغ = غائب
});

test('لا سرّ متاح ⇒ لا بصمة أصلاً (لا ملح ثابت في الكود)', () => {
  assert.equal(ipSalt({}), null);
  assert.equal(ipFingerprint('203.0.113.7', {}), null);
  assert.equal(ipFingerprint('', { JWT_SECRET: 'x' }), null);
  assert.equal(ipFingerprint(null, { JWT_SECRET: 'x' }), null);
});

test('المسار لا يحوي ملحاً افتراضياً ويشتقّ البصمة من ipFingerprint في /track و/go/wa', async () => {
  const { readFileSync } = await import('node:fs');
  const route = readFileSync(new URL('../routes/analytics.ts', import.meta.url), 'utf8');
  const service = readFileSync(new URL('../services/attribution.ts', import.meta.url), 'utf8');
  assert.equal(route.includes('fieldsa-visits'), false);
  assert.equal(service.includes('fieldsa-visits'), false);
  assert.equal((route.match(/const ipHash = ipFingerprint\(ip\);/g) || []).length, 2);
});

// --- #15: بلا IPAPI_KEY الطلب مطابق حرفياً لما قبل المفتاح ---

test('geoLookupUrl بلا مفتاح = رابط HTTP المجاني نفسه حرفياً (IPv4 وIPv6)', () => {
  for (const ip of ['8.8.8.8', '2001:4860:4860::8888']) {
    const head = `http://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city`;
    assert.equal(geoLookupUrl(ip), head);
    assert.equal(geoLookupUrl(ip, ''), head);
    assert.equal(geoLookupUrl(ip, '   '), head);
  }
});

test('geoLookupUrl بمفتاح ⇒ HTTPS، وعنوان غير صالح ⇒ لا طلب', () => {
  assert.equal(
    geoLookupUrl('8.8.8.8', 'k&y'),
    'https://pro.ip-api.com/json/8.8.8.8?fields=status,country,countryCode,regionName,city&key=k%26y',
  );
  for (const bad of ['', 'abc', '1.2.3.4/../batch', '1.2.3.4?x=1', '1.2.3.4:8080', 'fe80::1%eth0']) {
    assert.equal(geoLookupUrl(bad), null, `ip=${bad}`);
  }
});
