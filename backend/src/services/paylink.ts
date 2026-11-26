import crypto from 'crypto';
import prisma from '../config/database';
import { roundHalfUp } from '../lib/money';
import { createInvoice, fetchInvoice, cancelInvoice, sarToHalalas, moyasarConfigured } from './moyasar';
import { postCollectionEntries, postRefundEntry } from './settlement';
import { generateReceiptNumber, withNumberRetry } from '../utils/helpers';
import { postReceiptEntries, reverseReceiptEntries, clean } from './accounting';
import { publishInvoicesChanged } from './liveEvents';
import { claimReceiptCancel, restoreAllocations } from './docCancel';
// ZATCA المرحلة الثانية (Z5.4، F2): فاتورةٌ لم تعتمدها الهيئة لا يُصدر لها رابط دفع، والمتبقّي يُقرأ مقفلاً (نقد 13)
import { ALLOCATION_BLOCKED_MIRRORS } from '../compliance/zatca/status';
import { ZATCA_ERROR_CATALOGUE } from '../compliance/zatca/errors';
// «أرشيف العميل — السجل الزمني»: إصدار الرابط وسداده وإلغاؤه وانتهاؤه واسترداده أحداثٌ في سجلّ العميل داخل معاملة كل تبديل
import {
  SYSTEM_META, cardPaymentMeta, customerMeta, paylinkEventInput, receiptEventInput, recordDocActivity, type DocActivityMeta,
} from './customerActivityDocs';

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

