/**
 * إرسال واتساب آلي عبر WhatsApp Cloud API (Meta) — إرسال جماعي من الخادم.
 *
 * يتطلّب متغيّرَي بيئة:
 *  - WHATSAPP_TOKEN            : توكن دائم (System User) من Meta
 *  - WHATSAPP_PHONE_NUMBER_ID  : معرّف رقم واتساب الأعمال (Phone number ID)
 *
 * ملاحظة سياسة Meta المهمة: الرسائل التسويقية للعملاء الذين لم يراسلوك خلال 24 ساعة
 * يجب أن تكون **قوالب معتمدة (Template)**؛ النص الحرّ يعمل فقط ضمن نافذة 24 ساعة.
 */

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

async function post(payload: Record<string, unknown>): Promise<void> {
  const { token, phoneId } = cfg();
  const r = await fetch(`${GRAPH}/${phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
  });
  if (!r.ok) {
    const t = await r.text();
    // استخراج رسالة خطأ Meta المفهومة إن أمكن
    let msg = t.slice(0, 200);
    try { msg = JSON.parse(t)?.error?.message || msg; } catch { /* نص خام */ }
    throw new Error(msg);
  }
}

// رسالة نصّية حرّة (تعمل فقط لمن راسلك خلال 24 ساعة)
export async function sendWhatsAppText(to: string, body: string): Promise<void> {
  await post({ to, type: 'text', text: { body, preview_url: true } });
}

// رسالة قالب معتمد (للتسويق البارد) — bodyParams تملأ متغيّرات جسم القالب {{1}},{{2}}...
export async function sendWhatsAppTemplate(
  to: string,
  templateName: string,
  language: string,
  bodyParams: string[],
): Promise<void> {
  const components = bodyParams.length
    ? [{ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) }]
    : [];
  await post({
    to,
    type: 'template',
    template: { name: templateName, language: { code: language }, components },
  });
}
