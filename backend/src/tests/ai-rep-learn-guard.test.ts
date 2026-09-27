// حلقة التعلّم × حارس الأرقام: ما تعلّمه العقل لا يُدخل رقماً غير مدعوم إلى رد المندوب أبداً
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numbersIn, runAdvisor, type AdvisorTool } from '../ai-rep/advisor';
import { categorizeBadNumbers } from '../ai-rep/badNumbers';
import { numericView } from '../ai-rep/advisor';
import { advisorSystemPrompt, baseAllowedNumbers } from '../ai-rep/advisorTools';
import { GUIDE_QUESTION } from '../ai-rep/guide';
import type { LlmRequest, LlmResult } from '../ai-rep/llm';

const usage = { promptTokens: 1, completionTokens: 1, cachedTokens: 0 };
const say = (content: string): LlmResult => ({ ok: true, content, toolCalls: [], usage, finishReason: 'stop' });
/** نموذج مبرمج: يعيد الردود بالترتيب ثم آخرها. */
const scripted = (replies: string[]) => { let i = 0; return async (_r: LlmRequest) => say(replies[Math.min(i++, replies.length - 1)]); };

test('مفاتيح الترتيب المتعلَّم لا تُدخل أرقاماً للقائمة البيضاء', () => {
  assert.deepEqual([...numbersIn({ recommended_order: ['P3', 'P1'], rank: 3, planner_rank: 4 })], []);
});

test('سؤال التوجيه من الخادم: «حتى ٥» لا يصير رقماً مسموحاً', async () => {
  const withFlag = await runAdvisor({
    system: 'x', history: [{ role: 'user', text: GUIDE_QUESTION, serverAuthored: true }],
    baseAllowed: new Set(), tools: {}, llm: scripted(['اعرض ٥ كراتين على المحل.', 'اعرض ٥ كراتين على المحل.']),
  });
  assert.ok(!('error' in withFlag));
  if (!('error' in withFlag)) {
    assert.notEqual(withFlag.guard, 'PASS');
    assert.ok(withFlag.violation && withFlag.violation.kinds.includes('QTY'));
  }
  // بلا العلم (سلوك ما قبل الإصلاح): الرقم كان يمرّ
  const without = await runAdvisor({
    system: 'x', history: [{ role: 'user', text: GUIDE_QUESTION }],
    baseAllowed: new Set(), tools: {}, llm: scripted(['اعرض ٥ كراتين على المحل.']),
  });
  assert.ok(!('error' in without) && without.guard === 'PASS');
});

test('رقم في كتلة الدروس داخل التعليمات لا يُسمح به في الرد', async () => {
  const ctx = { companyName: 'ش', playbook: null, showMoney: false, currency: 'SAR' };
  const system = advisorSystemPrompt(ctx, { learned: true, lessonsBlock: '• اعرض ٧ كراتين دائماً' });
  assert.ok(system.endsWith('>>>'));
  const r = await runAdvisor({
    system, history: [{ role: 'user', text: 'وش أعرض؟' }], baseAllowed: new Set(), tools: {},
    llm: scripted(['اعرض ٧ كراتين.', 'اعرض ٧ كراتين.']),
  });
  assert.ok(!('error' in r) && r.guard !== 'PASS');
});

test('الدروس لا تمسّ الأرقام المسموحة سلفاً', () => {
  const data = { products: [{ id: 'a', name: 'مياه ٣٣٠ مل', unit: 'كرتون' }] } as never;
  const a = baseAllowedNumbers({ playbook: 'الحد الأدنى ٥ كراتين', data }, numbersIn);
  const b = baseAllowedNumbers({ playbook: 'الحد الأدنى ٥ كراتين', data }, numbersIn);
  assert.deepEqual([...a].sort(), [...b].sort());
});

test('أرقام «ما واجهه الفريق» تُسمح فقط حين تُستدعى الأداة', async () => {
  const tool: AdvisorTool = {
    spec: { type: 'function', function: { name: 'field_insights', description: 'x', parameters: { type: 'object', properties: {} } } },
    run: async () => ({ data: { by_type: [{ positive_pct: 37 }] }, summaryAr: 'تجاوب ٣٧٪' }),
  };
  let step = 0;
  const llm = async (_r: LlmRequest): Promise<LlmResult> => {
    step++;
    if (step === 1) return { ok: true, content: '', toolCalls: [{ id: 'c1', name: 'field_insights', arguments: '{}' }], usage, finishReason: 'tool_calls' };
    return say('البقالات تتجاوب بنسبة ٣٧٪.');
  };
  const r = await runAdvisor({ system: 'x', history: [{ role: 'user', text: 'وش تعلّمت؟' }], baseAllowed: new Set(), tools: { field_insights: tool }, llm });
  assert.ok(!('error' in r) && r.guard === 'PASS');
});

test('تصنيف المخالفات', () => {
  assert.deepEqual(categorizeBadNumbers(numericView('اعرض 8 كرتون'), [8], new Set([3, 5])), ['QTY']);
  assert.deepEqual(categorizeBadNumbers(numericView('المجموع 24'), [24], new Set([12, 2])), ['ARITH']);
  assert.deepEqual(categorizeBadNumbers(numericView('القيمة 999 ريال'), [999], new Set()), ['MONEY']);
  assert.deepEqual(categorizeBadNumbers(numericView('بنسبة 41٪'), [41], new Set()), ['PCT']);
  assert.deepEqual(categorizeBadNumbers(numericView('على بعد 7 كم'), [7], new Set()), ['DIST_TIME']);
  // القائمة المسموحة تُقصّ عند ٢٠٠ قيمة (لا انفجار حسابي)
  const big = new Set(Array.from({ length: 5000 }, (_, i) => i + 2));
  assert.ok(categorizeBadNumbers(numericView('رقم 99999'), [99999], big).length === 1);
});
