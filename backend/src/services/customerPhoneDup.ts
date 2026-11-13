import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { normImportPhone } from './importMatch';

/**
 * «منع تكرار جوال العميل داخل الشركة» (طلب المالك ١٣ نوفمبر ٢٠٢٦): لا يُفتح عميلٌ (ولا يُعدَّل جواله) برقمٍ مسجَّلٍ لعميلٍ آخر في
 * الشركة نفسها. المقارنة بالرقم المطبَّع (normImportPhone: الأرقام الهندية لاتينية، و٠٠/٩٦٦/+٩٦٦ = ٠٥…) فلا يفلت «+966 55…» من
 * «055…». الجوال فارغٌ أو تافه (أقل من ٨ أرقام، أو كلّه الرقم نفسه) لا يُطابَق — الجوال اختياري.
 *
 * الاستثناءات (لا رفض): مفتاح API — سياسة «الخادم لا يرفض شيئاً في النقل» (Odoo قد يحمل فرعين بجوالٍ واحد)؛ وإعادة رفع صندوق
 * المندوب (X-FS-Replay) — عميلٌ أُضيف دون اتصال وفواتيره تنتظره بمرجعه، فرفضه يُسقطها. المنع للإدخال الحيّ في الويب و/m والتطبيق.
 */
export const CUSTOMER_PHONE_EXISTS = 'CUSTOMER_PHONE_EXISTS';

/** الطلب يُعفى من المنع: مفتاح API أو إعادة رفع صندوق المندوب */
export function phoneDupExempt(req: { headers: Record<string, unknown>; user?: { apiKeyId?: string | null } | null }): boolean {
  if (req.user?.apiKeyId) return true;
  return String(req.headers['x-fs-replay'] ?? '') === '1';
}

/**
 * عميلٌ آخر في الشركة بالجوال نفسه (المطبَّع)، أو null. يُرشَّح في القاعدة بآخر ثمانية أرقام (بعد ترجمة الأرقام الهندية وحذف غير
 * الأرقام) ثم يُطابَق مطبَّعاً هنا. المحذوف لا يُعدّ، و`exceptId` العميل نفسه عند التعديل.
 */
export async function findPhoneDuplicate(tid: string, phone: unknown, exceptId?: string | null): Promise<{ id: string; name: string } | null> {
  const key = normImportPhone(phone);
  if (!key) return null;
  const tail = key.slice(-8);
  const rows = await prisma.$queryRaw<{ id: string; name: string; phone: string | null }[]>`
    SELECT id, name, phone FROM customers
    WHERE "tenantId" = ${tid} AND status <> 'DELETED'
      AND right(regexp_replace(translate(coalesce(phone, ''), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'), '[^0-9]', '', 'g'), 8) = ${tail}
      ${exceptId ? Prisma.sql`AND id <> ${exceptId}` : Prisma.empty}
    LIMIT 50`;
  const hit = (rows ?? []).find((r) => normImportPhone(r.phone) === key);
  return hit ? { id: hit.id, name: hit.name } : null;
}

/** جسم ردّ 409 — اسم العميل الآخر لمن يراه وحده (عزل عملاء المناديب لا يُكشف به عميلٌ غير مُسنَد) */
export function phoneDupBody(dup: { id: string; name: string }, canSee: boolean) {
  return {
    success: false as const,
    code: CUSTOMER_PHONE_EXISTS,
    message: canSee ? `رقم الجوال مسجل للعميل «${dup.name}»` : 'رقم الجوال مسجل لعميل آخر في الشركة',
    ...(canSee && { existingId: dup.id, existingName: dup.name }),
  };
}
