/**
 * المندوب الذكي — عميل النموذج اللغوي (واجهة متوافقة مع OpenAI Chat Completions).
 *
 * لا يرتبط بمزوّد بعينه: العنوان والمفتاح والنموذج من البيئة، فالتبديل (DeepSeek عبر مضيف أمريكي، أو Gemini،
 * أو خادم خاص لاحقاً) إعدادٌ لا كود:
 *   AI_REP_LLM_BASE_URL    مثل https://api.deepinfra.com/v1/openai
 *   AI_REP_LLM_API_KEY     مفتاح المضيف (لا يُطبع ولا يُسجَّل)
 *   AI_REP_LLM_MODEL       معرّف النموذج لدى المضيف
 *   AI_REP_LLM_EXTRA_BODY  (اختياري) JSON يُدمج في جسم الطلب — مثل مفتاح إطفاء «التفكير» الخاص بالمضيف
 *   AI_REP_LLM_TIMEOUT_MS  (اختياري) مهلة النداء الواحد، افتراضياً 20000
 *   AI_REP_LLM_MAX_TOKENS  (اختياري) حدّ رموز الرد، افتراضياً 8192 — يشمل «التفكير» فلا يُصغَّر وهو مفعّل
 * الإعداد المقرّر (DeepSeek V4.1 Flash عبر Fireworks بنقطة أمريكية حصرية):
 *   BASE_URL=https://us.api.fireworks.ai/inference/v1  MODEL=accounts/fireworks/routers/deepseek-v4p1-flash-us
 *   EXTRA_BODY={"reasoning_effort":"high"}  (يُرسل صراحةً: بعض المضيفين يطفئ التفكير بغيابه)
 * غياب أيٍّ من الثلاثة الأولى ⇒ المستشار «غير مضبوط»، وكل ما هو حتمي يبقى يعمل.
 */

export interface LlmToolCall { id: string; name: string; arguments: string }
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  /** «تفكير» النموذج في دورة الأدوات — يجب إعادته كما هو مع رسالة المساعد (DeepSeek يرفض الطلب بدونه). */
  reasoning_content?: string;
}
export interface LlmToolSpec { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface LlmRequest {
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  toolChoice?: 'auto' | 'none';
  maxTokens?: number;
  temperature?: number;
}
export interface LlmUsage { promptTokens: number; completionTokens: number; cachedTokens: number }
export type LlmResult =
  | { ok: true; content: string; toolCalls: LlmToolCall[]; usage: LlmUsage; finishReason: string; reasoning?: string }
  | { ok: false; code: 'LLM_NOT_CONFIGURED' | 'LLM_AUTH' | 'LLM_RATE_LIMIT' | 'LLM_TIMEOUT' | 'LLM_BAD_REQUEST' | 'LLM_UNAVAILABLE'; status?: number };

export interface LlmConfig { baseUrl: string; apiKey: string; model: string; extraBody: Record<string, unknown>; timeoutMs: number; maxTokens: number }

export function llmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig | null {
  const baseUrl = (env.AI_REP_LLM_BASE_URL || '').trim().replace(/\/+$/, '');
  const apiKey = (env.AI_REP_LLM_API_KEY || '').trim();
  const model = (env.AI_REP_LLM_MODEL || '').trim();
  if (!baseUrl || !apiKey || !model || !/^https:\/\//i.test(baseUrl)) return null;
  let extraBody: Record<string, unknown> = {};
  try {
    const parsed = env.AI_REP_LLM_EXTRA_BODY ? JSON.parse(env.AI_REP_LLM_EXTRA_BODY) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) extraBody = parsed as Record<string, unknown>;
  } catch { /* إعداد فاسد يُتجاهل بدل إسقاط المستشار */ }
  const t = Number(env.AI_REP_LLM_TIMEOUT_MS);
  const mt = Number(env.AI_REP_LLM_MAX_TOKENS);
  return {
    baseUrl, apiKey, model, extraBody,
    timeoutMs: Number.isFinite(t) && t >= 3000 && t <= 90000 ? t : 20000,
    maxTokens: Number.isFinite(mt) && mt >= 256 && mt <= 32768 ? Math.floor(mt) : 8192,
  };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function chatCompletion(cfg: LlmConfig | null, req: LlmRequest, fetchImpl?: FetchLike): Promise<LlmResult> {
  if (!cfg) return { ok: false, code: 'LLM_NOT_CONFIGURED' };
  const f: FetchLike = fetchImpl ?? (fetch as unknown as FetchLike);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  const body: Record<string, unknown> = {
    ...cfg.extraBody,
    model: cfg.model,
    messages: req.messages,
    max_tokens: req.maxTokens ?? cfg.maxTokens,
    temperature: req.temperature ?? 0.3,
    stream: false,
  };
  if (req.tools?.length) { body.tools = req.tools; body.tool_choice = req.toolChoice ?? 'auto'; }
  try {
    const res = await f(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const code = res.status === 401 || res.status === 403 ? 'LLM_AUTH' : res.status === 429 ? 'LLM_RATE_LIMIT' : res.status === 400 || res.status === 422 ? 'LLM_BAD_REQUEST' : 'LLM_UNAVAILABLE';
      return { ok: false, code, status: res.status };
    }
    return parseCompletion(await res.json());
  } catch (e) {
    return { ok: false, code: (e as { name?: string })?.name === 'AbortError' ? 'LLM_TIMEOUT' : 'LLM_UNAVAILABLE' };
  } finally {
    clearTimeout(timer);
  }
}

/** ردّ Chat Completions ← شكلنا. يتسامح مع مضيفين يُسقطون حقولاً اختيارية. */
export function parseCompletion(raw: unknown): LlmResult {
  const r = raw as {
    choices?: { message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; prompt_cache_hit_tokens?: number };
  };
  const choice = r?.choices?.[0];
  if (!choice?.message) return { ok: false, code: 'LLM_UNAVAILABLE' };
  // بعض المضيفين يعيد التفكير داخل النص بين <think>…</think> — يُفصل عنه (وإن لم يُغلق فالنص كله تفكير)
  const think = splitThink(typeof choice.message.content === 'string' ? choice.message.content : '');
  const toolCalls: LlmToolCall[] = (choice.message.tool_calls ?? [])
    .filter(t => t?.function?.name)
    .map((t, i) => ({ id: t.id || `call_${i}`, name: String(t.function!.name), arguments: typeof t.function!.arguments === 'string' ? t.function!.arguments : '{}' }));
  return {
    ok: true,
    content: think.content,
    toolCalls,
    finishReason: choice.finish_reason || 'stop',
    reasoning: typeof choice.message.reasoning_content === 'string' ? choice.message.reasoning_content : typeof choice.message.reasoning === 'string' ? choice.message.reasoning : think.reasoning,
    usage: {
      promptTokens: Number(r.usage?.prompt_tokens) || 0,
      completionTokens: Number(r.usage?.completion_tokens) || 0,
      cachedTokens: Number(r.usage?.prompt_tokens_details?.cached_tokens ?? r.usage?.prompt_cache_hit_tokens) || 0,
    },
  };
}

/** فصل وسم التفكير من أول النص. */
export function splitThink(content: string): { content: string; reasoning?: string } {
  const m = content.match(/^\s*<think>([\s\S]*?)(<\/think>|$)/i);
  if (!m) return { content };
  return { content: m[2] ? content.slice(m[0].length).trim() : '', reasoning: m[1].trim() };
}
