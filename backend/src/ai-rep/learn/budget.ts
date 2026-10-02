/**
 * حلقة التعلّم — ميزانية رموز العقل في الليلة (للمراجعة الذاتية وحدها؛ التوجيه والمحادثة خارجها).
 *
 * سقف لكل شركة وسقف للّيلة كلها، وتباعد بين النداءات حسب حدّ الرموز في الدقيقة (حصة Groq مشتركة مع بوت
 * واتساب)، وأول 429 يوقف كل نداءات الليلة. التقدير قبل النداء متحفّظ (محارف الطلب ÷٣ + سقف الرد)،
 * والخصم بعده بالاستهلاك الفعلي.
 *   AI_LEARN_TENANT_TOKENS  سقف الشركة في الليلة (افتراضياً ١٥ ألفاً: نداء + إعادة)
 *   AI_LEARN_NIGHT_TOKENS   سقف الليلة لكل الشركات (افتراضياً ٦٠٠ ألف)
 *   AI_LEARN_TPM            تباعد النداءات بالرموز في الدقيقة (افتراضياً ٥٠ ألفاً) — والحدّ الفعلي لحصة المضيف في دلو
 *                           العملية المشترك (AI_REP_LLM_TPM في llm.ts) الذي تنتظره الليلة حتى ٢٠ ث
 *   AI_LEARN_LLM=0          مفتاح إطفاء المراجعة بالعقل (الخطوات الحتمية تبقى)
 */
import { chatCompletion, type LlmConfig, type LlmRequest, type LlmResult } from '../llm';

export interface Budget {
  tenantCap: number;
  nightCap: number;
  tpm: number;
  /** أوقفه ٤٢٩ — لا نداءات أخرى هذه الليلة */
  stopped: boolean;
  nightUsed: number;
  tenantUsed: Map<string, number>;
  /** وقت آخر نداء (ms) — للتباعد */
  lastCallAt: number;
}

const MAX_PACE_MS = 20000;

const envInt = (v: string | undefined, def: number): number => {
  const n = Number(v);
  return v != null && v.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
};

export function createNightBudget(env: NodeJS.ProcessEnv = process.env): Budget {
  return {
    tenantCap: envInt(env.AI_LEARN_TENANT_TOKENS, 15000),
    nightCap: envInt(env.AI_LEARN_NIGHT_TOKENS, 600000),
    tpm: Math.max(1, envInt(env.AI_LEARN_TPM, 50000)),
    stopped: false,
    nightUsed: 0,
    tenantUsed: new Map(),
    lastCallAt: 0,
  };
}

/** مفتاح الإطفاء: AI_LEARN_LLM=0 يوقف المراجعة بالعقل وحدها. */
export function llmLearningEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.AI_LEARN_LLM !== '0';
}

const sleepMs = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * نداء العقل تحت الميزانية: يرفض (BUDGET) إن تجاوز التقديرُ سقفَ الشركة أو الليلة أو كانت الليلة موقوفة،
 * وينتظر (≤٢٠ ث) ليبقى تحت حدّ الدقيقة، ويوقف الليلة عند ٤٢٩، ويخصم الاستهلاك الفعلي.
 */
export async function budgetedCompletion(
  b: Budget, tid: string, cfg: LlmConfig, req: LlmRequest,
  deps: { llm?: (cfg: LlmConfig, req: LlmRequest) => Promise<LlmResult>; sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<LlmResult | { ok: false; code: 'BUDGET' }> {
  const llm = deps.llm ?? chatCompletion;
  const now = deps.now ?? Date.now;
  const promptChars = req.messages.reduce((s, m) => s + (m.content?.length ?? 0), 0);
  const est = Math.ceil(promptChars / 3) + (req.maxTokens ?? cfg.maxTokens);
  const used = b.tenantUsed.get(tid) ?? 0;
  if (b.stopped || used + est > b.tenantCap || b.nightUsed + est > b.nightCap) return { ok: false, code: 'BUDGET' };

  const wait = Math.min(MAX_PACE_MS, Math.max(0, (est / b.tpm) * 60000 - (now() - b.lastCallAt)));
  if (wait > 0) await (deps.sleep ?? sleepMs)(wait);
  b.lastCallAt = now();

  const res = await llm(cfg, { ...req, queueMs: req.queueMs ?? MAX_PACE_MS });
  if (!res.ok && res.code === 'LLM_RATE_LIMIT') b.stopped = true;
  // الفعلي إن أبلغ عنه المضيف، وإلا التقدير؛ المهلة المنقضية قد تكون استُهلكت عندهم فتُحسب احتياطاً
  const spent = res.ok ? (res.usage.promptTokens + res.usage.completionTokens || est) : res.code === 'LLM_TIMEOUT' ? est : 0;
  b.tenantUsed.set(tid, (b.tenantUsed.get(tid) ?? 0) + spent);
  b.nightUsed += spent;
  return res;
}
