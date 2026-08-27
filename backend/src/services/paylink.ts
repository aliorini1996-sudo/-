import crypto from 'crypto';
import prisma from '../config/database';
import { roundHalfUp } from '../lib/money';
import { createInvoice, fetchInvoice, cancelInvoice, sarToHalalas, moyasarConfigured } from './moyasar';
import { postCollectionEntries, postRefundEntry } from './settlement';
import { generateReceiptNumber, withNumberRetry } from '../utils/helpers';
import { postReceiptEntries, reverseReceiptEntries, clean } from './accounting';

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
    // فشل قبل تأكد الإنشاء لدى ميسر — ننظف صفنا (نفس فلسفة payments.ts).
    // الخطأ الخام (يحمل اسم المزود وتفاصيله) للسجل، والمندوب يرى رسالة عمل
    await prisma.customerPaymentLink.delete({ where: { id: row.id } }).catch(() => { /* best-effort */ });
    console.error('paylink issue: provider create failed:', (e as Error).message);
    return { ok: false, message: 'تعذر انشاء رابط الدفع حاليا حاول بعد لحظات' };
  }

  try {
    const updated = await prisma.customerPaymentLink.update({
      where: { id: row.id },
      data: { moyasarInvoiceId: moyasar.id, url: moyasar.url },
    });

    // سباق الإصدار المزدوج (جهازان في نفس اللحظة): لا قيد فريد يمنع رابطين حيين
    // بفاتورتي ميسر قابلتين للدفع معا. القاعدة: يبقى الأقدم — فإن وجدنا أقدم منا
    // حيا بمبلغنا ألغينا أنفسنا وأعدناه، فيتقارب الطرفان على رابط واحد
    const rival = await prisma.customerPaymentLink.findFirst({
      where: {
        tenantId: params.tenantId, invoiceId: invoice.id, status: 'initiated',
        amount: remaining, url: { not: null }, id: { not: row.id },
        createdAt: { lt: updated.createdAt },
      },
      orderBy: { createdAt: 'asc' },
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
      invoice: { select: { id: true, number: true, customerId: true, paidAmt: true, remainingAmt: true } },
      tenant: { select: { paylinkFeePct: true, paylinkFeeFlat: true } },
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
      await prisma.customerPaymentLink.updateMany({
        where: { id: link.id, status: { in: ['initiated', 'canceled', 'expired'] } },
        data: { status: remote.status },
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
        data: {
          status: 'paid', paidAt: new Date(), receiptId: rcp.id,
          // معرف الدفعة لدى المزود — بدونه لا يُبنى مسار الاسترداد
          moyasarPaymentId: remote.payments?.find(p => p.status === 'paid' || p.status === 'captured')?.id ?? null,
        },
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

// ═══ مجدول التسوية — الحقيقة تُجلب دورياً لا تُنتظر ═══

const RECONCILE_INTERVAL_MS = 2 * 60_000; // كل دقيقتين
const RECONCILE_BATCH = 40;

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
        await prisma.customerPaymentLink.update({ where: { id: link.id }, data: { status: 'expired' } }).catch(() => { /* سباق */ });
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
    include: { invoiceItems: true },
  });
  if (!receipt) return { ok: false, state: 'no-receipt' };
  if (receipt.status === 'CANCELLED') {
    await prisma.customerPaymentLink.update({ where: { id: link.id }, data: { status: 'refunded' } }).catch(() => { /* سباق */ });
    return { ok: true, state: 'already-refunded' };
  }

  await prisma.$transaction(async tx => {
    await tx.receipt.update({ where: { id: receipt.id }, data: { status: 'CANCELLED' } });
    for (const item of receipt.invoiceItems) {
      const inv = await tx.invoice.findUnique({ where: { id: item.invoiceId }, select: { paidAmt: true, remainingAmt: true } });
      if (!inv) continue;
      await tx.invoice.update({
        where: { id: item.invoiceId },
        data: {
          paidAmt: clean(Number(inv.paidAmt) - Number(item.amount)),
          remainingAmt: clean(Number(inv.remainingAmt) + Number(item.amount)),
        },
      });
    }
    await reverseReceiptEntries(tx as never, link.tenantId, receipt.id, link.customerId, Number(receipt.amount));
    await postRefundEntry(tx, {
      tenantId: link.tenantId,
      linkId: link.id,
      refunded: Number(receipt.amount),
      invoiceNumber: link.invoice.number,
    });
    await tx.customerPaymentLink.update({ where: { id: link.id }, data: { status: 'refunded' } });
    await tx.notification.create({
      data: {
        tenantId: link.tenantId,
        type: 'PAYLINK_REFUNDED',
        title: 'استرداد دفعة الكترونية',
        body: `رُدَّ مبلغ ${Number(receipt.amount)} لفاتورة ${link.invoice.number} — الغي سند ${receipt.number} (${reason})`,
      },
    }).catch(() => { /* كمالي */ });
  });
  console.error(`paylink refund ${link.id}: reversed receipt ${receipt.number} (${reason})`);
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
