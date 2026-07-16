/**
 * Webhook واتساب (Meta Cloud API) — نقطة **عامّة** بلا مصادقة (Meta تستدعيها).
 *
 * تستقبل أمرين:
 *  1) الردود الواردة  → تُسجَّل على العميل، وتُنقل مرحلته إلى «مؤهَّل» (الردّ أقوى إشارة نيّة لدينا)،
 *     أو تُوقف مراسلته نهائياً إن كان ردّه طلب انسحاب.
 *  2) حالات التسليم   → sent/delivered/read/failed تُحدَّث على سجلّ الرسالة عبر waId.
 *
 * الأمان: نتحقّق من توقيع Meta على الجسم الخام (WHATSAPP_APP_SECRET)، وإلا لأمكن لأي طرف
 * حقن ردود مزيّفة أو انسحابات كاذبة في خطّ العملاء.
 *
 * الإعداد في Meta: Callback URL = https://api.fieldsa.net/api/whatsapp/webhook
 *                  Verify Token = قيمة WHATSAPP_VERIFY_TOKEN
 */

import { Router, Request, Response } from 'express';
import prisma from '../config/database';
import { verifyWaSignature } from '../services/whatsapp';
import { handleInboundMessage } from '../services/waInbound';

const router = Router();

// ------------------------------- تحقّق الاشتراك (GET) ------------------------------- //
// Meta تستدعيها مرّة عند ربط الـwebhook وتتوقّع إعادة hub.challenge نصّاً خاماً.
router.get('/webhook', (req: Request, res: Response) => {
  const expected = (process.env.WHATSAPP_VERIFY_TOKEN || '').trim();
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (expected && mode === 'subscribe' && token === expected) {
    res.status(200).send(String(challenge ?? ''));
    return;
  }
  res.sendStatus(403);
});

// ------------------------------- الاستقبال (POST) ------------------------------- //

interface WaInboundMessage {
  id?: string;
  from?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
}

interface WaStatus {
  id?: string;
  status?: string; // sent | delivered | read | failed
  errors?: { title?: string; message?: string }[];
}

// نصّ الردّ مهما كان نوعه (نصّ/زر/قائمة/وسائط)
function inboundText(m: WaInboundMessage): string {
  return (
    m.text?.body
    || m.button?.text
    || m.interactive?.button_reply?.title
    || m.interactive?.list_reply?.title
    || `[${m.type || 'رسالة'}]`
  );
}

// المعالجة نفسها يتشاركها الجسر المحلي — المنطق في services/waInbound
async function onInbound(m: WaInboundMessage): Promise<void> {
  const phone = (m.from || '').replace(/[^\d]/g, '');
  if (!phone) return;
  await handleInboundMessage({
    waId: m.id || `in_${phone}_${Date.now()}`,
    phone,
    body: inboundText(m),
  });
}

async function onStatus(s: WaStatus): Promise<void> {
  if (!s.id || !s.status) return;
  const map: Record<string, string> = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ', failed: 'FAILED' };
  const status = map[s.status];
  if (!status) return;
  const error = s.errors?.[0]?.message || s.errors?.[0]?.title || null;
  // الرسالة قد لا تكون مسجّلة (أُرسلت من هاتف الأعمال مباشرةً) — نتجاهل بصمت
  await prisma.waMessage.updateMany({ where: { waId: s.id }, data: { status, ...(error ? { error } : {}) } });
}

router.post('/webhook', async (req: Request, res: Response) => {
  // نردّ 200 فوراً: Meta تعيد المحاولة بقوّة عند أي تأخّر أو خطأ، فنعالج بعد الردّ.
  const raw = (req as Request & { rawBody?: Buffer }).rawBody;
  const sig = req.get('x-hub-signature-256');
  if (!verifyWaSignature(raw, sig)) {
    res.sendStatus(401);
    return;
  }
  res.sendStatus(200);

  try {
    const body = req.body as { entry?: { changes?: { value?: { messages?: WaInboundMessage[]; statuses?: WaStatus[] } }[] }[] };
    for (const entry of body?.entry ?? []) {
      for (const ch of entry.changes ?? []) {
        for (const m of ch.value?.messages ?? []) await onInbound(m);
        for (const s of ch.value?.statuses ?? []) await onStatus(s);
      }
    }
  } catch (e) {
    console.error('[wa-webhook]', (e as Error).message);
  }
});

export default router;
