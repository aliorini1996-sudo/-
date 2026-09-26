// المندوب الذكي — المستشار: حلقة الوكيل، حارس الأرقام، حجب البيانات الشخصية، عميل النموذج، والأدوات. بلا شبكة.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractNumbers, normalizeDigits, numbersIn, runAdvisor, scrubPii, trimSentences, unsupportedNumbers, AdvisorTool } from '../ai-rep/advisor';
import { chatCompletion, llmConfig, parseCompletion, LlmRequest, LlmResult } from '../ai-rep/llm';
import { advisorSystemPrompt, buildAdvisorTools, orderStops, OutletCtx } from '../ai-rep/advisorTools';
import type { TenantEstimateData } from '../ai-rep/estimateData';

const U = { promptTokens: 100, completionTokens: 20, cachedTokens: 50 };
const say = (content: string): LlmResult => ({ ok: true, content, toolCalls: [], usage: U, finishReason: 'stop' });
const call = (name: string, args: unknown, id = 'c1'): LlmResult => ({ ok: true, content: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }], usage: U, finishReason: 'tool_calls' });
function scripted(steps: LlmResult[]) {
  const seen: LlmRequest[] = [];
  return { seen, llm: async (r: LlmRequest) => { seen.push(r); return steps.shift() ?? say('انتهى'); } };
}
const tool = (name: string, data: unknown, summaryAr = 'ملخّص', refs?: string[]): AdvisorTool => ({
  spec: { type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } },
  run: async () => ({ data, summaryAr, refs }),
});

// ───────────── الأرقام والخصوصية ─────────────

test('توحيد الأرقام: الهندية والفارسية والفاصلة العشرية العربية وفواصل الآلاف', () => {
  assert.equal(normalizeDigits('٣٣٠ مل و۱۲ و٢٫٥ و١٬٢٠٠'), '330 مل و12 و2.5 و1200');
  assert.deepEqual(extractNumbers('من ٦ إلى 12 كرتون، والوسيط ٨٫٥'), [6, 12, 8.5]);
});

test('القائمة البيضاء: النسب تُقبل مئوية، والأرقام الصغيرة للترقيم حرّة', () => {
  const allowed = numbersIn({ penetration: 0.7, qty: { low: 6, median: 8, high: 12 }, note: 'من ٩ بقالات' });
  assert.deepEqual(unsupportedNumbers('٧٠٪ من المحلات تشتريه، شهرياً ٦–١٢ والوسيط ٨، من ٩ بقالات', allowed), []);
  assert.deepEqual(unsupportedNumbers('اعرض عليه ٢٠ كرتون', allowed), [20]);
  assert.deepEqual(unsupportedNumbers('أول ٣ محلات', allowed), []);
});

test('حذف الجمل ذات الأرقام المخترعة فقط', () => {
  const allowed = new Set([8]);
  assert.equal(trimSentences('الوسيط 8 كراتين. واعرض 40 كرتون! ابدأ بالمياه.', allowed), 'الوسيط 8 كراتين. ابدأ بالمياه.');
});

test('حجب البيانات الشخصية قبل الإرسال — ويبقي أرقام المنتجات', () => {
  const s = scrubPii('جوال العميل ٠٥٥١٢٣٤٥٦٧ و+966 55 123 4567 وبريده a.b@x.com وآيبان SA0380000000608010167519 وسجله 1010123456 — كم كرتون مياه ٣٣٠ مل؟');
  assert.doesNotMatch(s, /0551234567|123 4567|a\.b@x\.com|SA0380|1010123456/);
  assert.match(s, /330 مل/);
  assert.match(s, /\[جوال محجوب\]/);
});

// ───────────── الحلقة ─────────────

test('الحلقة: أداة ثم رد بأرقامها ⇒ PASS، والمراجع والاستهلاك مجمّعة', async () => {
  const { llm, seen } = scripted([call('outlet_estimate', { ref: 'P1' }), say('P1 يشتري المياه شهرياً ٦–١٢ كرتون، ابدأ بطلب تجريبي ٤.')]);
  const r = await runAdvisor({
    system: 'sys', history: [{ role: 'user', text: 'وش أعرض على P1؟' }], baseAllowed: new Set(),
    tools: { outlet_estimate: tool('outlet_estimate', { monthly: { low: 6, median: 8, high: 12 }, trial: 4 }, 'P1: ملخص', ['P1']) }, llm,
  });
  assert.ok(!('error' in r));
  if ('error' in r) return;
  assert.equal(r.guard, 'PASS');
  assert.deepEqual(r.refs, ['P1']);
  assert.equal(r.hops, 1);
  assert.deepEqual(r.usage, { promptTokens: 200, completionTokens: 40, cachedTokens: 100 });
  assert.equal(seen[1].messages.at(-1)!.role, 'tool', 'نتيجة الأداة تُعاد للنموذج');
});

