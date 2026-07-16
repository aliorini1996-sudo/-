/**
 * إرسال واتساب آلي عبر WhatsApp Cloud API (Meta) — إرسال جماعي من الخادم.
 *
 * يتطلّب متغيّرَي بيئة:
 *  - WHATSAPP_TOKEN            : توكن دائم (System User) من Meta
 *  - WHATSAPP_PHONE_NUMBER_ID  : معرّف رقم واتساب الأعمال (Phone number ID)
 *
 * ولاستقبال الردود وحالات التسليم (webhook):
 *  - WHATSAPP_VERIFY_TOKEN     : نصّ من اختيارك، يُدخَل نفسه في إعداد الـwebhook بـMeta
 *  - WHATSAPP_APP_SECRET       : سرّ التطبيق — للتحقّق من توقيع Meta (يُنصح به بشدّة)
 *
 * ملاحظة سياسة Meta المهمة: الرسائل التسويقية للعملاء الذين لم يراسلوك خلال 24 ساعة
 * يجب أن تكون **قوالب معتمدة (Template)**؛ النص الحرّ يعمل فقط ضمن نافذة 24 ساعة.
 */

import crypto from 'crypto';

const GRAPH = 'https://graph.facebook.com/v21.0';

function cfg() {
  const token = (process.env.WHATSAPP_TOKEN || '').trim();
  const phoneId = (process.env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  return { token, phoneId, ready: !!(token && phoneId) };
}

export function whatsappReady(): boolean {
  return cfg().ready;
}

// تطبيع الرقم لصيغة واتساب (أرقام فقط بلا + أو مسافات، وإزالة 00 البادئة)
export function waNumber(phone?: string | null): string {
  if (!phone) return '';
  let d = phone.replace(/[^\d]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  return d;
}

// يُعيد معرّف رسالة واتساب (wamid) — مفتاح ربط حالات التسليم القادمة من الـwebhook
async function post(payload: Record<string, unknown>): Promise<string | null> {
  const { token, phoneId } = cfg();
  const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  const t = await r.text();
  if (!r.ok) {
    // استخراج رسالة خطأ Meta المفهومة إن أمكن
    let msg = t.slice(0, 200);
    try { msg = JSON.parse(t)?.error?.message || msg; } catch { /* نص خام */ }
    throw new Error(msg);
  }
  try {
    return (JSON.parse(t) as { messages?: { id: string }[] })?.messages?.[0]?.id || null;
  } catch {
    return null; // نجح الإرسال لكن تعذّرت قراءة المعرّف — لا نُفشل العملية
  }
}

// رسالة نصّية حرّة (تعمل فقط لمن راسلك خلال 24 ساعة)
export async function sendWhatsAppText(to: string, body: string): Promise<string | null> {
  return post({ to, type: 'text', text: { body, preview_url: true } });
}

// رسالة قالب معتمد (للتسويق البارد) — bodyParams تملأ متغيّرات جسم القالب {{1}},{{2}}...
export async function sendWhatsAppTemplate(
  to: string,
  templateName: string,
  language: string,
  bodyParams: string[],
): Promise<string | null> {
  const components = bodyParams.length
    ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }]
    : [];
  return post({
    to,
    type: 'template',
    template: { name: templateName, language: { code: language }, components },
  });
}

// ------------------------------- الردود الواردة ------------------------------- //

// هل الردّ طلب انسحاب؟ نقيّده بالرسائل القصيرة حتى لا يُفسَّر ردّ حقيقي يذكر «إلغاء» كانسحاب
// (مثل: «نبغى نلغي النظام القديم عندنا ونجرب عندكم») — وهذا ردّ ساخن لا انسحاب.
const OPT_OUT_RE = /(إلغاء|الغاء|إيقاف|ايقاف|توقف|توقّف|لا تراسل|لا ترسل|لا أرغب|لا ارغب|أزلني|ازلني|stop|unsubscribe|opt\s*out|remove me)/i;
export function isOptOut(text?: string | null): boolean {
  if (!text) return false;
  const t = text.trim();
  if (t.length > 40) return false;
  return OPT_OUT_RE.test(t);
}

/**
 * التحقّق من توقيع Meta (X-Hub-Signature-256) على الجسم الخام.
 * إن لم يُضبط WHATSAPP_APP_SECRET نسمح بالمرور (حتى لا يتعطّل الاستقبال قبل ضبطه)،
 * لكن ضبطه هو ما يمنع أي طرف من حقن ردود مزيّفة في خطّ العملاء.
 */
export function verifyWaSignature(raw: Buffer | undefined, signature?: string): boolean {
  const secret = (process.env.WHATSAPP_APP_SECRET || '').trim();
  if (!secret) return true;
  if (!raw || !signature) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// هل سرّ التوقيع مضبوط؟ (لعرض تنبيه في لوحة المالك)
export function waSignatureEnforced(): boolean {
  return !!(process.env.WHATSAPP_APP_SECRET || '').trim();
}
