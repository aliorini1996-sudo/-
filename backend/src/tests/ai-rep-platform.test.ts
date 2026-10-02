// المندوب الذكي — العقل الموحّد للمنصّة (Groq gpt-oss-120b) وحارس روابط خرائط Google
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletion, llmConfig, GROQ_BASE_URL, GROQ_DEFAULT_MODEL } from '../ai-rep/llm';
import { isGoogleMapsUrl } from '../services/geoLink';

test('العقل: مفتاح Groq وحده يكفي — العنوان والنموذج وخيارات التفكير افتراضية', () => {
  assert.equal(llmConfig({} as NodeJS.ProcessEnv), null, 'بلا مفتاح ⇒ غير مضبوط');
  for (const env of [{ GROQ_API_KEY: 'gsk_x' }, { AI_REP_LLM_API_KEY: 'gsk_x' }]) {
    const c = llmConfig(env as NodeJS.ProcessEnv)!;
    assert.equal(c.baseUrl, GROQ_BASE_URL);
    assert.equal(c.model, GROQ_DEFAULT_MODEL);
    assert.equal(c.model, 'openai/gpt-oss-120b');
    assert.deepEqual(c.extraBody, { reasoning_effort: 'high', include_reasoning: false });
    assert.equal(c.echoReasoning, false);
  }
  // مفتاح Groq العام لا يُرسل لمضيف آخر
  assert.equal(llmConfig({ AI_REP_LLM_BASE_URL: 'https://api.example.com/v1', GROQ_API_KEY: 'gsk_x', AI_REP_LLM_MODEL: 'm' } as NodeJS.ProcessEnv), null);
  const other = llmConfig({ AI_REP_LLM_BASE_URL: 'https://api.example.com/v1', AI_REP_LLM_API_KEY: 'k', AI_REP_LLM_MODEL: 'm' } as NodeJS.ProcessEnv)!;
  assert.equal(other.echoReasoning, true);
  assert.deepEqual(other.extraBody, {});
});

test('Groq: «التفكير» لا يُعاد في دورة الأدوات', async () => {
  const cfg = llmConfig({ GROQ_API_KEY: 'gsk_x' } as NodeJS.ProcessEnv)!;
  let sent: { messages: Record<string, unknown>[]; reasoning_effort?: string; include_reasoning?: boolean } | null = null;
  const fake = async (_u: string, init: { body: string }) => {
    sent = JSON.parse(init.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'تمام' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) };
  };
  const r = await chatCompletion(cfg, { messages: [{ role: 'user', content: 'س' }, { role: 'assistant', content: null, reasoning_content: 'سرّي', tool_calls: [] }] }, fake);
  assert.equal(r.ok, true);
  assert.ok(sent);
  assert.ok(!('reasoning_content' in sent!.messages[1]));
  assert.equal(sent!.reasoning_effort, 'high');
  assert.equal(sent!.include_reasoning, false);
});

test('حارس الروابط: خرائط Google وحدها', () => {
  for (const u of ['https://maps.app.goo.gl/AbC123', 'https://goo.gl/maps/x', 'https://www.google.com/maps/place/x', 'https://maps.google.com.sa/?q=1,2', 'https://google.com.sa/maps']) {
    assert.equal(isGoogleMapsUrl(u), true, u);
  }
  for (const u of ['https://googlefevil.com/x', 'https://google.com.evil.io/', 'http://169.254.169.254/', 'https://evil.com/?google.com', 'file:///etc/passwd', 'https://maps.google.com@evil.com/', 'not a url']) {
    assert.equal(isGoogleMapsUrl(u), false, u);
  }
});

test('معرّف مكان Google: ما تُرسله ضغطة الخريطة وحده (لا مسارات ولا قصير)', async () => {
  const { isGooglePlaceId } = await import('../ai-rep/places');
  assert.equal(isGooglePlaceId('ChIJN1t_tDeuEmsRUsoyG83frY4'), true);
  assert.equal(isGooglePlaceId('../../etc'), false);
  assert.equal(isGooglePlaceId('short'), false);
});

// ───────────── جلب الروابط من الخادم (SSRF) ─────────────

test('العناوين الداخلية مرفوضة: loopback والشبكات الخاصة وlink-local (بيانات السحابة) وCGNAT وIPv6 المحلي والمُعيَّن', async () => {
  const { isPublicIp } = await import('../services/geoLink');
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', 'not-an-ip']) {
    assert.equal(isPublicIp(ip), false, ip);
  }
  for (const ip of ['142.250.74.46', '8.8.8.8', '172.32.0.1', '2a00:1450:4001:82b::200e', '::ffff:8.8.8.8']) assert.equal(isPublicIp(ip), true, ip);
});

