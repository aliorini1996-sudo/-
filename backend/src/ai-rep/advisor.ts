/**
 * المندوب الذكي — المستشار: حلقة وكيل بنمط Hermes (نموذج ← أداة ← نتيجة ← نموذج) داخل خادمنا.
 *
 * الضوابط:
 *   - الأدوات للقراءة فقط، وتُنفَّذ بسياق الجلسة (الشركة والمندوب وجلسة البحث في الخادم) — النموذج لا يمرّر
 *     إلا مراجع معتمة (P1…) أعطيناه إياها.
 *   - **حارس الأرقام:** كل رقم في الرد — بالأرقام أو بالكلمات («عشرين كرتون»، «كرتونين»، «نص») — يجب أن يأتي من
 *     مخرجات الأدوات أو رسالة المندوب أو دليل الشركة/الكتالوج. لا إعفاء للأرقام الصغيرة (الطلب التجريبي غالباً ١–٥)؛
 *     المستثنى فقط مراجع المحلات (P3) وأرقام الترقيم في أول السطر («1)»).
 *     المخالفة ⇒ إعادة توليد واحدة ⇒ ثم حذف الجمل المخالفة ⇒ ثم قالب حتمي من ملخّصات الأدوات.
 *   - **الردود المعطوبة** (وسوم أدوات متسرّبة DSML، تفكير <think> في النص، فراغ، أو رد مبتور بحدّ الرموز) لا تصل
 *     المندوب: إعادة واحدة ثم فشل صريح أو قصّ للجملة المبتورة.
 *   - **حجب البيانات الشخصية** من نص المندوب قبل إرساله (جوال، بريد، آيبان، أرقام طويلة).
 *   - حدّ 4 قفزات أدوات، والاستهلاك (الرموز) يُعاد دائماً — حتى مع الفشل — ليُحتسب.
 * الدالة صرفة بتبعيات محقونة (النموذج والأدوات) — مختبَرة بلا شبكة.
 */
import type { LlmMessage, LlmRequest, LlmResult, LlmToolSpec, LlmUsage } from './llm';

export const MAX_HOPS = 4;
/** حدّ الرموز لإعادة رد انقطع بحدّ الرموز (التفكير من ضمنه). */
export const LENGTH_RETRY_TOKENS = 16384;

export interface ToolOutput {
  /** ما يراه النموذج (JSON) — بلا أسماء Google ولا بيانات شخصية. */
  data: unknown;
  /** ملخّص عربي حتمي يُستعمل في القالب الاحتياطي. */
  summaryAr: string;
  /** المراجع المعتمة التي تخصّها النتيجة (P1…) — تُعرض للمندوب أزراراً. */
  refs?: string[];
}
export interface AdvisorTool {
  spec: LlmToolSpec;
  run(args: Record<string, unknown>): Promise<ToolOutput | { error: string }>;
}
export interface AdvisorTurn { role: 'user' | 'assistant'; text: string }
export type GuardResult = 'PASS' | 'REGEN' | 'TRIM' | 'TEMPLATE';
export interface AdvisorResult {
  text: string;
  refs: string[];
  guard: GuardResult;
  hops: number;
  usage: LlmUsage;
  toolNames: string[];
}
export interface AdvisorError { error: 'LLM'; code: string; usage: LlmUsage }

// ───────────── الأرقام ─────────────

const DIGIT_MAP: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

/** توحيد الأرقام: الهندية والفارسية إلى لاتينية، والفاصلة العشرية العربية نقطة، وحذف فواصل الآلاف. */
export function normalizeDigits(s: string): string {
  return s
    .replace(/[٠-٩۰-۹]/g, d => DIGIT_MAP[d] ?? d)
    .replace(/(\d)[٫](\d)/g, '$1.$2')
    .replace(/(\d)[٬,](?=\d{3}\b)/g, '$1');
}