test('الحارس: رقم مخترع ⇒ إعادة توليد نظيفة (REGEN)', async () => {
  const { llm, seen } = scripted([call('outlet_estimate', { ref: 'P1' }), say('اعرض ٢٥ كرتون.'), say('اعرض الطلب التجريبي ٤ كراتين.')]);
  const r = await runAdvisor({ system: 's', history: [{ role: 'user', text: 'كم أعرض؟' }], baseAllowed: new Set(), tools: { outlet_estimate: tool('outlet_estimate', { trial: 4 }) }, llm });
  assert.ok(!('error' in r) && r.guard === 'REGEN');
  assert.match(String(seen[2].messages.at(-1)!.content), /25/, 'التنبيه يسمّي الرقم المخالف');
  assert.equal(seen[2].toolChoice, 'none');
});

test('الحارس: الإعادة مخالفة أيضاً ⇒ قصّ الجمل، وإن لم يبقَ شيء ⇒ قالب حتمي', async () => {
  const b = scripted([call('outlet_estimate', { ref: 'P1' }), say('اعرض ٥٠ كرتون.'), say('الطلب التجريبي ٤ كراتين مناسب جداً لهذا المحل. واعرض ٣٠ كرتون عصير.')]);
  const r2 = await runAdvisor({ system: 's', history: [{ role: 'user', text: 'كم؟' }], baseAllowed: new Set(), tools: { outlet_estimate: tool('outlet_estimate', { trial: 4 }) }, llm: b.llm });
  assert.ok(!('error' in r2) && r2.guard === 'TRIM');
  if (!('error' in r2)) assert.doesNotMatch(r2.text, /30/);
  const c = scripted([call('outlet_estimate', { ref: 'P1' }), say('اعرض ٥٠ كرتون.'), say('اعرض ٧٠.')]);
  const r3 = await runAdvisor({ system: 's', history: [{ role: 'user', text: 'كم؟' }], baseAllowed: new Set(), tools: { outlet_estimate: tool('outlet_estimate', { trial: 4 }, 'P1: الطلب التجريبي 4') }, llm: c.llm });
  assert.ok(!('error' in r3) && r3.guard === 'TEMPLATE');
  if (!('error' in r3)) assert.equal(r3.text, 'P1: الطلب التجريبي 4');
});

test('أرقام رسالة المندوب ودليل الشركة مسموحة', async () => {
  const { llm } = scripted([say('طلبت ١٥ كرتون، والحد الأدنى في دليلكم 5 كراتين والآجل 30 يوماً.')]);
  const r = await runAdvisor({ system: 's', history: [{ role: 'user', text: 'العميل يبي ١٥ كرتون' }], baseAllowed: new Set([30]), tools: {}, llm });
  assert.ok(!('error' in r) && r.guard === 'PASS');
});

test('أداة مجهولة أو وسائط فاسدة أو تكرار ⇒ خطأ يُعاد للنموذج ويستمر', async () => {
  const bad: LlmResult = { ok: true, content: '', toolCalls: [{ id: 'b', name: 'outlet_estimate', arguments: '{not json' }], usage: U, finishReason: 'tool_calls' };
  const { llm, seen } = scripted([call('delete_everything', {}), bad, call('outlet_estimate', { ref: 'P1' }), call('outlet_estimate', { ref: 'P1' }, 'c2'), say('تم.')]);
  const r = await runAdvisor({ system: 's', history: [{ role: 'user', text: 'x' }], baseAllowed: new Set(), tools: { outlet_estimate: tool('outlet_estimate', { a: 1 }) }, llm });
  assert.ok(!('error' in r));
  const toolMsgs = seen.at(-1)!.messages.filter(m => m.role === 'tool').map(m => String(m.content));
  assert.match(toolMsgs[0], /unknown tool/);
  assert.match(toolMsgs[1], /invalid JSON/);
  assert.match(toolMsgs[3], /duplicate/);
});

