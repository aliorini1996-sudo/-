/**
 * معالجة الردود الواردة على واتساب — مشتركة بين مصدرَين:
 *  1) webhook الـCloud API الرسمي (routes/whatsappWebhook.ts)
 *  2) الجسر المحلي على واتساب ويب (routes/waBridge.ts)
 *
 * المنطق واحد مهما كان المصدر: سجّل الرسالة، وإما أوقف المراسلة (انسحاب) أو ارفع
 * المرحلة إلى «مؤهَّل» — لأن الردّ أقوى إشارة نيّة لدينا.
 */

import prisma from '../config/database';
import { isOptOut } from './whatsapp';

/**
 * إيجاد العميل من رقم واتساب.
 * الأدقّ: آخر رسالة صادرة لنفس الرقم المطبَّع (نحن من خزّنه). واحتياطاً: مطابقة آخر 9 أرقام،
 * لأن أرقام العملاء محفوظة بصيغ مختلفة (+966… / 00966… / 05…) بينما واتساب يعطي 966… فقط.
 */
export async function findLeadIdByPhone(waPhone: string): Promise<string | null> {
  const prev = await prisma.waMessage.findFirst({
    where: { phone: waPhone, leadId: { not: null } },
    orderBy: { createdAt: 'desc' },
    select: { leadId: true },
  });
  if (prev?.leadId) return prev.leadId;

  const tail = waPhone.slice(-9);
  if (tail.length < 8) return null;
  const lead = await prisma.lead.findFirst({ where: { phone: { contains: tail } }, select: { id: true } });
  return lead?.id ?? null;
}

export interface InboundInput {
  waId: string;   // معرّف الرسالة — مفتاح منع التكرار
  phone: string;  // رقم المُرسِل (أرقام فقط)
  body: string;   // نصّ الردّ
}

export interface InboundResult {
  handled: boolean;
  leadId: string | null;
  optOut: boolean;
  duplicate: boolean;
}

export async function handleInboundMessage(input: InboundInput): Promise<InboundResult> {
  const phone = (input.phone || '').replace(/[^\d]/g, '');
  const body = input.body || '';
  if (!phone) return { handled: false, leadId: null, optOut: false, duplicate: false };

  // المصدران يعيدان إرسال الأحداث أحياناً — بلا هذا الحارس تتكرّر الأنشطة على العميل
  const seen = await prisma.waMessage.findUnique({ where: { waId: input.waId }, select: { id: true } });
  if (seen) return { handled: false, leadId: null, optOut: false, duplicate: true };

  const leadId = await findLeadIdByPhone(phone);
  const optOut = isOptOut(body);

  await prisma.waMessage.create({
    data: { waId: input.waId, leadId, phone, direction: 'IN', body, status: 'RECEIVED' },
  });

  if (!leadId) return { handled: true, leadId: null, optOut, duplicate: false };

  await prisma.leadActivity.create({
    data: {
      leadId,
      type: optOut ? 'WHATSAPP_OPTOUT' : 'WHATSAPP_IN',
      content: optOut ? `طلب إيقاف المراسلة: «${body}»` : `ردّ واتساب: «${body}»`,
      createdBy: 'واتساب',
    },
  });

  if (optOut) {
    await prisma.lead.update({ where: { id: leadId }, data: { waOptOut: true } });
    return { handled: true, leadId, optOut: true, duplicate: false };
  }

  // نرفع المرحلة من الأولى/الثانية فقط — لا نتراجع بعميل بلغ مرحلة متقدّمة
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { stage: true } });
  const promote = lead?.stage === 'NEW' || lead?.stage === 'CONTACTED';
  await prisma.lead.update({
    where: { id: leadId },
    data: { lastContactedAt: new Date(), ...(promote ? { stage: 'QUALIFIED' } : {}) },
  });

  return { handled: true, leadId, optOut: false, duplicate: false };
}
