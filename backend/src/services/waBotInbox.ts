/**
 * نداء صندوق محادثات بوت واتساب — مشتركٌ بين وسيط لوحة المالك (routes/waInbox.ts) ومزامنة «إدارة المبيعات»
 * (services/salesInbox.ts).
 *
 * البوت خدمةٌ منفصلة بقاعدة بيانات معزولة (قرار متعمَّد: عطلٌ في البوت لا يمسّ المنصّة)، ورمزه يبقى في بيئة
 * الخادم لا في كود الواجهة. لا يرمي: يعيد النتيجة أو سبب الفشل بالعربية مع رمز الحالة المقترح للردّ.
 */

const botUrl = (): string => (process.env.WA_BOT_URL || 'https://wa-sales-bot.onrender.com').replace(/\/+$/, '');
const botToken = (): string => (process.env.WA_SWEEP_TOKEN || '').trim();

export function waBotConfigured(): boolean {
  return !!botToken();
}

export type WaBotResult =
  | { ok: true; body: unknown }
  | { ok: false; status: number; message: string };

export const WA_BOT_NOT_CONFIGURED = 'WA_SWEEP_TOKEN غير مضبوط في بيئة الخادم — لا يمكن قراءة محادثات البوت';

/**
 * GET على البوت برمز الصندوق. `timeoutMs` يختاره المستدعي: الوسيط ينتظر دقيقة (إيقاظ خطّة النوم ~٥٠ث)،
 * والمزامنة ثوانيَ قليلة كي لا تُبطئ الصفحة — و`timeoutMessage` ما يُقال عند انقضائها.
 */
export async function fetchWaBot(path: string, opts: { timeoutMs: number; timeoutMessage: string }): Promise<WaBotResult> {
  if (!waBotConfigured()) return { ok: false, status: 503, message: WA_BOT_NOT_CONFIGURED };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  try {
    const r = await fetch(`${botUrl()}${path}`, {
      headers: { 'x-inbox-token': botToken() },
      signal: ctrl.signal,
    });
    const body = await r.json().catch(() => null);
    if (!r.ok) {
      return {
        ok: false,
        status: r.status === 401 ? 502 : r.status,
        message: r.status === 401
          ? 'البوت رفض الرمز — تأكّد أن WA_SWEEP_TOKEN متطابق في الخدمتين'
          : (body as { message?: string })?.message || `البوت ردّ ${r.status}`,
      };
    }
    return { ok: true, body };
  } catch (e) {
    const aborted = (e as Error).name === 'AbortError';
    return { ok: false, status: 504, message: aborted ? opts.timeoutMessage : 'تعذّر الوصول للبوت' };
  } finally {
    clearTimeout(t);
  }
}
