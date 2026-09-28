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

test('تفاصيل محلٍّ ضُغط على الخريطة: النوع والموقع، والمغلق، والأخطاء بلا مفتاح', async () => {
  const { placeDetails, isGooglePlaceId } = await import('../ai-rep/places');
  assert.equal(isGooglePlaceId('ChIJN1t_tDeuEmsRUsoyG83frY4'), true);
  assert.equal(isGooglePlaceId('../../etc'), false);
  assert.equal(isGooglePlaceId('short'), false);
  let url = '';
  let headers: Record<string, string> = {};
  const ok = (body: unknown, status = 200) => async (u: string, init: { headers: Record<string, string> }) => {
    url = u; headers = init.headers;
    return { ok: status < 400, status, json: async () => body };
  };
  const r = await placeDetails({ apiKey: 'k', placeId: 'ChIJN1t_tDeuEmsRUsoyG83frY4', fetchImpl: ok({ id: 'ChIJN1t_tDeuEmsRUsoyG83frY4', displayName: { text: 'تموينات النرجس' }, location: { latitude: 24.8, longitude: 46.6 }, primaryType: 'grocery_store', types: ['grocery_store', 'store'] }) });
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.place.name, 'تموينات النرجس'); assert.equal(r.place.primaryType, 'grocery_store'); assert.equal(r.closed, false); }
  assert.match(url, /places\/ChIJN1t_tDeuEmsRUsoyG83frY4\?languageCode=ar$/);
  assert.equal(headers['X-Goog-FieldMask'], 'id,displayName,location,primaryType,types,businessStatus');
  const closed = await placeDetails({ apiKey: 'k', placeId: 'ChIJN1t_tDeuEmsRUsoyG83frY4', fetchImpl: ok({ id: 'x1234567890', location: { latitude: 1, longitude: 2 }, businessStatus: 'CLOSED_PERMANENTLY' }) });
  assert.ok(closed.ok && closed.closed);
  assert.deepEqual((await placeDetails({ apiKey: null, placeId: 'ChIJN1t_tDeuEmsRUsoyG83frY4' })).ok, false);
  const quota = await placeDetails({ apiKey: 'k', placeId: 'ChIJN1t_tDeuEmsRUsoyG83frY4', fetchImpl: ok({}, 429) });
  assert.ok(!quota.ok && quota.code === 'PLACES_QUOTA');
});