// أعداد بالكلمات (فصحى وخليجية) ← أرقام، ليخضع كل عدد للحارس. «واحد» و«الاثنين» مستثنيان عمداً (استعمال غير عددي شائع).
const WORD_NUMBERS: [RegExp, string][] = [
  [/(^|[\s،,.:؛(])(?:[وبلف])?(اثنين|اثنان|ثنتين|اثنتين)(?=$|[\s،,.:؛)])/g, '$1 2 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(ثلاث|ثلاثة|ثلاثه)(?=$|[\s،,.:؛)])/g, '$1 3 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(أربع|اربع|أربعة|اربعة|اربعه)(?=$|[\s،,.:؛)])/g, '$1 4 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(خمس|خمسة|خمسه)(?=$|[\s،,.:؛)])/g, '$1 5 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(ست|ستة|سته)(?=$|[\s،,.:؛)])/g, '$1 6 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(سبع|سبعة|سبعه)(?=$|[\s،,.:؛)])/g, '$1 7 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(ثمان|ثماني|ثمانية|ثمانيه)(?=$|[\s،,.:؛)])/g, '$1 8 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(تسع|تسعة|تسعه)(?=$|[\s،,.:؛)])/g, '$1 9 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(عشر|عشرة|عشره)(?=$|[\s،,.:؛)])/g, '$1 10 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(عشرين|عشرون)(?=$|[\s،,.:؛)])/g, '$1 20 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(ثلاثين|ثلاثون)(?=$|[\s،,.:؛)])/g, '$1 30 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(أربعين|اربعين|أربعون)(?=$|[\s،,.:؛)])/g, '$1 40 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(خمسين|خمسون)(?=$|[\s،,.:؛)])/g, '$1 50 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(ستين|ستون)(?=$|[\s،,.:؛)])/g, '$1 60 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(سبعين|سبعون)(?=$|[\s،,.:؛)])/g, '$1 70 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(ثمانين|ثمانون)(?=$|[\s،,.:؛)])/g, '$1 80 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(تسعين|تسعون)(?=$|[\s،,.:؛)])/g, '$1 90 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(مية|ميه|مئة|مائة|مائه)(?=$|[\s،,.:؛)])/g, '$1 100 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(ميتين|مئتين|مائتين|مئتان)(?=$|[\s،,.:؛)])/g, '$1 200 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(ألف|الف)(?=$|[\s،,.:؛)])/g, '$1 1000 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(ألفين|الفين)(?=$|[\s،,.:؛)])/g, '$1 2000 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(نص|نصف)(?=$|[\s،,.:؛)])/g, '$1 0.5 '],
  [/(^|[\s،,.:؛(])(?:[وبلف])?(ربع)(?=$|[\s،,.:؛)])/g, '$1 0.25 '],
  // المثنّى على وحدة: «كرتونين، حبتين، علبتين، كيسين، صندوقين، شدّتين، درزنين، باكيتين»
  [/(^|[\s،,.:؛(])(?:[وبلف])?(كرتونين|كراتينين|حبتين|علبتين|كيسين|صندوقين|شدتين|شدّتين|درزنين|باكيتين|بكتين|قطعتين)(?=$|[\s،,.:؛)])/g, '$1 2 $2 '],
];

/** نص الرد مهيّأً لفحص الأرقام: الأعداد بالكلمات أرقاماً، بلا مراجع المحلات (P3) ولا ترقيم أول السطر. */
export function numericView(s: string): string {
  let t = normalizeDigits(s);
  for (const [re, rep] of WORD_NUMBERS) t = t.replace(re, rep);
  return t
    .replace(/\bP\d{1,3}\b/g, ' ')
    .replace(/^\s*\d{1,2}\s*[).\-–:]\s+/gm, '');
}