test('حلّ رابط موقع العميل: لا يجلب رابطاً خارج Google (googleOnly) ولا عنواناً داخلياً أبداً — والإحداثيات الصريحة بلا شبكة', async () => {
  const { resolveLocationUrl } = await import('../services/geoLink');
  const realFetch = globalThis.fetch;
  const fetched: string[] = [];
  globalThis.fetch = (async (u: string) => { fetched.push(String(u)); return new Response('', { status: 404 }); }) as typeof fetch;
  try {
    assert.equal(await resolveLocationUrl('http://internal-service:8080/admin', { googleOnly: true }), null);
    assert.equal(await resolveLocationUrl('http://127.0.0.1:5432/', {}), null, 'حتى بلا googleOnly لا عنوان داخلي');
    assert.equal(await resolveLocationUrl('http://169.254.169.254/latest/meta-data/', {}), null);
    assert.equal(await resolveLocationUrl('http://[::1]/', {}), null);
    assert.deepEqual(fetched, [], 'لا طلب شبكة لأيٍّ منها');
    assert.deepEqual(await resolveLocationUrl('https://evil.example/?q=24.7136,46.6753', { googleOnly: true }), { lat: 24.7136, lng: 46.6753 }, 'الإحداثيات في الرابط تُقرأ بلا جلب');
    // لصق «lat,lng» مباشرة (بالفاصلة العربية أيضاً) — أفسده تنظيف النصوص aa0c3be فلم يُقرأ
    assert.deepEqual(await resolveLocationUrl('24.7136, 46.6753', { googleOnly: true }), { lat: 24.7136, lng: 46.6753 });
    assert.deepEqual(await resolveLocationUrl('24.7136،46.6753'), { lat: 24.7136, lng: 46.6753 });
    assert.deepEqual(fetched, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ───────────── دلو رموز العقل المشترك ─────────────

test('دلو الرموز: يحجز فوراً وينتظر العجز، ويرفض بلا حجز ما لا يتّسع خلال مهلته، ويردّ فرق التقدير بعد النداء', async () => {
  const { TokenBucket } = await import('../ai-rep/llm');
  let t = 0;
  const b = new TokenBucket(6000, () => t);
  assert.equal(b.take(4000, 3000), 0, 'ممتلئ ⇒ بلا انتظار');
  assert.equal(b.take(3000, 30_000), 10_000, 'عجز ١٠٠٠ بمعدّل ١٠٠ في الثانية ⇒ ١٠ ث');
  assert.equal(b.take(500, 3000), null, 'لا يتّسع خلال ٣ ث ⇒ رفض');
  b.settle(3000, 1000); // الفعلي أقلّ من التقدير ⇒ يعود الفرق
  t += 60_000; // دقيقة ⇒ يمتلئ من جديد (لا يتجاوز سعته)
  assert.equal(b.take(6000, 0), 0);
  assert.equal(b.take(99_999, 0), null, 'التقدير فوق السعة يُحسب بالسعة');
});

test('حدّ الرموز في الدقيقة: Groq ٨٠٠٠ افتراضياً، وغيره بلا حدّ، والمتغيّر يغلب؛ والدلو المستنفد يردّ LLM_RATE_LIMIT محلياً بلا طلب', async () => {
  const { chatCompletion: call, llmConfig: cfgOf, llmTpm, resetLlmBucket } = await import('../ai-rep/llm');
  assert.equal(llmTpm('https://api.groq.com/openai/v1', {} as NodeJS.ProcessEnv), 8000);
  assert.equal(llmTpm('https://api.example.com/v1', {} as NodeJS.ProcessEnv), 0);
  assert.equal(llmTpm('https://api.groq.com/openai/v1', { AI_REP_LLM_TPM: '250000' } as NodeJS.ProcessEnv), 250000);
  assert.equal(llmTpm('https://api.groq.com/openai/v1', { AI_REP_LLM_TPM: '0' } as NodeJS.ProcessEnv), 0, '0 يطفئه');
  const prev = process.env.AI_REP_LLM_TPM;
  process.env.AI_REP_LLM_TPM = '1000';
  resetLlmBucket();
  try {
    const cfg = cfgOf({ GROQ_API_KEY: 'gsk_x' } as NodeJS.ProcessEnv)!;
    let hits = 0;
    const fake = async () => { hits++; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'تمام' }, finish_reason: 'stop' }], usage: { prompt_tokens: 400, completion_tokens: 500 } }) }; };
    const req = { messages: [{ role: 'user' as const, content: 'س' }], maxTokens: 500 };
    assert.equal((await call(cfg, req, fake)).ok, true);
    const r = await call(cfg, req, fake);
    assert.ok(!r.ok && r.code === 'LLM_RATE_LIMIT', 'الاستهلاك الفعلي ٩٠٠ من ١٠٠٠ ⇒ النداء التالي لا يتّسع خلال ٣ ث');
    assert.equal(hits, 1, 'لم يُرسل للمضيف');
  } finally {
    if (prev === undefined) delete process.env.AI_REP_LLM_TPM; else process.env.AI_REP_LLM_TPM = prev;
    resetLlmBucket();
  }
});