// FRONTEND_URL قائمة أصول بفاصلة (لأغراض CORS) — رابط العميل يبنى من الأول فقط.
// أخذها كاملة أنتج روابط مكسورة «fieldsa.net,https://www.fieldsa.net/pay/…» لا تفتح.
const FRONT = (process.env.FRONTEND_URL || 'https://fieldsa.net').split(',')[0].trim().replace(/\/+$/, '');

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
  /** «أرشيف العميل»: فاعل الإصدار من الطلب — وغيابه يُشتقّ من المُصدِر (الإداري، وإلا المندوب) */
  activity?: DocActivityMeta | null;
}): Promise<IssueResult> {
  if (!paylinkConfigured()) return { ok: false, message: 'بوابة الدفع غير مهيأة' };

  const [invoice, company] = await Promise.all([
    prisma.invoice.findFirst({
      where: { id: params.invoiceId, tenantId: params.tenantId },
      select: {
        id: true, number: true, status: true, type: true, customerId: true, remainingAmt: true, einvoiceStatus: true,
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
  // ZATCA المرحلة الثانية (F2): لا رابط دفع على فاتورة لم تصر نهائية عند الهيئة — القائمة والسند يحرسان الشرط نفسه
  if (invoice.einvoiceStatus !== null && (ALLOCATION_BLOCKED_MIRRORS as readonly string[]).includes(invoice.einvoiceStatus)) {
    return { ok: false, message: ZATCA_ERROR_CATALOGUE.ZATCA_ALLOCATION_BLOCKED.messageAr };
  }
  // ميسر بالريال حصراً — الشركات بعملة أخرى مقفلة (قرار المالك)
  if ((company?.currency || 'SAR') !== 'SAR') {
    return { ok: false, message: 'الدفع الالكتروني متاح للشركات بالريال السعودي فقط' };
  }
  const remaining = roundHalfUp(Number(invoice.remainingAmt), 2);
  if (remaining <= 0) return { ok: false, message: 'الفاتورة مسددة بالكامل' };
  if (remaining > 1_000_000) {
    return { ok: false, message: 'المبلغ يتجاوز حد الدفع الالكتروني للعملية الواحدة (مليون ريال) — قسط التحصيل او حصله بطريقة اخرى' };
  }

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

  // «أرشيف العميل»: فاعل الإصدار (ومعه إماتة القديم الذي يحلّ محلّه)
  const activity = params.activity ?? cardPaymentMeta({ createdById: params.createdById ?? null, salesRepId: params.salesRepId ?? null });

  // متبقٍّ تغيّر يميت الروابط القديمة قبل إصدار الجديد — لا رابطين حيّين بمبلغين
  await expireStaleLinks(params.tenantId, invoice.id, remaining, { activity, reason: 'REPLACED' });

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
    // فشل قبل تأكد الإنشاء لدى ميسر — ننظف صفنا (نفس فلسفة payments.ts).
    // الخطأ الخام (يحمل اسم المزود وتفاصيله) للسجل، والمندوب يرى رسالة عمل
    await prisma.customerPaymentLink.delete({ where: { id: row.id } }).catch(() => { /* best-effort */ });
    console.error('paylink issue: provider create failed:', (e as Error).message);
    return { ok: false, message: 'تعذر انشاء رابط الدفع حاليا حاول بعد لحظات' };
  }

  try {
    // «أرشيف العميل»: ربط الرابط بالمزوّد وحدث إصداره في معاملة واحدة — والحدث للرابط الباقي وحده (لا لتوأم السباق الذي
    // يُلغى أدناه ولم يصل أحداً)
    const { updated, rival } = await prisma.$transaction(async tx => {
      const updated = await tx.customerPaymentLink.update({
        where: { id: row.id },
        data: { moyasarInvoiceId: moyasar.id, url: moyasar.url },
      });

      // سباق الإصدار المزدوج (جهازان في نفس اللحظة): لا قيد فريد يمنع رابطين حيين
      // بفاتورتي ميسر قابلتين للدفع معا. القاعدة: يبقى الأقدم — فإن وجدنا أقدم منا
      // حيا بمبلغنا ألغينا أنفسنا وأعدناه، فيتقارب الطرفان على رابط واحد
      const rival = await tx.customerPaymentLink.findFirst({
        where: {
          tenantId: params.tenantId, invoiceId: invoice.id, status: 'initiated',
          amount: remaining, url: { not: null }, id: { not: row.id },
          createdAt: { lt: updated.createdAt },
        },
        orderBy: { createdAt: 'asc' },
      });
      if (!rival?.url) {
        await recordDocActivity(tx, paylinkEventInput({ action: 'PAYLINK_CREATED', meta: activity, link: updated, invoiceNo: invoice.number, amount: remaining }));
      }
      return { updated, rival };
    });
    if (rival?.url) {
      await prisma.customerPaymentLink.update({ where: { id: row.id }, data: { status: 'canceled' } }).catch(() => { /* سباق */ });
      cancelInvoice(moyasar.id).catch((e: unknown) =>
        console.error(`paylink converge ${row.id}: cancel failed:`, (e as Error).message));
      return {
        ok: true, reused: true,
        link: { id: rival.id, token: rival.token, url: rival.url, payUrl: `${FRONT}/pay/${rival.token}`, amount: rival.amount, expiresAt: rival.expiresAt },
      };
    }

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
export async function expireStaleLinks(
  tenantId: string, invoiceId: string, keepAmount?: number,
  /** «أرشيف العميل»: من أمات الروابط ولماذا — الغياب = النظام لتغيّر الفاتورة (تحصيلٌ أو إلغاءٌ أو إشعار) */
  opts?: { activity?: DocActivityMeta | null; reason?: string },
): Promise<void> {
  const stale = await prisma.customerPaymentLink.findMany({
    where: {
      tenantId, invoiceId, status: 'initiated',
      ...(keepAmount !== undefined ? { NOT: { amount: keepAmount } } : {}),
    },
    // عميل الرابط ومبلغه ورقم فاتورته لحدث الإلغاء في سجلّ العميل
    select: { id: true, moyasarInvoiceId: true, tenantId: true, customerId: true, invoiceId: true, amount: true, invoice: { select: { number: true } } },
  });
  const meta = opts?.activity ?? SYSTEM_META;
  for (const s of stale) {
    // الإلغاء وحدثه في معاملة واحدة — **تبديلٌ مشروط** من «بانتظار الدفع» وحده (القراءة أعلاه خارج المعاملة): إماتتان متزامنتان على
    // اللقطة نفسها يفوز بها واحد فلا يتكرّر الحدث، ورابطٌ سُدّد بعد القراءة لا يُدهس إلى «ملغى» ولا يُلحق بسداده إلغاء.
    // فشل المعاملة يُبتلع كما كان (سباق)
    const claimed = await prisma.$transaction(async tx => {
      const r = await tx.customerPaymentLink.updateMany({ where: { id: s.id, status: 'initiated' }, data: { status: 'canceled' } });
      if (r.count !== 1) return false;
      await recordDocActivity(tx, paylinkEventInput({
        action: 'PAYLINK_CANCELLED', meta, link: s, invoiceNo: s.invoice?.number ?? null, data: { reason: opts?.reason ?? 'INVOICE_CHANGED' },
      }));
      return true;
    }).catch(() => null /* سباق — لا يُعرف من فاز */);
    // رابطٌ أماته غيرنا أو سُدّد في الأثناء: لا إلغاء لفاتورته لدى ميسر من هنا (من أماته ألغاها، والمسدَّد لا يُلغى)
    if (claimed === false) continue;
    // فشل إلغاء فاتورة ميسر يعني احتمال «دُفعت للتو» — لا يُبتلع صامتاً:
    // الصوت هنا + مسح الموتى-حديثاً في المجدول يحييان أي دفعة سبقت الإلغاء
    if (s.moyasarInvoiceId) {
      cancelInvoice(s.moyasarInvoiceId).catch((e: unknown) =>
        console.error(`paylink expire ${s.id}: moyasar cancel failed (may be paid):`, (e as Error).message));
    }
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
      invoice: { select: { id: true, number: true, customerId: true, paidAmt: true, remainingAmt: true, teamId: true } },
      tenant: { select: { paylinkFeePct: true, paylinkFeeFlat: true } },
      // «أرشيف العميل»: الدافع هو العميل نفسه — باسمه فاعلاً لحدث السداد
      customer: { select: { name: true } },
    },
  });
  if (!link?.moyasarInvoiceId) return { ok: false, state: 'no-link' };
  if (link.status === 'paid' && link.receiptId) return { ok: true, state: 'already-paid', receiptId: link.receiptId };

  const remote = await fetchInvoice(link.moyasarInvoiceId);
  // دفاتر الميزة بالريال حصرا — عملة أخرى من المزود تعني خللا يوقف القيد لا يمرره
  if (remote.currency && remote.currency !== 'SAR') {
    console.error(`CRITICAL paylink ${link.id}: currency ${remote.currency} != SAR — booking refused`);
    return { ok: false, state: 'currency-mismatch' };
  }
  if (remote.status !== 'paid') {
    // انتهاء أو إلغاء لدى ميسر ينعكس عندنا — لكن لا نكتب فوق paid أبدا (درس الدهس)
    if (remote.status === 'expired' || remote.status === 'canceled') {
      // «أرشيف العميل»: موت الرابط الحيّ حدثٌ بفاعل النظام — للانتقال من «بانتظار الدفع» وحده (المسح يعيد السؤال عن الميت
      // ثلاثة أيام، فتبديلٌ بين حالتي الموت لا يُكرّر حدثاً). والأثر على الصفّ كما كان حرفاً: الحالة من المزوّد
      const deadStatus = remote.status;
      await prisma.$transaction(async tx => {
        const fromLive = await tx.customerPaymentLink.updateMany({ where: { id: link.id, status: 'initiated' }, data: { status: deadStatus } });
        if (fromLive.count === 1) {
          await recordDocActivity(tx, paylinkEventInput({
            action: deadStatus === 'expired' ? 'PAYLINK_EXPIRED' : 'PAYLINK_CANCELLED', meta: SYSTEM_META, link,
            invoiceNo: link.invoice?.number ?? null, data: { reason: 'PROVIDER' },
          }));
          return;
        }
        await tx.customerPaymentLink.updateMany({
          where: { id: link.id, status: { in: ['initiated', 'canceled', 'expired'] } },
          data: { status: deadStatus },
        });
      }).catch(() => { /* سباق */ });
    }
    return { ok: false, state: remote.status };
  }

  // المبلغ الحاكم ما دفعه العميل لدى ميسر فعلاً — لا ما جمّدناه عند الإصدار
  const collected = roundHalfUp(remote.amount / 100, 2);
  const clientRef = `paylink:${link.moyasarInvoiceId}`;

  const receipt = await withNumberRetry(async () => {
    const number = await generateReceiptNumber(link.tenantId);
    return prisma.$transaction(async tx => {
      // نقد 13: يُقرأ الصفّ **مقفلاً** (FOR UPDATE) لا بلقطةٍ حرّة — وإلا دهست الكتابةُ المطلقة أدناه أيّ تغييرٍ
      // متزامن على المتبقّي (إبطال فاتورة رفضتها الهيئة، أو سند قبض في اللحظة نفسها) فطُولب العميل بما دفعه
      const locked = await tx.$queryRaw<{ paidAmt: number; remainingAmt: number }[]>`
        SELECT "paidAmt", "remainingAmt" FROM invoices WHERE id = ${link.invoiceId} FOR UPDATE`;
      const inv = locked[0] ?? null;
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
          ...(link.invoice?.teamId && { teamId: link.invoice.teamId }), // الفرق: يُحسب لفريق فاتورته
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
        data: {
          status: 'paid', paidAt: new Date(), receiptId: rcp.id,
          // معرف الدفعة لدى المزود — بدونه لا يُبنى مسار الاسترداد
          moyasarPaymentId: remote.payments?.find(p => p.status === 'paid' || p.status === 'captured')?.id ?? null,
        },
      });

      // «أرشيف العميل»: سداد العميل رابطَه وسندُ القبض الذي أنشأه — بفاعل العميل نفسه، في معاملة القيد الواحدة (clientRef الفريد
      // يمنع تكرارها مع الويب هوك المكرّر)
      const payer = customerMeta(link.customer?.name ?? null);
      await recordDocActivity(tx, [
        paylinkEventInput({
          action: 'PAYLINK_PAID', meta: payer, link, invoiceNo: link.invoice.number, amount: collected,
          data: { receiptNo: number, ...(alloc < collected && { overpaid: clean(collected - alloc) }) },
        }),
        receiptEventInput({
          tenantId: link.tenantId, action: 'RECEIPT_ISSUED', meta: payer, receipt: rcp,
          allocations: alloc > 0 ? [{ invoiceId: link.invoiceId, invoiceNo: link.invoice.number, amount: alloc, settled: clean(remaining - alloc) <= 0.004 }] : [],
          data: { via: 'PAYLINK', paylinkId: link.id },
        }),
      ]);

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

  // الدفعة الإلكترونية تصل من ميسر لا من شاشة — فلا شيء غير هذا البثّ يُخبر
  // الإداريّ الواقف على قائمة الفواتير أن «المدفوع» تغيّر
  publishInvoicesChanged(link.tenantId);
  return { ok: true, state: 'paid', receiptId: receipt.id };
}

// ═══ مجدول التسوية — الحقيقة تُجلب دورياً لا تُنتظر ═══

const RECONCILE_INTERVAL_MS = 2 * 60_000; // كل دقيقتين
const RECONCILE_BATCH = 40;

/**
 * انتهاء مهلة الرابط (أسبوعان) — الأثر على الصفّ كما كان حرفاً (expired)، و«أرشيف العميل»: حدث الانتهاء بفاعل النظام في المعاملة
 * نفسها للانتقال من «بانتظار الدفع» وحده (التأكيد قبله قد يكون أماته بحالة المزوّد وسجّل حدثه).
 */
async function expireLinkAfterTtl(linkId: string): Promise<void> {
  await prisma.$transaction(async tx => {
    const fromLive = await tx.customerPaymentLink.updateMany({ where: { id: linkId, status: 'initiated' }, data: { status: 'expired' } });
    if (fromLive.count !== 1) {
      await tx.customerPaymentLink.update({ where: { id: linkId }, data: { status: 'expired' } });
      return;
    }
    const l = await tx.customerPaymentLink.findUnique({
      where: { id: linkId },
      select: { id: true, tenantId: true, customerId: true, invoiceId: true, amount: true, invoice: { select: { number: true } } },
    });
    if (l) {
      await recordDocActivity(tx, paylinkEventInput({ action: 'PAYLINK_EXPIRED', meta: SYSTEM_META, link: l, invoiceNo: l.invoice?.number ?? null, data: { reason: 'TTL' } }));
    }
  }).catch(() => { /* سباق */ });
}

/**
 * تسوية الروابط المعلقة: يمر على «بانتظار الدفع» فيؤكد المدفوع وينهي المنتهي.
 *
 * لماذا لا يكفي الويب هوك: إشعار ميسر قناة قد تتأخر أو لا تصل (تسجيلها في
 * لوحتهم خطوة يدوية، والشبكات تخذل)، وصفحة النجاح تفترض أن الدافع عاد إليها —
 * ومن دفع من متصفح واتساب ثم أغلقه لا يعود. المال لا يعلق على افتراضين:
 * المجدول يسأل ميسر بنفسه فيتأكد السداد خلال دقيقتين في أسوأ الأحوال،
 * والويب هوك حين يعمل يجعله فورياً.
 */
export async function reconcilePendingLinks(): Promise<void> {
  const now = new Date();
  // الأقدم-فحصاً أولاً: updatedAt يرتفع بكل لمسة فتدور الدفعة على الكل بلا تجويع —
  // الأحدث-أولاً السابقة كانت تثبت النافذة على أحدث ٤٠ ويهمل ما بعدها حتى انتهائه
  const pending = await prisma.customerPaymentLink.findMany({
    where: { status: 'initiated', moyasarInvoiceId: { not: null } },
    orderBy: { updatedAt: 'asc' },
    take: RECONCILE_BATCH,
    select: { id: true, moyasarInvoiceId: true, expiresAt: true },
  });
  for (const link of pending) {
    try {
      if (link.expiresAt < now) {
        // انتهت مهلتنا: الحقيقة من المزود **قبل** الإماتة — دفعة اللحظة الأخيرة
        // كانت تُمات ثم لا يحييها شيء، فالمال يؤخذ بلا سند
        const out = await confirmLinkPayment(link.id);
        if (out.state === 'paid' || out.state === 'already-paid') continue;
        await expireLinkAfterTtl(link.id);
        if (link.moyasarInvoiceId) {
          cancelInvoice(link.moyasarInvoiceId).catch((e: unknown) =>
            console.error(`paylink expire ${link.id}: cancel failed:`, (e as Error).message));
        }
        continue;
      }
      const out = await confirmLinkPayment(link.id); // يجلب الحقيقة من ميسر ويتصرف بها
      if (out.state === 'initiated') {
        // لمسة تدوير: ترفع updatedAt فيتقدم غيره في الدفعة القادمة
        await prisma.customerPaymentLink.update({ where: { id: link.id }, data: {} }).catch(() => { /* شكلي */ });
      }
    } catch (e) {
      // رابط واحد معطوب لا يوقف تسوية البقية
      console.error(`paylink reconcile ${link.id}:`, (e as Error).message);
    }
  }

  // مسح الموتى-حديثاً: رابط أُمِيت محلياً وقد يكون دُفع لدى المزود في نافذة السباق
  // (إلغاء إداري/تحصيل نقدي لحظة الدفع، أو فشل إلغاء ميسر) — نسأله عنه ثلاثة أيام.
  // confirmLinkPayment يتجاهل الحالة المحلية ويقيد المدفوع فيُبعث الرابط paid بسنده
  const dead = await prisma.customerPaymentLink.findMany({
    where: {
      status: { in: ['canceled', 'expired'] },
      receiptId: null,
      moyasarInvoiceId: { not: null },
      updatedAt: { gt: new Date(now.getTime() - 72 * 3600_000) },
    },
    orderBy: { updatedAt: 'asc' },
    take: 25,
    select: { id: true },
  });
  for (const link of dead) {
    try {
      const out = await confirmLinkPayment(link.id);
      if (out.state === 'paid') console.error(`paylink resurrect ${link.id}: paid-under-cancel booked`);
      else await prisma.customerPaymentLink.update({ where: { id: link.id }, data: {} }).catch(() => { /* تدوير */ });
    } catch (e) {
      console.error(`paylink dead-sweep ${link.id}:`, (e as Error).message);
    }
  }

  // صفوف لم يكتمل ربطها بميسر (انهيار بين الإنشاء والربط): بلا url لا تُدفع ولا تُعاد —
  // تُمات بعد ربع ساعة كي لا تسد إعادة الاستعمال على فاتورتها
  await prisma.customerPaymentLink.updateMany({
    where: { status: 'initiated', url: null, createdAt: { lt: new Date(now.getTime() - 15 * 60_000) } },
    data: { status: 'canceled' },
  }).catch(() => { /* best-effort */ });
}

/**
 * عكس سداد رابط بعد استرداد كامل لدى المزود (نزاع بطاقة أو رد من لوحة ميسر).
 *
 * قبل هذا كان حدث الاسترداد يضيع صامتا: السند يبقى والفاتورة مسددة ورصيد
 * أمانات الشركة شاملا مبلغا خرج فعليا من حسابنا للعميل — فالتوريد الأسبوعي
 * كان سيدفع للشركة مالا رُدَّ. المعاملة الواحدة: إلغاء السند + إرجاع الفاتورة +
 * عكس قيود العميل + قيد REFUND في الأمانات (العمولة لا تُرد — الخدمة قُدمت).
 */
export async function reverseLinkPayment(linkId: string, reason: string): Promise<{ ok: boolean; state: string }> {
  const link = await prisma.customerPaymentLink.findUnique({
    where: { id: linkId },
    include: { invoice: { select: { number: true } } },
  });
  if (!link) return { ok: false, state: 'no-link' };
  if (link.status === 'refunded') return { ok: true, state: 'already-refunded' };
  if (link.status !== 'paid' || !link.receiptId) return { ok: false, state: 'not-paid' };

  const receipt = await prisma.receipt.findUnique({
    where: { id: link.receiptId },
    // رقم فاتورة كل تخصيص لحدث إلغاء السند في سجلّ العميل («أرشيف العميل») — من الاستعلام نفسه
    include: { invoiceItems: { include: { invoice: { select: { number: true } } } } },
  });
  if (!receipt) return { ok: false, state: 'no-receipt' };

  const reversed = await prisma.$transaction(async tx => {
    /* مقارنةٌ وتبديل على الرابط أولاً (مراجعة ٣٠ سبتمبر ٢٠٢٦): الفحوص أعلاه على قراءةٍ سابقة للمعاملة، فكان webhook
     * مكرّر يعكس القيد مرّتين. من يفوز بتبديل الرابط paid→refunded يكتب قيد REFUND في الأمانات **دائماً**: ميسر ردّ
     * المال من حسابنا أياً كانت حالة السند — وكان سندٌ أُلغي يدوياً قبل الاسترداد يُسقط هذا القيد، فيدفع التوريد
     * الأسبوعي للشركة مالاً رُدّ لعميلها (MD-8). أما عكس ذمّة العميل فلمن يفوز بإلغاء السند وحده. */
    const linkClaim = await tx.customerPaymentLink.updateMany({ where: { id: link.id, status: 'paid' }, data: { status: 'refunded' } });
    if (linkClaim.count !== 1) return null;
    await postRefundEntry(tx, {
      tenantId: link.tenantId,
      linkId: link.id,
      refunded: Number(receipt.amount),
      invoiceNumber: link.invoice.number,
    });
    // سندٌ أُلغي يدوياً (قبل الاسترداد أو معه) عُكست ذمّته هناك — لا عكس ثانٍ
    const receiptCancelled = await claimReceiptCancel(tx, link.tenantId, receipt.id);
    if (receiptCancelled) {
      await restoreAllocations(tx, link.tenantId, receipt.invoiceItems);
      await reverseReceiptEntries(tx as never, link.tenantId, receipt.id, link.customerId, Number(receipt.amount));
    }
    await tx.notification.create({
      data: {
        tenantId: link.tenantId,
        type: 'PAYLINK_REFUNDED',
        title: 'استرداد دفعة الكترونية',
        body: `رُدَّ مبلغ ${Number(receipt.amount)} لفاتورة ${link.invoice.number} — ${receiptCancelled ? 'الغي' : 'كان ملغى'} سند ${receipt.number} (${reason})`,
      },
    }).catch(() => { /* كمالي */ });
    // «أرشيف العميل»: استرداد دفعة الرابط (حدث «استرداد» — المال عاد للعميل، لا «إلغاء رابط») بفاعل النظام، وإلغاء سندها إن أُلغي
    // هنا برقم فاتورة كل تخصيص — لمن فاز بتبديل الرابط وحده
    await recordDocActivity(tx, [
      paylinkEventInput({
        action: 'PAYLINK_REFUNDED', meta: SYSTEM_META, link, invoiceNo: link.invoice.number, amount: Number(receipt.amount),
        data: { status: 'refunded', reason, receiptNo: receipt.number, ...(!receiptCancelled && { receiptAlreadyCancelled: true }) },
      }),
      receiptCancelled
        ? receiptEventInput({
          tenantId: link.tenantId, action: 'RECEIPT_CANCELLED', meta: SYSTEM_META, receipt,
          allocations: receipt.invoiceItems.map(a => ({
            invoiceId: a.invoiceId, invoiceNo: a.invoice?.number ?? (a.invoiceId === link.invoiceId ? link.invoice.number : null), amount: Number(a.amount),
          })),
          data: { via: 'PAYLINK_REFUND', paylinkId: link.id, reason },
        })
        : null,
    ]);
    return receiptCancelled;
  });
  if (reversed === null) return { ok: true, state: 'already-refunded' };
  console.error(`paylink refund ${link.id}: ${reversed ? 'reversed' : 'refund booked, already-cancelled'} receipt ${receipt.number} (${reason})`);
  publishInvoicesChanged(link.tenantId);
  return { ok: true, state: 'refunded' };
}

export function startPaylinkScheduler(): void {
  if (!paylinkConfigured()) return;
  setInterval(() => { void reconcilePendingLinks(); }, RECONCILE_INTERVAL_MS);
  console.log('💳 Paylink scheduler started (reconcile pending links every 2min)');
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

  // إيصال السداد: سند القبض الذي أنشأه الدفع يُعرض للعميل دليلاً موثقاً —
  // الرمز غير القابل للتخمين هو إذن الاطلاع، ولا يُكشف إلا ما يخص هذه العملية
  let receipt: { number: string; amount: number; date: Date } | null = null;
  if (link.status === 'paid' && link.receiptId) {
    const r = await prisma.receipt.findUnique({
      where: { id: link.receiptId },
      select: { number: true, amount: true, receiptDate: true },
    });
    if (r) receipt = { number: r.number, amount: roundHalfUp(Number(r.amount), 2), date: r.receiptDate };
  }

  // اللون يحقن في سياق style بصفحة عامة — لا يغادر الخادم الا لونا صرفا
  const safeColor = /^#[0-9a-fA-F]{3,8}$/.test(company?.primaryColor ?? '') ? company!.primaryColor : null;

  return {
    company: { name: company?.name || link.tenant.name, logo: company?.logo ?? null, primaryColor: safeColor },
    customerName: link.customer.name,
    invoiceNumber: link.invoice.number,
    amount: link.amount,
    status: expired ? 'expired' : settled ? 'settled' : link.status,
    payUrl: link.status === 'initiated' && !expired && !settled ? link.url : null,
    paidAt: link.paidAt,
    receipt,
  };
}
