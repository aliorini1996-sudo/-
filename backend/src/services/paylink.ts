import crypto from 'crypto';
import prisma from '../config/database';
import { roundHalfUp } from '../lib/money';
import { createInvoice, fetchInvoice, cancelInvoice, sarToHalalas, moyasarConfigured } from './moyasar';
import { postCollectionEntries } from './settlement';
import { generateReceiptNumber, withNumberRetry } from '../utils/helpers';
import { postReceiptEntries, clean } from './accounting';

/**
 * روابط دفع فواتير العملاء — «الدفع الإلكتروني» (ميزة اشتراك يفعّلها المالك).
 *
 * المسار: المندوب يختار فاتورة غير مسدَّدة من ملف العميل → يصدر رابطاً بكامل
 * متبقّيها → يشاركه واتساب → العميل يدفع على صفحة ميسر → الويب هوك يؤكّد →
 * معاملة واحدة تنشئ سند القبض (بكامل المدفوع) وتسدّد الفاتورة وتقيّد الأمانات.
 *
 * قراران حاكمان من المالك:
 *  - لا رابط بلا فاتورة، والرابط بكامل المتبقّي لا جزء منه.
 *  - نحن نجمع ثم نورّد أسبوعياً — فالعمولة (٤٪+١ شاملة الضريبة لكل شركة على
 *    حدة) تُقتطع من أمانات الشركة لا من سند العميل.
 */

const LINK_TTL_DAYS = 14; // رابط واتساب قد يُفتح متأخراً — أسبوعان ثم ينتهي

const FRONT = (process.env.FRONTEND_URL || 'https://fieldsa.net').replace(/\/+$/, '');

export function paylinkConfigured(): boolean {
  return moyasarConfigured();
}

/** رمز صفحة الدفع العامة — عشوائية نظام لا تسلسل، فالصفحة بلا مصادقة */
function newToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export interface IssueResult {
  ok: boolean;
  message?: string;
  link?: { id: string; token: string; url: string | null; payUrl: string; amount: number; expiresAt: Date };
  /** رابط قائم صالح أعيد بدل إنشاء مكرر */
  reused?: boolean;
}

/**
 * إصدار رابط دفع لفاتورة.
 * لا يُصدر إلا من فاتورة CONFIRMED دائنة بمتبقٍّ موجب — وبكامل المتبقّي.
 * رابط قائم غير منتهٍ لنفس الفاتورة بنفس المبلغ يُعاد بدل إغراق ميسر بالمكررات.
 */
export async function issueLink(params: {
  tenantId: string;
  invoiceId: string;
  salesRepId?: string;
  createdById?: string;
}): Promise<IssueResult> {
  if (!paylinkConfigured()) return { ok: false, message: 'بوابة الدفع غير مهيأة' };

  const [invoice, company] = await Promise.all([
    prisma.invoice.findFirst({
      where: { id: params.invoiceId, tenantId: params.tenantId },
      select: {
        id: true, number: true, status: true, type: true, customerId: true, remainingAmt: true,
        tenant: { select: { name: true, paylinkEnabled: true } },
      },
    }),
    // العملة تعيش على إعدادات الشركة لا الفاتورة
    prisma.companySettings.findUnique({ where: { tenantId: params.tenantId }, select: { currency: true } }),
  ]);
  if (!invoice) return { ok: false, message: 'الفاتورة غير موجودة' };
  if (!invoice.tenant.paylinkEnabled) return { ok: false, message: 'ميزة الدفع الالكتروني غير مفعلة لاشتراك شركتك' };
  if (invoice.status !== 'CONFIRMED' || invoice.type === 'RETURN') {
    return { ok: false, message: 'الرابط يصدر من فاتورة معتمدة غير مرتجعة فقط' };
  }
  // ميسر بالريال حصراً — الشركات بعملة أخرى مقفلة (قرار المالك)
  if ((company?.currency || 'SAR') !== 'SAR') {
    return { ok: false, message: 'الدفع الالكتروني متاح للشركات بالريال السعودي فقط' };
  }
  const remaining = roundHalfUp(Number(invoice.remainingAmt), 2);
  if (remaining <= 0) return { ok: false, message: 'الفاتورة مسددة بالكامل' };

  // رابط قائم بنفس المبلغ يعاد كما هو — تكرار النقر لا يصنع فاتورتي ميسر
  const existing = await prisma.customerPaymentLink.findFirst({
    where: {
      tenantId: params.tenantId,
      invoiceId: invoice.id,
      status: 'initiated',
      amount: remaining,
      expiresAt: { gt: new Date() },
    },
  });
  if (existing?.url) {
    return {
      ok: true, reused: true,
      link: { id: existing.id, token: existing.token, url: existing.url, payUrl: `${FRONT}/pay/${existing.token}`, amount: existing.amount, expiresAt: existing.expiresAt },
    };
  }

  // متبقٍّ تغيّر يميت الروابط القديمة قبل إصدار الجديد — لا رابطين حيّين بمبلغين
  await expireStaleLinks(params.tenantId, invoice.id, remaining);

  const token = newToken();
  const expiresAt = new Date(Date.now() + LINK_TTL_DAYS * 24 * 3600_000);

  const row = await prisma.customerPaymentLink.create({
    data: {
      tenantId: params.tenantId,
      token,
      invoiceId: invoice.id,
      customerId: invoice.customerId,
      salesRepId: params.salesRepId,
      createdById: params.createdById,
      amount: remaining,
      expiresAt,
    },
  });

  let moyasar;
  try {
    moyasar = await createInvoice({
      amountHalalas: sarToHalalas(remaining),
      description: `سداد فاتورة ${invoice.number} — ${invoice.tenant.name}`,
      successUrl: `${FRONT}/pay/${token}?done=1`,
      backUrl: `${FRONT}/pay/${token}`,
      // kind يميز روابط العملاء عن روابط اشتراكاتنا في نفس الويب هوك
      metadata: { kind: 'cpl', linkId: row.id, tenantId: params.tenantId },
    });
  } catch (e) {
    // فشل قبل تأكد الإنشاء لدى ميسر — ننظف صفنا (نفس فلسفة payments.ts)
    await prisma.customerPaymentLink.delete({ where: { id: row.id } }).catch(() => { /* best-effort */ });
    throw e;
  }

  try {
    const updated = await prisma.customerPaymentLink.update({
      where: { id: row.id },
      data: { moyasarInvoiceId: moyasar.id, url: moyasar.url },
    });
    return {
      ok: true,
      link: { id: updated.id, token, url: updated.url, payUrl: `${FRONT}/pay/${token}`, amount: remaining, expiresAt },
    };
  } catch (e) {
    // فاتورة حية لدى ميسر وصف لم يكتمل ربطه — صوت عالٍ + إلغاء كي لا تُدفع يتيمة
    console.error(`CRITICAL paylink ${row.id}: moyasar invoice ${moyasar.id} created but not persisted`);
    cancelInvoice(moyasar.id).catch(() => { /* best-effort */ });
    throw e;
  }
}

