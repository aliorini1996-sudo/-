/**
 * مساعد Anthropic Claude المشترك للخادم — للمهام التي تمسّ العميل مباشرة (وكيل واتساب).
 *
 * لماذا Claude هنا لا Gemini: محادثة البيع بالعامية تحاجج عميلاً وتقترب من المال،
 * وقرار المالك المسجَّل «الجودة على السرعة عند مفاضلة الموديلات — البوت خلفي وقراره يمسّ مالاً».
 * يبقى Gemini مصدر بقية المهام (الصيد، التأهيل الجماعي).
 *
 * يقرأ ANTHROPIC_API_KEY من بيئة الخادم (Render). النموذج قابل للضبط عبر ANTHROPIC_MODEL
 * (افتراضي claude-opus-5 — أذكى نموذج متاح، والوكيل يستحقه). كل الاستدعاءات لها احتياط:
 * تُرجع '' عند غياب المفتاح أو أي خطأ، فيسقط المُنادي إلى Gemini أو رسالة آمنة.
 */

const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

export function anthropicReady(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || '').trim();
}

export function anthropicModel(): string {
  return (process.env.ANTHROPIC_MODEL || '').trim() || 'claude-opus-5';
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatOpts {
  system: string;
  messages: ChatTurn[];
  maxTokens?: number;
  /** low | medium | high | xhigh | max — عمق التفكير وسقف الإنفاق */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

/**
 * محادثة متعددة الأدوار عبر Claude. يُرجع نص الرد أو '' عند أي خطأ.
 * effort افتراضي 'medium': ردود واتساب قصيرة، والمحاججة لا تحتاج xhigh — توازن كلفة/جودة.
 */
export async function anthropicChat(opts: ChatOpts): Promise<string> {
  const key = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key || !opts.messages.length) return '';
  try {
    const r = await fetch(API, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: anthropicModel(),
        max_tokens: opts.maxTokens ?? 400,
        system: opts.system,
        messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
        output_config: { effort: opts.effort ?? 'medium' },
      }),
    });
    if (!r.ok) return '';
    const j = (await r.json()) as {
      stop_reason?: string;
      content?: Array<{ type: string; text?: string }>;
    };
    // تجاهل أي refusal — نسقط لرسالة آمنة بدل إرسال نص رفض للعميل
    if (j.stop_reason === 'refusal') return '';
    return (j.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text || '')
      .join('')
      .trim();
  } catch {
    return '';
  }
}