/** كل الأرقام في نص (بعد التوحيد وتحويل الأعداد بالكلمات). */
export function extractNumbers(s: string): number[] {
  const out: number[] = [];
  for (const m of numericView(s).matchAll(/\d+(?:\.\d+)?/g)) {
    const n = Number(m[0]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const SKIP_KEYS = new Set(['ref', 'refs', 'order']);

/**
 * كل الأرقام في قيمة JSON (القيم العددية والأرقام داخل النصوص). النسب بين 0 و1 تُضاف بصيغة مئوية أيضاً.
 * حقول المراجع والترتيب لا تُدخل أرقامها (رقم المرجع P7 ليس كمية).
 */
export function numbersIn(value: unknown, acc: Set<number> = new Set()): Set<number> {
  const add = (n: number) => {
    if (!Number.isFinite(n)) return;
    acc.add(round1(n));
    acc.add(Math.round(n));
    if (n > 0 && n < 1) acc.add(Math.round(n * 100));
  };
  if (typeof value === 'number') add(value);
  else if (typeof value === 'string') extractNumbers(value).forEach(add);
  else if (Array.isArray(value)) value.forEach(v => numbersIn(v, acc));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) if (!SKIP_KEYS.has(k)) numbersIn(v, acc);
  }
  return acc;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** أرقام الرد التي لا أصل لها في القائمة البيضاء. */
export function unsupportedNumbers(text: string, allowed: Set<number>): number[] {
  const bad: number[] = [];
  for (const n of extractNumbers(text)) {
    if (allowed.has(round1(n)) || allowed.has(Math.round(n))) continue;
    bad.push(n);
  }
  return [...new Set(bad)];
}

/** تقسيم إلى جمل — لا عند نقطة الكسر العشري (2.5). */
function sentences(text: string): string[] {
  return text.split(/(?<=[!؟?\n])\s*|(?<=\.)(?!\d)\s*/);
}

/** حذف الجمل التي تحوي رقماً غير مدعوم. */
export function trimSentences(text: string, allowed: Set<number>): string {
  return sentences(text).filter(p => unsupportedNumbers(p, allowed).length === 0).join(' ').replace(/\s+\n/g, '\n').trim();
}

/** رد انقطع بحدّ الرموز: تُحذف جملته الأخيرة غير المكتملة (قد تكون رقماً مبتوراً). */
export function dropLastSentence(text: string): string {
  const parts = sentences(text.trim());
  if (parts.length <= 1) return '';
  return parts.slice(0, -1).join(' ').trim();
}

// ───────────── الخصوصية ─────────────

/** حجب البيانات الشخصية من نص المندوب قبل إرساله للنموذج. */
export function scrubPii(s: string): string {
  return normalizeDigits(s)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[بريد محجوب]')
    .replace(/\bSA\d{2}[A-Z0-9 ]{18,30}\b/gi, '[آيبان محجوب]')
    .replace(/(?:\+|00)?966[\s-]?5\d(?:[\s-]?\d){7}/g, '[جوال محجوب]')
    .replace(/\b05\d(?:[\s-]?\d){7}\b/g, '[جوال محجوب]')
    .replace(/\d{9,}/g, '[رقم محجوب]');
}

// ───────────── الحلقة ─────────────

export async function runAdvisor(opts: {
  system: string;
  history: AdvisorTurn[];
  /** أرقام مسموحة سلفاً: من دليل الشركة وأسماء المنتجات. */
  baseAllowed: Set<number>;
  tools: Record<string, AdvisorTool>;
  llm: (req: LlmRequest) => Promise<LlmResult>;
  maxHops?: number;
}): Promise<AdvisorResult | AdvisorError> {
  const maxHops = opts.maxHops ?? MAX_HOPS;
  const toolSpecs = Object.values(opts.tools).map(t => t.spec);
  const messages: LlmMessage[] = [
    { role: 'system', content: opts.system },
    ...opts.history.map(h => ({ role: h.role, content: h.role === 'user' ? scrubPii(h.text) : h.text }) as LlmMessage),
  ];
  const allowed = new Set(opts.baseAllowed);
  // أرقام رسائل المندوب، وأرقام ردود المستشار السابقة (مرّت على الحارس في دورتها)
  for (const h of opts.history) extractNumbers(h.role === 'user' ? scrubPii(h.text) : h.text).forEach(n => { allowed.add(n); allowed.add(round1(n)); });
  const usage: LlmUsage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
  const addUsage = (u: LlmUsage) => { usage.promptTokens += u.promptTokens; usage.completionTokens += u.completionTokens; usage.cachedTokens += u.cachedTokens; };
  const fail = (code: string): AdvisorError => ({ error: 'LLM', code, usage });
  const summaries: string[] = [];
  const refs = new Set<string>();
  const toolNames: string[] = [];
  const seenCalls = new Set<string>();
  // الأدوات تُرسل دائماً (بعض المضيفين يرفض محادثة فيها استدعاءات أدوات بلا تعريفها)، ويُمنع استعمالها بـ none
  const withTools = (canCall: boolean): Pick<LlmRequest, 'tools' | 'toolChoice'> =>
    toolSpecs.length ? { tools: toolSpecs, toolChoice: canCall ? 'auto' : 'none' } : {};
  let hops = 0;
  let badArgRetries = 0;

  for (;;) {
    const req: LlmRequest = { messages, ...withTools(hops < maxHops) };
    let res = await opts.llm(req);
    if (!res.ok) return fail(res.code);
    addUsage(res.usage);
    // خلل معروف في DeepSeek V4.x لدى بعض المضيفين: أوامر الأدوات تتسرّب نصاً (DSML)، أو تفكير في النص، أو ردّ فارغ.
    // إعادة واحدة، ثم فشلٌ صريح (المستدعي يعرض الخطة الحتمية) — لا نعرض للمندوب وسوماً داخلية ولا فراغاً.
    if (isMalformed(res)) {
      res = await opts.llm(req);
      if (!res.ok) return fail(res.code);
      addUsage(res.usage);
      if (isMalformed(res)) return fail('LLM_BAD_OUTPUT');
    }

    if (res.toolCalls.length && hops < maxHops) {
      hops++;
      messages.push({
        role: 'assistant', content: res.content || null,
        tool_calls: res.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })),
        ...(res.reasoning ? { reasoning_content: res.reasoning } : {}),
      });
      for (const call of res.toolCalls) {
        const tool = opts.tools[call.name];
        let out: ToolOutput | { error: string };
        let args: Record<string, unknown> | null = null;
        try {
          const parsed = call.arguments ? JSON.parse(call.arguments) : {};
          args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
        } catch { args = null; }
        const key = `${call.name}|${JSON.stringify(args)}`;
        if (!tool) out = { error: `unknown tool ${call.name}` };
        else if (!args) out = { error: 'invalid JSON arguments — send a JSON object' };
        else if (seenCalls.has(key)) out = { error: 'duplicate call — use the previous result' };
        else { seenCalls.add(key); out = await tool.run(args).catch(() => ({ error: 'tool failed' })); }
        if ('error' in out) {
          badArgRetries++;
          messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ error: out.error }) });
          continue;
        }
        toolNames.push(call.name);
        numbersIn(out.data, allowed);
        summaries.push(out.summaryAr);
        (out.refs ?? []).forEach(r => refs.add(r));
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(out.data) });
      }
      if (badArgRetries > 3) return finalize(fallbackText(summaries), 'TEMPLATE');
      continue;
    }

    // الرد النهائي — انقطع بحدّ الرموز؟ إعادة بحدّ أعلى، وإلا تُحذف الجملة المبتورة
    let final = res;
    if (final.finishReason === 'length') {
      const again = await opts.llm({ ...req, maxTokens: LENGTH_RETRY_TOKENS });
      if (again.ok) {
        addUsage(again.usage);
        if (!isMalformed(again) && !again.toolCalls.length) final = again;
      }
    }
    let text = cleanText(final.content);
    let truncated = false;
    if (final.finishReason === 'length') { text = dropLastSentence(text); truncated = true; }
    if (!text) return finalize(fallbackText(summaries), 'TEMPLATE');

    // حارس الأرقام
    if (unsupportedNumbers(text, allowed).length === 0) return finalize(text, truncated ? 'TRIM' : 'PASS');
    const bad = unsupportedNumbers(text, allowed);
    const regen = await opts.llm({
      messages: [...messages, { role: 'assistant', content: text }, {
        role: 'user',
        content: `تنبيه من النظام: هذه الأرقام في ردّك لا مصدر لها في نتائج الأدوات: ${bad.join('، ')}. أعد كتابة الرد بلا أي رقم ليس في نتائج الأدوات أو رسالتي (ولا بالكلمات)، ولا تخمّن أرقاماً.`,
      }],
      ...withTools(false),
    });
    if (regen.ok) {
      addUsage(regen.usage);
      const usable = !isMalformed(regen) && !regen.toolCalls.length && regen.finishReason !== 'length';
      const t2 = usable ? cleanText(regen.content) : '';
      if (t2 && unsupportedNumbers(t2, allowed).length === 0) return finalize(t2, 'REGEN');
      const trimmed = trimSentences(t2 || text, allowed);
      if (trimmed.length >= 20 && !looksMalformed(trimmed)) return finalize(trimmed, 'TRIM');
    }
    return finalize(fallbackText(summaries), 'TEMPLATE');
  }

  function finalize(text: string, guard: GuardResult): AdvisorResult {
    return { text, refs: [...refs], guard, hops, usage, toolNames };
  }
}

const MALFORMED_RE = /DSML|<｜|｜>|<\/?(tool_call|function_calls?|invoke|think)\b/i;

function looksMalformed(t: string): boolean { return MALFORMED_RE.test(t); }

/** إزالة أي تفكير مغلق في أول النص (احتياط إن لم يفصله المضيف). */
function cleanText(s: string | null | undefined): string {
  return (s || '').replace(/^\s*<think>[\s\S]*?<\/think>\s*/i, '').trim();
}

/** ردّ لا يصلح: لا أدوات ولا نص، أو وسوم أدوات/تفكير داخلية تسرّبت إلى النص. */
export function isMalformed(res: Extract<LlmResult, { ok: true }>): boolean {
  if (res.toolCalls.length) return false;
  const t = cleanText(res.content);
  return !t || looksMalformed(t);
}

function fallbackText(summaries: string[]): string {
  if (!summaries.length) return 'لا أملك رقماً موثوقاً لهذا السؤال. اسألني عن محلٍّ محدّد من قائمة «القريبة» لأحسب لك المتوقع من بيانات شركتك.';
  return summaries.join('\n');
}
