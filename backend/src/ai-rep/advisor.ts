/**
 * المندوب الذكي — المستشار: حلقة وكيل بنمط Hermes (نموذج ← أداة ← نتيجة ← نموذج) داخل خادمنا.
 *
 * الضوابط:
 *   - الأدوات للقراءة فقط، وتُنفَّذ بسياق الجلسة (الشركة والمندوب وموقعه) — أي معرّف يرسله النموذج لا يُعتدّ به
 *     إلا المراجع المعتمة (P1…) التي أعطيناه إياها في هذه المحادثة.
 *   - **حارس الأرقام:** كل رقم في الرد يجب أن يأتي من مخرجات الأدوات أو من رسالة المندوب أو من دليل الشركة/الكتالوج.
 *     المخالفة ⇒ إعادة توليد واحدة مع تنبيه ⇒ ثم حذف الجمل المخالفة ⇒ ثم قالب حتمي من ملخّصات الأدوات.
 *   - **حجب البيانات الشخصية** من نص المندوب قبل إرساله (جوال، بريد، آيبان، أرقام طويلة كالهوية والسجل والرقم الضريبي).
 *   - حدّ 4 قفزات أدوات، ووسائط الأداة تُتحقّق بمخطّطها، والفاسدة تُعاد للنموذج مرة مع نص الخطأ.
 * الدالة صرفة بتبعيات محقونة (النموذج والأدوات) — مختبَرة بلا شبكة.
 */
import type { LlmMessage, LlmRequest, LlmResult, LlmToolSpec, LlmUsage } from './llm';

export const MAX_HOPS = 4;
const FREE_SMALL_NUMBERS = new Set([1, 2, 3, 4, 5]); // ترقيم وقوائم («أول ٣ محلات») — لا تُعدّ أرقام مبيعات

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

/** كل الأرقام في نص (بعد التوحيد). */
export function extractNumbers(s: string): number[] {
  const out: number[] = [];
  for (const m of normalizeDigits(s).matchAll(/\d+(?:\.\d+)?/g)) {
    const n = Number(m[0]);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** كل الأرقام في قيمة JSON (القيم العددية والأرقام داخل النصوص). النسب بين 0 و1 تُضاف بصيغة مئوية أيضاً. */
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
  else if (value && typeof value === 'object') Object.values(value).forEach(v => numbersIn(v, acc));
  return acc;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** أرقام الرد التي لا أصل لها في القائمة البيضاء. */
export function unsupportedNumbers(text: string, allowed: Set<number>): number[] {
  const bad: number[] = [];
  for (const n of extractNumbers(text)) {
    if (FREE_SMALL_NUMBERS.has(n)) continue;
    if (allowed.has(round1(n)) || allowed.has(Math.round(n))) continue;
    bad.push(n);
  }
  return [...new Set(bad)];
}

/** حذف الجمل التي تحوي رقماً غير مدعوم. */
export function trimSentences(text: string, allowed: Set<number>): string {
  const parts = text.split(/(?<=[.!؟?\n])\s*/);
  return parts.filter(p => unsupportedNumbers(p, allowed).length === 0).join(' ').replace(/\s+\n/g, '\n').trim();
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
}): Promise<AdvisorResult | { error: 'LLM'; code: string }> {
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
  const summaries: string[] = [];
  const refs = new Set<string>();
  const toolNames: string[] = [];
  const seenCalls = new Set<string>();
  let hops = 0;
  let badArgRetries = 0;

  for (;;) {
    const res = await opts.llm({ messages, tools: hops < maxHops ? toolSpecs : undefined, toolChoice: hops < maxHops ? 'auto' : 'none' });
    if (!res.ok) return { error: 'LLM', code: res.code };
    addUsage(res.usage);

    if (res.toolCalls.length && hops < maxHops) {
      hops++;
      messages.push({ role: 'assistant', content: res.content || null, tool_calls: res.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) });
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

    // الرد النهائي — حارس الأرقام
    const text = (res.content || '').trim();
    if (unsupportedNumbers(text, allowed).length === 0) return finalize(text, 'PASS');
    const bad = unsupportedNumbers(text, allowed);
    const regen = await opts.llm({
      messages: [...messages, { role: 'assistant', content: text }, {
        role: 'user',
        content: `تنبيه من النظام: هذه الأرقام في ردّك لا مصدر لها في نتائج الأدوات: ${bad.join('، ')}. أعد كتابة الرد بلا أي رقم ليس في نتائج الأدوات أو رسالتي، ولا تخمّن أرقاماً.`,
      }],
      toolChoice: 'none',
    });
    if (regen.ok) {
      addUsage(regen.usage);
      const t2 = (regen.content || '').trim();
      if (t2 && unsupportedNumbers(t2, allowed).length === 0) return finalize(t2, 'REGEN');
      const trimmed = trimSentences(t2 || text, allowed);
      if (trimmed.length >= 20) return finalize(trimmed, 'TRIM');
    }
    return finalize(fallbackText(summaries), 'TEMPLATE');
  }

  function finalize(text: string, guard: GuardResult): AdvisorResult {
    return { text, refs: [...refs], guard, hops, usage, toolNames };
  }
}

function fallbackText(summaries: string[]): string {
  if (!summaries.length) return 'لا أملك رقماً موثوقاً لهذا السؤال. اسألني عن محلٍّ محدّد من قائمة «القريبة» لأحسب لك المتوقع من بيانات شركتك.';
  return summaries.join('\n');
}