test('حدّ القفزات: بعد 4 يُمنع استدعاء الأدوات ويُطلب رد', async () => {
  const steps = [0, 1, 2, 3].map(i => call('outlet_estimate', { ref: `P${i + 1}` }, `c${i}`));
  const { llm, seen } = scripted([...steps, say('خلاصة.')]);
  const r = await runAdvisor({ system: 's', history: [{ role: 'user', text: 'x' }], baseAllowed: new Set(), tools: { outlet_estimate: tool('outlet_estimate', {}) }, llm });
  assert.ok(!('error' in r) && r.hops === 4);
  assert.equal(seen[4].tools, undefined);
  assert.equal(seen[4].toolChoice, 'none');
});

test('فشل النموذج ⇒ خطأ صريح لا رد مخترع', async () => {
  const r = await runAdvisor({ system: 's', history: [{ role: 'user', text: 'x' }], baseAllowed: new Set(), tools: {}, llm: async () => ({ ok: false, code: 'LLM_TIMEOUT' }) });
  assert.deepEqual(r, { error: 'LLM', code: 'LLM_TIMEOUT' });
});

test('رسالة المندوب تُرسل للنموذج محجوبة البيانات الشخصية', async () => {
  const { llm, seen } = scripted([say('تمام')]);
  await runAdvisor({ system: 's', history: [{ role: 'user', text: 'رقمه 0551234567' }], baseAllowed: new Set(), tools: {}, llm });
  assert.doesNotMatch(String(seen[0].messages[1].content), /0551234567/);
});

// ───────────── عميل النموذج ─────────────

test('الإعداد: الثلاثة مطلوبة وHTTPS فقط، والجسم الإضافي يُدمج', () => {
  assert.equal(llmConfig({}), null);
  assert.equal(llmConfig({ AI_REP_LLM_BASE_URL: 'http://x', AI_REP_LLM_API_KEY: 'k', AI_REP_LLM_MODEL: 'm' }), null);
  const c = llmConfig({ AI_REP_LLM_BASE_URL: 'https://api.example.com/v1/', AI_REP_LLM_API_KEY: 'k', AI_REP_LLM_MODEL: 'm', AI_REP_LLM_EXTRA_BODY: '{"chat_template_kwargs":{"thinking":false}}' });
  assert.equal(c!.baseUrl, 'https://api.example.com/v1');
  assert.deepEqual(c!.extraBody, { chat_template_kwargs: { thinking: false } });
  assert.deepEqual(llmConfig({ AI_REP_LLM_BASE_URL: 'https://a', AI_REP_LLM_API_KEY: 'k', AI_REP_LLM_MODEL: 'm', AI_REP_LLM_EXTRA_BODY: '{bad' })!.extraBody, {});
});

test('الطلب: المفتاح في الترويسة، والأدوات والمعاملات، والأخطاء تُترجم لرموز', async () => {
  const cfg = llmConfig({ AI_REP_LLM_BASE_URL: 'https://h/v1', AI_REP_LLM_API_KEY: 'secret', AI_REP_LLM_MODEL: 'deepseek', AI_REP_LLM_EXTRA_BODY: '{"x":1}' });
  let sent: { url: string; headers: Record<string, string>; body: string } | null = null;
  const ok = await chatCompletion(cfg, { messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 't', description: 'd', parameters: {} } }] },
    async (url, init) => { sent = { url, headers: init.headers, body: init.body }; return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'أهلاً' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 8 } }) }; });
  assert.ok(ok.ok && ok.content === 'أهلاً' && ok.usage.cachedTokens === 8);
  assert.equal(sent!.url, 'https://h/v1/chat/completions');
  assert.equal(sent!.headers.Authorization, 'Bearer secret');
  const b = JSON.parse(sent!.body);
  assert.equal(b.model, 'deepseek'); assert.equal(b.x, 1); assert.equal(b.tool_choice, 'auto'); assert.equal(b.stream, false);
  const denied = await chatCompletion(cfg, { messages: [] }, async () => ({ ok: false, status: 401, json: async () => ({}) }));
  assert.ok(!denied.ok && denied.code === 'LLM_AUTH');
  const limited = await chatCompletion(cfg, { messages: [] }, async () => ({ ok: false, status: 429, json: async () => ({}) }));
  assert.ok(!limited.ok && limited.code === 'LLM_RATE_LIMIT');
  const aborted = await chatCompletion(cfg, { messages: [] }, async () => { const e = new Error('a'); e.name = 'AbortError'; throw e; });
  assert.ok(!aborted.ok && aborted.code === 'LLM_TIMEOUT');
  assert.deepEqual(await chatCompletion(null, { messages: [] }), { ok: false, code: 'LLM_NOT_CONFIGURED' });
});

