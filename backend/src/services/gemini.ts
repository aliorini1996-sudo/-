/**
 * مساعد Google Gemini 2.5 المشترك للخادم — مصدر واحد لكل استدعاءات الذكاء الاصطناعي
 * (توليد كلمات الصيد، تأهيل العملاء، بحث المجتمعات). يقرأ GEMINI_API_KEY من بيئة الخادم (Render).
 *
 * النموذج قابل للضبط عبر GEMINI_MODEL (افتراضي gemini-2.5-flash — سريع ومجاني الحصّة على هذا الحجم،
 * وأذكى من الموديل السابق). للجودة القصوى اضبط GEMINI_MODEL=gemini-2.5-pro
 * (قد يبلغ حدّ الحصّة اليومي على الطبقة المجانية مع تشغيل الصيد كل 30 دقيقة).
 */

export function geminiReady(): boolean {
  return !!(process.env.GEMINI_API_KEY || '').trim();
}

export function geminiModel(): string {
  return (process.env.GEMINI_MODEL || '').trim() || 'gemini-2.5-flash';
}

interface GeminiOpts { maxTokens?: number; temperature?: number }

/**
 * يولّد نصًا عبر Gemini. يُرجع النص أو '' عند أي خطأ (الاستدعاءات كلها اختيارية ولها احتياط).
 */
export async function geminiGenerate(system: string, user: string, opts: GeminiOpts = {}): Promise<string> {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  if (!key) return '';
  const model = geminiModel();
  const generationConfig: Record<string, unknown> = { maxOutputTokens: opts.maxTokens ?? 700, temperature: opts.temperature ?? 0.7 };
  // مهام قصيرة/JSON لا تحتاج «تفكير» 2.5؛ إطفاؤه على flash يمنع ابتلاع حدّ المخرجات ويقلّل التكلفة والزمن.
  if (model.includes('flash')) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig,
        }),
      },
    );
    if (!r.ok) return '';
    const j = (await r.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const parts = j.candidates?.[0]?.content?.parts || [];
    return parts.map((p) => p.text || '').join('').trim();
  } catch {
    return '';
  }
}