/**
 * إماتة الروابط الحية لفاتورة — تُستدعى عند تحصيل نقدي يغيّر المتبقّي وعند
 * إلغاء الفاتورة. «صلاحية الرابط تُفحص لحظة الدفع»: أقوى تطبيق لها إلغاء
 * فاتورة ميسر نفسها فلا يستطيع العميل الدفع أصلاً.
 */
export async function expireStaleLinks(tenantId: string, invoiceId: string, keepAmount?: number): Promise<void> {
  const stale = await prisma.customerPaymentLink.findMany({
    where: {
      tenantId, invoiceId, status: 'initiated',
      ...(keepAmount !== undefined ? { NOT: { amount: keepAmount } } : {}),
    },
    select: { id: true, moyasarInvoiceId: true },
  });
  for (const s of stale) {
    await prisma.customerPaymentLink.update({ where: { id: s.id }, data: { status: 'canceled' } }).catch(() => { /* سباق */ });
    if (s.moyasarInvoiceId) cancelInvoice(s.moyasarInvoiceId).catch(() => { /* best-effort — الويب هوك يلتقط ما فلت */ });
  }
}

export interface ConfirmResult { ok: boolean; state: string; receiptId?: string }

/**
 * تأكيد سداد رابط — يُستدعى من الويب هوك ومن التحديث اليدوي.
 * الحقيقة تُجلب من ميسر بمفتاحنا السري (لا ثقة بجسم أي ويب هوك)، ثم معاملة
 * واحدة تنشئ: سند القبض بكامل المدفوع + توزيعه على الفاتورة + قيدي الأمانات.
 *
 * idempotency: clientRef = 'paylink:<فاتورة ميسر>' — القيد الفريد القائم
 * @@unique([tenantId, clientRef]) يجعل تكرار الويب هوك يقرأ لا يكرر.
 */