test('تحليل الرد: استدعاءات الأدوات والرموز المخزّنة بصيغتَي OpenAI وDeepSeek', () => {
  const r = parseCompletion({ choices: [{ message: { content: null, tool_calls: [{ id: 'x', function: { name: 'plan_route', arguments: '{"refs":["P1"]}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 3 } } });
  assert.ok(r.ok && r.toolCalls[0].name === 'plan_route' && r.usage.cachedTokens === 3 && r.content === '');
  assert.equal(parseCompletion({}).ok, false);
});

// ───────────── الأدوات ─────────────

const data: TenantEstimateData = {
  timezone: 'Asia/Riyadh', window: { from: '2026-03', to: '2026-08' },
  peers: ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, lat: 24.7, lng: 46.7 + 0.001 * (i + 1), outletType: 'GROCERY', firstYm: '2025-01', lastInvoiceAt: new Date('2026-09-10') })),
  monthly: ['a', 'b', 'c', 'd', 'e'].flatMap(id => ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].map(ym => ({ customerId: id, productId: 'w', ym, qty: 8, value: 80 }))),
  firstOrders: [], products: [{ id: 'w', name: 'مياه 330 مل', unit: 'كرتون' }],
};
const outlets: OutletCtx[] = [
  { ref: 'P1', outletType: 'GROCERY', lat: 24.7, lng: 46.705, distanceM: 400, relation: 'NEW', lastOutcome: null },
  { ref: 'P2', outletType: 'GROCERY', lat: 24.7, lng: 46.71, distanceM: 900, relation: 'CUSTOMER', lastOutcome: 'INTERESTED' },
];
const ctx = { companyName: 'شركة س', outlets, origin: { lat: 24.7, lng: 46.7 }, data, minPeers: 5, showMoney: true, playbook: 'الحد الأدنى 5 كراتين', now: new Date('2026-09-20'), currency: 'SAR' };

test('الأدوات: القائمة بلا إحداثيات ولا أسماء، والتوقّع لمحل، والمسار، والمرجع المجهول', async () => {
  const t = buildAdvisorTools(ctx);
  const list = await t.list_opportunities.run({});
  assert.ok(!('error' in list));
  const json = JSON.stringify((list as { data: unknown }).data);
  assert.doesNotMatch(json, /24\.7|46\.7/, 'لا إحداثيات للنموذج');
  assert.match(json, /"ref":"P1"/);
  const est = await t.outlet_estimate.run({ ref: 'P1' });
  assert.ok(!('error' in est));
  assert.match(JSON.stringify((est as { data: unknown }).data), /"median":8/);
  assert.ok('error' in (await t.outlet_estimate.run({ ref: 'P9' })));
  assert.ok('error' in (await t.outlet_estimate.run({ ref: 'DROP TABLE' })));
  const route = await t.plan_route.run({ refs: ['P2', 'P1'] });
  assert.ok(!('error' in route));
  assert.deepEqual((route as { refs: string[] }).refs, ['P1', 'P2']);
  const cat = await t.product_catalog.run({ query: 'مياه' });
  assert.ok(!('error' in cat));
});

test('إخفاء المال يمتد إلى الأدوات والتعليمات', async () => {
  const t = buildAdvisorTools({ ...ctx, showMoney: false });
  const est = await t.outlet_estimate.run({ ref: 'P1' });
  assert.doesNotMatch(JSON.stringify((est as { data: unknown }).data), /value/);
  assert.match(advisorSystemPrompt({ ...ctx, showMoney: false }), /لا تذكر أي قيمة مالية/);
  assert.match(advisorSystemPrompt(ctx), /<<<\nالحد الأدنى 5 كراتين\n>>>/);
});

test('ترتيب المحطات من موقع المندوب', () => {
  const o = { lat: 0, lng: 0 };
  assert.deepEqual(orderStops(o, [{ lat: 0, lng: 0.03, id: 'c' }, { lat: 0, lng: 0.01, id: 'a' }, { lat: 0, lng: 0.02, id: 'b' }]).map(s => s.id), ['a', 'b', 'c']);
});

// ───────────── التوجيه ─────────────
import { planFromText, rulePlan, ruleGuideText, opportunityScore, PlanCandidate } from '../ai-rep/guide';
import { estimateOutlet } from '../ai-rep/estimate';

const estOf = (o: OutletCtx) => estimateOutlet({
  target: { lat: o.lat, lng: o.lng, outletType: o.outletType }, now: new Date('2026-09-20'), window: data.window,
  peers: data.peers, monthly: data.monthly, firstOrders: data.firstOrders, products: data.products, minPeers: 5, showMoney: true,
}, 'بقالة');

test('الخطة الحتمية: الفرص الجديدة غير المرفوضة فقط، ومرتّبة مساراً من موقع المندوب', () => {
  const cands: PlanCandidate[] = [
    { ...outlets[0], estimate: estOf(outlets[0]) },                                              // P1 جديد قريب
    { ...outlets[1], estimate: estOf(outlets[1]) },                                              // P2 عميل ⇒ خارج الخطة
    { ref: 'P3', outletType: 'GROCERY', lat: 24.7, lng: 46.72, distanceM: 1900, relation: 'NEW', lastOutcome: 'NOT_INTERESTED', estimate: estOf(outlets[0]) }, // مرفوض
    { ref: 'P4', outletType: 'GROCERY', lat: 24.7, lng: 46.715, distanceM: 1400, relation: 'NEW', lastOutcome: null, estimate: estOf(outlets[0]) },
  ];
  const plan = rulePlan(cands, { lat: 24.7, lng: 46.7 });
  assert.deepEqual(plan, ['P1', 'P4']);
  assert.ok(opportunityScore(cands[0]) > opportunityScore(cands[3]), 'الأقرب بالقيمة نفسها أعلى');
  const byRef = new Map(cands.map(c => [c.ref, { ...c, typeLabel: 'بقالة' }]));
  const text = ruleGuideText(plan, byRef, { lat: 24.7, lng: 46.7 }, 'SAR');
  assert.match(text, /1\) P1 — بقالة على بعد 400 م/);
  assert.match(text, /2\) P4/);
  assert.match(ruleGuideText([], byRef, null, 'SAR'), /لا توجد فرص جديدة/);
});

test('مراجع خطة العقل: بترتيب الظهور، مقصورةً على الفرص الجديدة، بلا تكرار', () => {
  assert.deepEqual(planFromText('ابدأ بـ P4 ثم P1، وتجنّب P2، ثم عد إلى P4. P9 غير موجود', new Set(['P1', 'P4'])), ['P4', 'P1']);
});

test('DeepSeek: «التفكير» يُعاد مع رسالة الأدوات، والرد المعطوب (وسوم DSML أو فراغ) يُعاد مرة ثم فشل صريح', async () => {
  const withReasoning: LlmResult = { ok: true, content: '', toolCalls: [{ id: 'c1', name: 'outlet_estimate', arguments: '{"ref":"P1"}' }], usage: U, finishReason: 'tool_calls', reasoning: 'أفكر في المحل' };
  const a = scripted([withReasoning, say('تمام.')]);
  await runAdvisor({ system: 's', history: [{ role: 'user', text: 'x' }], baseAllowed: new Set(), tools: { outlet_estimate: tool('outlet_estimate', {}) }, llm: a.llm });
  const asst = a.seen[1].messages.find(m => m.role === 'assistant');
  assert.equal(asst?.reasoning_content, 'أفكر في المحل');
  const b = scripted([say('<｜DSML｜function_calls>…'), say('ابدأ بالمياه.')]);
  const rb = await runAdvisor({ system: 's', history: [{ role: 'user', text: 'x' }], baseAllowed: new Set(), tools: {}, llm: b.llm });
  assert.ok(!('error' in rb) && rb.text === 'ابدأ بالمياه.');
  const c = scripted([say(''), say('   ')]);
  assert.deepEqual(await runAdvisor({ system: 's', history: [{ role: 'user', text: 'x' }], baseAllowed: new Set(), tools: {}, llm: c.llm }), { error: 'LLM', code: 'LLM_BAD_OUTPUT' });
});

test('الإعداد: حدّ الرد افتراضياً 4096 ويُضبط، والتفكير يُقرأ من reasoning_content أو reasoning', () => {
  assert.equal(llmConfig({ AI_REP_LLM_BASE_URL: 'https://a', AI_REP_LLM_API_KEY: 'k', AI_REP_LLM_MODEL: 'm' })!.maxTokens, 4096);
  assert.equal(llmConfig({ AI_REP_LLM_BASE_URL: 'https://a', AI_REP_LLM_API_KEY: 'k', AI_REP_LLM_MODEL: 'm', AI_REP_LLM_MAX_TOKENS: '16000' })!.maxTokens, 16000);
  const r = parseCompletion({ choices: [{ message: { content: 'x', reasoning: 'r' } }] });
  assert.ok(r.ok && r.reasoning === 'r');
});
