// المندوب الذكي — مفتاح العقل لكل شركة (تشفير مربوط بالشركة) وحارس روابط خرائط Google
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const SRC = path.join(__dirname, '..');
const stub = (rel: string, exports: Record<string, unknown>): void => {
  const id = require.resolve(path.join(SRC, rel));
  require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, ...exports }, children: [], paths: [] } as unknown as NodeJS.Module;
};
stub('config/database', { default: {} });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { encryptLlmKey, decryptLlmKey, llmConfigFromRow, secretsReady, keyHint, LLM_PROVIDERS } = require('../ai-rep/llmTenant') as typeof import('../ai-rep/llmTenant');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { isGoogleMapsUrl } = require('../services/geoLink') as typeof import('../services/geoLink');

const env = { ZATCA_SECRETS_KEY: 'a'.repeat(64) } as NodeJS.ProcessEnv;
const KEY = 'fw_test_1234567890abcdef';

test('التشفير: ذهاب وإياب، والنص المشفّر لا يحوي المفتاح', () => {
  const enc = encryptLlmKey('t1', KEY, env);
  assert.match(enc, /^v1\./);
  assert.ok(!enc.includes(KEY));
  assert.equal(decryptLlmKey('t1', enc, env), KEY);
  assert.notEqual(encryptLlmKey('t1', KEY, env), enc, 'متّجه ابتدائي عشوائي لكل تشفير');
});

test('التشفير مربوط بالشركة وبسرّ الخادم', () => {
  const enc = encryptLlmKey('t1', KEY, env);
  assert.equal(decryptLlmKey('t2', enc, env), null, 'نصّ شركة لا يصلح لأخرى');
  assert.equal(decryptLlmKey('t1', enc, { ZATCA_SECRETS_KEY: 'b'.repeat(64) } as NodeJS.ProcessEnv), null);
  assert.equal(decryptLlmKey('t1', enc.slice(0, -2) + 'AA', env), null, 'العبث بالنص يُرفض');
  assert.equal(secretsReady({} as NodeJS.ProcessEnv), false);
  assert.throws(() => encryptLlmKey('t1', KEY, {} as NodeJS.ProcessEnv), /SECRETS_NOT_CONFIGURED/);
});

test('إعداد العقل من صفّ الشركة، والرجوع للإعداد العام عند غيابه', () => {
  const row = { llmProvider: 'FIREWORKS_US', llmModel: null, llmKeyEnc: encryptLlmKey('t1', KEY, env) };
  const cfg = llmConfigFromRow('t1', row, env);
  assert.ok(cfg);
  assert.equal(cfg!.apiKey, KEY);
  assert.equal(cfg!.baseUrl, LLM_PROVIDERS.FIREWORKS_US.baseUrl);
  assert.equal(cfg!.model, LLM_PROVIDERS.FIREWORKS_US.defaultModel);
  assert.equal(llmConfigFromRow('t1', { ...row, llmModel: 'custom/model' }, env)!.model, 'custom/model');
  // مفتاح شركة أخرى أو مزوّد مجهول ⇒ لا مفتاح للشركة (والبيئة بلا إعداد عام ⇒ null)
  assert.equal(llmConfigFromRow('t2', row, env), null);
  assert.equal(llmConfigFromRow('t1', { ...row, llmProvider: 'EVIL' }, env), null);
  assert.equal(llmConfigFromRow('t1', null, env), null);
  assert.equal(keyHint(KEY), 'cdef');
  // Groq: gpt-oss-120b افتراضياً، والتفكير لا يُعاد في الرد (فلا يُرسل راجعاً في حلقة الأدوات)
  const groq = llmConfigFromRow('t1', { llmProvider: 'GROQ', llmModel: null, llmKeyEnc: encryptLlmKey('t1', KEY, env) }, env)!;
  assert.equal(groq.model, 'openai/gpt-oss-120b');
  assert.equal(groq.extraBody?.include_reasoning, false);
});

test('حارس الروابط: خرائط Google وحدها', () => {
  for (const u of ['https://maps.app.goo.gl/AbC123', 'https://goo.gl/maps/x', 'https://www.google.com/maps/place/x', 'https://maps.google.com.sa/?q=1,2', 'https://google.com.sa/maps']) {
    assert.equal(isGoogleMapsUrl(u), true, u);
  }
  for (const u of ['https://googlefevil.com/x', 'https://google.com.evil.io/', 'http://169.254.169.254/', 'https://evil.com/?google.com', 'file:///etc/passwd', 'https://maps.google.com@evil.com/', 'not a url']) {
    assert.equal(isGoogleMapsUrl(u), false, u);
  }
});