export async function confirmLinkPayment(linkId: string): Promise<ConfirmResult> {
  const link = await prisma.customerPaymentLink.findUnique({
    where: { id: linkId },
    include: {
      invoice: { select: { id: true, number: true, customerId: true, paidAmt: true, remainingAmt: true } },
      tenant: { select: { paylinkFeePct: true, paylinkFeeFlat: true } },
    },
  });
  if (!link?.moyasarInvoiceId) return { ok: false, state: 'no-link' };
  if (link.status === 'paid' && link.receiptId) return { ok: true, state: 'already-paid', receiptId: link.receiptId };

  const remote = await fetchInvoice(link.moyasarInvoiceId);
  if (remote.status !== 'paid') {
    // انتهاء أو إلغاء لدى ميسر ينعكس عندنا — والحالات العابرة تُترك كما هي
    if (remote.status === 'expired' || remote.status === 'canceled') {
      await prisma.customerPaymentLink.update({ where: { id: link.id }, data: { status: remote.status } }).catch(() => { /* سباق */ });
    }
    return { ok: false, state: remote.status };
  }

  // المبلغ الحاكم ما دفعه العميل لدى ميسر فعلاً — لا ما جمّدناه عند الإصدار
  const collected = roundHalfUp(remote.amount / 100, 2);
  const clientRef = `paylink:${link.moyasarInvoiceId}`;

  const receipt = await withNumberRetry(async () => {
    const number = await generateReceiptNumber(link.tenantId);
    return prisma.$transaction(async tx => {
      const inv = await tx.invoice.findUnique({
        where: { id: link.invoiceId },
        select: { paidAmt: true, remainingAmt: true },
      });
      const remaining = roundHalfUp(Number(inv?.remainingAmt ?? 0), 2);
      // سُدّدت نقداً في السباق؟ التخصيص بقدر المتبقي والباقي رصيد دائن للعميل —
      // لا نبتلع مالاً دفعه العميل ولا نصنع تسديداً فوق التسديد
      const alloc = Math.min(collected, Math.max(0, remaining));

      const rcp = await tx.receipt.create({
        data: {
          tenantId: link.tenantId,
          number,
          clientRef,
          customerId: link.customerId,
          salesRepId: link.salesRepId, // السند باسم المندوب المصدر — يدخل تقريره
          amount: collected,
          paymentMethod: 'ONLINE',
          notes: alloc < collected
            ? `دفع الكتروني — فاتورة ${link.invoice.number} (سددت جزئيا قبل الدفع — الفائض رصيد دائن)`
            : `دفع الكتروني — فاتورة ${link.invoice.number}`,
        },
      });

      if (alloc > 0) {
        await tx.receiptInvoice.create({ data: { receiptId: rcp.id, invoiceId: link.invoiceId, amount: alloc } });
        await tx.invoice.update({
          where: { id: link.invoiceId },
          data: {
            paidAmt: clean(Number(inv?.paidAmt ?? 0) + alloc),
            remainingAmt: clean(remaining - alloc),
          },
        });
      }

      await postReceiptEntries(tx as never, link.tenantId, rcp.id, link.customerId, collected);

      // دفتر الأمانات: + المحصل كاملا ثم − عمولتنا (نسبة الشركة نفسها)
      await postCollectionEntries(tx, {
        tenantId: link.tenantId,
        linkId: link.id,
        collected,
        feePct: link.tenant.paylinkFeePct,
        feeFlat: link.tenant.paylinkFeeFlat,
        invoiceNumber: link.invoice.number,
      });

      await tx.customerPaymentLink.update({
        where: { id: link.id },
        data: { status: 'paid', paidAt: new Date(), receiptId: rcp.id },
      });

      await tx.notification.create({
        data: {
          tenantId: link.tenantId,
          type: 'PAYLINK_PAID',
          title: 'دفعة الكترونية',
          body: `سداد الكتروني ${collected} لفاتورة ${link.invoice.number} — سند ${number}`,
        },
      }).catch(() => { /* الإشعار كمالي لا يفشل المال */ });

      return rcp;
    });
  }).catch(async (e: unknown) => {
    // سباق ويب هوك مكرر: P2002 على clientRef يعني أن معاملة موازية سبقت — نقرأ سندها
    const err = e as { code?: string };
    if (err?.code === 'P2002') {
      const existing = await prisma.receipt.findUnique({
        where: { tenantId_clientRef: { tenantId: link.tenantId, clientRef } },
      });
      if (existing) return existing;
    }
    throw e;
  });

  return { ok: true, state: 'paid', receiptId: receipt.id };
}

/** بيانات صفحة الدفع العامة /pay/:token — يُعاد فقط ما يصلح للعلن */
export async function publicLinkView(token: string) {
  const link = await prisma.customerPaymentLink.findUnique({
    where: { token },
    include: {
      tenant: { select: { name: true, paylinkEnabled: true } },
      invoice: { select: { number: true, remainingAmt: true } },
      customer: { select: { name: true } },
    },
  });
  if (!link || !link.tenant.paylinkEnabled) return null;

  const company = await prisma.companySettings.findUnique({
    where: { tenantId: link.tenantId },
    select: { name: true, logo: true, primaryColor: true },
  });

  const expired = link.status === 'initiated' && link.expiresAt < new Date();
  // «الصلاحية لحظة الفتح»: متبقٍّ تغيّر منذ الإصدار يميت الرابط أمام العميل
  const remaining = roundHalfUp(Number(link.invoice.remainingAmt), 2);
  const settled = link.status === 'initiated' && remaining < link.amount - 0.0005;

  return {
    company: { name: company?.name || link.tenant.name, logo: company?.logo ?? null, primaryColor: company?.primaryColor ?? null },
    customerName: link.customer.name,
    invoiceNumber: link.invoice.number,
    amount: link.amount,
    status: expired ? 'expired' : settled ? 'settled' : link.status,
    payUrl: link.status === 'initiated' && !expired && !settled ? link.url : null,
  };
}
